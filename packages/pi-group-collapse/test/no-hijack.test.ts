/**
 * No-hijack scenario matrix (change task 4.4).
 *
 * Pins that summary handling never becomes an area-wide click grab:
 * drags, double-clicks, wheel events, and non-shell rows always reach the
 * original handler unconsumed; OSC 8 hyperlink bytes survive projection;
 * a consumed release claims neither capture nor focus (overlays keep
 * their routing); re-hitting after a resize finds the summary where it
 * renders now; and a layout change between press and release that moves
 * or drops the target forwards the release instead of toggling.
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";

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
  wheelDelta?: number;
};

const at = (
  type: Event["type"],
  x: number,
  y: number,
  extra: Partial<Event> = {},
): Event => ({ type, x, y, ...extra });

const dispatch = (component: object, event: Event) =>
  (component as unknown as { handleMouse(e: unknown): unknown }).handleMouse({
    ...event,
    button: "left",
    width: WIDTH,
    height: 24,
    screenX: event.x,
    screenY: event.y,
    shift: false,
    alt: false,
    ctrl: false,
    ...event,
  });

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

describe("no-hijack scenario matrix", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };
  let tool: ToolExecutionComponent;

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    tool = toolComponent("t1");
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
  });

  const folded = () => tool.render(WIDTH).length === 1;

  test("a drag across the summary forwards everything and toggles nothing", () => {
    expect(folded()).toBe(true);
    const pressResult = dispatch(tool, at("press", 2, 0));
    expect(pressResult).not.toEqual({ handled: true, render: true });
    dispatch(tool, at("drag", 2, 0));
    const releaseResult = dispatch(tool, at("release", 30, 0));
    expect(releaseResult).not.toEqual({ handled: true, render: true });
    expect(folded()).toBe(true);
  });

  test("a double-click release forwards instead of toggling", () => {
    dispatch(tool, at("press", 2, 0));
    const result = dispatch(tool, at("release", 2, 0, { clickCount: 2 }));
    expect(result).not.toEqual({ handled: true, render: true });
    expect(folded()).toBe(true);
  });

  test("wheel events pass through untouched", () => {
    const result = dispatch(tool, at("wheel", 2, 0, { wheelDelta: -3 }));
    expect(result).not.toEqual({ handled: true, render: true });
    expect(folded()).toBe(true);
  });

  test("the consumed release claims neither capture nor focus", () => {
    dispatch(tool, at("press", 2, 0));
    const result = dispatch(tool, at("release", 2, 0)) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ handled: true, render: true });
    expect("capture" in result).toBe(false);
    expect("focus" in result).toBe(false);
    expect("focusTarget" in result).toBe(false);
  });

  test("non-shell rows of an expanded group are never consumed", () => {
    dispatch(tool, at("press", 2, 0));
    dispatch(tool, at("release", 2, 0)); // expand
    expect(tool.render(WIDTH).length).toBeGreaterThan(1);

    // Events on content rows (below the title) go to the original handler.
    const result = dispatch(tool, at("release", 5, 2));
    expect(result).not.toEqual({ handled: true, render: true });
    // And they do not flip the group.
    expect(tool.render(WIDTH).length).toBeGreaterThan(1);
  });

  test("OSC 8 hyperlink bytes survive the projection", () => {
    const link = "\x1b]8;;https://example.test\x07example\x1b]8;;\x07";
    runtime.debugApplyPolicyRules([
      {
        kind: "notification",
        textPrefix: "Link:",
        level: "info",
        action: "group",
      },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    const note = new Text(`Link: ${link}`, 1, 0);
    receiver.chatContainer.addChild(note);
    runtime.debugRegisterNotification(note, "info", `Link: ${link}`);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    dispatch(note, at("press", 1, 0));
    dispatch(note, at("release", 1, 0));
    const expanded = note.render(WIDTH);
    // The member's own line re-renders with its hyperlink intact, byte
    // for byte, below the title.
    expect(expanded.join("\n")).toContain(link);
  });

  test("re-hitting after a resize finds the summary where it renders now", () => {
    // Fold at a wide terminal, then shrink: the summary may drop counts,
    // but whatever row 0 holds is what a click resolves against.
    dispatch(tool, at("press", 2, 0));
    dispatch(tool, at("release", 2, 0)); // expand at 80
    const narrowLines = (
      tool as unknown as { render(w: number): string[] }
    ).render(40);
    // Collapse again through a narrow-width click on the title row.
    (tool as unknown as { handleMouse(e: unknown): unknown }).handleMouse({
      type: "press",
      x: 1,
      y: 0,
      button: "left",
      width: 40,
      height: 24,
      screenX: 1,
      screenY: 0,
      shift: false,
      alt: false,
      ctrl: false,
    });
    const collapsed = (
      tool as unknown as { handleMouse(e: unknown): unknown }
    ).handleMouse({
      type: "release",
      x: 1,
      y: 0,
      button: "left",
      width: 40,
      height: 24,
      screenX: 1,
      screenY: 0,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(collapsed).toEqual({ handled: true, render: true });
    expect(
      (tool as unknown as { render(w: number): string[] }).render(40).length,
    ).toBe(1);
    void narrowLines;
  });

  test("a layout change that drops the target forwards the release", () => {
    dispatch(tool, at("press", 2, 0)); // press on the folded summary
    // Between press and release the layout narrows so far that the summary
    // no longer fits: the group keeps its original display and there is no
    // shell row to hit any more.
    const releaseAt = (width: number) =>
      (tool as unknown as { handleMouse(e: unknown): unknown }).handleMouse({
        type: "release",
        x: 2,
        y: 0,
        button: "left",
        width,
        height: 24,
        screenX: 2,
        screenY: 0,
        shift: false,
        alt: false,
        ctrl: false,
      });
    const result = releaseAt(4);
    expect(result).not.toEqual({ handled: true, render: true });
    // The group stays folded — the click did nothing.
    expect(folded()).toBe(true);
  });
});
