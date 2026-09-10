import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import { SandboxManager } from "@xzzpig/sandbox-runtime";
import assert from "node:assert/strict";

import registerSandbox from "../src/extension.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
const originalTrust = process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
const originalStartupAckPath = process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH;
const originalStartupAckToken = process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN;
const originalInProcessChild = process.env.PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD;
const originalDiagnosticsPath = process.env.PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH;
const originalExitCode = process.exitCode;
const originalInitialize = SandboxManager.initialize;
const roots: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
  else process.env.PI_SUBAGENT_SANDBOX_PROFILE = originalProfile;
  if (originalTrust === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
  else process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = originalTrust;
  if (originalStartupAckPath === undefined) delete process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH;
  else process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH = originalStartupAckPath;
  if (originalStartupAckToken === undefined)
    delete process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN;
  else process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN = originalStartupAckToken;
  if (originalInProcessChild === undefined) delete process.env.PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD;
  else process.env.PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD = originalInProcessChild;
  if (originalDiagnosticsPath === undefined)
    delete process.env.PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH;
  else process.env.PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH = originalDiagnosticsPath;
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
  return { pi, handlers };
}

function headlessContext(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => false,
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionContext;
}

test("a headless child applies a valid global profile and blocks unapproved reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-profile-enforcement-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const projectOnlyPath = path.join(cwd, "project-only");
  const deniedReadPath = path.join(cwd, "blocked-secret.txt");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "sandbox.json"),
    JSON.stringify({
      profiles: {
        strict: {
          inheritGlobalConfig: false,
          network: { allowedDomains: [] },
          filesystem: { allowRead: [cwd], denyRead: [deniedReadPath], allowWrite: [] },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(cwd, ".pi", "sandbox.json"),
    JSON.stringify({
      filesystem: { allowRead: [projectOnlyPath] },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_SANDBOX_PROFILE = "strict";
  process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = "invalid";
  const startupAckPath = path.join(root, "sandbox-profile-startup.json");
  const startupAckToken = "profile-startup-token";
  process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH = startupAckPath;
  process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN = startupAckToken;

  let initializedConfig: { filesystem?: { allowRead?: string[] } } | undefined;
  SandboxManager.initialize = async (config) => {
    initializedConfig = config;
  };

  const { pi, handlers } = createMockPi();
  registerSandbox(pi as never);
  const ctx = {
    ...headlessContext(cwd),
    isProjectTrusted: () => true,
  };
  const sessionStart = handlers.get("session_start")?.[0];
  const toolCall = handlers.get("tool_call")?.[0];
  assert.ok(sessionStart);
  assert.ok(toolCall);
  await sessionStart!({ reason: "startup" }, ctx);

  assert.deepEqual(JSON.parse(fs.readFileSync(startupAckPath, "utf-8")), {
    version: 1,
    profile: "strict",
    token: startupAckToken,
  });
  assert.equal(initializedConfig?.filesystem?.allowRead?.includes(projectOnlyPath), false);
  const readResult = (await toolCall!(
    { toolName: "read", toolCallId: "read-1", input: { path: deniedReadPath } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.equal(readResult?.block, true);
  assert.match(
    readResult?.reason ?? "",
    /Sandbox profile 'strict'.*read access denied.*in denyRead/,
  );

  const networkResult = (await toolCall!(
    {
      toolName: "bash",
      toolCallId: "bash-1",
      input: { command: "curl https://blocked.example.com" },
    },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.equal(networkResult?.block, true);
  assert.match(
    networkResult?.reason ?? "",
    /Sandbox profile 'strict'.*Network access to "blocked.example.com"/,
  );

  const writeResult = (await toolCall!(
    {
      toolName: "write",
      toolCallId: "write-1",
      input: { path: path.join(cwd, "blocked.txt"), content: "blocked" },
    },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.equal(writeResult?.block, true);
  assert.match(writeResult?.reason ?? "", /Sandbox profile 'strict'.*write access denied/);
});

test("a headless child with an unresolved sandbox profile blocks before its first model turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-profile-runtime-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_SANDBOX_PROFILE = "missing-profile";
  process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = "0";
  const diagnosticsPath = path.join(root, "sandbox-startup-diagnostic.json");
  process.env.PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH = diagnosticsPath;

  const { pi, handlers } = createMockPi();
  registerSandbox(pi as never);
  const ctx = headlessContext(cwd);
  const sessionStart = handlers.get("session_start")?.[0];
  const input = handlers.get("input")?.[0];
  const toolCall = handlers.get("tool_call")?.[0];

  assert.ok(sessionStart);
  assert.ok(input);
  assert.ok(toolCall);
  await sessionStart!({ reason: "startup" }, ctx);

  // The blocked child publishes why it refused to start, so the launcher can
  // report the profile instead of an invented empty-output model failure.
  const diagnostic = JSON.parse(fs.readFileSync(diagnosticsPath, "utf-8"));
  assert.equal(diagnostic.version, 1);
  assert.equal(diagnostic.profile, "missing-profile");
  assert.match(diagnostic.reason, /Sandbox profile 'missing-profile'.*not defined/);

  const inputResult = input!({ text: "Task: inspect" }, ctx);
  assert.deepEqual(inputResult, { action: "handled" });
  assert.equal(process.exitCode, 1);

  const toolResult = (await toolCall!(
    { toolName: "read", toolCallId: "read-1", input: { path: "secret.txt" } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.equal(toolResult?.block, true);
  assert.match(toolResult?.reason ?? "", /Sandbox profile 'missing-profile'.*not defined/);
});

// Regression: a real print/json child session has no initialized TUI theme at all.
// Touching theme-dependent UI during profile startup used to throw, and that throw
// was treated as an initialization failure, blocking every sandboxed child.
test("a print-mode child without an initialized theme still enables its profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-profile-no-theme-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "sandbox.json"),
    JSON.stringify({
      profiles: {
        strict: {
          inheritGlobalConfig: false,
          network: { allowedDomains: [] },
          filesystem: { allowRead: [cwd], allowWrite: [] },
        },
      },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_SANDBOX_PROFILE = "strict";
  process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = "1";
  const startupAckPath = path.join(root, "sandbox-profile-startup.json");
  process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH = startupAckPath;
  process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN = "no-theme-token";

  let initialized = false;
  SandboxManager.initialize = async () => {
    initialized = true;
  };

  const themeError = (): never => {
    throw new Error("Theme not initialized. Call initTheme() first.");
  };
  const { pi, handlers } = createMockPi();
  registerSandbox(pi as never);
  const ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    isProjectTrusted: () => true,
    ui: {
      notify: themeError,
      setStatus: themeError,
      get theme(): never {
        return themeError();
      },
    },
  } as unknown as ExtensionContext;

  const sessionStart = handlers.get("session_start")?.[0];
  const input = handlers.get("input")?.[0];
  const toolCall = handlers.get("tool_call")?.[0];
  assert.ok(sessionStart);
  assert.ok(input);
  assert.ok(toolCall);

  await sessionStart!({ reason: "startup" }, ctx);

  // The sandbox is enabled and acknowledged even though every UI call throws.
  assert.equal(initialized, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(startupAckPath, "utf-8")), {
    version: 1,
    profile: "strict",
    token: "no-theme-token",
  });
  // No startup failure was recorded, so the first turn is not blocked.
  assert.equal(input!({ text: "Task: inspect" }, ctx), undefined);
  assert.notEqual(process.exitCode, 1);
  const readResult = (await toolCall!(
    { toolName: "read", toolCallId: "read-1", input: { path: path.join(cwd, "inside.txt") } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.doesNotMatch(readResult?.reason ?? "", /could not initialize/);
});

// An in-process child shares the host process, so a blocked first turn must not
// leave a non-zero exit code behind on the parent's own successful session.
test("an in-process child does not set the host exit code when its profile fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-profile-in-process-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_SANDBOX_PROFILE = "missing-profile";
  process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = "0";
  process.env.PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD = "1";
  process.exitCode = undefined;

  const { pi, handlers } = createMockPi();
  registerSandbox(pi as never);
  const ctx = headlessContext(cwd);
  const sessionStart = handlers.get("session_start")?.[0];
  const input = handlers.get("input")?.[0];
  assert.ok(sessionStart);
  assert.ok(input);
  await sessionStart!({ reason: "startup" }, ctx);

  // The first turn is still blocked, but the host keeps its own exit status.
  assert.deepEqual(input!({ text: "Task: inspect" }, ctx), { action: "handled" });
  assert.notEqual(process.exitCode, 1);
});
