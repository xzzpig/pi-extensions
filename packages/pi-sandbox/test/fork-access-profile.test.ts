import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { sandboxManagerFactory } from "../src/sandbox-runtime.ts";

test("access tools report and enforce the selected profile's effective denyRead", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-access-profile-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const secret = join(projectDir, "secret.txt");
  mkdirSync(agentDir);
  mkdirSync(projectDir);
  writeFileSync(secret, "secret");
  writeFileSync(
    join(agentDir, "sandbox.json"),
    JSON.stringify({
      enabled: true,
      enableAccessRequestTool: true,
      network: { disabled: true },
      filesystem: { allowRead: [projectDir] },
      profiles: { strict: { filesystem: { denyRead: [secret] } } },
    }),
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
  const previousFactory = sandboxManagerFactory.create;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_SANDBOX_PROFILE = "strict";
  const manager = previousFactory();
  manager.initialize = async () => {};
  manager.reset = async () => {};
  sandboxManagerFactory.create = () => manager;
  t.after(() => {
    sandboxManagerFactory.create = previousFactory;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    else process.env.PI_SUBAGENT_SANDBOX_PROFILE = previousProfile;
    rmSync(root, { recursive: true, force: true });
  });

  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
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
    cwd: projectDir,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "access-profile", getSessionFile: () => undefined },
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionToolContext;
  extension(pi);
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  t.after(async () => handlers.get("session_shutdown")?.({ reason: "shutdown" }, ctx));

  const statusTool = tools.get("sandbox_status");
  const requestTool = tools.get("sandbox_request_access");
  assert.ok(statusTool);
  assert.ok(requestTool);
  const status = await statusTool.execute("status", {}, undefined, undefined, ctx);
  const text = status.content.find((part) => part.type === "text");
  assert.ok(text && text.type === "text");
  const details = JSON.parse(text.text);
  assert.equal(details.profile, "strict");
  assert.ok(details.filesystem.allowRead.includes(projectDir));
  assert.ok(details.filesystem.denyRead.includes(secret));
  await assert.rejects(
    requestTool.execute(
      "request",
      { kind: "read", target: secret, reason: "Inspect file" },
      undefined,
      undefined,
      ctx,
    ),
    /explicitly denied/,
  );
});
