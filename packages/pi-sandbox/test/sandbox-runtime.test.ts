import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { SandboxManager } from "@xzzpig/sandbox-runtime";
import assert from "node:assert/strict";

import type { SandboxConfig } from "../src/config.ts";

import { DEFAULT_CONFIG, mergeConfigLayers, mergeProfileLayers } from "../src/config.ts";
import { canonicalizePath } from "../src/policy.ts";
import {
  buildRuntimeConfig,
  createSandboxedBashOps,
  extractBlockedWritePath,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createExecTestContext(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-exec-"));
  const backgroundPidPaths: string[] = [];

  // Exercise exec without an OS sandbox session: identity wrap, no SSH proxy.
  mock.method(SandboxManager, "wrapWithSandbox", async (command: string) => command);
  t.after(() => {
    try {
      for (const pidPath of backgroundPidPaths) terminateRecordedProcess(pidPath);
    } finally {
      mock.restoreAll();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  return {
    cwd,
    exec: createSandboxedBashOps(undefined, false).exec,
    trackBackgroundProcess: (pidPath: string) => backgroundPidPaths.push(pidPath),
  };
}

function terminateRecordedProcess(pidPath: string): void {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ESRCH")
    ) {
      throw error;
    }
  }
}

function backgroundNodeCommand(cwd: string, source: string): { command: string; pidPath: string } {
  const pidPath = join(cwd, "background.pid");
  const childSource = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    source,
  ].join("\n");
  const command = [
    `${shellQuote(process.execPath)} -e ${shellQuote(childSource)} &`,
    `while [ ! -s ${shellQuote(pidPath)} ]; do sleep 0.01; done`,
  ].join(" ");
  return { command, pidPath };
}

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
  });
  assert.equal(runtime.network?.allowedDomains?.includes("example.com"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("buildRuntimeConfig canonicalizes non-glob filesystem paths", () => {
  const runtime = buildRuntimeConfig({
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      denyRead: ["/tmp"],
      allowRead: [],
      allowWrite: ["/tmp"],
      denyWrite: ["*.key"],
    },
  });

  assert.deepEqual(runtime.filesystem?.denyRead, [canonicalizePath("/tmp")]);
  assert.equal(runtime.filesystem?.allowRead?.includes(canonicalizePath("/tmp")), true);
  assert.deepEqual(runtime.filesystem?.allowWrite, [canonicalizePath("/tmp")]);
  assert.deepEqual(runtime.filesystem?.denyWrite, ["*.key"]);
});

test("buildRuntimeConfig exposes the bundled seccomp helper on Linux", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, undefined, "linux");
  const runtimeEntryUrl = import.meta.resolve("@xzzpig/sandbox-runtime");
  const seccompPath = canonicalizePath(
    fileURLToPath(new URL("../vendor/seccomp", runtimeEntryUrl)),
  );

  assert.equal(runtime.filesystem?.allowRead?.includes(seccompPath), true);
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

test("exec resolves when the command exits even if a daemonized grandchild holds the stdio pipes", async (t) => {
  const { cwd, exec, trackBackgroundProcess } = createExecTestContext(t);
  const { command, pidPath } = backgroundNodeCommand(cwd, "setInterval(() => {}, 1000);");
  trackBackgroundProcess(pidPath);

  // The background process inherits stdout/stderr indefinitely. Exec should
  // return after its post-exit idle grace, not wait for natural pipe EOF.
  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: () => {} });
  const elapsed = Date.now() - started;

  assert.equal(exitCode, 0);
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected early teardown`);
});

test("exec drains output that stays active after the direct child exits", async (t) => {
  const { cwd, exec, trackBackgroundProcess } = createExecTestContext(t);
  const writerSource = `
let tick = 0;
const writer = setInterval(() => {
  tick += 1;
  process.stdout.write(\`stdout-\${tick}\\n\`);
  process.stderr.write(\`stderr-\${tick}\\n\`);
  if (tick === 6) clearInterval(writer);
}, 50);
setInterval(() => {}, 1000);
`;
  const { command, pidPath } = backgroundNodeCommand(cwd, writerSource);
  trackBackgroundProcess(pidPath);

  const chunks: Buffer[] = [];
  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: (data) => chunks.push(data) });
  const elapsed = Date.now() - started;
  const output = Buffer.concat(chunks).toString("utf8");

  assert.equal(exitCode, 0);
  for (let tick = 1; tick <= 6; tick += 1) {
    assert.ok(output.includes(`stdout-${tick}\n`), `missing stdout token ${tick}`);
    assert.ok(output.includes(`stderr-${tick}\n`), `missing stderr token ${tick}`);
  }
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected idle teardown`);
});

test("exec returns a nonzero exit code", async (t) => {
  const { cwd, exec } = createExecTestContext(t);

  assert.deepEqual(await exec("exit 7", cwd, { onData: () => {} }), { exitCode: 7 });
});

test("exec rejects after its command timeout", async (t) => {
  const { cwd, exec } = createExecTestContext(t);

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, timeout: 0.05 }),
    new Error("timeout:0.05"),
  );
});

test("exec rejects when an in-flight command is aborted", async (t) => {
  const { cwd, exec } = createExecTestContext(t);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 50);
  t.after(() => clearTimeout(abortTimer));

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, signal: controller.signal }),
    new Error("aborted"),
  );
});

test("default denyWrite drops non-existent literal entries when the opt-out is active", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-sb-denytest-"));
  const originalCwd = process.cwd();
  process.chdir(tmp);
  try {
    // No .env in the project: the built-in default literal entry is dropped so
    // bwrap does not materialize a placeholder mount point for it. Glob
    // patterns pass through untouched.
    const runtime = buildRuntimeConfig(DEFAULT_CONFIG);
    assert.equal(runtime.filesystem?.denyWrite?.includes(canonicalizePath(".env")), false);
    assert.deepEqual(runtime.filesystem?.denyWrite, [".env.*", "*.pem", "*.key"]);

    // An existing .env keeps full write protection.
    writeFileSync(join(tmp, ".env"), "TEST=1");
    const withEnv = buildRuntimeConfig(DEFAULT_CONFIG);
    assert.equal(withEnv.filesystem?.denyWrite?.includes(canonicalizePath(".env")), true);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("user-configured denyWrite literals are filtered when non-existent (false)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-sb-denyuser-"));
  const originalCwd = process.cwd();
  process.chdir(tmp);
  try {
    // Default (false): a user-configured literal path that does not exist is
    // dropped entirely — no placeholder, no protection.
    const runtime = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(runtime.filesystem?.denyWrite, []);

    // An existing user-configured entry keeps full write protection.
    writeFileSync(join(tmp, "custom.key"), "k");
    const withExisting = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(withExisting.filesystem?.denyWrite, [canonicalizePath("custom.key")]);

    // Explicit true: legacy behavior — non-existent user denies stay in place
    // and are protected via placeholder mounts.
    const protectAll = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        protectNonexistentFiles: true,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(protectAll.filesystem?.denyWrite, [
      canonicalizePath("secrets/does-not-exist.env"),
      canonicalizePath("custom.key"),
    ]);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("profile hard denyWrite rules retain nonexistent literal paths in runtime sandbox config", () => {
  const profileConfig = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      profiles: {
        strict: {
          filesystem: { denyWrite: ["future-secret.env"] },
        },
      },
    },
    {},
    "strict",
  );

  assert.equal(profileConfig.filesystem?.protectNonexistentFiles, true);
  const runtime = buildRuntimeConfig(profileConfig);
  assert.ok(runtime.filesystem?.denyWrite?.includes(canonicalizePath("future-secret.env")));
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

test("DEFAULT_CONFIG disables placeholder protection for non-existent dangerous files", () => {
  // pi-sandbox wants encoding tools (git status, lint glob scans, …) to see the
  // real directory during a sandboxed run, so the default is the opposite of the
  // runtime default (true).
  assert.equal(DEFAULT_CONFIG.filesystem?.protectNonexistentFiles, false);
});

test("protectNonexistentFiles survives mergeConfigLayers and can be set to true", () => {
  const mergedDefault = mergeConfigLayers(DEFAULT_CONFIG, {}, {});
  assert.equal(mergedDefault.filesystem?.protectNonexistentFiles, false);

  const mergedTrue = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { protectNonexistentFiles: true } },
    {},
  );
  assert.equal(mergedTrue.filesystem?.protectNonexistentFiles, true);

  const mergedProjectOverride = mergeConfigLayers(
    DEFAULT_CONFIG,
    {},
    { filesystem: { protectNonexistentFiles: true } },
  );
  assert.equal(mergedProjectOverride.filesystem?.protectNonexistentFiles, true);

  const runtime = buildRuntimeConfig(mergedTrue, {
    domains: [],
    readPaths: [],
    writePaths: [],
  });
  assert.equal(runtime.filesystem?.protectNonexistentFiles, true);
});

test("buildRuntimeConfig passes network.disabled through to the runtime config", () => {
  const disabled: SandboxConfig = {
    ...DEFAULT_CONFIG,
    network: {
      ...DEFAULT_CONFIG.network,
      allowedDomains: ["example.com"],
      deniedDomains: [],
      disabled: true,
    },
  };

  const runtime = buildRuntimeConfig(disabled);
  assert.equal(runtime.network?.disabled, true);
  assert.deepEqual(runtime.network?.allowedDomains, ["example.com"]);

  // Default config leaves the flag unset, preserving today's behavior.
  const enabled = buildRuntimeConfig(DEFAULT_CONFIG);
  assert.equal(enabled.network?.disabled, undefined);
});
