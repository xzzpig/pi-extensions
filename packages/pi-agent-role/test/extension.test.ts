import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerSandboxService } from "@xzzpig/pi-sandbox/service";

import { PERMISSION_PROFILE_ENV } from "../src/broadcast.ts";
import registerAgentRoleExtension from "../src/extension.ts";

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: { name?: unknown };
}

const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(() => {
  delete process.env[PERMISSION_PROFILE_ENV];
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * Point the global agent dir at a temp dir holding a pi-permission-system
 * config, so profile-name validation sees the same registry a user would have.
 */
function useAgentDir(config: Record<string, unknown>): string {
  const root = tempRoot("pi-agent-role-agent-");
  const dir = path.join(root, "extensions", "pi-permission-system");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  process.env.PI_CODING_AGENT_DIR = root;
  return root;
}

interface HarnessOptions {
  cwd?: string;
  entries?: SessionEntryLike[];
  trusted?: boolean;
  hasUI?: boolean;
  mode?: string;
  statusThrows?: boolean;
  /** Value the picker resolves with; omit to simulate a cancelled picker. */
  pick?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const commands = new Map<
    string,
    {
      description?: string;
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    }
  >();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notified: Array<{ message: string; type: string }> = [];
  const statuses: Array<string | undefined> = [];

  const pi = {
    appendEntry(customType: string, data?: unknown) {
      appended.push({ customType, data });
    },
    registerCommand(
      name: string,
      definition: {
        description?: string;
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      },
    ) {
      commands.set(name, definition);
    },
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: options.cwd ?? tempRoot("pi-agent-role-project-"),
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => options.trusted ?? false,
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionId: () => "session-1",
    },
    ui: {
      notify(message: string, type: string) {
        notified.push({ message, type });
      },
      setStatus(_key: string, text: string | undefined) {
        if (options.statusThrows) throw new Error("no theme available");
        statuses.push(text);
      },
      // The picker UI itself is covered by ui.test.ts; here only the command
      // flow matters, so the dialog resolves with the scripted choice (or a
      // cancelled picker when none is scripted).
      custom: () => Promise.resolve(options.pick),
    },
  } as unknown as ExtensionContext;

  registerAgentRoleExtension(pi);
  return { pi, ctx, handlers, commands, appended, notified, statuses };
}

async function runSessionStart(
  harness: ReturnType<typeof createHarness>,
  reason = "startup",
): Promise<void> {
  const handler = harness.handlers.get("session_start")?.[0];
  expect(handler).toBeDefined();
  await handler?.({ reason }, harness.ctx);
}

function writeProjectAgent(cwd: string, name: string): void {
  const dir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Project helper\n---\n\nProject prompt.\n`,
  );
}

describe("session role extension", () => {
  it("clears an active_agent identity left by an earlier session", async () => {
    const harness = createHarness({
      entries: [
        {
          type: "custom",
          customType: "active_agent",
          data: { name: "worker" },
        },
      ],
    });

    await runSessionStart(harness);

    expect(harness.appended).toEqual([
      { customType: "active_agent", data: { name: null } },
    ]);
  });

  it("does not write an identity entry when none was persisted", async () => {
    const harness = createHarness({
      entries: [{ type: "message" }, { type: "custom", customType: "other" }],
    });

    await runSessionStart(harness);

    expect(harness.appended).toEqual([]);
  });

  it("leaves an already-cleared identity alone", async () => {
    const harness = createHarness({
      entries: [
        {
          type: "custom",
          customType: "active_agent",
          data: { name: "worker" },
        },
        { type: "custom", customType: "active_agent", data: { name: null } },
      ],
    });

    await runSessionStart(harness);

    expect(harness.appended).toEqual([]);
  });
});

describe("role commands", () => {
  it("applies an explicit permission profile without a trust gate", async () => {
    useAgentDir({ profiles: { locked: { permission: { write: "deny" } } } });
    const harness = createHarness({ trusted: false });
    const command = harness.commands.get("permission-profile");
    expect(command).toBeDefined();

    await command?.handler("locked", harness.ctx);

    expect(process.env[PERMISSION_PROFILE_ENV]).toBe("locked");
    expect(harness.appended).toEqual([
      { customType: "active_agent", data: { name: null } },
    ]);
    expect(harness.notified).toEqual([]);
    expect(harness.statuses.at(-1)).toBe("role: perm locked");
  });

  it("rejects an unknown permission profile before touching the selection", async () => {
    useAgentDir({ profiles: { locked: { permission: { write: "deny" } } } });
    const harness = createHarness();
    const command = harness.commands.get("permission-profile");

    await command?.handler("not-a-profile", harness.ctx);

    expect(process.env[PERMISSION_PROFILE_ENV]).toBeUndefined();
    expect(harness.appended).toEqual([]);
    expect(harness.statuses).toEqual([]);
    expect(harness.notified).toEqual([
      {
        message: expect.stringContaining(
          "Unknown permission profile",
        ) as string,
        type: "error",
      },
    ]);
  });

  it("clears the permission profile with the none keyword", async () => {
    useAgentDir({ profiles: { locked: { permission: { write: "deny" } } } });
    const harness = createHarness();
    const command = harness.commands.get("permission-profile");
    process.env[PERMISSION_PROFILE_ENV] = "locked";

    await command?.handler("none", harness.ctx);

    expect(process.env[PERMISSION_PROFILE_ENV]).toBeUndefined();
    expect(harness.statuses.at(-1)).toBeUndefined();
  });

  it("rejects a project-scoped agent while the project is untrusted", async () => {
    const home = tempRoot("pi-agent-role-home-");
    process.env.HOME = home;
    const cwd = tempRoot("pi-agent-role-untrusted-");
    writeProjectAgent(cwd, "project-helper");
    const harness = createHarness({ cwd, trusted: false });
    const command = harness.commands.get("role");

    await command?.handler("project-helper", harness.ctx);

    expect(harness.appended).toEqual([]);
    expect(harness.notified).toEqual([
      {
        message: expect.stringContaining("not trusted") as string,
        type: "error",
      },
    ]);
  });

  it("adopts a project-scoped agent once the project is trusted", async () => {
    const home = tempRoot("pi-agent-role-home-");
    process.env.HOME = home;
    const cwd = tempRoot("pi-agent-role-trusted-");
    writeProjectAgent(cwd, "project-helper");
    const harness = createHarness({ cwd, trusted: true });
    const command = harness.commands.get("role");

    await command?.handler("project-helper", harness.ctx);

    expect(harness.appended).toEqual([
      { customType: "active_agent", data: { name: "project-helper" } },
    ]);
    expect(harness.notified).toEqual([]);
    expect(harness.statuses.at(-1)).toBe("role: project-helper");
  });

  it("clears an adopted agent with the none argument", async () => {
    const home = tempRoot("pi-agent-role-home-");
    process.env.HOME = home;
    const cwd = tempRoot("pi-agent-role-clear-");
    writeProjectAgent(cwd, "project-helper");
    const harness = createHarness({ cwd, trusted: true });
    const command = harness.commands.get("role");

    await command?.handler("project-helper", harness.ctx);
    await command?.handler("none", harness.ctx);

    expect(harness.appended).toEqual([
      { customType: "active_agent", data: { name: "project-helper" } },
      { customType: "active_agent", data: { name: null } },
    ]);
    expect(harness.notified).toEqual([]);
    expect(harness.statuses.at(-1)).toBeUndefined();
  });

  it("reports an unknown agent reference", async () => {
    const home = tempRoot("pi-agent-role-home-");
    process.env.HOME = home;
    const harness = createHarness({ trusted: true });
    const command = harness.commands.get("role");

    await command?.handler("does-not-exist", harness.ctx);

    expect(harness.appended).toEqual([]);
    expect(harness.notified).toEqual([
      {
        message: expect.stringContaining("Unknown agent") as string,
        type: "error",
      },
    ]);
  });

  it("refuses to pick a role without a UI", async () => {
    const harness = createHarness({ hasUI: false });
    const command = harness.commands.get("role");

    await command?.handler("", harness.ctx);

    expect(harness.notified).toEqual([
      {
        message: expect.stringContaining("interactive session") as string,
        type: "warning",
      },
    ]);
  });
});

describe("role footer status", () => {
  it("clears the status when a session starts with no role", async () => {
    const harness = createHarness();

    await runSessionStart(harness);

    expect(harness.statuses).toEqual([undefined]);
  });

  it("skips the footer outside the interactive mode", async () => {
    useAgentDir({ profiles: { locked: { permission: { write: "deny" } } } });
    const harness = createHarness({ mode: "print" });
    const command = harness.commands.get("permission-profile");

    await command?.handler("locked", harness.ctx);

    expect(process.env[PERMISSION_PROFILE_ENV]).toBe("locked");
    expect(harness.statuses).toEqual([]);
  });

  it("tolerates a failing status write", async () => {
    useAgentDir({ profiles: { locked: { permission: { write: "deny" } } } });
    const harness = createHarness({ statusThrows: true });
    const command = harness.commands.get("permission-profile");

    await command?.handler("locked", harness.ctx);

    expect(process.env[PERMISSION_PROFILE_ENV]).toBe("locked");
    expect(harness.notified).toEqual([]);
  });
});

describe("picker flows and sandbox profile selection", () => {
  it("adopts the agent chosen in the /role picker", async () => {
    const home = tempRoot("pi-agent-role-home-");
    process.env.HOME = home;
    const cwd = tempRoot("pi-agent-role-picker-");
    writeProjectAgent(cwd, "project-helper");
    const harness = createHarness({
      cwd,
      trusted: true,
      pick: "project-helper",
    });
    const command = harness.commands.get("role");

    await command?.handler("", harness.ctx);

    expect(harness.appended).toEqual([
      { customType: "active_agent", data: { name: "project-helper" } },
    ]);
    expect(harness.statuses.at(-1)).toBe("role: project-helper");
  });

  it("does nothing when the picker is cancelled", async () => {
    const home = tempRoot("pi-agent-role-home-");
    process.env.HOME = home;
    const cwd = tempRoot("pi-agent-role-cancel-");
    writeProjectAgent(cwd, "project-helper");
    const harness = createHarness({ cwd, trusted: true });
    const command = harness.commands.get("role");

    await command?.handler("", harness.ctx);

    expect(harness.appended).toEqual([]);
    expect(harness.statuses).toEqual([]);
  });

  it("applies a known sandbox profile through the session service", async () => {
    const root = tempRoot("pi-agent-role-sandbox-");
    const calls: Array<string | undefined> = [];
    const dispose = registerSandboxService("session-1", {
      getProfile: () => undefined,
      setProfile: async (profileName) => {
        calls.push(profileName);
        return { ok: true };
      },
      listProfiles: () => ["role-strict"],
    });
    try {
      const harness = createHarness({ cwd: root });
      const command = harness.commands.get("sandbox-profile");

      await command?.handler("role-strict", harness.ctx);

      expect(calls).toEqual(["role-strict"]);
      expect(harness.notified).toEqual([]);
      expect(harness.statuses.at(-1)).toBe("role: sandbox role-strict");
    } finally {
      dispose();
    }
  });

  it("rejects an unknown sandbox profile before touching the selection", async () => {
    const root = tempRoot("pi-agent-role-sandbox-");
    const calls: Array<string | undefined> = [];
    const dispose = registerSandboxService("session-1", {
      getProfile: () => undefined,
      setProfile: async (profileName) => {
        calls.push(profileName);
        return { ok: true };
      },
      listProfiles: () => ["role-strict"],
    });
    try {
      const harness = createHarness({ cwd: root });
      const command = harness.commands.get("sandbox-profile");

      await command?.handler("bogus", harness.ctx);

      expect(calls).toEqual([]);
      expect(harness.statuses).toEqual([]);
      expect(harness.notified).toEqual([
        {
          message: expect.stringContaining("Unknown sandbox profile") as string,
          type: "error",
        },
      ]);
    } finally {
      dispose();
    }
  });

  it("reports an unavailable pi-sandbox instead of pretending to apply a profile", async () => {
    const harness = createHarness();
    const command = harness.commands.get("sandbox-profile");

    await command?.handler("role-strict", harness.ctx);

    expect(harness.statuses).toEqual([]);
    expect(harness.notified).toEqual([
      {
        message: expect.stringContaining(
          "pi-sandbox is not available",
        ) as string,
        type: "error",
      },
    ]);
  });
});
