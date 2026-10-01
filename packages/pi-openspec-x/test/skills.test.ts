import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  OpenspecCliMissingError,
  resetOpenspecVersionCacheForTests,
  type SpawnSyncLike,
} from "../src/cli.ts";
import {
  OPENSPEC_SKILL_NAMES,
  ensureOpenspecSkills,
  renderSkill,
  resetSkillsFreezeForTests,
} from "../src/skills.ts";
import {
  FAKE_CLI_VERSION,
  FAKE_SCHEMAS,
  fakeCliEnv,
  makeFakeCliDir,
  makeTempDir,
} from "./helpers.ts";

beforeEach(() => {
  resetOpenspecVersionCacheForTests();
  resetSkillsFreezeForTests();
});

const STAMP_FILE_NAME = ".pi-openspec-x-stamp.json";

describe("ensureOpenspecSkills (real fake CLI)", () => {
  test("generates five skills into the versioned cache dir", () => {
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const result = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir,
    });
    const expectedDir = path.join(
      agentDir,
      "cache",
      "pi-openspec-x",
      "skills",
      FAKE_CLI_VERSION,
    );

    expect(result).toEqual({
      skillsDir: expectedDir,
      version: FAKE_CLI_VERSION,
      cacheHit: false,
      skillFilePaths: OPENSPEC_SKILL_NAMES.map((name) =>
        path.join(expectedDir, name, "SKILL.md"),
      ),
    });
    for (const filePath of result.skillFilePaths) {
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  test("resolves the agent dir from PI_CODING_AGENT_DIR when agentDir is omitted", () => {
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const result = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir(), { PI_CODING_AGENT_DIR: agentDir }),
      homeDir: "/nonexistent-home",
    });
    expect(result.skillsDir).toBe(
      path.join(agentDir, "cache", "pi-openspec-x", "skills", FAKE_CLI_VERSION),
    );
  });

  test("frontmatter follows the official skeleton format", () => {
    const result = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });
    const content = fs.readFileSync(
      path.join(result.skillsDir, "openspec-propose", "SKILL.md"),
      "utf-8",
    );
    const frontmatter = content.slice(0, content.indexOf("---", 3) + 3);

    expect(frontmatter).toContain("name: openspec-propose");
    expect(frontmatter).toContain(
      "description: Propose a new OpenSpec change with all artifacts generated in one step.",
    );
    expect(frontmatter).toContain("allowed-tools: Bash(openspec:*)");
    expect(frontmatter).toContain("license: MIT");
    expect(frontmatter).toContain("compatibility: Requires openspec CLI.");
    expect(frontmatter).toContain("metadata:");
    expect(frontmatter).toContain("  author: openspec");
    expect(frontmatter).toContain('generatedBy: "9.9.9-test"');
  });

  test("bodies instruct fetching authoritative instructions from the CLI at execution time", () => {
    const result = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });
    const instructionsDriven = OPENSPEC_SKILL_NAMES.filter(
      (name) => name !== "openspec-explore",
    );
    for (const name of OPENSPEC_SKILL_NAMES) {
      const content = fs.readFileSync(
        path.join(result.skillsDir, name, "SKILL.md"),
        "utf-8",
      );
      expect(content).toContain("source of truth at execution time");
      expect(content).toContain("--json");
      expect(content).toContain("openspec status --change");
    }
    for (const name of instructionsDriven) {
      const content = fs.readFileSync(
        path.join(result.skillsDir, name, "SKILL.md"),
        "utf-8",
      );
      expect(content).toContain("openspec instructions");
    }
    const explore = fs.readFileSync(
      path.join(result.skillsDir, "openspec-explore", "SKILL.md"),
      "utf-8",
    );
    expect(explore).toContain("openspec list --json");
  });

  test("artifact list comes from the schemas output (spec-driven)", () => {
    const result = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });
    const propose = fs.readFileSync(
      path.join(result.skillsDir, "openspec-propose", "SKILL.md"),
      "utf-8",
    );
    expect(propose).toContain(
      "`spec-driven` schema (Default OpenSpec workflow - proposal → specs → design → tasks)",
    );
    expect(propose).toContain("proposal, specs, design, tasks");
  });

  test("an empty schemas list still generates skills with a discovery fallback line", () => {
    const result = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir({ schemasStdout: "[]" })),
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });
    const propose = fs.readFileSync(
      path.join(result.skillsDir, "openspec-propose", "SKILL.md"),
      "utf-8",
    );
    expect(propose).toContain("openspec schemas --json");
  });

  test("descriptions stay semantically aligned with the official static skills", () => {
    const context = { cliVersion: FAKE_CLI_VERSION, schema: FAKE_SCHEMAS[0] };
    expect(renderSkill("openspec-explore", context)).toContain(
      "thinking partner for exploring ideas",
    );
    expect(renderSkill("openspec-apply-change", context)).toContain(
      "Implement tasks from an OpenSpec change.",
    );
    expect(renderSkill("openspec-archive-change", context)).toContain(
      "Archive a completed OpenSpec change",
    );
    expect(renderSkill("openspec-sync-specs", context)).toContain(
      "Sync delta specs from an OpenSpec change",
    );
  });
});

