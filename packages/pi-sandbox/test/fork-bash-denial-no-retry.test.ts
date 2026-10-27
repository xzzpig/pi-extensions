import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { sandboxManagerFactory } from "../src/sandbox-runtime.ts";

test("bash denial text never prompts for write access or replays prior side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-no-retry-"));
  const agentDir = join(root, "agent");
  const attempts = join(root, "attempts");
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, "sandbox.json"),
    JSON.stringify({
      enabled: true,
      network: { disabled: true },
      filesystem: { allowRead: [], denyRead: [], allowWrite: [root], denyWrite: [] },
    }),
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
  const previousFactory = sandboxManagerFactory.create;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
  const manager = previousFactory();
  manager.initialize = async () => {};
  manager.wrapWithSandbox = async (command) => command;
  manager.cleanupAfterCommand = () => {};
  manager.getSocksProxyPort = () => undefined;
  manager.reset = async () => {};
  sandboxManagerFactory.create = () => manager;

  let prompts = 0;
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
    events: {
      emit: () => {
        prompts++;
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "bash-no-retry", getSessionFile: () => undefined },
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_color: string, text: string) => text },
      custom: async () => {
        prompts++;
        return { action: "session", value: "/outside" };
      },
    },
  } as unknown as ExtensionToolContext;

  try {
    extension(pi);
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    assert.ok(bash);
    for (const [index, text] of ["Operation not permitted", "Read-only file system"].entries()) {
      const command =
        `printf 'attempt\\n' >> ${JSON.stringify(attempts)}; ` +
        `printf 'bash: line 1: /outside/file: ${text}\\n' >&2; exit 1`;
      const result = await bash.execute("test", { command }, undefined, undefined, ctx);
      const output = result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      assert.equal(result.isError, true);
      assert.match(output, new RegExp(text));
      assert.doesNotMatch(output, /\[pi-sandbox\] This error was caused/);
      assert.equal(readFileSync(attempts, "utf8"), "attempt\n".repeat(index + 1));
      assert.equal(prompts, 0);
    }
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
