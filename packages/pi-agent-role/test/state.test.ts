import { describe, expect, it } from "vitest";

import {
  agentRoleDeclaration,
  clearAgent,
  formatRoleStatus,
  isEmptyRole,
  resolveEffectiveRole,
  selectAgent,
  selectPermissionProfile,
  selectSandboxProfile,
  type RoleSelection,
} from "../src/state.ts";

describe("role selection", () => {
  it("starts empty", () => {
    expect(isEmptyRole({})).toBe(true);
    expect(isEmptyRole({ agentName: "worker" })).toBe(false);
  });

  it("drops explicit profile overrides when a new agent is adopted", () => {
    const withProfiles: RoleSelection = {
      sandboxProfile: "strict",
      permissionProfile: "locked",
    };

    const next = selectAgent("worker");

    expect(next).toEqual({ agentName: "worker" });
    // The previous selection is untouched: callers replace, never mutate.
    expect(withProfiles).toEqual({
      sandboxProfile: "strict",
      permissionProfile: "locked",
    });
    expect(
      resolveEffectiveRole(next, { sandboxProfile: "agent-declared" }),
    ).toEqual({
      agentName: "worker",
      sandboxProfile: "agent-declared",
    });
  });

  it("clears the agent while keeping explicit profile selections", () => {
    const selection = selectSandboxProfile(selectAgent("worker"), "strict");

    const cleared = clearAgent(selection);

    expect(cleared).toEqual({ sandboxProfile: "strict" });
  });

  it("sets and clears explicit profiles independently", () => {
    const withSandbox = selectSandboxProfile({}, "strict");
    expect(withSandbox).toEqual({ sandboxProfile: "strict" });

    const withBoth = selectPermissionProfile(withSandbox, "locked");
    expect(withBoth).toEqual({
      sandboxProfile: "strict",
      permissionProfile: "locked",
    });

    expect(selectSandboxProfile(withBoth, undefined)).toEqual({
      permissionProfile: "locked",
    });
    expect(selectPermissionProfile(withBoth, undefined)).toEqual({
      sandboxProfile: "strict",
    });
  });
});

describe("effective role resolution", () => {
  it("prefers an explicit selection over the agent declaration", () => {
    const effective = resolveEffectiveRole(
      { agentName: "worker", sandboxProfile: "explicit-sandbox" },
      {
        sandboxProfile: "declared-sandbox",
        permissionProfile: "declared-permission",
      },
    );

    expect(effective).toEqual({
      agentName: "worker",
      sandboxProfile: "explicit-sandbox",
      permissionProfile: "declared-permission",
    });
  });

  it("falls back to the agent declaration and then to nothing", () => {
    expect(
      resolveEffectiveRole(
        { agentName: "worker" },
        { sandboxProfile: "declared" },
      ),
    ).toEqual({
      agentName: "worker",
      sandboxProfile: "declared",
    });
    expect(resolveEffectiveRole({ agentName: "worker" })).toEqual({
      agentName: "worker",
    });
    expect(resolveEffectiveRole({})).toEqual({});
  });

  it("reads declarations from an agent config shape without inventing values", () => {
    expect(
      agentRoleDeclaration({ sandbox: "strict", permissionProfile: "locked" }),
    ).toEqual({
      sandboxProfile: "strict",
      permissionProfile: "locked",
    });
    expect(agentRoleDeclaration({})).toEqual({});
  });
});

describe("role footer text", () => {
  it("is absent when there is no role", () => {
    expect(formatRoleStatus({})).toBeUndefined();
  });

  it("labels the adopted agent and hides its profile detail", () => {
    expect(formatRoleStatus({ agentName: "worker" })).toBe("role: worker");
    expect(
      formatRoleStatus({
        agentName: "worker",
        sandboxProfile: "strict",
        permissionProfile: "locked",
      }),
    ).toBe("role: worker");
  });

  it("names hand-picked profiles when no agent is adopted", () => {
    expect(formatRoleStatus({ sandboxProfile: "strict" })).toBe(
      "role: sandbox strict",
    );
    expect(formatRoleStatus({ permissionProfile: "locked" })).toBe(
      "role: perm locked",
    );
    expect(
      formatRoleStatus({
        sandboxProfile: "strict",
        permissionProfile: "locked",
      }),
    ).toBe("role: sandbox strict · perm locked");
  });
});
