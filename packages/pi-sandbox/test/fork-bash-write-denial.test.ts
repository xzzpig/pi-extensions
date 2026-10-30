import type { Component, TUI } from "@earendil-works/pi-tui";

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionToolContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { sandboxManagerFactory } from "../src/sandbox-runtime.ts";

for (const scenario of ["headless", "abort", "cancel", "allow", "denyWrite"] as const) {
  test(`Bash write-denial: ${scenario}`, { timeout: 5000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-write-denial-"));
    const agentDir = join(root, "agent");
    const attempts = join(root, "attempts");
    const blocked = join(root, "blocked-file");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "sandbox.json"),
      JSON.stringify({
        enabled: true,
        network: { disabled: true },
        filesystem: {
          allowRead: [],
          denyRead: [],
          allowWrite: [],
          denyWrite: scenario === "denyWrite" ? [blocked] : [],
        },
      }),
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    const previousFactory = sandboxManagerFactory.create;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    const manager = previousFactory();
    let updates = 0;
    manager.initialize = async () => {};
    manager.updateConfig = () => {
      updates++;
    };
    manager.wrapWithSandbox = async (command) => command;
    manager.cleanupAfterCommand = () => {};
    manager.getSocksProxyPort = () => undefined;
    manager.reset = async () => {};
    sandboxManagerFactory.create = () => manager;

    let prompts = 0;
    const toolAbort = new AbortController();
    let widget: (Component & { dispose?(): void }) | undefined;
    const editor = Object.create(CustomEditor.prototype) as CustomEditor;
    const tui = { requestRender() {}, getFocusedComponent: () => editor } as unknown as TUI;
    const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
    let bash: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
    const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
    const pi = {
      registerFlag() {},
      registerTool(tool: typeof bash) {
        bash = tool;
      },
      registerShortcut() {},
      registerCommand() {},
      getFlag: () => false,
      on(name: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) {
        handlers.set(name, handler);
      },
      events: { emit() {} },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: root,
      mode: scenario === "headless" ? "print" : "tui",
      hasUI: scenario !== "headless",
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => `write-denial-${scenario}`,
        getSessionFile: () => undefined,
      },
      ui: {
        notify() {},
        setStatus() {},
        theme,
        onTerminalInput(handler: (data: string) => unknown) {
          queueMicrotask(() => {
            if (scenario === "cancel") toolAbort.abort();
            else handler(scenario === "allow" ? "s" : "\x1b");
          });
          return () => {};
        },
        setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => typeof widget) {
          widget?.dispose?.();
          widget = undefined;
          if (!factory) return;
          prompts++;
          widget = factory(tui, theme);
        },
      },
    } as unknown as ExtensionToolContext;

    try {
      extension(pi);
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      assert.ok(bash);
      const command =
        `printf 'attempt\\n' >> ${JSON.stringify(attempts)}; ` +
        `printf 'bash: line 1: ${blocked}: Read-only file system\\n' >&2; exit 1`;
      const result = await bash.execute(
        "test",
        { command },
        scenario === "cancel" ? toolAbort.signal : undefined,
        undefined,
        ctx,
      );
      const output = result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      assert.equal(result.isError, true);
      assert.match(output, /\[pi-sandbox\] This error was caused by the OS-level sandbox/);
      assert.ok(output.includes(blocked));
      assert.equal(
        prompts,
        scenario === "allow" || scenario === "abort" || scenario === "cancel" ? 1 : 0,
      );
      assert.equal(
        readFileSync(attempts, "utf8"),
        "attempt\n".repeat(scenario === "allow" ? 2 : 1),
      );
      assert.equal(updates, scenario === "allow" ? 2 : 0);
      if (scenario === "allow")
        assert.match(output, /was allowed for this session but the write still fails/);
      if (scenario === "abort" || scenario === "cancel")
        assert.match(output, /dismissed or timed out/);
      if (scenario === "denyWrite") assert.match(output, /explicitly denied/);
    } finally {
      await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
      sandboxManagerFactory.create = previousFactory;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
      else process.env.PI_SUBAGENT_SANDBOX_PROFILE = previousProfile;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
