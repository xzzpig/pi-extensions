import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  InteractiveMode,
  ToolExecutionComponent,
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import extension, { getGroupCollapseRuntime } from "../index.ts";
import type { GroupCollapseRuntime } from "../src/runtime.ts";

const WIDTH = 120;
const runtimeKey = Symbol.for("pi-group-collapse.runtime.v1");
let root: string;
let priorAgentDir: string | undefined;
let runtime: GroupCollapseRuntime | undefined;

beforeEach(() => {
  initTheme();
  root = mkdtempSync(join(tmpdir(), "group-collapse-command-"));
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  Reflect.deleteProperty(globalThis, runtimeKey);
  writeFileSync(
    join(root, "group-collapse.json"),
    JSON.stringify({
      rules: [
        {
          kind: "notification",
          textPrefix: "Observational memory:",
          action: "group",
        },
      ],
    }),
  );
});

afterEach(() => {
  runtime?.onSessionShutdown();
  runtime = undefined;
  Reflect.deleteProperty(globalThis, runtimeKey);
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  type Handler = (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void> | void;
  let handler: Handler | undefined;
  const registration = {
    on: () => () => {},
    registerCommand: (_name: string, definition: { handler: Handler }) => {
      handler = definition.handler;
    },
  };
  // SAFETY: the factory only calls these two registration methods; all
  // handlers are tested separately, not against missing SDK capabilities.
  extension(registration as unknown as ExtensionAPI);
  const active = getGroupCollapseRuntime(() => {});
  runtime = active;
  active.onSessionStart({ cwd: root, mode: "tui", getBranch: () => [] });
  const requestRender = vi.fn();
  const host = Object.create(InteractiveMode.prototype) as {
    chatContainer: Container;
    ui: { requestRender: () => void };
    outputPad: number;
    showExtensionNotify(
      message: string,
      level?: "info" | "warning" | "error",
    ): void;
  };
  host.chatContainer = new Container();
  host.ui = { requestRender };
  host.outputPad = 1;
  const notify = vi.fn(
    (message: string, level?: "info" | "warning" | "error") =>
      host.showExtensionNotify(message, level),
  );
  // SAFETY: the command reads only mode and ui.notify, supplied here. It
  // never invokes the SDK's session-switching or model capabilities.
  const ctx = {
    mode: "tui",
    ui: { notify },
  } as unknown as ExtensionCommandContext;
  const run = async (action: string) => {
    if (handler === undefined) throw new Error("Command was not registered");
    await handler(action, ctx);
  };

  active.handlePiEvent({ type: "agent_start" });
  const tools: ToolExecutionComponent[] = [];
  let count = 0;
  for (const size of [2, 3, 3, 9]) {
    for (let index = 0; index < size; index++) {
      const id = `command-tool-${++count}`;
      const tool = new ToolExecutionComponent(
        "bash",
        id,
        { command: `printf BODY-${id}` },
        {},
        undefined,
        host.ui as ConstructorParameters<typeof ToolExecutionComponent>[5],
        root,
      );
      tool.updateResult(
        { content: [{ type: "text", text: `BODY-${id}` }], isError: false },
        false,
      );
      tools.push(tool);
      host.chatContainer.addChild(tool);
      active.syncReceiver(host);
      active.handlePiEvent({
        type: "tool_execution_end",
        toolCallId: id,
        isError: false,
      });
    }
    notify(`Observational memory: batch ${count}`, "info");
    active.syncReceiver(host);
    host.chatContainer.render(WIDTH);
  }
  active.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  active.handlePiEvent({ type: "agent_before_settle", outcome: "completed" });
  active.handlePiEvent({ type: "agent_settled", aborted: false });
  notify.mockClear();
  requestRender.mockClear();
  const rendered = () =>
    stripTerminalSequences(host.chatContainer.render(WIDTH).join("\n"));
  const expectSingleGroup = () => {
    expect(active.currentSegmentsForTest()).toHaveLength(1);
    expect(active.currentSegmentsForTest()[0].members).toHaveLength(21);
  };
  return {
    active,
    host,
    tools,
    run,
    notify,
    requestRender,
    rendered,
    expectSingleGroup,
  };
}

test("commands preserve one OM group and repaint without success notifications", async () => {
  const fixture = setup();
  const count = fixture.host.chatContainer.children.length;
  expect(fixture.rendered()).toContain("▸ 分组 17 次工具调用 · 4 条消息");
  await fixture.run("expand");
  fixture.expectSingleGroup();
  expect(fixture.rendered()).toContain("▾ 分组 17 次工具调用 · 4 条消息");
  expect(fixture.rendered()).toContain("BODY-command-tool-17");
  expect(fixture.requestRender).toHaveBeenCalledTimes(1);

  await fixture.run("collapse");
  fixture.expectSingleGroup();
  expect(fixture.rendered()).toContain("▸ 分组 17 次工具调用 · 4 条消息");
  expect(fixture.rendered()).not.toContain("BODY-command-tool-");
  expect(fixture.requestRender).toHaveBeenCalledTimes(2);
  expect(fixture.notify).not.toHaveBeenCalled();
  expect(fixture.host.chatContainer.children).toHaveLength(count);
});

test("collapse command refolds a pointer-opened group without changing membership", async () => {
  const fixture = setup();
  const first = fixture.tools[0];
  const lines = first.render(WIDTH);
  const event: Parameters<ToolExecutionComponent["handleMouse"]>[0] = {
    type: "click",
    button: "left",
    x: 1,
    y: 0,
    width: WIDTH,
    height: lines.length,
    screenX: 1,
    screenY: 0,
    shift: false,
    ctrl: false,
    alt: false,
    clickCount: 1,
  };
  first.handleMouse(event);
  expect(fixture.rendered()).toContain("▾ 分组 17 次工具调用 · 4 条消息");
  fixture.requestRender.mockClear();
  await fixture.run("collapse");
  fixture.expectSingleGroup();
  expect(fixture.rendered()).toContain("▸ 分组 17 次工具调用 · 4 条消息");
  expect(fixture.rendered()).not.toContain("BODY-command-tool-");
  expect(fixture.requestRender).toHaveBeenCalledTimes(1);
  expect(fixture.notify).not.toHaveBeenCalled();
});

test("no-op commands do not touch the status tail or request another frame", async () => {
  const fixture = setup();
  await fixture.run("collapse");
  fixture.expectSingleGroup();
  expect(fixture.requestRender).not.toHaveBeenCalled();
  await fixture.run("expand");
  fixture.requestRender.mockClear();
  await fixture.run("expand");
  fixture.expectSingleGroup();
  expect(fixture.requestRender).not.toHaveBeenCalled();
  expect(fixture.notify).not.toHaveBeenCalled();
});

test("invalid command arguments retain a warning without reclassifying OM rows", async () => {
  const fixture = setup();
  await fixture.run("invalid");
  expect(fixture.notify).toHaveBeenCalledWith(
    "group-collapse: expected expand or collapse",
    "warning",
  );
  fixture.expectSingleGroup();
  expect(fixture.rendered()).toContain("▸ 分组 17 次工具调用 · 4 条消息");
});
