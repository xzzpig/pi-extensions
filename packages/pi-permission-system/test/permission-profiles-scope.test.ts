import { afterEach, describe, expect, it } from "vitest";

import { createInMemoryManager } from "#test/helpers/manager-harness";
import { PERMISSION_PROFILE_ENV } from "#src/permission-profile";

/**
 * Named permission profiles (OpenSpec add-agent-permission-profiles):
 * the profile scope sits between project and agent in the merge pipeline, so
 * it refines global/project per pattern and the agent frontmatter refines it
 * per pattern. Unknown or empty profiles fail the scope closed (allow→ask).
 */

function bashCheck(command: string) {
  return {
    kind: "tool" as const,
    surface: "bash",
    input: { command },
  };
}

function readCheck() {
  return {
    kind: "tool" as const,
    surface: "read",
    input: { path: "/some/file.txt" },
  };
}

function writeCheck() {
  return {
    kind: "tool" as const,
    surface: "write",
    input: { path: "/some/file.txt" },
  };
}

afterEach(() => {
  delete process.env[PERMISSION_PROFILE_ENV];
});

describe("profile scope merge position", () => {
  const manager = createInMemoryManager({
    global: {
      permission: { read: "allow", write: "deny" },
      profiles: {
        reviewer: {
          permission: { "*": "deny", read: "allow", bash: { "git *": "ask" } },
        },
      },
    },
    agent: {
      worker: {
        profileName: "reviewer",
        permission: { bash: { "git status": "allow" } },
      },
    },
  });

  it("applies profile rules with origin 'profile-global'", () => {
    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("allow");
    expect(read.origin).toBe("profile-global");

    // The profile does not mention `write`: the global deny survives with its
    // own origin (a profile cannot silently drop an inherited deny).
    const write = manager.check({ ...writeCheck(), agentName: "worker" });
    expect(write.state).toBe("deny");
    expect(write.origin).toBe("global");
  });

  it("lets the agent frontmatter override the profile per pattern", () => {
    const status = manager.check({ ...bashCheck("git status"), agentName: "worker" });
    expect(status.state).toBe("allow");
    expect(status.origin).toBe("agent");

    const fetch = manager.check({ ...bashCheck("git fetch"), agentName: "worker" });
    expect(fetch.state).toBe("ask");
    expect(fetch.origin).toBe("profile-global");
  });

  it("keeps a global deny the profile does not mention", () => {
    // The profile only refines `read` and `bash`; the global `write: deny`
    // pattern is untouched and keeps its origin.
    const write = manager.check({ ...writeCheck(), agentName: "worker" });
    expect(write.state).toBe("deny");
    expect(write.origin).toBe("global");
  });

  it("lets the profile's universal fallback govern unmatched surfaces", () => {
    // The profile's '*'=deny feeds the synthesized defaults, so an unmentioned
    // surface resolves to the profile's fallback with its origin.
    const skill = manager.check({
      kind: "tool",
      surface: "skill",
      input: { skillName: "librarian" },
      agentName: "worker",
    });
    expect(skill.state).toBe("deny");
    expect(skill.origin).toBe("profile-global");
  });
});

describe("profile selection precedence", () => {
  it("prefers the project agent file over the global agent file", () => {
    const manager = createInMemoryManager({
      global: {
        profiles: {
          agentA: { permission: { read: "ask" } },
          projectA: { permission: { read: "allow" } },
        },
      },
      agent: { worker: { profileName: "agentA" } },
      projectAgent: { worker: { profileName: "projectA" } },
    });
    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("allow");
    expect(read.origin).toBe("profile-global");
  });

  it("prefers the launcher env over both agent files", () => {
    process.env[PERMISSION_PROFILE_ENV] = "envA";
    const manager = createInMemoryManager({
      global: {
        profiles: {
          agentA: { permission: { read: "ask" } },
          projectA: { permission: { read: "allow" } },
          envA: { permission: { read: "deny" } },
        },
      },
      agent: { worker: { profileName: "agentA" } },
      projectAgent: { worker: { profileName: "projectA" } },
    });
    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("deny");
    expect(read.origin).toBe("profile-global");
  });

  it("applies the profile to the requester's agent name (cross-session 0008)", () => {
    const manager = createInMemoryManager({
      global: {
        permission: { read: "allow" },
        profiles: {
          reviewer: { permission: { read: "deny" } },
        },
      },
      agent: { child: { profileName: "reviewer" } },
    });
    // A forwarded request is resolved by the serving node under the
    // requester's agent name — the requester's profile rules apply.
    const read = manager.check({ ...readCheck(), agentName: "child" });
    expect(read.state).toBe("deny");
    expect(read.origin).toBe("profile-global");
  });
});

