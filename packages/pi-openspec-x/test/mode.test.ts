/**
 * Restricted-mode activation channel tests (design D4).
 *
 * Driven through a fake pi (capturing appendEntry) and an injectable service
 * locator, asserting the event sequences: enter → identity entry + profile
 * set; exit → cleanup + profile restore; session_start → stale entry nulled;
 * missing dependency → typed OpsxDependencyMissingError with nothing applied.
 *
 * The `active_agent` entry shape is pinned to pi-agent-role's contract
 * (`{ name: string | null }` under customType "active_agent") — /role and
 * pi-permission-system interop depends on it.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  OpsxDependencyMissingError,
  probeSandboxDependency,
  resetDependencyStateForTests,
  type SandboxServiceLike,
} from "../src/dependencies.ts";
import {
  ACTIVE_AGENT_ENTRY_TYPE,
  createOpsxSessionStartHandler,
  enterOpsxMode,
  exitOpsxMode,
} from "../src/mode.ts";

beforeEach(() => {
  resetDependencyStateForTests();
});

interface RecordedEntry {
  customType: string;
  data: unknown;
}

function createFakePi(options: { appendEntryError?: Error } = {}) {
  const entries: RecordedEntry[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      if (options.appendEntryError) throw options.appendEntryError;
      entries.push({ customType, data });
    },
    on: vi.fn(() => () => {}),
  };
  return { pi: pi as unknown as ExtensionAPI, entries };
}

function createFakeService(
  behavior: { ok?: boolean; message?: string } = {},
): SandboxServiceLike & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    async setProfile(profileName) {
      calls.push(profileName);
      return { ok: behavior.ok ?? true, message: behavior.message };
    },
  };
}

/** Probe the real dependency state with a fake pi-sandbox module. */
async function probeWith(service: SandboxServiceLike | undefined) {
  const probe = await probeSandboxDependency(async () => ({
    registerSandboxProfiles() {},
    getSandboxService: () => service,
  }));
  if (!probe.available) throw new Error("fake module probe must succeed");
  return probe;
}

function sessionContext(entries: unknown[]): ExtensionContext {
  return {
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext;
}

function activeAgentEntry(name: string | null): unknown {
  return {
    type: "custom",
    customType: ACTIVE_AGENT_ENTRY_TYPE,
    data: { name },
  };
}

describe("enterOpsxMode", () => {
  test("entering planner records the identity entry and sets the opsx-planner profile", async () => {
    const service = createFakeService();
    await probeWith(service);
    const { pi, entries } = createFakePi();

    const outcome = await enterOpsxMode(pi, "planner");

    expect(outcome.ok).toBe(true);
    expect(outcome.notices).toEqual([]);
    expect(entries).toEqual([
      { customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: "opsx-planner" } },
    ]);
    expect(service.calls).toEqual(["opsx-planner"]);
  });

  test("entering agent mode uses the opsx-agent identity and profile", async () => {
    const service = createFakeService();
    await probeWith(service);
    const { pi, entries } = createFakePi();

    await enterOpsxMode(pi, "agent");

    expect(entries).toEqual([
      { customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: "opsx-agent" } },
    ]);
    expect(service.calls).toEqual(["opsx-agent"]);
  });

  test("a selection warning (sandbox switch off) surfaces as a notice, mode still entered", async () => {
    const service = createFakeService({
      ok: true,
      message: "Selection recorded, but the sandbox is currently disabled.",
    });
    await probeWith(service);
    const { pi, entries } = createFakePi();

    const outcome = await enterOpsxMode(pi, "planner");

    expect(outcome.ok).toBe(true);
    expect(outcome.notices).toEqual([
      {
        message: "Selection recorded, but the sandbox is currently disabled.",
        severity: "warning",
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(service.calls).toEqual(["opsx-planner"]);
  });

  test("missing dependency: typed error before anything is applied", async () => {
    // No probe ran: the recorded state is "unavailable".
    const { pi, entries } = createFakePi();

    const error = await enterOpsxMode(pi, "planner").then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(OpsxDependencyMissingError);
    expect((error as Error).message).toContain("@xzzpig/pi-sandbox");
    expect((error as Error).message).toMatch(/fail-closed/i);
    expect(entries).toEqual([]);
  });

  test("module available but no session service: typed error with the reason", async () => {
    await probeWith(undefined);
    const { pi, entries } = createFakePi();

    const error = await enterOpsxMode(pi, "agent").then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(OpsxDependencyMissingError);
    expect((error as OpsxDependencyMissingError).reason).toContain(
      "no sandbox service is published for this session",
    );
    expect(entries).toEqual([]);
  });

  test("rejected profile: refusal error and no identity entry", async () => {
    const service = createFakeService({
      ok: false,
      message: "profile cannot disable the sandbox",
    });
    await probeWith(service);
    const { pi, entries } = createFakePi();

    await expect(enterOpsxMode(pi, "planner")).rejects.toThrow(
      /was rejected; refusing to enter restricted mode .*fail-closed/s,
    );
    expect(entries).toEqual([]);
    expect(service.calls).toEqual(["opsx-planner"]);
  });

  test("failing service call: refusal error and no identity entry", async () => {
    const service: SandboxServiceLike = {
      async setProfile() {
        throw new Error("service exploded");
      },
    };
    await probeWith(service);
    const { pi, entries } = createFakePi();

    await expect(enterOpsxMode(pi, "planner")).rejects.toThrow(
      /could not be applied; refusing to enter restricted mode/s,
    );
    expect(entries).toEqual([]);
  });

  test("identity write failure: the profile is rolled back before throwing", async () => {
    const service = createFakeService();
    await probeWith(service);
    const { pi } = createFakePi({
      appendEntryError: new Error("session is read-only"),
    });

    await expect(enterOpsxMode(pi, "planner")).rejects.toThrow(
      /Could not record the opsx-planner session identity: session is read-only/,
    );
    // Profile applied, then rolled back to the session default.
    expect(service.calls).toEqual(["opsx-planner", undefined]);
  });

  test("an injected loadService bypasses the recorded module lookup", async () => {
    const service = createFakeService();
    const { pi, entries } = createFakePi();
    // Dependency never probed, yet the injected locator answers: the gate
    // still refuses — restricted modes require the probed dependency.
    await expect(
      enterOpsxMode(pi, "planner", { loadService: async () => service }),
    ).rejects.toBeInstanceOf(OpsxDependencyMissingError);
    expect(entries).toEqual([]);
  });

  test("the session id from deps reaches the default service locator", async () => {
    const service = createFakeService();
    const probe = await probeWith(service);
    const module = probe.module as unknown as {
      getSandboxService: (id?: string) => unknown;
    };
    const seen: Array<string | undefined> = [];
    const original = module.getSandboxService;
    module.getSandboxService = (id?: string) => {
      seen.push(id);
      return original(id);
    };
    const { pi } = createFakePi();

    await enterOpsxMode(pi, "planner", { sessionId: () => "session-7" });

    expect(seen).toEqual(["session-7"]);
  });
});

describe("exitOpsxMode", () => {
  test("exiting nulls the identity entry and clears the sandbox profile", async () => {
    const service = createFakeService();
    await probeWith(service);
    const { pi, entries } = createFakePi();

    await enterOpsxMode(pi, "planner");
    const outcome = await exitOpsxMode(pi);

    expect(outcome.ok).toBe(true);
    expect(outcome.notices).toEqual([]);
    expect(entries).toEqual([
      { customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: "opsx-planner" } },
      { customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: null } },
    ]);
    expect(service.calls).toEqual(["opsx-planner", undefined]);
  });

  test("exiting without a dependency never throws and reports the gap", async () => {
    const { pi, entries } = createFakePi();

    const outcome = await exitOpsxMode(pi);

    expect(outcome.ok).toBe(true);
    expect(outcome.notices).toEqual([
      {
        message: expect.stringContaining("pi-sandbox is unavailable"),
        severity: "warning",
      },
    ]);
    expect(entries).toEqual([
      { customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: null } },
    ]);
  });

  test("a failed profile clear is reported as an error notice", async () => {
    const service = createFakeService({ ok: false, message: "nope" });
    await probeWith(service);
    const { pi } = createFakePi();

    const outcome = await exitOpsxMode(pi);

    expect(outcome.ok).toBe(false);
    expect(outcome.notices).toEqual([{ message: "nope", severity: "error" }]);
  });
});

