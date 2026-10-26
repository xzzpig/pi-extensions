/**
 * Render-stability regression (change task 5.1).
 *
 * Re-renders stable scenes through the live projection and pins that
 * nothing feeds the frame loop: no `requestRender` originates from a
 * render pass, no timers or intervals are ever scheduled, repeated renders
 * are byte-stable, and no handler, member, or statistic grows with render
 * count. The scenes deliberately include the risky ones: an expanded
 * tool-plus-thinking group (the edit/write shape) and the abnormal-then-
 * recovered deferred fold.
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";

const WIDTH = 80;

const stubUi = (counters: { renders: number }): { requestRender(): void } => ({
  requestRender: () => {
    counters.renders += 1;
  },
});

function toolComponent(
  id: string,
  name: string,
  ui: { requestRender(): void },
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    name,
    id,
    name === "edit" || name === "write"
      ? { file_path: `/tmp/${id}.ts`, old: "a", new: "b" }
      : { command: `echo ${id}` },
    {},
    undefined,
    ui as never,
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

describe("render stability", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };
  let ui: { requestRender(): void };
  let counters: { renders: number };
  let timers: number;

  const captureTimers = () => {
    timers = 0;
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    (globalThis as unknown as Record<string, unknown>).setTimeout = (
      fn: unknown,
      ...rest: unknown[]
    ) => {
      timers += 1;
      return (originalSetTimeout as (...a: unknown[]) => number)(fn, ...rest);
    };
    (globalThis as unknown as Record<string, unknown>).setInterval = (
      fn: unknown,
      ...rest: unknown[]
    ) => {
      timers += 1;
      return (originalSetInterval as (...a: unknown[]) => number)(fn, ...rest);
    };
    return () => {
      (globalThis as unknown as Record<string, unknown>).setTimeout =
        originalSetTimeout;
      (globalThis as unknown as Record<string, unknown>).setInterval =
        originalSetInterval;
    };
  };

  beforeEach(() => {
    initTheme();
    counters = { renders: 0 };
    ui = stubUi(counters);
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  });

  const renderAll = () =>
    receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );

  test("repeated renders of a stable folded scene request nothing and grow nothing", () => {
    const restore = captureTimers();
    try {
      runtime.handlePiEvent({ type: "agent_start" });
      const edit = toolComponent("e1", "edit", ui);
      const write = toolComponent("w1", "write", ui);
      receiver.chatContainer.addChild(edit);
      receiver.chatContainer.addChild(write);
      runtime.syncReceiver(receiver);
      for (const id of ["e1", "w1"]) {
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

      const rendersBefore = counters.renders;
      const first = renderAll();
      const segmentsBefore = runtime.debugSegmentCount();
      for (let pass = 0; pass < 50; pass++) {
        renderAll();
        runtime.syncReceiver(receiver);
      }
      // No frame was requested by any render pass; no timer was scheduled.
      expect(counters.renders).toBe(rendersBefore);
      expect(timers).toBe(0);
      // Byte-stable output, no growing statistics.
      expect(renderAll().join("\n")).toBe(first.join("\n"));
      expect(runtime.debugSegmentCount()).toBe(segmentsBefore);
      expect(first.length).toBe(1); // one folded summary line
      expect(plain(first)).toContain("2 次工具调用");
    } finally {
      restore();
    }
  });

  test("an expanded edit/write group with thinking stays render-stable", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    const assistant = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    assistant.updateContent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "considering the edit" },
          { type: "toolCall", id: "e1", name: "edit", arguments: {} },
        ],
      } as never,
      false,
    );
    receiver.chatContainer.addChild(assistant);
    const edit = toolComponent("e1", "edit", ui);
    receiver.chatContainer.addChild(edit);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "e1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    // Expand the group through its own handle.
    runtime.expandAll();
    const rendersBefore = counters.renders;
    const first = renderAll();
    expect(plain(first)).toContain("considering the edit");
    expect(plain(first)).toContain("done e1");

    for (let pass = 0; pass < 50; pass++) {
      renderAll();
      runtime.syncReceiver(receiver);
    }
    expect(counters.renders).toBe(rendersBefore);
    expect(renderAll().join("\n")).toBe(first.join("\n"));
  });

  test("the abnormal-then-recovered deferred fold is render-stable", () => {
    // Abnormal turn: stays visible.
    runtime.handlePiEvent({ type: "agent_start" });
    const bad = toolComponent("bad", "bash", ui);
    receiver.chatContainer.addChild(bad);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "bad",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: true });
    expect(plain(renderAll())).toContain("echo bad");

    // Recovery turn folds both.
    runtime.handlePiEvent({ type: "agent_start" });
    const good = toolComponent("good", "bash", ui);
    receiver.chatContainer.addChild(good);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "good",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    const rendersBefore = counters.renders;
    const first = renderAll();
    const summaries = first.filter((line) => line.includes("1 次工具调用"));
    expect(summaries.length).toBe(2); // both groups folded

    for (let pass = 0; pass < 50; pass++) {
      renderAll();
      runtime.syncReceiver(receiver);
    }
    expect(counters.renders).toBe(rendersBefore);
    expect(renderAll().join("\n")).toBe(first.join("\n"));
    expect(runtime.debugPendingCount()).toBe(0);
  });
});
