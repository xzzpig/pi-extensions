import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@xzzpig/sandbox-runtime";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { sandboxManagerFactory } from "../src/sandbox-runtime.ts";
import { getSandboxService } from "../src/service.ts";

test("macOS hot-switch to disabled network skips prompts and stale SSH proxy for bash and user_bash", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-ssh-hot-switch-"));
  const cwd = join(root, "session");
  const agent = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agent);
  const previousEnv = { ...process.env };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const create = sandboxManagerFactory.create;
  const handlers = new Map<string, (event: any, ctx: ExtensionToolContext) => any>();
  let bash: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  let activeConfig: SandboxRuntimeConfig | undefined;
  let initialized = 0;
  let reset = 0;
  const wrapped: string[] = [];
  const manager = create();
  manager.initialize = async (config) => {
    activeConfig = config;
    initialized++;
  };
  manager.updateConfig = (config) => {
    activeConfig = config;
  };
  manager.reset = async () => {
    reset++;
  };
  manager.waitForNetworkInitialization = async () => initialized > 0;
  manager.getSocksProxyPort = () => 12345;
  manager.wrapWithSandbox = async (command) => {
    wrapped.push(command);
    return "printf safe";
  };
  manager.cleanupAfterCommand = () => {};
  sandboxManagerFactory.create = () => manager;
  try {
    process.env.PI_CODING_AGENT_DIR = agent;
    delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    delete process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    writeFileSync(
      join(agent, "sandbox.json"),
      JSON.stringify({
        network: { disabled: true },
        profiles: { restricted: { network: { disabled: false, allowedDomains: [] } } },
      }),
    );
    extension({
      registerFlag() {},
      registerShortcut() {},
      registerCommand() {},
      getFlag: () => false,
      registerTool: (tool: typeof bash) => {
        bash = tool;
      },
      on: (event: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
        handlers.set(event, handler),
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd,
      hasUI: false,
      mode: "print",
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => "ssh-hot-switch", getSessionFile: () => undefined },
      ui: { notify() {}, setStatus() {} },
    } as unknown as ExtensionToolContext;
    await handlers.get("session_start")!({}, ctx);
    assert.equal(activeConfig?.network.disabled, true);
    const service = getSandboxService("ssh-hot-switch")!;
    // Simulate the initial unrestricted state having no proxy, then restriction starts one.
    manager.waitForNetworkInitialization = async () => false;
    assert.equal((await service.setProfile("restricted")).ok, true);
    assert.equal(reset, 1);
    assert.equal(initialized, 2);
    assert.equal(activeConfig?.network.disabled, false);
    assert.ok(activeConfig?.filesystem.allowWrite.includes(cwd));
    await bash!.execute(
      "restricted",
      { command: "ssh example.com", timeout: 5 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(wrapped.at(-1)!, /ProxyCommand=/);
    assert.equal((await service.setProfile(undefined)).ok, true);
    assert.equal(activeConfig?.network.disabled, true);
    const blocked = await handlers.get("tool_call")!(
      { toolName: "bash", input: { command: "curl https://blocked.example.com" } },
      ctx,
    );
    assert.equal(blocked, undefined);
    await bash!.execute(
      "unrestricted",
      { command: "ssh example.com", timeout: 5 },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(wrapped.at(-1), "ssh example.com");
    const result = await handlers.get("user_bash")!({ command: "ssh example.com" }, ctx);
    await result.operations.exec("ssh example.com", cwd, {
      onData() {},
      env: process.env,
      timeout: 5,
    });
    assert.equal(wrapped.at(-1), "ssh example.com");
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    sandboxManagerFactory.create = create;
    Object.defineProperty(process, "platform", platform);
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