describe("session_start stale identity cleanup", () => {
  test("a stale opsx identity at the branch tail is nulled", () => {
    const { pi, entries } = createFakePi();
    const ctx = sessionContext([
      { type: "message", role: "user" },
      activeAgentEntry("opsx-planner"),
      { type: "message", role: "assistant" },
    ]);

    createOpsxSessionStartHandler(pi)(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    expect(entries).toEqual([
      { customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: null } },
    ]);
  });

  test("a tail identity that is already null stays untouched", () => {
    const { pi, entries } = createFakePi();
    const ctx = sessionContext([
      activeAgentEntry("opsx-agent"),
      activeAgentEntry(null),
    ]);

    createOpsxSessionStartHandler(pi)(
      { type: "session_start", reason: "startup" },
      ctx,
    );

    expect(entries).toEqual([]);
  });

  test("no persisted identity means no cleanup entry", () => {
    const { pi, entries } = createFakePi();
    const ctx = sessionContext([{ type: "message", role: "user" }]);

    createOpsxSessionStartHandler(pi)(
      { type: "session_start", reason: "new" },
      ctx,
    );

    expect(entries).toEqual([]);
  });

  test("only the tail entry decides: an older named entry behind a null stays", () => {
    const { pi, entries } = createFakePi();
    const ctx = sessionContext([
      activeAgentEntry("opsx-planner"),
      activeAgentEntry(null),
      { type: "message", role: "user" },
    ]);

    createOpsxSessionStartHandler(pi)(
      { type: "session_start", reason: "fork" },
      ctx,
    );

    expect(entries).toEqual([]);
  });

  test("an unreadable session is survived without cleanup", () => {
    const { pi, entries } = createFakePi();
    const ctx = {
      sessionManager: {
        getEntries: () => {
          throw new Error("unreadable");
        },
      },
    } as unknown as ExtensionContext;

    expect(() =>
      createOpsxSessionStartHandler(pi)(
        { type: "session_start", reason: "startup" },
        ctx,
      ),
    ).not.toThrow();
    expect(entries).toEqual([]);
  });
});