describe("project-scoped profile two-layer merge", () => {
  const manager = createInMemoryManager({
    global: {
      permission: { read: "allow", write: "deny" },
      profiles: {
        dev: {
          permission: {
            read: "allow",
            write: "deny",
            bash: { "git *": "ask" },
          },
        },
      },
    },
    project: {
      // Same-named project profile: overrides `read` per pattern, leaves
      // `write` deny and `bash` untouched.
      profiles: { dev: { permission: { read: "ask" } } },
    },
    agent: { worker: { profileName: "dev" } },
  });

  it("attributes each pattern to its own two-layer origin", () => {
    const rules = manager.getComposedConfigRules("worker");
    const originOf = (surface: string, pattern = "*") =>
      rules.find((rule) => rule.surface === surface && rule.pattern === pattern)
        ?.origin;
    // The same-named project profile overrides this pattern.
    expect(originOf("read")).toBe("profile-project");
    // Patterns the project profile does not mention keep the global layer.
    expect(originOf("write")).toBe("profile-global");
    expect(originOf("bash", "git *")).toBe("profile-global");
  });

  it("applies the project pattern override at runtime", () => {
    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("ask");
    expect(read.origin).toBe("profile-project");
  });

  it("keeps the global same-named profile deny the project does not mention", () => {
    const write = manager.check({ ...writeCheck(), agentName: "worker" });
    expect(write.state).toBe("deny");
    expect(write.origin).toBe("profile-global");
  });
});

describe("profile fail-closed", () => {
  it("floors every allow to ask when the selected profile is unknown", () => {
    const manager = createInMemoryManager({
      global: { permission: { read: "allow" } },
      agent: { worker: { profileName: "does-not-exist" } },
    });

    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("ask");
    expect(read.origin).toBe("fail-closed");

    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) => issue.includes("Invalid profile configuration")),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes("Permission profile 'does-not-exist' could not be resolved"),
      ),
    ).toBe(true);
  });

  it("floors every allow to ask when the selected profile has no rules", () => {
    const manager = createInMemoryManager({
      global: {
        permission: { read: "allow" },
        profiles: { empty: {} },
      },
      agent: { worker: { profileName: "empty" } },
    });

    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("ask");
    expect(read.origin).toBe("fail-closed");

    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) => issue.includes("Permission profile 'empty'")),
    ).toBe(true);
  });

  it("does not fail closed when no profile is selected", () => {
    const manager = createInMemoryManager({
      global: { permission: { read: "allow" } },
      agent: { worker: { permission: { bash: "ask" } } },
    });
    const read = manager.check(readCheck());
    expect(read.state).toBe("allow");
    expect(read.origin).toBe("global");
  });
});

describe("project-scoped profile selection end-to-end (trusted / untrusted)", () => {
  it("resolves a project-only profile name when the project is trusted", () => {
    const manager = createInMemoryManager({
      global: { permission: { read: "allow" } },
      project: {
        profiles: { "project-dev": { permission: { read: "ask" } } },
      },
      agent: { worker: { profileName: "project-dev" } },
    });
    // Trusted by default (no configureForCwd): the project-only name resolves.
    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("ask");
    expect(read.origin).toBe("profile-project");
    expect(manager.getPolicyIssues("worker")).toEqual([]);
  });

  it("degrades a same-named selection to the global profile when untrusted", () => {
    const manager = createInMemoryManager({
      global: {
        permission: { read: "allow", write: "deny" },
        profiles: {
          dev: { permission: { read: "allow", write: "deny" } },
        },
      },
      project: {
        profiles: { dev: { permission: { read: "ask" } } },
      },
      agent: { worker: { profileName: "dev" } },
    });
    manager.configureForCwd(undefined); // untrusted

    const read = manager.check({ ...readCheck(), agentName: "worker" });
    // The project layer is withheld: global dev profile governs read=allow.
    expect(read.state).toBe("allow");
    expect(read.origin).toBe("profile-global");

    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) =>
        issue.includes(
          "Project defines 1 permission profile that was not applied (project is not trusted).",
        ),
      ),
    ).toBe(true);
  });

  it("fails closed on a project-only name when the project is untrusted", () => {
    const manager = createInMemoryManager({
      global: { permission: { read: "allow" } },
      project: {
        profiles: { "project-dev": { permission: { read: "ask" } } },
      },
      agent: { worker: { profileName: "project-dev" } },
    });
    manager.configureForCwd(undefined); // untrusted

    const read = manager.check({ ...readCheck(), agentName: "worker" });
    // Unknown name (project layer withheld) ⇒ allow is floored to ask.
    expect(read.state).toBe("ask");
    expect(read.origin).toBe("fail-closed");

    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) =>
        issue.includes(
          "Permission profile 'project-dev' could not be resolved",
        ),
      ),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes(
          "Project defines 1 permission profile that was not applied (project is not trusted).",
        ),
      ),
    ).toBe(true);
  });
});

