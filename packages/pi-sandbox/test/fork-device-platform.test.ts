import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { sandboxManagerFactory } from "../src/sandbox-runtime.ts";

for (const platform of ["win32", "darwin", "freebsd"] as const) {
  test(`nonempty devices on ${platform} block startup and all bash paths without a profile`, async () => {
    await scenario(platform, ["/dev/kvm"], true);
  });
}
for (const devices of [undefined, []]) {
  test(`unsupported platform without devices preserves legacy fallback (${JSON.stringify(devices)})`, async () => {
    await scenario("win32", devices, false);
  });
}

async function scenario(
  platform: NodeJS.Platform,
  devices: string[] | undefined,
  blocked: boolean,
) {
  const root = mkdtempSync(join(tmpdir(), "pi-device-platform-"));
  const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const keys = [
    "PI_CODING_AGENT_DIR",
    "PI_SUBAGENT_SANDBOX_PROFILE",
    "PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED",
    "PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH",
    "PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN",
    "PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH",
  ];
  const saved = keys.map((key) => process.env[key]);
  const savedFactory = sandboxManagerFactory.create;
  let initialized = 0;
  const manager = savedFactory();
  sandboxManagerFactory.create = () => ({
    ...manager,
    initialize: async () => {
      initialized++;
    },
    reset: async () => {},
  });
  const handlers = new Map<string, (event: any, ctx: ExtensionToolContext) => any>();
  let bash: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const notices: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "device-platform", getSessionFile: () => undefined },
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionToolContext;
  try {
    for (const key of keys) delete process.env[key];
    const agent = join(root, "agent");
    mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    writeFileSync(
      join(agent, "sandbox.json"),
      JSON.stringify({ network: { disabled: true }, filesystem: { allowDevices: devices } }),
    );
    extension({
      on: (name: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) =>
        handlers.set(name, handler),
      registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        if (tool.name === "bash") bash = tool;
      },
      registerFlag: () => {},
      registerShortcut: () => {},
      registerCommand: () => {},
      getFlag: () => false,
    } as unknown as ExtensionAPI);
    Object.defineProperty(process, "platform", { ...savedPlatform, value: platform });
    try {
      await handlers.get("session_start")!({ reason: "startup" }, ctx);
    } finally {
      Object.defineProperty(process, "platform", savedPlatform);
    }
    assert.equal(
      initialized,
      0,
      "unsupported device request must not reach runtime initialization",
    );
    const marker = join(root, "MUST_NOT_EXECUTE");
    const command = `printf probe > ${marker}`;
    const decision = await handlers.get("tool_call")!(
      { toolName: "bash", toolCallId: "probe", input: { command } },
      ctx,
    );
    const result = await bash!.execute("probe", { command, timeout: 5 }, undefined, undefined, ctx);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const userBash = await handlers.get("user_bash")!({ command }, ctx);
    if (blocked) {
      const pattern = new RegExp(`filesystem\\.allowDevices.*not supported on ${platform}`);
      assert.equal(decision?.block, true);
      assert.match(decision.reason, pattern);
      assert.match(text, pattern);
      assert.equal(userBash.result.exitCode, 1);
      assert.match(userBash.result.output, pattern);
      assert.equal(userBash.operations, undefined);
      assert.equal(existsSync(marker), false, "bash tool must not execute unsandboxed fallback");
    } else {
      assert.equal(decision, undefined);
      assert.equal(existsSync(marker), true, text);
      assert.equal(userBash, undefined);
      assert.ok(notices.some((message) => message.includes("Sandbox not supported")));
    }
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    Object.defineProperty(process, "platform", savedPlatform);
    sandboxManagerFactory.create = savedFactory;
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    rmSync(root, { recursive: true, force: true });
  }
}
