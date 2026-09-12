import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import { SandboxManager } from "@xzzpig/sandbox-runtime";
import assert from "node:assert/strict";

import registerSandbox from "../src/extension.ts";
import { getSandboxService, listGlobalSandboxProfiles } from "../src/service.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
const originalTrust = process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
const originalInitialize = SandboxManager.initialize;
const originalExitCode = process.exitCode;
const roots: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
  else process.env.PI_SUBAGENT_SANDBOX_PROFILE = originalProfile;
  if (originalTrust === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
  else process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = originalTrust;
  process.exitCode = originalExitCode;
  SandboxManager.initialize = originalInitialize;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createMockPi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    registerFlag() {},
    registerTool() {},
    registerShortcut() {},
    registerCommand() {},
    getFlag() {
      return false;
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

function headlessContext(
  cwd: string,
  sessionId: string,
  statuses: Array<string | undefined> = [],
  mode = "print",
): ExtensionContext {
  return {
    cwd,
    mode,
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify() {},
      setStatus(_key: string, text: string | undefined) {
        statuses.push(text);
      },
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionContext;
}

/**
 * A sandboxed session whose sandbox is disabled by configuration, so profile
 * selection exercises the "configuration applied, isolation not active" path
 * without any OS-level sandbox being available in the test environment.
 */
function createProbe(
  options: {
    profiles?: Record<string, unknown>;
    projectProfiles?: Record<string, unknown>;
    /** Start with the sandbox switch on, so initialization actually runs. */
    enabled?: boolean;
    /** Status line text captured from the session UI. */
    statuses?: Array<string | undefined>;
    /** Session mode; "tui" is what renders the status line. */
    mode?: string;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-service-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "sandbox.json"),
    JSON.stringify({ enabled: options.enabled ?? false, profiles: options.profiles ?? {} }),
  );
  if (options.projectProfiles) {
    fs.writeFileSync(
      path.join(cwd, ".pi", "sandbox.json"),
      JSON.stringify({ profiles: options.projectProfiles }),
    );
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { pi, handlers } = createMockPi();
  registerSandbox(pi);
  const sessionId = `session-${path.basename(root)}`;
  const ctx = headlessContext(
    cwd,
    sessionId,
    options.statuses ?? [],
    options.mode ?? "print",
  );
  return { root, cwd, agentDir, handlers, ctx, sessionId };
}

const STRICT_PROFILE = {
  inheritGlobalConfig: false,
  network: { allowedDomains: [] },
  filesystem: { allowRead: [], allowWrite: [] },
};

async function startSession(
  handlers: ReturnType<typeof createMockPi>["handlers"],
  ctx: ExtensionContext,
) {
  const startHandler = handlers.get("session_start")?.[0];
  assert.ok(startHandler, "the extension must register a session_start handler");
  await startHandler({ reason: "startup" }, ctx);
}

test("selects a valid global profile and reports that isolation is inactive", async () => {
  const probe = createProbe({ profiles: { strict: STRICT_PROFILE } });
  await startSession(probe.handlers, probe.ctx);
  const service = getSandboxService(probe.sessionId);
  assert.ok(service, "session_start must publish the sandbox service");

  assert.deepEqual(service.listProfiles(), ["strict"]);
  assert.equal(service.getProfile(), undefined);

  const result = await service.setProfile("strict");

  assert.equal(result.ok, true);
  assert.match(result.message ?? "", /not enabled/);
  assert.equal(service.getProfile(), "strict");
});

test("rejects malformed and unknown profiles without changing the selection", async () => {
  const probe = createProbe({ profiles: { strict: STRICT_PROFILE } });
  await startSession(probe.handlers, probe.ctx);
  const service = getSandboxService(probe.sessionId);
  assert.ok(service);

  const malformed = await service.setProfile("../escape");
  assert.equal(malformed.ok, false);
  assert.match(malformed.message ?? "", /letters, digits, underscores, or hyphens/);
  assert.equal(service.getProfile(), undefined);

  const unknown = await service.setProfile("missing");
  assert.equal(unknown.ok, false);
  assert.match(unknown.message ?? "", /not defined in the global sandbox configuration/);
  assert.equal(service.getProfile(), undefined);

  await service.setProfile("strict");
  const stillUnknown = await service.setProfile("also-missing");
  assert.equal(stillUnknown.ok, false);
  assert.equal(
    service.getProfile(),
    "strict",
    "a rejected selection must leave the previous one intact",
  );
});

test("clears the selected profile", async () => {
  const probe = createProbe({ profiles: { strict: STRICT_PROFILE } });
  await startSession(probe.handlers, probe.ctx);
  const service = getSandboxService(probe.sessionId);
  assert.ok(service);

  await service.setProfile("strict");
  const cleared = await service.setProfile(undefined);

  assert.equal(cleared.ok, true);
  assert.equal(service.getProfile(), undefined);
});

test("lists only profiles the global configuration defines", () => {
  const probe = createProbe({
    profiles: { strict: STRICT_PROFILE, loose: STRICT_PROFILE },
    projectProfiles: { "project-only": STRICT_PROFILE },
  });

  assert.deepEqual(listGlobalSandboxProfiles(probe.cwd), ["loose", "strict"]);
});

test("scopes the service per session and disposes it on shutdown", async () => {
  const probe = createProbe({ profiles: { strict: STRICT_PROFILE } });
  assert.equal(
    getSandboxService(probe.sessionId),
    undefined,
    "no service exists before session_start",
  );

  await startSession(probe.handlers, probe.ctx);
  assert.ok(getSandboxService(probe.sessionId));
  assert.equal(getSandboxService("some-other-session"), undefined);

  const shutdownHandler = probe.handlers.get("session_shutdown")?.[0];
  assert.ok(shutdownHandler, "the extension must register a session_shutdown handler");
  await shutdownHandler({ reason: "quit" }, probe.ctx);

  assert.equal(getSandboxService(probe.sessionId), undefined);
});

test("keeps a failed profile switch fail-closed and reports it", async () => {
  const probe = createProbe({
    enabled: true,
    profiles: { strict: STRICT_PROFILE, loose: STRICT_PROFILE },
  });
  SandboxManager.initialize = async () => {};
  await startSession(probe.handlers, probe.ctx);
  const service = getSandboxService(probe.sessionId);
  assert.ok(service, "session_start must publish the sandbox service");
  const applied = await service.setProfile("strict");
  assert.equal(applied.ok, true);
  assert.equal(applied.message, undefined);
  assert.equal(service.getProfile(), "strict");

  // The sandbox stops coming up: the requested profile cannot be applied, so
  // the switch must report failure and leave the session on what it was
  // actually running rather than claiming a policy that is not in force.
  SandboxManager.initialize = async () => {
    throw new Error("bwrap is unavailable");
  };
  const failed = await service.setProfile("loose");

  assert.equal(failed.ok, false);
  assert.match(failed.message ?? "", /could not initialize/);
  assert.equal(service.getProfile(), "strict");

  // Fail-closed: the session cannot reach a model turn while the sandbox it was
  // asked to run under is not initialized.
  const inputHandler = probe.handlers.get("input")?.[0];
  assert.ok(inputHandler, "the extension must register an input handler");
  assert.deepEqual(await inputHandler({ text: "hello" }, probe.ctx), {
    action: "handled",
  });
});

test("re-renders the status line from the selected profile's effective config", async () => {
  const statuses: Array<string | undefined> = [];
  const probe = createProbe({
    enabled: true,
    mode: "tui",
    statuses,
    profiles: { strict: STRICT_PROFILE, loose: STRICT_PROFILE },
  });
  SandboxManager.initialize = async () => {};
  await startSession(probe.handlers, probe.ctx);
  const service = getSandboxService(probe.sessionId);
  assert.ok(service);

  // Plain registration uses the base configuration: the default allowWrite list
  // has two entries and no profile suffix.
  const base = statuses.at(-1);
  assert.match(base ?? "", /2 write paths/);
  assert.doesNotMatch(base ?? "", /\(strict\)/);

  await service.setProfile("strict");

  // A named profile replaces the allow list, so the status line must be
  // recomputed: advertising the previous policy's write paths would tell the
  // operator the child can write where the profile forbids it.
  const selected = statuses.at(-1);
  assert.match(selected ?? "", /0 write paths \(strict\)/);

  await service.setProfile(undefined);

  const cleared = statuses.at(-1);
  assert.match(cleared ?? "", /2 write paths/);
  assert.doesNotMatch(cleared ?? "", /\(strict\)/);
});
