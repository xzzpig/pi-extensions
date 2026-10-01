import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  OpenspecCliExitError,
  OpenspecCliMissingError,
  OpenspecJsonParseError,
  getOpenspecArtifactInstructions,
  listOpenspecSchemas,
  listOpenspecTemplates,
  probeOpenspecVersion,
  resolveOpenspecBinary,
  resetOpenspecVersionCacheForTests,
  runOpenspecJson,
  type SpawnSyncLike,
} from "../src/cli.ts";
import {
  FAKE_CLI_VERSION,
  FAKE_SCHEMAS,
  FAKE_TEMPLATES,
  fakeCliEnv,
  makeFakeCliDir,
  makeTempDir,
} from "./helpers.ts";

beforeEach(() => {
  resetOpenspecVersionCacheForTests();
});

function fakeSpawnResult(
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  return {
    pid: 12345,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

/** A directory whose PATH holds a real (harmless) executable named openspec. */
function makeDummyBinaryDir(): { env: NodeJS.ProcessEnv; binaryPath: string } {
  const dir = makeTempDir("pi-openspec-x-dummy-bin-");
  const binaryPath = path.join(dir, "openspec");
  fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", {
    encoding: "utf-8",
    mode: 0o755,
  });
  return { env: fakeCliEnv(dir), binaryPath };
}

describe("resolveOpenspecBinary", () => {
  test("finds an executable openspec on PATH", () => {
    const cliDir = makeFakeCliDir();
    const resolved = resolveOpenspecBinary(fakeCliEnv(cliDir));
    expect(resolved).toBeDefined();
    expect(path.dirname(resolved as string)).toBe(fs.realpathSync(cliDir));
  });

  test("returns undefined when PATH is empty", () => {
    expect(resolveOpenspecBinary({ PATH: "" })).toBeUndefined();
  });

  test("returns undefined when the candidate is not executable", () => {
    const dir = makeTempDir("pi-openspec-x-noexec-");
    fs.writeFileSync(path.join(dir, "openspec"), "#!/bin/sh\n", {
      encoding: "utf-8",
      mode: 0o644,
    });
    expect(resolveOpenspecBinary(fakeCliEnv(dir))).toBeUndefined();
  });
});

describe("probeOpenspecVersion (spawn mocked)", () => {
  test("CLI exists: probes --version through spawn and returns the trimmed version", () => {
    const { env, binaryPath } = makeDummyBinaryDir();
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ stdout: "1.2.3\n" }),
    );
    expect(probeOpenspecVersion({ env, spawnImpl })).toBe("1.2.3");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [file, args] = spawnImpl.mock.calls[0] as [string, string[], unknown];
    expect(file).toBe(fs.realpathSync(binaryPath));
    expect(args).toEqual(["--version"]);
  });

  test("per-session cache: a second probe of the same binary does not spawn again", () => {
    const { env } = makeDummyBinaryDir();
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ stdout: "1.2.3\n" }),
    );
    probeOpenspecVersion({ env, spawnImpl });
    expect(probeOpenspecVersion({ env, spawnImpl })).toBe("1.2.3");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  test("CLI missing: empty PATH raises OpenspecCliMissingError without spawning", () => {
    const spawnImpl = vi.fn<SpawnSyncLike>();
    expect(() =>
      probeOpenspecVersion({ env: { PATH: "" }, spawnImpl }),
    ).toThrow(OpenspecCliMissingError);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("version change: the cached version wins until the per-session cache is reset", () => {
    const { env } = makeDummyBinaryDir();
    let versionOutput = "1.2.3";
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ stdout: `${versionOutput}\n` }),
    );
    expect(probeOpenspecVersion({ env, spawnImpl })).toBe("1.2.3");
    versionOutput = "2.0.0";
    expect(probeOpenspecVersion({ env, spawnImpl })).toBe("1.2.3");
    resetOpenspecVersionCacheForTests();
    expect(probeOpenspecVersion({ env, spawnImpl })).toBe("2.0.0");
  });

  test("spawn-level failure maps to OpenspecCliExitError with a null exit code", () => {
    const { env } = makeDummyBinaryDir();
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ error: new Error("spawn EACCES"), status: null }),
    );
    try {
      probeOpenspecVersion({ env, spawnImpl });
      expect.unreachable("expected OpenspecCliExitError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenspecCliExitError);
      const exitError = error as OpenspecCliExitError;
      expect(exitError.exitCode).toBeNull();
      expect(exitError.stderr).toContain("EACCES");
    }
  });

  test("empty version output is rejected instead of cached", () => {
    const { env } = makeDummyBinaryDir();
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ stdout: "\n" }),
    );
    expect(() => probeOpenspecVersion({ env, spawnImpl })).toThrow(
      OpenspecCliExitError,
    );
  });
});

