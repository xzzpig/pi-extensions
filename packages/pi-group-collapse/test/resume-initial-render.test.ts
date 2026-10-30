/**
 * First-startup resume regression.
 *
 * Pi's interactive startup emits `session_start` from
 * `rebindCurrentSession()` and only then renders the restored transcript
 * with `renderInitialMessages()`. The runtime rebuilt its history model
 * during `session_start`, but if it only observes `handleEvent` and
 * `rebuildChatFromMessages`, the components rendered by that first call are
 * never bound: the model is folded while the screen shows the raw history,
 * and `/group-collapse collapse` has no components to act on until a model
 * event or `/reload`.
 *
 * These tests drive the real `InteractiveMode.prototype.renderInitialMessages`
 * with a receiver whose `renderSessionEntries` adds the restored components,
 * exactly in that order, and prove the first render binds and folds without
 * any model event, reload, or manual sync.
 */

import { describe, expect, test } from "vitest";
import {
  InteractiveMode,
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import { readExpandTarget } from "../src/expand-target.ts";

const WIDTH = 80;

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function toolComponent(id: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "bash",
    id,
    { command: `echo ${id}` },
    {},
    undefined,
    stubUi() as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `done ${id}` }], isError: false },
    false,
  );
  return component;
}

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

const renderedText = (receiver: { chatContainer: Container }): string =>
  plain(
    receiver.chatContainer.children.flatMap((child) =>
      (child as { render(width: number): string[] }).render(WIDTH),
    ),
  );

/** A persisted, normally settled tool turn: history folds it by default. */
function settledBranch(): readonly never[] {
  return [
    { type: "message", id: "u", message: { role: "user", content: [] } },
    {
      type: "message",
      id: "a",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "resume-tool", name: "bash" }],
        stopReason: "stop",
      },
    },
    {
      type: "message",
      id: "r",
      message: { role: "toolResult", toolCallId: "resume-tool", content: [] },
    },
  ] as never;
}

/**
 * The startup receiver: a real InteractiveMode prototype instance with the
 * host fields `renderInitialMessages` reads, and a `renderSessionEntries`
 * that adds the restored component the way the host does.
 */
function startupReceiver(branch: readonly never[]): {
  receiver: { chatContainer: Container; renderInitialMessages(): void };
  renderRequests: number[];
} {
  const renderRequests: number[] = [];
  const receiver = Object.assign(
    Object.create(InteractiveMode.prototype) as object,
    {
      chatContainer: new Container(),
      ui: { requestRender: () => void renderRequests.push(1) },
      outputPad: 0,
      renderSessionEntries: () => {
        receiver.chatContainer.addChild(toolComponent("resume-tool"));
      },
      renderProjectTrustWarningIfNeeded: () => {},
    },
  ) as unknown as {
    chatContainer: Container;
    renderInitialMessages(): void;
  };
  // `sessionManager` is a prototype getter on InteractiveMode; the test
  // receiver owns the branch projection instead of a real session.
  Object.defineProperty(receiver, "sessionManager", {
    configurable: true,
    value: {
      buildContextEntries: () => branch,
      getEntries: () => branch,
    },
  });
  return { receiver, renderRequests };
}

describe("first-startup resume binding", () => {
  test("the restored transcript binds and folds on the first host render", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const branch = settledBranch();
    const { receiver, renderRequests } = startupReceiver(branch);
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => branch,
    });

    // The history model is already folded before the host renders; the
    // components do not exist yet.
    expect(runtime.debugFoldedIds()).toEqual([1]);
    expect(receiver.chatContainer.children.length).toBe(0);

    // Pi init: session_start returned, now the host renders the restored
    // transcript. No handleEvent, model event, reload, or manual sync.
    receiver.renderInitialMessages();

    const rendered = renderedText(receiver);
    expect(rendered).toContain("1 次工具调用");
    expect(rendered).not.toContain("echo resume-tool");
    expect(rendered).not.toContain("done resume-tool");
    // The binding requested the one repaint that makes the folded first
    // frame visible; it does not leave the host showing raw content.
    expect(renderRequests.length).toBe(1);
    runtime.onSessionShutdown();
  });

  test("command-opening a reconstructed folded group retains its title and footer", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const branch = settledBranch();
    const { receiver } = startupReceiver(branch);
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => branch,
    });
    receiver.renderInitialMessages();
    expect(runtime.debugFoldedIds()).toEqual([1]);
    expect(runtime.expandAll()).toBe(1);
    const child = receiver.chatContainer.children[0] as ToolExecutionComponent;
    const rows = child.render(WIDTH).map(stripTerminalSequences);
    const header = rows.findIndex((row) => row.includes("▾ 分组"));
    const footer = rows.findIndex((row) => row.includes("收起分组"));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(footer).toBeGreaterThan(header);
    expect(rows.join("\n")).toContain("done resume-tool");
    const headerTarget = readExpandTarget(child)?.resolveLocalTarget(
      header,
      WIDTH,
    );
    const footerTarget = readExpandTarget(child)?.resolveLocalTarget(
      footer,
      WIDTH,
    );
    expect(footerTarget?.component).toBe(headerTarget?.component);
    expect(footerTarget?.expanded).toBe(false);
    footerTarget?.component.setExpanded(false);
    expect(renderedText(receiver)).toContain("▸ 分组");
    expect(renderedText(receiver)).not.toContain("done resume-tool");
    runtime.onSessionShutdown();
  });

  test("shutdown restores the host method and stops binding", () => {
    initTheme();
    const original = InteractiveMode.prototype.renderInitialMessages;
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const branch = settledBranch();
    const { receiver } = startupReceiver(branch);
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => branch,
    });
    expect(InteractiveMode.prototype.renderInitialMessages).not.toBe(original);

    runtime.onSessionShutdown();
    expect(InteractiveMode.prototype.renderInitialMessages).toBe(original);

    // A late render after shutdown must pass through untouched.
    receiver.renderInitialMessages();
    expect(renderedText(receiver)).toContain("echo resume-tool");
  });

  test("a non-TUI session installs no initial-render binding", () => {
    initTheme();
    const original = InteractiveMode.prototype.renderInitialMessages;
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const branch = settledBranch();
    const { receiver } = startupReceiver(branch);
    runtime.onSessionStart({
      mode: "rpc",
      cwd: "/tmp/no-config-resume",
      getBranch: () => branch,
    });
    expect(runtime.isDisplayInstalled()).toBe(false);
    expect(InteractiveMode.prototype.renderInitialMessages).toBe(original);

    receiver.renderInitialMessages();
    expect(renderedText(receiver)).toContain("echo resume-tool");
    runtime.onSessionShutdown();
  });
});
