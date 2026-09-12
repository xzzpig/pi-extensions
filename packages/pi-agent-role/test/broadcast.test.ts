import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyRoleSelection,
  PERMISSION_PROFILE_ENV,
  roleTrustError,
} from "../src/broadcast.ts";
import type { SandboxServiceLike } from "../src/sandbox-service.ts";

afterEach(() => {
  delete process.env[PERMISSION_PROFILE_ENV];
});

function makeHarness() {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/pi-agent-role-project",
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as ExtensionContext;
  return { pi, ctx, appended };
}

describe("role broadcast", () => {
  it("appends the agent identity and clears a stale permission profile", async () => {
    const { pi, ctx, appended } = makeHarness();
    process.env[PERMISSION_PROFILE_ENV] = "stale";

    const outcome = await applyRoleSelection(
      pi,
      ctx,
      { agentName: "worker" },
      { agentName: "worker" },
      async () => undefined,
    );

    expect(appended).toEqual([
      { customType: "active_agent", data: { name: "worker" } },
    ]);
    expect(process.env[PERMISSION_PROFILE_ENV]).toBeUndefined();
    expect(outcome).toEqual({ ok: true, notices: [] });
  });

  it("clears the identity and writes the permission profile environment", async () => {
    const { pi, ctx, appended } = makeHarness();

    const outcome = await applyRoleSelection(
      pi,
      ctx,
      {},
      { permissionProfile: "locked" },
      async () => undefined,
    );

    expect(appended).toEqual([
      { customType: "active_agent", data: { name: null } },
    ]);
    expect(process.env[PERMISSION_PROFILE_ENV]).toBe("locked");
    expect(outcome.ok).toBe(true);
  });

  it("reports an error when a sandbox profile is selected but pi-sandbox is unavailable", async () => {
    const { pi, ctx } = makeHarness();

    const outcome = await applyRoleSelection(
      pi,
      ctx,
      { sandboxProfile: "strict" },
      { sandboxProfile: "strict" },
      async () => undefined,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.notices).toEqual([
      {
        message: expect.stringContaining("pi-sandbox is unavailable") as string,
        severity: "error",
      },
    ]);
  });

  it("applies the effective sandbox profile through the session service", async () => {
    const { pi, ctx } = makeHarness();
    const calls: Array<string | undefined> = [];
    const service: SandboxServiceLike = {
      setProfile: async (profileName) => {
        calls.push(profileName);
        return { ok: true };
      },
    };

    const outcome = await applyRoleSelection(
      pi,
      ctx,
      {},
      { sandboxProfile: "strict" },
      async () => service,
    );

    expect(calls).toEqual(["strict"]);
    expect(outcome).toEqual({ ok: true, notices: [] });
  });

  it("surfaces a rejected sandbox profile as an error notice", async () => {
    const { pi, ctx } = makeHarness();

    const outcome = await applyRoleSelection(
      pi,
      ctx,
      { sandboxProfile: "missing" },
      { sandboxProfile: "missing" },
      async () => ({
        setProfile: async () => ({
          ok: false,
          message: "profile is not defined",
        }),
      }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.notices).toEqual([
      { message: "profile is not defined", severity: "error" },
    ]);
  });

  it("reports the sandbox-disabled warning without failing the role", async () => {
    const { pi, ctx } = makeHarness();

    const outcome = await applyRoleSelection(
      pi,
      ctx,
      { sandboxProfile: "strict" },
      { sandboxProfile: "strict" },
      async () => ({
        setProfile: async () => ({
          ok: true,
          message:
            "Sandbox profile 'strict' is selected, but the sandbox is not enabled for this session, so no isolation is active.",
        }),
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.notices[0]?.severity).toBe("warning");
  });

  it("surfaces an appendEntry failure instead of dropping it", async () => {
    const pi = {
      appendEntry() {
        throw new Error("session is read-only");
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/tmp",
      sessionManager: { getSessionId: () => "session-1" },
    } as unknown as ExtensionContext;

    const outcome = await applyRoleSelection(
      pi,
      ctx,
      { agentName: "worker" },
      { agentName: "worker" },
      async () => undefined,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.notices).toEqual([
      {
        message: expect.stringContaining("session is read-only") as string,
        severity: "error",
      },
    ]);
  });
});

describe("role trust gate", () => {
  it("rejects a project-scoped agent in an untrusted project", () => {
    expect(
      roleTrustError({ name: "project-helper", projectScoped: true }, false),
    ).toMatch(/not trusted/);
  });

  it("allows a project-scoped agent in a trusted project", () => {
    expect(
      roleTrustError({ name: "project-helper", projectScoped: true }, true),
    ).toBeUndefined();
  });

  it("never gates non-project agents", () => {
    expect(
      roleTrustError({ name: "worker", projectScoped: false }, false),
    ).toBeUndefined();
  });
});