describe("runOpenspecJson (spawn mocked)", () => {
  test("returns the parsed JSON payload", () => {
    const { env } = makeDummyBinaryDir();
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ stdout: '{"ok":true}\n' }),
    );
    expect(
      runOpenspecJson<{ ok: boolean }>(["list", "--json"], { env, spawnImpl }),
    ).toEqual({ ok: true });
    const [, args] = spawnImpl.mock.calls[0] as [string, string[], unknown];
    expect(args).toEqual(["list", "--json"]);
  });

  test("non-zero exit raises OpenspecCliExitError with code and stderr", () => {
    const { env } = makeDummyBinaryDir();
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ status: 2, stderr: "boom\n" }),
    );
    try {
      runOpenspecJson(["list", "--json"], { env, spawnImpl });
      expect.unreachable("expected OpenspecCliExitError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenspecCliExitError);
      const exitError = error as OpenspecCliExitError;
      expect(exitError.exitCode).toBe(2);
      expect(exitError.stderr).toBe("boom");
      expect(exitError.args).toEqual(["list", "--json"]);
    }
  });

  test("bad JSON raises OpenspecJsonParseError carrying the raw stdout", () => {
    const { env } = makeDummyBinaryDir();
    const spawnImpl = vi.fn<SpawnSyncLike>(() =>
      fakeSpawnResult({ stdout: "not json at all" }),
    );
    try {
      runOpenspecJson(["schemas", "--json"], { env, spawnImpl });
      expect.unreachable("expected OpenspecJsonParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenspecJsonParseError);
      const parseError = error as OpenspecJsonParseError;
      expect(parseError.stdout).toBe("not json at all");
      expect(parseError.args).toEqual(["schemas", "--json"]);
    }
  });
});

describe("openspec CLI integration (real spawnSync, fake binary)", () => {
  test("version, schemas, and templates round-trip end to end", () => {
    const options = { env: fakeCliEnv(makeFakeCliDir()) };
    expect(probeOpenspecVersion(options)).toBe(FAKE_CLI_VERSION);
    const schemas = listOpenspecSchemas(options);
    expect(schemas).toEqual(FAKE_SCHEMAS);
    expect(schemas[0]?.artifacts).toEqual([
      "proposal",
      "specs",
      "design",
      "tasks",
    ]);
    const templates = listOpenspecTemplates(options);
    expect(templates).toEqual(FAKE_TEMPLATES);
    expect(templates.proposal?.path).toBe("/tmp/fake-templates/proposal.md");
  });

  test("a real missing CLI raises OpenspecCliMissingError", () => {
    expect(() => listOpenspecSchemas({ env: { PATH: "" } })).toThrow(
      OpenspecCliMissingError,
    );
  });

  test("a real non-zero exit raises OpenspecCliExitError", () => {
    const options = { env: fakeCliEnv(makeFakeCliDir({ schemasExitCode: 3 })) };
    try {
      listOpenspecSchemas(options);
      expect.unreachable("expected OpenspecCliExitError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenspecCliExitError);
      expect((error as OpenspecCliExitError).exitCode).toBe(3);
      expect((error as OpenspecCliExitError).stderr).toBe("boom");
    }
  });

  test("a real bad-JSON response raises OpenspecJsonParseError", () => {
    const options = {
      env: fakeCliEnv(
        makeFakeCliDir({ schemasStdout: "<html>not json</html>" }),
      ),
    };
    expect(() => listOpenspecSchemas(options)).toThrow(OpenspecJsonParseError);
  });

  test("schema entries missing required fields raise OpenspecJsonParseError", () => {
    const options = {
      env: fakeCliEnv(
        makeFakeCliDir({ schemasStdout: JSON.stringify([{ name: "x" }]) }),
      ),
    };
    expect(() => listOpenspecSchemas(options)).toThrow(OpenspecJsonParseError);
  });

  test("template values missing required fields raise OpenspecJsonParseError", () => {
    const options = {
      env: fakeCliEnv(
        makeFakeCliDir({
          templatesStdout: JSON.stringify({ proposal: { source: "package" } }),
        }),
      ),
    };
    expect(() => listOpenspecTemplates(options)).toThrow(
      OpenspecJsonParseError,
    );
  });
});

describe("getOpenspecArtifactInstructions", () => {
  test("validates and returns the fields the plan flow renders", () => {
    const { env } = makeDummyBinaryDir();
    const spawnImpl: SpawnSyncLike = () =>
      fakeSpawnResult({
        stdout: JSON.stringify({
          artifactId: "proposal",
          changeName: "change-a",
          instruction: "Draft it.",
          template: "# Proposal",
          context: "Chinese",
          rules: ["Be concise"],
          resolvedOutputPath: "/p/proposal.md",
          unknownField: "ignored",
        }),
      });

    expect(
      getOpenspecArtifactInstructions("proposal", "change-a", {
        env,
        spawnImpl,
      }),
    ).toEqual({
      artifactId: "proposal",
      changeName: "change-a",
      instruction: "Draft it.",
      template: "# Proposal",
      context: "Chinese",
      rules: ["Be concise"],
      resolvedOutputPath: "/p/proposal.md",
    });
  });

  test("omits absent optional fields and rejects a missing instruction", () => {
    const { env } = makeDummyBinaryDir();
    const minimal: SpawnSyncLike = () =>
      fakeSpawnResult({
        stdout: JSON.stringify({
          artifactId: "proposal",
          changeName: "change-a",
          instruction: "Do it.",
        }),
      });
    expect(
      getOpenspecArtifactInstructions("proposal", "change-a", {
        env,
        spawnImpl: minimal,
      }),
    ).toEqual({
      artifactId: "proposal",
      changeName: "change-a",
      instruction: "Do it.",
    });

    const missing: SpawnSyncLike = () =>
      fakeSpawnResult({
        stdout: JSON.stringify({ artifactId: "proposal", changeName: "c" }),
      });
    expect(() =>
      getOpenspecArtifactInstructions("proposal", "c", {
        env,
        spawnImpl: missing,
      }),
    ).toThrow(OpenspecJsonParseError);
  });
});
