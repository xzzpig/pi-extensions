/**
 * Native summary-click and coordinate-translation tests (change task 4.3).
 *
 * Drives the runtime's fallback click path (the one hosts without a click
 * consumer use) with real components and real pi-tui event shapes:
 *
 * - a plain click on a summary/title row toggles the group exactly once;
 * - drags away, modified releases, and double-clicks never toggle;
 * - events below a title or inside a thinking-filtered message are handed
 *   to the original handler in the original row space (the assistant's own
 *   thinking click still toggles `thinkingVisibilityOverrides`);
 * - summaries carried by tools, custom messages, assistants, and by
 *   notification lines (a plain Text with no setExpanded of its own) are
 *   all clickable;
 * - when an upstream consumer (Starline on) takes the release, only the
 *   press reaches the component and nothing toggles — one click, one
 *   toggle, in every combination.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import { readExpandTarget } from "../src/expand-target.ts";

const WIDTH = 80;

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

type Event = {
  type: "press" | "release" | "move" | "drag" | "click" | "wheel";
  x: number;
  y: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  clickCount?: number;
};

const at = (
  type: Event["type"],
  x: number,
  y: number,
  extra: Partial<Event> = {},
): Event => ({
  type,
  x,
  y,
  ...extra,
});

const dispatch = (component: object, event: Event) =>
  (component as unknown as { handleMouse(e: unknown): unknown }).handleMouse({
    ...event,
    button: "left",
    width: WIDTH,
    height: 8,
    screenX: event.x,
    screenY: event.y,
    shift: false,
    alt: false,
    ctrl: false,
    ...extraOf(event),
  });

function extraOf(event: Event): Record<string, unknown> {
  const record = event as unknown as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  if ("clickCount" in record) extra.clickCount = record.clickCount;
  if ("shift" in record) extra.shift = record.shift;
  if ("ctrl" in record) extra.ctrl = record.ctrl;
  return extra;
}

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

function foldedToolGroup(
  runtime: GroupCollapseRuntime,
  receiver: { chatContainer: Container },
) {
  runtime.handlePiEvent({ type: "agent_start" });
  const tool = toolComponent("t1");
  receiver.chatContainer.addChild(tool);
  runtime.syncReceiver(receiver);
  runtime.handlePiEvent({
    type: "tool_execution_end",
    toolCallId: "t1",
    isError: false,
  });
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
  return tool;
}

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

describe("native summary clicks", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  });

  test("a plain click on a tool-carried summary toggles exactly once", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const tool = foldedToolGroup(runtime, receiver);
      expect(tool.render(WIDTH).length).toBe(1); // folded

      dispatch(tool, at("press", 2, 0));
      const result = dispatch(tool, at("release", 2, 0));
      expect(result).toEqual({ handled: true, render: true });
      const expanded = tool.render(WIDTH);
      expect(expanded.length).toBeGreaterThan(1);
      expect(plain(expanded)).toContain("echo t1");

      // A separate click after the double-click window collapses again.
      clock.mockReturnValue(1_600);
      dispatch(tool, at("press", 2, 0));
      dispatch(tool, at("release", 2, 0));
      expect(tool.render(WIDTH).length).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("a second same-cell release after Starline toggles does not toggle again", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const tool = foldedToolGroup(runtime, receiver);
      tool.render(WIDTH);
      const target = readExpandTarget(tool)?.resolveLocalTarget(0, WIDTH);
      expect(target).toBeDefined();
      // Pi receives the first press, then Starline consumes its release and
      // invokes the shared group target directly. The native component sees
      // the second press/release when Starline leaves double-click selection
      // to Pi; it must not undo the first toggle.
      expect(dispatch(tool, at("press", 2, 0))).toBeUndefined();
      target?.component.setExpanded(true);
      tool.render(WIDTH);
      clock.mockReturnValue(10_100);
      expect(dispatch(tool, at("press", 2, 0))).toBeUndefined();
      expect(dispatch(tool, at("release", 2, 0))).toBeUndefined();
      dispatch(tool, at("click", 2, 0, { clickCount: 1 }));
      expect(plain(tool.render(WIDTH))).toContain("▾ 分组");
      expect(plain(tool.render(WIDTH))).toContain("收起分组");
    } finally {
      clock.mockRestore();
    }
  });

  test("a second same-cell native click remains a selection", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(20_000);
    try {
      const tool = foldedToolGroup(runtime, receiver);
      tool.render(WIDTH);
      dispatch(tool, at("press", 2, 0));
      expect(dispatch(tool, at("release", 2, 0))).toEqual({
        handled: true,
        render: true,
      });
      tool.render(WIDTH);
      clock.mockReturnValue(20_100);
      expect(dispatch(tool, at("press", 2, 0))).toBeUndefined();
      expect(dispatch(tool, at("release", 2, 0))).toBeUndefined();
      dispatch(tool, at("click", 2, 0, { clickCount: 1 }));
      expect(plain(tool.render(WIDTH))).toContain("▾ 分组");
    } finally {
      clock.mockRestore();
    }
  });

  test("press alone (an upstream consumer took the release) toggles nothing", () => {
    const tool = foldedToolGroup(runtime, receiver);
    dispatch(tool, at("press", 2, 0));
    // Starline on: the release is consumed before components see it.
    expect(tool.render(WIDTH).length).toBe(1);
    // Even a later unrelated release elsewhere does not fire.
    dispatch(tool, at("release", 9, 0));
    expect(tool.render(WIDTH).length).toBe(1);
  });

  test("drags away and modified or double clicks never toggle", () => {
    const tool = foldedToolGroup(runtime, receiver);
    dispatch(tool, at("press", 2, 0));
    dispatch(tool, at("drag", 5, 0));
    dispatch(tool, at("release", 5, 0));
    expect(tool.render(WIDTH).length).toBe(1);

    // Shift-click stays a selection.
    dispatch(tool, at("press", 2, 0));
    dispatch(tool, at("release", 2, 0, { shift: true }));
    expect(tool.render(WIDTH).length).toBe(1);

    // Double-click stays a word select.
    dispatch(tool, at("press", 2, 0));
    dispatch(tool, at("release", 2, 0, { clickCount: 2 }));
    expect(tool.render(WIDTH).length).toBe(1);
  });

  test("a custom-message-carried summary toggles", () => {
    // Swap the rule table before any member enters the model.
    runtime.debugApplyPolicyRules([
      {
        kind: "customMessage",
        customType: "pi-goal-audit-event",
        action: "group",
      },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    const custom = new CustomMessageComponent({
      role: "custom",
      customType: "pi-goal-audit-event",
      content: "audit note",
      display: true,
      timestamp: Date.now(),
    });
    receiver.chatContainer.addChild(custom);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    expect(custom.render(WIDTH).length).toBe(1);

    dispatch(custom, at("press", 1, 0));
    dispatch(custom, at("release", 1, 0));
    expect(custom.render(WIDTH).length).toBeGreaterThan(1);
    expect(plain(custom.render(WIDTH))).toContain("audit note");
  });

  test("a notification-carried summary toggles without any setExpanded of its own", () => {
    runtime.debugApplyPolicyRules([
      {
        kind: "notification",
        textPrefix: "Observational memory:",
        level: "info",
        action: "group",
      },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    const note = new Text("Observational memory: stored", 1, 0);
    const original = note.render(WIDTH);
    receiver.chatContainer.addChild(note);
    runtime.debugRegisterNotification(
      note,
      "info",
      "Observational memory: stored",
    );
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    expect(note.render(WIDTH).length).toBe(1);

    dispatch(note, at("press", 1, 0));
    const result = dispatch(note, at("release", 1, 0));
    expect(result).toEqual({ handled: true, render: true });
    // The added title and footer are group UI; the member stays byte-identical.
    const expanded = note.render(WIDTH);
    expect(expanded).toHaveLength(original.length + 2);
    expect(expanded.slice(1, -1)).toEqual(original);
    expect(plain(expanded)).toContain("Observational memory: stored");
    expect(plain([expanded.at(-1) ?? ""])).toContain("收起分组");
    dispatch(note, at("press", 1, expanded.length - 1));
    expect(dispatch(note, at("release", 1, expanded.length - 1))).toEqual({
      handled: true,
      render: true,
    });
    expect(note.render(WIDTH)).toHaveLength(1);
  });

  test("clicks below a title reach the original handler in original coordinates", () => {
    const tool = foldedToolGroup(runtime, receiver);
    dispatch(tool, at("press", 2, 0));
    dispatch(tool, at("release", 2, 0)); // open: [title, ...own]
    const own = tool.render(WIDTH);
    expect(own.length).toBeGreaterThan(1);

    // The assistant case proves the translation with real behavior: a
    // thinking run's native click toggles thinkingVisibilityOverrides.
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "alpha thinking" },
          { type: "text", text: "final answer" },
        ],
      } as never,
      false,
    );
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);
    // A fresh turn owns the assistant message, so its settle folds it.
    runtime.handlePiEvent({ type: "agent_start" });
    const overrides = (
      component as unknown as {
        thinkingVisibilityOverrides: Map<number, boolean>;
      }
    ).thinkingVisibilityOverrides;

    // Fold the message's group (thinking-only segment) via a settle.
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    const folded = component.render(WIDTH);
    expect(plain(folded)).not.toContain("alpha thinking");
    expect(plain(folded)).toContain("1 段思考");

    // Expand through a plain click on the in-place summary row...
    const summaryRow = folded.findIndex((line) =>
      stripTerminalSequences(line).includes("1 段思考"),
    );
    expect(summaryRow).toBeGreaterThan(-1);
    dispatch(component, at("press", 1, summaryRow));
    dispatch(component, at("release", 1, summaryRow));
    const reopened = component.render(WIDTH);
    expect(plain(reopened)).toContain("alpha thinking");
    expect(overrides.size).toBe(0); // group toggle never touched member state

    // ...then click the thinking row itself: the native MouseRegion
    // handler runs with translated coordinates (pi synthesizes "click"
    // events for plain clicks) and flips the override.
    const thinkingRow = reopened.findIndex((line) =>
      stripTerminalSequences(line).includes("alpha thinking"),
    );
    expect(thinkingRow).toBeGreaterThan(-1);
    dispatch(component, at("click", 3, thinkingRow));
    expect(overrides.get(0)).toBe(true);
    expect(plain(component.render(WIDTH)).includes("alpha thinking")).toBe(
      false,
    );
  });
});

describe("synthesized click events (pi-tui fullscreen path)", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };

  beforeEach(() => {
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  });

  test("a synthesized click toggles the group once", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    const tool = toolComponent("c1");
    receiver.chatContainer.addChild(tool);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    expect(tool.render(WIDTH).length).toBe(1); // folded

    // pi-tui delivers press/release for selection anchoring and then a
    // synthesized "click" — the component toggles on the click alone.
    const result = dispatch(tool, at("click", 2, 0));
    expect(result).toEqual({ handled: true, render: true });
    expect(tool.render(WIDTH).length).toBeGreaterThan(1);

    // A second click collapses again — one click, one toggle.
    dispatch(tool, at("click", 2, 0));
    expect(tool.render(WIDTH).length).toBe(1);
  });

  test("modified or double synthesized clicks stay with the original handler", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    const tool = toolComponent("c2");
    receiver.chatContainer.addChild(tool);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "c2",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    dispatch(tool, at("click", 2, 0, { shift: true }));
    expect(tool.render(WIDTH).length).toBe(1);
    dispatch(tool, at("click", 2, 0, { clickCount: 2 }));
    expect(tool.render(WIDTH).length).toBe(1);
  });
});
