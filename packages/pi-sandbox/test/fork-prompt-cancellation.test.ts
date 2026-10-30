import type { Component, TUI } from "@earendil-works/pi-tui";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { setImmediate } from "node:timers/promises";

import extension from "../src/extension.ts";

test(
  "cancelling an access tool closes its prompt without granting access",
  { timeout: 5000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-prompt-cancel-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "sandbox.json"),
      JSON.stringify({
        enabled: false,
        enableAccessRequestTool: true,
        filesystem: { allowRead: [], allowWrite: [] },
      }),
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;

    const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
    let widget: (Component & { dispose?(): void }) | undefined;
    let listener: ((data: string) => unknown) | undefined;
    const editor = Object.create(CustomEditor.prototype) as CustomEditor;
    const tui = { requestRender() {}, getFocusedComponent: () => editor } as unknown as TUI;
    const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
    const pi = {
      registerFlag() {},
      registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
        tools.set(tool.name, tool);
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
      mode: "tui",
      hasUI: true,
      signal: undefined,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "prompt-cancellation",
        getSessionFile: () => undefined,
      },
      ui: {
        notify() {},
        onTerminalInput(handler: (data: string) => unknown) {
          listener = handler;
          return () => {
            listener = undefined;
          };
        },
        setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => typeof widget) {
          widget?.dispose?.();
          widget = undefined;
          if (factory) widget = factory(tui, theme);
        },
      },
    } as unknown as ExtensionToolContext;
    extension(pi);
    t.after(async () => {
      await handlers.get("session_shutdown")?.({ reason: "shutdown" }, ctx);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
      else process.env.PI_SUBAGENT_SANDBOX_PROFILE = previousProfile;
      rmSync(root, { recursive: true, force: true });
    });
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    const request = tools.get("sandbox_request_access");
    const status = tools.get("sandbox_status");
    assert.ok(request);
    assert.ok(status);

    const controller = new AbortController();
    const pending = request.execute(
      "request",
      { kind: "read", target: "/unapproved", reason: "Inspect file" },
      controller.signal,
      undefined,
      ctx,
    );
    await setImmediate();
    assert.ok(widget);
    assert.ok(listener);
    controller.abort();
    await assert.rejects(pending, /Access request cancelled/);
    assert.equal(widget, undefined);
    assert.equal(listener, undefined);
    const result = await status.execute("status", {}, undefined, undefined, ctx);
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.deepEqual(JSON.parse(text.text).sessionGrants.readPaths, []);
  },
);
