/**
 * Hover on a folded group. The pointer's `move` packets reach the tool
 * component (pi enables 1003 all-motion tracking outside tmux), light up the
 * row under it, and are never consumed — pi still needs them for selection.
 *
 * The theme is a fake: colours are identity, because the row layout measures
 * cells with `visibleWidth` and tag text would count as cells. Only the hover
 * band keeps a marker (`[band]…[/band]`) so assertions can see it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
(globalThis as any)[THEME_KEY] = {
  fg: (_color: string, text: string) => text,
  // Zero-width fill, so widths stay readable in assertions.
  bg: (color: string, text: string) => (color === "selectedBg" ? `[band]${text}[/band]` : text),
  bold: (text: string) => text,
};

const { NOT_GROUPED, renderGroupedTool, routeGroupedMouse } = await import("../src/tools/tool-group-view.ts");
const { disableHoverForTests, enableHoverForTests, resetHover } = await import("../src/hover.ts");
const { noteBoundary, resetGroups } = await import("../src/tools/tool-groups.ts");

const theme = (globalThis as any)[THEME_KEY];

function fakeTool(name = "bash", result: any = { isError: false, durationMs: 100, content: [] }) {
  const tool: any = {
    toolName: name,
    toolCallId: `${name}-${Math.random()}`,
    args: { command: "pnpm test" },
    isPartial: false,
    expanded: false,
    result,
    renders: 0,
    ui: {
      requestRender() {
        tool.renders++;
      },
    },
    setExpanded(next: boolean) {
      tool.expanded = next;
    },
  };
  return tool;
}

const routing = {
  pinned: false,
  asPointer: <T>(fn: () => T): T => fn(),
  boxMouse: () => undefined,
};

/** One render pass, the way the render patch calls it. */
/** One render pass, the way the render patch calls it. */
function draw(tool: any, width = 200): string[] {
  return renderGroupedTool(tool, width, theme, { icons: false, pinned: false }, () => ["box"]) ?? [];
}

function startGroup(): any {
  resetGroups();
  resetHover();
  enableHoverForTests();
  const boundary = {};
  noteBoundary(boundary);
  return fakeTool();
}

test("the pointer on a folded summary turns ▸ into ▶ and bands the row", () => {
  const tool = startGroup();
  assert.match(draw(tool)[0]!, /▸ 1 call/);

  const before = tool.renders;
  // Never consumed: pi still gets the packet for drag-selection.
  assert.equal(routeGroupedMouse(tool, { type: "move", x: 3, y: 0, button: "none" }, routing), undefined);
  assert.equal(tool.renders, before + 1, "the row asks for exactly one repaint");

  const line = draw(tool)[0]!;
  assert.match(line, /^\[band\]/);
  assert.match(line, /▶ 1 call/);
  assert.ok(line.endsWith("[/band]"));

  // A second move within the same row is a no-op.
  const settled = tool.renders;
  routeGroupedMouse(tool, { type: "move", x: 9, y: 0, button: "none" }, routing);
  assert.equal(tool.renders, settled);
});

test("moving off the rows drops the band", () => {
  const tool = startGroup();
  routeGroupedMouse(tool, { type: "move", x: 3, y: 0, button: "none" }, routing);
  assert.match(draw(tool)[0]!, /\[band\]/);

  // Two rows below the summary: still inside the component, off the row.
  routeGroupedMouse(tool, { type: "move", x: 3, y: 2, button: "none" }, routing);
  assert.doesNotMatch(draw(tool)[0]!, /\[band\]/);
});

test("hover is per row: a level-1 tool row lights up, not the header", () => {
  const tool = startGroup();
  const second = fakeTool("read");
  // Opening the group is what shows one row per call.
  routeGroupedMouse(tool, { type: "click", x: 1, y: 0, button: "left" }, routing);
  draw(tool);
  routeGroupedMouse(second, { type: "click", x: 1, y: 0, button: "left" }, routing);
  second.setExpanded(false);

  routeGroupedMouse(second, { type: "move", x: 4, y: 0, button: "none" }, routing);
  // The second call carries no header of its own: row 0 is its own row.
  const lines = draw(second);
  assert.match(lines[0]!, /\[band\]/);
  assert.match(lines[0]!, /read/);
  assert.match(lines[0]!, /›/);
});

test("without the alt-screen hook there is no hover to go stale", () => {
  resetGroups();
  resetHover();
  disableHoverForTests();
  const boundary = {};
  noteBoundary(boundary);
  const tool = fakeTool();
  // `hoverTracking` is off: the move is ignored, the row stays plain.
  routeGroupedMouse(tool, { type: "move", x: 3, y: 0, button: "none" }, routing);
  assert.doesNotMatch(draw(tool)[0]!, /\[band\]/);
});

test("ungrouped tools are not claimed by the hover path", () => {
  const tool = fakeTool();
  tool.expanded = true;
  const pinned = routeGroupedMouse(tool, { type: "move", y: 0 }, { ...routing, pinned: true });
  assert.equal(pinned, NOT_GROUPED);
});