describe("untrusted project profiles warning via getPolicyIssues", () => {
  // projectTrusted=false forces resolveProfileScopes to treat the project
  // registry as empty and emit the «N not applied» warning; the manager path
  // reaches it through ResolvedPermissions.warnings → getPolicyIssues.
  function untrustedManager() {
    const manager = createInMemoryManager({
      global: {
        permission: { read: "allow" },
        profiles: { dev: { permission: { read: "allow" } } },
      },
      project: {
        profiles: {
          dev: { permission: { read: "ask" } },
          extra: { permission: { write: "deny" } },
        },
      },
      agent: { worker: { profileName: "dev" } },
    });
    manager.configureForCwd(undefined);
    return manager;
  }

  it("reports the project profile count with singular/plural wording", () => {
    const issues = untrustedManager().getPolicyIssues("worker");
    expect(
      issues.some((issue) =>
        issue.includes(
          "Project defines 2 permission profiles that were not applied (project is not trusted).",
        ),
      ),
    ).toBe(true);
  });

  it("reports a single project profile in the singular", () => {
    const manager = createInMemoryManager({
      global: { profiles: { dev: { permission: { read: "allow" } } } },
      project: { profiles: { dev: { permission: { read: "ask" } } } },
      agent: { worker: { profileName: "dev" } },
    });
    manager.configureForCwd(undefined);
    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) =>
        issue.includes(
          "Project defines 1 permission profile that was not applied (project is not trusted).",
        ),
      ),
    ).toBe(true);
  });

  it("is silent for a trusted project with the same registry", () => {
    const manager = createInMemoryManager({
      global: { profiles: { dev: { permission: { read: "allow" } } } },
      project: { profiles: { dev: { permission: { read: "ask" } } } },
      agent: { worker: { profileName: "dev" } },
    });
    manager.configureForCwd("/trusted/project");
    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) => issue.includes("not applied (project is not trusted)")),
    ).toBe(false);
  });

  it("is silent when the trusted default applies (no configureForCwd)", () => {
    const manager = createInMemoryManager({
      global: { profiles: { dev: { permission: { read: "allow" } } } },
      project: { profiles: { dev: { permission: { read: "ask" } } } },
      agent: { worker: { profileName: "dev" } },
    });
    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) => issue.includes("not applied (project is not trusted)")),
    ).toBe(false);
  });

  it("is silent for an untrusted project whose registry is empty", () => {
    const manager = createInMemoryManager({
      global: { profiles: { dev: { permission: { read: "allow" } } } },
      agent: { worker: { profileName: "dev" } },
    });
    manager.configureForCwd(undefined);
    const issues = manager.getPolicyIssues("worker");
    expect(
      issues.some((issue) => issue.includes("not applied (project is not trusted)")),
    ).toBe(false);
  });
});

/**
 * Launcher env selection lifetime (agent-role R7).
 *
 * pi-agent-role selects a session's permission profile by writing the launcher
 * environment key. A subagent child receives the value its launcher pinned, but
 * the shared process environment reverts to the host's value once the child
 * creation window closes — and concurrent in-process children overwrite each
 * other's value. A child therefore freezes the selection at its own
 * `session_start`; a host session keeps reading it live so a mid-session role
 * change applies on the next decision.
 */
describe("launcher env selection lifetime", () => {
  const buildManager = () =>
    createInMemoryManager({
      global: {
        permission: { read: "allow" },
        profiles: {
          hostRole: { permission: { read: "deny" } },
          childRole: { permission: { read: "ask" } },
        },
      },
    });

  it("keeps reading the environment live for a host session", () => {
    const manager = buildManager();
    process.env[PERMISSION_PROFILE_ENV] = "hostRole";
    expect(manager.check(readCheck()).state).toBe("deny");

    process.env[PERMISSION_PROFILE_ENV] = "childRole";
    expect(manager.check(readCheck()).state).toBe("ask");
  });

  it("freezes the selection a child was launched with", () => {
    const manager = buildManager();
    process.env[PERMISSION_PROFILE_ENV] = "childRole";
    manager.freezeEnvProfileSelection?.();

    // The window closes and the host's own role value is back in the shared env.
    process.env[PERMISSION_PROFILE_ENV] = "hostRole";

    const read = manager.check(readCheck());
    expect(read.state).toBe("ask");
    expect(read.origin).toBe("profile-global");
  });

  it("keeps a child that declared no profile unselected", () => {
    const manager = buildManager();
    delete process.env[PERMISSION_PROFILE_ENV];
    manager.freezeEnvProfileSelection?.();

    process.env[PERMISSION_PROFILE_ENV] = "hostRole";

    const read = manager.check(readCheck());
    expect(read.state).toBe("allow");
    expect(read.origin).toBe("global");
  });

  it("drops the frozen selection when a new session takes over", () => {
    const manager = buildManager();
    process.env[PERMISSION_PROFILE_ENV] = "childRole";
    manager.freezeEnvProfileSelection?.();
    manager.clearEnvProfileSelection?.();

    process.env[PERMISSION_PROFILE_ENV] = "hostRole";
    expect(manager.check(readCheck()).state).toBe("deny");

    // The first freeze wins while a session lives: a second call cannot adopt a
    // later value.
    manager.freezeEnvProfileSelection?.();
    process.env[PERMISSION_PROFILE_ENV] = "childRole";
    expect(manager.check(readCheck()).state).toBe("deny");
  });
});
