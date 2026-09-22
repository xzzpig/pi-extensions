import { describe, expect, it } from "vitest";

import { resolveProfileScope, resolveProfileScopes } from "#src/policy/profile-scope";

/**
 * Fork-only tests: project-scoped permission profiles.
 *
 * `resolveProfileScope` combines a same-named global and (trusted) project
 * profile at the `(surface, pattern)` level, treats an untrusted project's
 * registry as empty, and fails closed on unknown/empty selections. These cases
 * are fork-only: upstream has no profile layer at all.
 */

const globalProfiles = {
  dev: {
    permission: {
      "bash/*": "ask" as const,
      read: "allow" as const,
      write: "deny" as const,
    },
  },
};

const projectProfiles = {
  dev: {
    permission: {
      read: "ask" as const,
    },
  },
};

describe("resolveProfileScope project profiles", () => {
  it("combines same-named global and trusted project profiles per pattern", () => {
    const result = resolveProfileScope({
      envProfileName: undefined,
      projectAgentProfileName: undefined,
      agentProfileName: "dev",
      profiles: globalProfiles,
      projectProfiles,
    });
    expect(result.invalidProfileName).toBeUndefined();
    expect(result.profileScope).toEqual({
      permission: {
        // Project overrides the same pattern (read: ask).
        read: "ask",
        // Unmentioned patterns keep the global values.
        "bash/*": "ask",
        write: "deny",
      },
    });
  });

  it("treats an untrusted project registry as empty (global only)", () => {
    const result = resolveProfileScope({
      envProfileName: undefined,
      projectAgentProfileName: undefined,
      agentProfileName: "dev",
      profiles: globalProfiles,
      projectProfiles,
      projectTrusted: false,
    });
    expect(result.invalidProfileName).toBeUndefined();
    expect(result.profileScope).toEqual({
      permission: {
        "bash/*": "ask",
        read: "allow",
        write: "deny",
      },
    });
  });

  it("fails closed on a project-only name in an untrusted project", () => {
    const result = resolveProfileScope({
      envProfileName: undefined,
      projectAgentProfileName: undefined,
      agentProfileName: "project-only",
      profiles: undefined,
      // Present in the project registry, but the project is untrusted.
      projectProfiles: {
        "project-only": { permission: { "*": "allow" } },
      },
      projectTrusted: false,
    });
    expect(result.invalidProfileName).toBe("project-only");
    expect(result.profileScope).toEqual({ invalid: true });
  });

  it("resolves a trusted project-only name", () => {
    const result = resolveProfileScope({
      envProfileName: undefined,
      projectAgentProfileName: undefined,
      agentProfileName: "project-only",
      profiles: undefined,
      projectProfiles: {
        "project-only": { permission: { "*": "allow" } },
      },
    });
    expect(result.invalidProfileName).toBeUndefined();
    expect(result.profileScope).toEqual({
      permission: { "*": "allow" },
    });
  });

  it("returns no scope when no profile is selected at all", () => {
    const result = resolveProfileScope({
      envProfileName: undefined,
      projectAgentProfileName: undefined,
      agentProfileName: undefined,
      profiles: globalProfiles,
      projectProfiles,
    });
    expect(result.profileScope).toBeUndefined();
    expect(result.invalidProfileName).toBeUndefined();
  });

  it("fails closed when the selection matches neither registry", () => {
    const result = resolveProfileScope({
      envProfileName: undefined,
      projectAgentProfileName: undefined,
      agentProfileName: "missing",
      profiles: globalProfiles,
      projectProfiles,
    });
    expect(result.invalidProfileName).toBe("missing");
    expect(result.profileScope).toEqual({ invalid: true });
  });

  it("fails closed on an empty merged ruleset", () => {
    const result = resolveProfileScope({
      envProfileName: undefined,
      projectAgentProfileName: undefined,
      agentProfileName: "dev",
      profiles: { dev: { permission: {} } },
      projectProfiles: { dev: { permission: {} } },
    });
    expect(result.invalidProfileName).toBe("dev");
    expect(result.profileScope).toEqual({ invalid: true });
  });
});
describe("resolveProfileScopes two-layer resolution", () => {
  it("returns global and trusted project layers in merge order with distinct origins", () => {
    const result = resolveScopes({
      agentProfileName: "dev",
      profiles: globalProfiles,
      projectProfiles,
    });
    expect(result.invalidProfileName).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.scopes.map(([origin]) => origin)).toEqual([
      "profile-global",
      "profile-project",
    ]);
    expect(result.scopes[0][1]).toEqual({
      permission: { "bash/*": "ask", read: "allow", write: "deny" },
    });
    expect(result.scopes[1][1]).toEqual({
      permission: { read: "ask" },
    });
  });

  it("omits the project layer and warns when the project is untrusted", () => {
    const result = resolveScopes({
      agentProfileName: "dev",
      profiles: globalProfiles,
      projectProfiles,
      projectTrusted: false,
    });
    expect(result.invalidProfileName).toBeUndefined();
    expect(result.scopes.map(([origin]) => origin)).toEqual([
      "profile-global",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("project is not trusted");
    expect(result.warnings[0]).toMatch(/defines \d+ permission profiles?/);
  });

  it("fails closed with the selected name when neither layer resolves", () => {
    const result = resolveScopes({
      agentProfileName: "missing",
      profiles: globalProfiles,
      projectProfiles,
    });
    expect(result.scopes).toEqual([]);
    expect(result.invalidProfileName).toBe("missing");
    expect(result.warnings).toEqual([]);
  });

  it("returns empty scopes and no warning when nothing is selected", () => {
    const result = resolveScopes({
      agentProfileName: undefined,
      profiles: globalProfiles,
      projectProfiles,
    });
    expect(result.scopes).toEqual([]);
    expect(result.invalidProfileName).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("resolves a trusted project-only name with a project layer only", () => {
    const result = resolveScopes({
      agentProfileName: "project-only",
      profiles: undefined,
      projectProfiles: {
        "project-only": { permission: { "*": "allow" } },
      },
    });
    expect(result.invalidProfileName).toBeUndefined();
    expect(result.scopes.map(([origin]) => origin)).toEqual([
      "profile-project",
    ]);
    expect(result.warnings).toEqual([]);
  });
});

function resolveScopes(
  selection: Omit<
    Parameters<typeof resolveProfileScopes>[0],
    "envProfileName" | "projectAgentProfileName"
  >,
) {
  return resolveProfileScopes({
    envProfileName: undefined,
    projectAgentProfileName: undefined,
    ...selection,
  });
}