describe("skills cache", () => {
  test("cache hit: the second call runs no CLI command at all", () => {
    const env = fakeCliEnv(makeFakeCliDir());
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const first = ensureOpenspecSkills({ env, agentDir });
    expect(first.cacheHit).toBe(false);

    // Even the version probe must be served from the per-session cache:
    // a spawning spawnImpl would throw and fail the test.
    const spawnImpl = vi.fn(() => {
      throw new Error("cache hit must not run the CLI");
    });
    const second = ensureOpenspecSkills({ env, agentDir, spawnImpl });
    expect(second.cacheHit).toBe(true);
    expect(second.skillsDir).toBe(first.skillsDir);
    expect(second.skillFilePaths).toEqual(first.skillFilePaths);
  });

  test("a CLI version change regenerates into a new versioned directory", () => {
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const first = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir,
    });
    // A CLI upgrade takes effect in a NEW session; the session freeze is what
    // stops it from taking effect mid-session.
    resetSkillsFreezeForTests();
    const upgraded = ensureOpenspecSkills({
      env: fakeCliEnv(makeFakeCliDir({ version: "10.0.0" })),
      agentDir,
    });

    expect(upgraded.version).toBe("10.0.0");
    expect(upgraded.cacheHit).toBe(false);
    expect(upgraded.skillsDir).toBe(
      path.join(agentDir, "cache", "pi-openspec-x", "skills", "10.0.0"),
    );
    expect(
      fs.readFileSync(
        path.join(upgraded.skillsDir, "openspec-explore", "SKILL.md"),
        "utf-8",
      ),
    ).toContain('generatedBy: "10.0.0"');
    // The old version's cache is left untouched.
    expect(fs.existsSync(first.skillsDir)).toBe(true);
  });

  test("a missing or mismatched stamp forces regeneration", () => {
    const env = fakeCliEnv(makeFakeCliDir());
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const first = ensureOpenspecSkills({ env, agentDir });
    fs.rmSync(path.join(first.skillsDir, STAMP_FILE_NAME));

    let spawnCount = 0;
    const spawnImpl = vi.fn<SpawnSyncLike>((file, args, options) =>
      spawnSync(file, args, options),
    );
    spawnImpl.mockImplementation((file, args, options) => {
      spawnCount += 1;
      return spawnSync(file, args, options);
    });
    resetOpenspecVersionCacheForTests();
    resetSkillsFreezeForTests();
    const second = ensureOpenspecSkills({ env, agentDir, spawnImpl });

    expect(second.cacheHit).toBe(false);
    expect(second.skillsDir).toBe(first.skillsDir);
    // --version + schemas --json, both through the (counted) real spawn.
    expect(spawnCount).toBe(2);
    expect(fs.existsSync(path.join(first.skillsDir, STAMP_FILE_NAME))).toBe(
      true,
    );
  });

  test("a partially generated cache (missing skill file) is regenerated", () => {
    const env = fakeCliEnv(makeFakeCliDir());
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const first = ensureOpenspecSkills({ env, agentDir });
    fs.rmSync(path.join(first.skillsDir, "openspec-sync-specs", "SKILL.md"));

    // Same-session re-discovery is frozen, so model a new session to exercise
    // the incomplete-cache regeneration path.
    resetSkillsFreezeForTests();
    const second = ensureOpenspecSkills({ env, agentDir });
    expect(second.cacheHit).toBe(false);
    expect(
      fs.existsSync(
        path.join(first.skillsDir, "openspec-sync-specs", "SKILL.md"),
      ),
    ).toBe(true);
  });
});

describe("failure surfacing", () => {
  test("a missing CLI raises OpenspecCliMissingError (no partial generation)", () => {
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    expect(() => ensureOpenspecSkills({ env: { PATH: "" }, agentDir })).toThrow(
      OpenspecCliMissingError,
    );
    expect(fs.existsSync(path.join(agentDir, "cache"))).toBe(false);
  });
});

describe("session-level skills freeze", () => {
  test("keeps the first resolved skills dir and version for the session", () => {
    const agentDir = makeTempDir("opsx-skills-");
    const cwd = makeTempDir("opsx-skills-");
    const first = ensureOpenspecSkills({
      agentDir,
      cwd,
      env: fakeCliEnv(makeFakeCliDir()),
    });
    expect(first.version).toBe(FAKE_CLI_VERSION);

    // Spec: 同一会话内发生 skill 重新发现（如扩展 reload）时路径与内容保持不变，
    // 期间发生的 CLI 升级不在本会话生效。
    const second = ensureOpenspecSkills({
      agentDir,
      cwd,
      env: fakeCliEnv(makeFakeCliDir({ version: "10.0.0-upgraded" })),
    });
    expect(second.version).toBe(FAKE_CLI_VERSION);
    expect(second.skillsDir).toBe(first.skillsDir);
    expect(second.cacheHit).toBe(true);
  });

  test("does not freeze a failed resolution", () => {
    const agentDir = makeTempDir("opsx-skills-");
    const cwd = makeTempDir("opsx-skills-");
    expect(() =>
      ensureOpenspecSkills({
        agentDir,
        cwd,
        env: fakeCliEnv(makeTempDir("opsx-skills-")),
      }),
    ).toThrow(OpenspecCliMissingError);

    // The CLI appears afterwards: a later discovery in the same session may
    // still succeed, because nothing was pinned.
    const resolved = ensureOpenspecSkills({
      agentDir,
      cwd,
      env: fakeCliEnv(makeFakeCliDir()),
    });
    expect(resolved.version).toBe(FAKE_CLI_VERSION);
  });
});
