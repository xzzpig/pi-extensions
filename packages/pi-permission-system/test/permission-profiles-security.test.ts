import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createAgentDirHarness, createInMemoryPolicyLoader } from "#test/helpers/manager-harness";
import { getGlobalConfigPath, getProjectAgentsDir } from "#src/config-paths";
import { PermissionManager } from "#src/permission-manager";
import { FilePolicyLoader } from "#src/policy-loader";

/**
 * Security boundaries of named permission profiles (OpenSpec
 * add-agent-permission-profiles): project trust gating, cache invalidation,
 * yoloMode deny-preservation, and pure-increment compatibility with
 * pre-change parsing.
 */

function readCheck(agentName?: string) {
  return {
    kind: "tool" as const,
    surface: "read",
    input: { path: "/some/file.txt" },
    ...(agentName ? { agentName } : {}),
  };
}

describe("profile selection trust gate", () => {
  it("ignores a project agent file's profile selection when the project is untrusted", () => {
    const harness = createAgentDirHarness({
      globalPermission: { read: "allow" },
    });
    try {
      // Global agent file carries no profile selection.
      const globalAgentsDir = join(harness.agentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "worker.md"),
        "---\nname: worker\n---\nWork.\n",
      );
      // The project agent file selects a strict profile.
      const projectAgentsDir = getProjectAgentsDir(harness.cwd);
      mkdirSync(projectAgentsDir, { recursive: true });
      writeFileSync(
        join(projectAgentsDir, "worker.md"),
        "---\nname: worker\npermission-profile: reviewer-strict\n---\nWork.\n",
      );
      // The global config defines the profile and the registry.
      const globalConfigPath = getGlobalConfigPath(harness.agentDir);
      writeFileSync(
        globalConfigPath,
        JSON.stringify({
          permission: { read: "allow" },
          profiles: {
            "reviewer-strict": { permission: { read: "deny" } },
          },
        }),
      );

      // Untrusted: the project cwd is withheld, so the project agent scope
      // (including its profile selection) never loads.
      const untrusted = new PermissionManager({ agentDir: harness.agentDir });
      untrusted.configureForCwd(undefined);
      const untrustedResult = untrusted.check(readCheck("worker"));
      expect(untrustedResult.state).toBe("allow");
      expect(untrustedResult.origin).toBe("global");

      // Trusted: the project cwd is supplied and the selection applies.
      const trusted = new PermissionManager({ agentDir: harness.agentDir });
      trusted.configureForCwd(harness.cwd);
      const trustedResult = trusted.check(readCheck("worker"));
      expect(trustedResult.state).toBe("deny");
      expect(trustedResult.origin).toBe("profile");
    } finally {
      harness.cleanup();
    }
  });
});

describe("profile cache invalidation", () => {
  it("recomputes resolution when the global config (profiles registry) changes", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "permission-profiles-cache-"));
    try {
      const globalConfigPath = join(baseDir, "config.json");
      const agentsDir = join(baseDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "worker.md"),
        "---\nname: worker\npermission-profile: reviewer\n---\nWork.\n",
      );
      writeFileSync(
        globalConfigPath,
        JSON.stringify({
          permission: { read: "allow" },
          profiles: { reviewer: { permission: { read: "deny" } } },
        }),
      );
      const loader = new FilePolicyLoader({ globalConfigPath, agentsDir });
      const manager = new PermissionManager({ policyLoader: loader });

      expect(manager.check(readCheck("worker")).state).toBe("deny");

      // Rewrite the registry with an explicit mtime bump so the stamp changes.
      writeFileSync(
        globalConfigPath,
        JSON.stringify({
          permission: { read: "allow" },
          profiles: { reviewer: { permission: { read: "ask" } } },
        }),
      );
      const future = new Date(Date.now() + 5000);
      utimesSync(globalConfigPath, future, future);

      expect(manager.check(readCheck("worker")).state).toBe("ask");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("recomputes resolution when the agent file (profile selection) changes", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "permission-profiles-cache-agent-"));
    try {
      const globalConfigPath = join(baseDir, "config.json");
      const agentsDir = join(baseDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      const agentFile = join(agentsDir, "worker.md");
      writeFileSync(agentFile, "---\nname: worker\npermission-profile: reviewer\n---\nWork.\n");
      writeFileSync(
        globalConfigPath,
        JSON.stringify({
          permission: { read: "allow" },
          profiles: {
            reviewer: { permission: { read: "deny" } },
            relaxed: { permission: { read: "allow" } },
          },
        }),
      );
      const loader = new FilePolicyLoader({ globalConfigPath, agentsDir });
      const manager = new PermissionManager({ policyLoader: loader });

      expect(manager.check(readCheck("worker")).state).toBe("deny");

      writeFileSync(agentFile, "---\nname: worker\npermission-profile: relaxed\n---\nWork.\n");
      const future = new Date(Date.now() + 5000);
      utimesSync(agentFile, future, future);

      expect(manager.check(readCheck("worker")).state).toBe("allow");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("profile rules under yoloMode", () => {
  function makeYoloManager(): PermissionManager {
    return new PermissionManager({
      policyLoader: createInMemoryPolicyLoader({
        global: {
          permission: { read: "allow", write: "allow" },
          profiles: {
            reviewer: {
              permission: { read: "ask", write: "deny", bash: { "*": "ask" } },
            },
          },
        },
        agent: { worker: { profileName: "reviewer" } },
      }),
      isYoloEnabled: () => true,
    });
  }

  it("rewrites a profile ask to allow with origin 'yolo' but keeps a profile deny", () => {
    const manager = makeYoloManager();
    const ask = manager.check({
      ...readCheck("worker"),
      surface: "bash",
      input: { command: "git status" },
    });
    expect(ask.state).toBe("allow");
    expect(ask.origin).toBe("yolo");

    const deny = manager.check({
      kind: "tool",
      surface: "write",
      input: { path: "/some/file.txt" },
      agentName: "worker",
    });
    expect(deny.state).toBe("deny");
    expect(deny.origin).toBe("profile");
  });

  it("keeps profile rules yolo-free on display surfaces", () => {
    const manager = makeYoloManager();
    const rules = manager.getComposedConfigRules("worker");
    const readRule = rules.find((rule) => rule.surface === "read" && rule.pattern === "*");
    expect(readRule?.action).toBe("ask");
    expect(readRule?.origin).toBe("profile");
  });
});

describe("legacy frontmatter compatibility (pure increment)", () => {
  it("parses a pre-change agent file into exactly the old scope shape", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "permission-profiles-legacy-"));
    try {
      const agentsDir = join(baseDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "worker.md"),
        `---\nname: worker\npermission:\n  bash: allow\n---\n# Worker agent\n`,
      );
      const loader = new FilePolicyLoader({
        globalConfigPath: join(baseDir, "config.json"),
        agentsDir,
      });
      writeFileSync(join(baseDir, "config.json"), "{}");
      const config = loader.loadAgentConfig("worker");
      // The scope shape is byte-identical to the pre-profile feature: only
      // `permission`, no profileName, no profiles, no invalid flag.
      expect(config).toEqual({ permission: { bash: "allow" } });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("leaves resolution unchanged when the env selection is absent", () => {
    const manager = new PermissionManager({
      policyLoader: createInMemoryPolicyLoader({
        global: {
          permission: { read: "allow" },
          profiles: { reviewer: { permission: { read: "deny" } } },
        },
        agent: { worker: {} },
      }),
    });
    const result = manager.check(readCheck("worker"));
    expect(result.state).toBe("allow");
    expect(result.origin).toBe("global");
  });
});
