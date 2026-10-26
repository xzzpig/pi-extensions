/**
 * Runtime assembly tests (change task 3.4).
 *
 * Drives the process runtime end-to-end against a fake host receiver that
 * carries a real chat container with real components: Pi events map into
 * the model, a normal settle folds the group through the live render
 * projection, an abnormal settle keeps everything visible, the commands
 * restore/fold content without a mouse while skipping the running turn,
 * and a non-TUI mode installs no display behavior at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";

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

function plainLines(lines: readonly string[]): string {
  return stripTerminalSequences(lines.join("\n"));
}

describe("GroupCollapseRuntime", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({
      notify: () => {},
    });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  });

  afterEach(() => {
    runtime.onSessionShutdown();
  });

  const runNormalTurn = (toolIds: string[]) => {
    runtime.handlePiEvent({ type: "agent_start" });
    for (const id of toolIds) {
      receiver.chatContainer.addChild(toolComponent(id));
    }
    runtime.syncReceiver(receiver);
    for (const id of toolIds) {
      runtime.handlePiEvent({
        type: "tool_execution_end",
        toolCallId: id,
        isError: false,
      });
    }
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
  };

  test("a normal settle folds the group to one summary line", () => {
    runNormalTurn(["t1", "t2"]);
    const lines = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    // Every member renders through the projection: carrier shows the
    // single summary, the other member hides.
    const summary = lines.filter((line) => line.includes("2 次工具调用"));
    expect(summary.length).toBe(1);
    expect(plainLines(lines)).not.toContain("echo t1");
    expect(plainLines(lines)).not.toContain("done t2");
  });

  test("an abnormal settle keeps the original display", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("t1"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: true });

    const lines = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    expect(plainLines(lines)).toContain("echo t1");
    expect(plainLines(lines)).toContain("done t1");
  });

  test("a deferred abnormal group folds at the next normal settle", () => {
    // Abnormal turn.
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("a1"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "a1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: true });
    const userBoundary = new UserMessageComponent(
      "next question",
      getMarkdownTheme(),
    );
    receiver.chatContainer.addChild(userBoundary);
    // Normal turn afterwards.
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("b1"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "b1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    const lines = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    const plain = plainLines(lines);
    // Both abnormal and normal groups folded; boundary message visible.
    expect(plain).not.toContain("echo a1");
    expect(plain).not.toContain("echo b1");
    expect(plain).toContain("next question");
    const summaries = lines.filter((line) => line.includes("1 次工具调用"));
    expect(summaries.length).toBe(2);
  });

  test("expand restores content without a mouse; collapse folds again", () => {
    runNormalTurn(["t1"]);
    runtime.expandAll();
    const lines = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    const plain = plainLines(lines);
    // Title line plus the byte-identical member output.
    expect(plain).toContain("1 次工具调用");
    expect(plain).toContain("echo t1");
    expect(plain).toContain("done t1");

    runtime.collapseAll();
    const collapsed = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    expect(plainLines(collapsed)).not.toContain("echo t1");
  });

  test("collapse skips the running turn's segments", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("live"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "live",
      isError: false,
    });
    runtime.collapseAll();
    const lines = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    expect(plainLines(lines)).toContain("echo live");
  });

  test("a non-TUI mode installs no display behavior", () => {
    const offline = new GroupCollapseRuntime({ notify: () => {} });
    offline.onSessionStart({
      mode: "rpc",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    expect(offline.isDisplayInstalled()).toBe(false);
    offline.onSessionShutdown();
  });

  test("session_shutdown uninstalls and stays idempotent", () => {
    expect(runtime.isDisplayInstalled()).toBe(true);
    runtime.onSessionShutdown();
    expect(runtime.isDisplayInstalled()).toBe(false);
    runtime.onSessionShutdown();
    expect(runtime.isDisplayInstalled()).toBe(false);
  });

  test("unresolved tool results keep the group visible on normal settle", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("pending"));
    runtime.syncReceiver(receiver);
    // The result event never arrives.
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    const lines = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    expect(plainLines(lines)).toContain("echo pending");
  });
});
