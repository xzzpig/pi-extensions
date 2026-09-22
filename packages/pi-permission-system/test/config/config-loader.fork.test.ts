import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadAndMergeConfigs,
  mergeUnifiedConfigs,
  validateUnifiedConfig,
} from "#src/config/config-loader";

// Fork-only tests: profiles registry support and its load/merge gating
// (upstream `config-loader.test.ts` covers the unextended behavior).

describe("validateUnifiedConfig profile gating", () => {
  it("accepts a profiles registry by default (global config)", () => {
    const result = validateUnifiedConfig({
      profiles: { reviewer: { permission: { "*": "ask" } } },
    });
    expect(result.issues).toEqual([]);
    expect(result.config.profiles?.reviewer?.permission).toEqual({
      "*": "ask",
    });
  });

  it("accepts a profiles registry in a project-shaped config", () => {
    const result = validateUnifiedConfig({
      permission: { "*": "ask" },
      profiles: { reviewer: { permission: { "*": "ask" } } },
    });
    expect(result.issues).toEqual([]);
    expect(result.config.profiles?.reviewer?.permission).toEqual({
      "*": "ask",
    });
  });

  it("accepts a project config without a profiles registry", () => {
    const result = validateUnifiedConfig({ permission: { bash: "deny" } });
    expect(result.issues).toEqual([]);
    expect(result.config.permission).toEqual({ bash: "deny" });
  });

  it("rejects non-object parsed values without crashing", () => {
    for (const parsed of [null, "string", 42, ["profiles"]]) {
      const result = validateUnifiedConfig(parsed);
      expect(result.config).toEqual({});
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("mergeUnifiedConfigs profiles", () => {
  it("keeps the base profiles registry when the override carries none", () => {
    const merged = mergeUnifiedConfigs(
      { profiles: { reviewer: { permission: { "*": "ask" } } } },
      { permission: { read: "allow" } },
    );
    expect(merged.profiles).toEqual({
      reviewer: { permission: { "*": "ask" } },
    });
    expect(merged.permission).toEqual({ read: "allow" });
  });

  it("replaces the profiles registry when the override defines one", () => {
    const merged = mergeUnifiedConfigs(
      { profiles: { old: { permission: { "*": "ask" } } } },
      { profiles: { new: { permission: { "*": "deny" } } } },
    );
    expect(Object.keys(merged.profiles ?? {})).toEqual(["new"]);
  });

  it("leaves profiles undefined when neither side defines one", () => {
    const merged = mergeUnifiedConfigs({ permission: { "*": "ask" } }, {});
    expect(merged.profiles).toBeUndefined();
  });
});

describe("loadAndMergeConfigs profiles gating", () => {
  let tempDir: string;
  let agentDir: string;
  let cwd: string;
  let extensionRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "config-profiles-merge-test-"));
    agentDir = join(tempDir, "agent");
    cwd = join(tempDir, "project");
    extensionRoot = join(tempDir, "ext");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("carries the global profiles registry into the merged config", () => {
    const globalDir = join(agentDir, "extensions", "pi-permission-system");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({
        permission: { "*": "ask" },
        profiles: { reviewer: { permission: { read: "allow" } } },
      }),
    );

    const result = loadAndMergeConfigs(agentDir, cwd, extensionRoot);
    expect(result.issues).toEqual([]);
    expect(result.merged.profiles).toEqual({
      reviewer: { permission: { read: "allow" } },
    });
  });

  it("carries a project profiles registry into the project and merged configs", () => {
    const globalDir = join(agentDir, "extensions", "pi-permission-system");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ permission: { "*": "ask", bash: "deny" } }),
    );
    const projectDir = join(cwd, ".pi", "extensions", "pi-permission-system");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "config.json"),
      JSON.stringify({
        permission: { bash: "allow" },
        profiles: { "project-dev": { permission: { read: "allow" } } },
      }),
    );

    const result = loadAndMergeConfigs(agentDir, cwd, extensionRoot);
    expect(result.issues).toEqual([]);
    // Project config is read whole: its permission merges normally and its
    // profiles registry rides the project scope for resolution.
    expect(result.project.profiles).toEqual({
      "project-dev": { permission: { read: "allow" } },
    });
  });
});

