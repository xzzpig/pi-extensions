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

  it("applies profile rules with origin 'profile'", () => {
    const read = manager.check({ ...readCheck(), agentName: "worker" });
    expect(read.state).toBe("allow");
    expect(read.origin).toBe("profile");

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
    expect(fetch.origin).toBe("profile");
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
    expect(skill.origin).toBe("profile");
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
    expect(read.origin).toBe("profile");
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
    expect(read.origin).toBe("profile");
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
    expect(read.origin).toBe("profile");
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

    const issues = manager.getConfigIssues("worker");
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

    const issues = manager.getConfigIssues("worker");
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
