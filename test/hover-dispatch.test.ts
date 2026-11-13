/**
 * The hover path end to end, against the real `TuiAltScreen`: a motion packet
 * with no button held (`\x1b[<35;x;yM`, all-motion tracking) reaches a
 * component inside a ScrollView, lights the row under it, and the wrapper over
 * `handleMouseEvent` drops the band as soon as the pointer leaves.
 *
 * This is the assumption the feature rests on and it is pi's code, not ours:
 * `move` is dispatched with no press in progress, at the component's local
 * coordinates, and returns no result of its own — so the repaint has to come
 * from us.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
(globalThis as any)[THEME_KEY] = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => (color === "selectedBg" ? `[band]${text}[/band]` : text),
  bold: (text: string) => text,
};
const theme = (globalThis as any)[THEME_KEY];

const { renderGroupedTool, routeGroupedMouse } = await import("../src/tools/tool-group-view.ts");
const { enableHoverForTests, installHoverTracking, resetHover } = await import("../src/hover.ts");
const { noteBoundary, resetGroups } = await import("../src/tools/tool-groups.ts");

/** The Terminal surface TuiAltScreen touches, minus anything real. */
function fakeTerminal(columns = 200, rows = 20) {
  const state: { input?: (data: string) => void; writes: string[] } = { writes: [] };
  return {
    state,
    columns,
    rows,
    kittyProtocolActive: false,
    isTTY: false,
    start(onInput: (data: string) => void) {
      state.input = onInput;
    },
    stop() {
      state.input = undefined;
    },
    async drainInput() {},
    write(data: string) {
      state.writes.push(data);
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    clearProgress() {},
  };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function groupedComponent(tool: any) {
  return {
    renders: 0,
    render(width: number) {
      this.renders += 1;
      return renderGroupedTool(tool, width, theme, { icons: false, pinned: false }, () => []) ?? [];
    },
    invalidate() {},
    handleMouse(event: any) {
      return routeGroupedMouse(
        tool,
        event,
        { pinned: false, asPointer: <T,>(fn: () => T) => fn(), boxMouse: () => undefined },
      ) as any;
    },
  };
}

test("a motion packet lights the row under it, and leaving drops the band", async () => {
  resetGroups();
  resetHover();
  enableHoverForTests();
  installHoverTracking();
  noteBoundary({});

  const tool: any = {
    toolName: "bash",
    toolCallId: "call-1",
    args: { command: "pnpm test" },
    isPartial: false,
    expanded: false,
    result: { isError: false, durationMs: 100, content: [] },
    setExpanded(next: boolean) {
      tool.expanded = next;
    },
  };
  const grouped = groupedComponent(tool);
  tool.ui = { requestRender: () => grouped.render(200) };
  const plain = { render: () => ["a message row"], invalidate: () => {} };

  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal as any);
  // The tool sits above a plain component, so a pointer moving onto the plain
  // one is "left our rows" — exactly the case the wrapper has to catch.
  tui.addChild(
    new ScrollView(
      {
        render: (width: number) => [...grouped.render(width), ...plain.render()],
        invalidate() {},
        handleMouse(event: any) {
          if (event.y === 0 && event.type === "move") return grouped.handleMouse(event);
          return undefined;
        },
      } as any,
      {} as any,
    ) as any,
  );
  tui.start();
  await tick();

  const send = (seq: string) => terminal.state.input?.(seq);
  send("\x1b[<35;3;1M"); // motion, no button, row 1 → the tool's summary line
  await tick();
  assert.match(grouped.render(200)[0]!, /\[band\]/, "the row under the pointer is lit");

  send("\x1b[<35;3;2M"); // row 2 → the plain component below it
  await tick();
  assert.doesNotMatch(grouped.render(200)[0]!, /\[band\]/, "the band is dropped");

  tui.stop();
});

test("the pointer is a hand over a lit row and the arrow again off it", async () => {
  resetGroups();
  resetHover();
  enableHoverForTests();
  installHoverTracking();
  noteBoundary({});

  const tool: any = {
    toolName: "bash",
    toolCallId: "call-pointer",
    args: { command: "pnpm test" },
    isPartial: false,
    expanded: false,
    result: { isError: false, durationMs: 100, content: [] },
    setExpanded(next: boolean) {
      tool.expanded = next;
    },
  };
  const grouped = groupedComponent(tool);
  tool.ui = { requestRender: () => grouped.render(200) };
  const plain = { render: () => ["a message row"], invalidate: () => {} };

  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal as any);
  tui.addChild(
    new ScrollView(
      {
        render: (width: number) => [...grouped.render(width), ...plain.render()],
        invalidate() {},
        handleMouse(event: any) {
          if (event.y === 0 && event.type === "move") return grouped.handleMouse(event);
          return undefined;
        },
      } as any,
      {} as any,
    ) as any,
  );
  tui.start();
  await tick();

  /** Every OSC 22 the terminal received, as its shape name. */
  const shapes = () =>
    terminal.state.writes.flatMap((data) => [...data.matchAll(/\x1b\]22;([^\x1b]*)\x1b\\/g)].map((match) => match[1]));
  const send = (seq: string) => terminal.state.input?.(seq);

  send("\x1b[<35;3;1M"); // onto the summary line
  await tick();
  assert.deepEqual(shapes(), ["pointer"], "a lit row turns the pointer into a hand");

  send("\x1b[<35;9;1M"); // along the same row
  await tick();
  assert.deepEqual(shapes(), ["pointer"], "moving along the row writes nothing more");

  send("\x1b[<35;3;2M"); // off it, onto the plain component
  await tick();
  assert.deepEqual(shapes(), ["pointer", "default"], "leaving the row brings the arrow back");

  // Lit when pi leaves the alt screen: the arrow goes back before mouse
  // tracking is switched off, so the terminal's own cursor wins afterwards.
  send("\x1b[<35;3;1M");
  await tick();
  terminal.state.writes.length = 0;
  tui.stop();
  const out = terminal.state.writes.join("");
  const reset = out.indexOf("\x1b]22;default\x1b\\");
  assert.ok(reset >= 0, "stopping while lit resets the pointer");
  assert.ok(reset < out.indexOf("\x1b[?1003l"), "the reset precedes turning mouse tracking off");
});
