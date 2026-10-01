/**
 * [fork] Tests for the runtime profile registry (src/fork-profile-registry.ts):
 * registration makes a profile selectable through the session service, user
 * sandbox.json definitions of the same name keep priority, unregistered names
 * behave exactly as before, invalid definitions are rejected atomically at
 * registration time, and nothing is ever written to a configuration file.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import assert from "node:assert/strict";

import registerSandbox from "../src/extension.ts";
import {
  lookupRegisteredSandboxProfile,
  registerSandboxProfiles,
  type SandboxProfileDefinition,
} from "../src/fork-profile-registry.ts";
import { listGlobalSandboxProfiles, loadConfig } from "../src/profile-config.ts";
import { getSandboxService } from "../src/service.ts";

/**
 * The runtime validator is the same one a sandbox.json profile goes through, so
 * it must also reject what the static type would have caught at compile time.
 * This escape hatch feeds intentionally malformed definitions to that layer.
 */
function registerUnchecked(profiles: Record<string, unknown>): void {
  registerSandboxProfiles(profiles as Record<string, SandboxProfileDefinition>);
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
const originalTrust = process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
const roots: string[] = [];

/**
 * The registry is process-global by design; clear it between tests through the
 * documented Symbol.for key so assertions never see another test's leftovers.
 */
const PROFILE_REGISTRY_KEY = Symbol.for("@xzzpig/pi-sandbox/session-profile-registry");

afterEach(() => {
  (globalThis as typeof globalThis & Record<symbol, Map<string, unknown> | undefined>)[
    PROFILE_REGISTRY_KEY
  ]?.clear();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
  else process.env.PI_SUBAGENT_SANDBOX_PROFILE = originalProfile;
  if (originalTrust === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
  else process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = originalTrust;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createWorkspace(options: { profiles?: Record<string, unknown> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-profile-registry-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const sandboxJsonPath = path.join(agentDir, "sandbox.json");
  fs.writeFileSync(
    sandboxJsonPath,
    JSON.stringify({ enabled: false, profiles: options.profiles ?? {} }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { root, cwd, agentDir, sandboxJsonPath };
}

const WRITER_PROFILE = { filesystem: { allowRead: ["."], allowWrite: ["openspec/**"] } };

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

function headlessContext(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionContext;
}

async function startSession(
  handlers: ReturnType<typeof createMockPi>["handlers"],
  ctx: ExtensionContext,
) {
  const startHandler = handlers.get("session_start")?.[0];
  assert.ok(startHandler, "the extension must register a session_start handler");
  await startHandler({ reason: "startup" }, ctx);
}

test("a registered profile is selectable through the session service and applies its policy", async () => {
  // The sandbox stays disabled by configuration, so no OS-level sandbox is
  // needed: selection exercises the "configuration applied, isolation not
  // active" path while still resolving the registered definition.
  const workspace = createWorkspace();
  registerSandboxProfiles({ "opsx-planner": WRITER_PROFILE });

  const { pi, handlers } = createMockPi();
  registerSandbox(pi);
  const sessionId = "registry-session";
  const ctx = headlessContext(workspace.cwd, sessionId);
  await startSession(handlers, ctx);

  const service = getSandboxService(sessionId);
  assert.ok(service, "session_start must publish the sandbox service");
  assert.deepEqual(service.listProfiles(), ["opsx-planner"]);

  const selection = await service.setProfile("opsx-planner");
  assert.equal(selection.ok, true);
  assert.equal(service.getProfile(), "opsx-planner");

  // The registered definition is what resolves: the profile's write boundary
  // replaces the base allowWrite list, and selecting it forces isolation on.
  const config = loadConfig(workspace.cwd, { profileName: "opsx-planner" });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.filesystem?.allowWrite, ["openspec/**"]);
});

test("a user-defined same-name profile wins over the runtime registration", () => {
  const workspace = createWorkspace({
    profiles: { planner: { filesystem: { allowRead: ["."], allowWrite: ["/user-only/**"] } } },
  });
  registerSandboxProfiles({
    planner: { filesystem: { allowRead: ["."], allowWrite: ["/registered-only/**"] } },
  });

  const config = loadConfig(workspace.cwd, { profileName: "planner" });
  assert.deepEqual(config.filesystem?.allowWrite, ["/user-only/**"]);
  assert.ok(!config.filesystem?.allowWrite.includes("/registered-only/**"));

  // The merged listing still shows the name exactly once.
  assert.deepEqual(listGlobalSandboxProfiles(workspace.cwd), ["planner"]);
});

test("a registered profile resolves even when an untrusted project defines the same name", () => {
  const workspace = createWorkspace();
  fs.mkdirSync(path.join(workspace.cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace.cwd, ".pi", "sandbox.json"),
    JSON.stringify({
      profiles: { planner: { filesystem: { allowRead: ["."], allowWrite: ["/project/**"] } } },
    }),
  );
  registerSandboxProfiles({
    planner: { filesystem: { allowRead: ["."], allowWrite: ["/registered/**"] } },
  });

  const warnings: string[] = [];
  const config = loadConfig(workspace.cwd, {
    profileName: "planner",
    projectTrusted: false,
    onWarning: (warning) => warnings.push(warning),
  });
  assert.deepEqual(config.filesystem?.allowWrite, ["/registered/**"]);
  // The untrusted project's registry is still reported as skipped.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /not applied/);
});

test("an unregistered name keeps failing exactly as before", () => {
  const workspace = createWorkspace({ profiles: { "config-only": WRITER_PROFILE } });

  const rejectionOf = (profileName: string): string => {
    try {
      loadConfig(workspace.cwd, { profileName });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return assert.fail(`an unknown profile (${profileName}) must be rejected`);
  };

  const before = rejectionOf("missing");
  assert.match(before, /not defined in the global sandbox configuration/);
  assert.match(before, /Available profiles: config-only/);

  registerSandboxProfiles({ "registered-one": WRITER_PROFILE });

  // Same rejection; the available list simply also names registered profiles.
  const after = rejectionOf("missing");
  assert.match(after, /not defined in the global sandbox configuration/);
  assert.match(after, /Available profiles: config-only/);
  assert.match(after, /registered-one/);
  assert.equal(lookupRegisteredSandboxProfile("missing"), undefined);
});

test("an invalid definition is rejected at registration time and commits nothing", () => {
  const workspace = createWorkspace();
  const valid = WRITER_PROFILE;

  assert.throws(
    () => registerUnchecked({ "../escape": valid }),
    /registered sandbox profile must contain only letters, digits, underscores, or hyphens/,
  );
  assert.throws(
    () => registerUnchecked({ "bad-name": { enabled: false } }),
    /cannot disable the sandbox/,
  );
  assert.throws(
    () => registerUnchecked({ "bad-name": { "unsupported-field": true } }),
    /unsupported field/,
  );
  assert.throws(
    () => registerUnchecked({ "bad-name": { filesystem: { allowWrite: "nope" } } }),
    /must be an array of strings/,
  );
  assert.throws(
    () => registerUnchecked({ "bad-name": { network: { disabled: true } } }),
    /cannot disable network isolation/,
  );

  // Atomic commit: one invalid entry rejects the whole call, so the valid
  // definition in the same record never becomes visible.
  assert.throws(
    () => registerUnchecked({ "bad-name": { enabled: false }, "kept-out": valid }),
    /cannot disable the sandbox/,
  );
  assert.equal(lookupRegisteredSandboxProfile("kept-out"), undefined);
  assert.throws(
    () => loadConfig(workspace.cwd, { profileName: "kept-out" }),
    /not defined in the global sandbox configuration/,
  );
});

test("registering the same name again replaces the previous definition (latter wins)", () => {
  const workspace = createWorkspace();
  registerSandboxProfiles({
    planner: { filesystem: { allowRead: ["."], allowWrite: ["/first/**"] } },
  });
  assert.deepEqual(loadConfig(workspace.cwd, { profileName: "planner" }).filesystem?.allowWrite, [
    "/first/**",
  ]);

  registerSandboxProfiles({
    planner: { filesystem: { allowRead: ["."], allowWrite: ["/second/**"] } },
  });
  assert.deepEqual(loadConfig(workspace.cwd, { profileName: "planner" }).filesystem?.allowWrite, [
    "/second/**",
  ]);
});

test("registration never writes a configuration file", async () => {
  const workspace = createWorkspace();
  const before = fs.readFileSync(workspace.sandboxJsonPath, "utf-8");

  registerSandboxProfiles({
    "opsx-reviewer": { filesystem: { allowRead: ["."], allowWrite: [] } },
  });
  const { pi, handlers } = createMockPi();
  registerSandbox(pi);
  const ctx = headlessContext(workspace.cwd, "persist-session");
  await startSession(handlers, ctx);
  const service = getSandboxService("persist-session");
  assert.ok(service);
  const selection = await service.setProfile("opsx-reviewer");
  assert.equal(selection.ok, true);

  assert.equal(fs.readFileSync(workspace.sandboxJsonPath, "utf-8"), before);
  assert.equal(fs.existsSync(path.join(workspace.cwd, ".pi", "sandbox.json")), false);
  assert.deepEqual(Object.keys(JSON.parse(before).profiles), []);
});

test("registered names are listed alongside the configured ones", () => {
  const workspace = createWorkspace({ profiles: { alpha: WRITER_PROFILE } });
  registerSandboxProfiles({ zulu: WRITER_PROFILE, mike: WRITER_PROFILE });

  assert.deepEqual(listGlobalSandboxProfiles(workspace.cwd), ["alpha", "mike", "zulu"]);
  assert.deepEqual(listGlobalSandboxProfiles(workspace.cwd, { projectTrusted: false }), [
    "alpha",
    "mike",
    "zulu",
  ]);
});
