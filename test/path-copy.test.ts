/**
 * A file box's path is one click away, and a border that names it is content.
 *
 * A `write` or `edit` box puts its path in the top border. Two things follow: the
 * border's label is not the frame's chrome (a drag along it used to copy nothing at
 * all, which Pi reports as "no selection"), and a chip after the path puts it on the
 * clipboard without a drag.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { setClipboardWriter } from "../src/clipboard.ts";
import { cleanTranscriptRows } from "../src/clean-copy.ts";
import { visibleText } from "../src/draw/frame-draw.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../src/hover.ts";
import { chipLabels } from "../src/turns/code-blocks.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";

initTheme("dark");
const W = 120;
const CWD = process.cwd();
const CHIP = chipLabels(true);
const PATH = `${CWD}/draft.md`;
/** What the title shows and the chip copies: `$HOME` as `~`. */
const SHOWN = `~${PATH.slice(process.env.HOME!.length)}`;
const ui = { requestRender() {} };

resetGroups();
patchToolBoxFrames({ icons: true, groupTools: false, splitDiff: true, splitDiffMinWidth: 72, diffLines: 8 });

function writeBox(path = PATH): any {
  const box = new ToolExecutionComponent(
    "write", "call-write", { path, content: "first\nsecond" }, {},
    createWriteToolDefinition(CWD) as any, ui as any, CWD,
  );
  box.setExpanded(true);
  box.setArgsComplete();
  box.markExecutionStarted();
  box.updateResult({ content: [], isError: false, durationMs: 3 } as any, false);
  return box;
}

function editBox(path = PATH): any {
  const box = new ToolExecutionComponent(
    "edit", "call-edit", { path, edits: [{ oldText: "a", newText: "b" }] }, {},
    createEditToolDefinition(CWD) as any, ui as any, CWD,
  );
  box.setExpanded(true);
  box.setArgsComplete();
  box.markExecutionStarted();
  box.updateResult({
    content: [{ type: "text", text: "ok" }],
    isError: false,
    durationMs: 4,
    details: { diff: "-const a = 1;\n+const a = 2;", firstChangedLine: 1 },
  } as any, false);
  return box;
}

function bashBox(): any {
  const box = new ToolExecutionComponent("bash", "call-bash", { command: "pnpm test" }, {}, createBashToolDefinition(CWD) as any, ui as any, CWD);
  box.setArgsComplete();
  box.markExecutionStarted();
  box.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 9 } as any, false);
  return box;
}

function draw(component: any, width = W): string[] {
  const container = new Container();
  container.addChild(component);
  return container.render(width).map(visibleText);
}

function mouse(container: Container, type: string, x: number, y: number, height: number): unknown {
  return container.handleMouse({
    type, button: type === "move" ? "none" : "left", x, y, screenX: x, screenY: y,
    width: W, height, shift: false, alt: false, ctrl: false,
  } as any);
}

const chipRow = (rows: readonly string[], chip = CHIP.copy) => rows.findIndex((row) => row.includes(chip));

/** A substring's screen column: Nerd Font glyphs are two UTF-16 units and one cell. */
function columnOf(row: string, text: string): number {
  const at = row.indexOf(text);
  assert.ok(at >= 0, `${text} is not on the row: ${row}`);
  return visibleWidth(row.slice(0, at));
}

test("a write and an edit box carry the chip after their path", () => {
  for (const box of [writeBox(), editBox()]) {
    const rows = draw(box);
    assert.equal(chipRow(rows), 0, rows.join("\n"));
    assert.match(rows[0]!, /draft\.md/, "the path stays in the border");
    assert.ok(rows[0]!.indexOf(CHIP.copy) > rows[0]!.indexOf("draft.md"), "the chip sits after the path");
  }
});

test("a box that names no file has no chip", () => {
  assert.equal(chipRow(draw(bashBox())), -1);
});

test("clicking the chip copies the path without opening or closing the box", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const box = writeBox();
    const container = new Container();
    container.addChild(box);
    const rows = container.render(W).map(visibleText);
    const y = chipRow(rows);
    mouse(container, "click", columnOf(rows[y]!, CHIP.copy), y, rows.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [SHOWN], "the path as the title shows it");
    assert.equal(box.expanded, true, "the chip is the one cell of the box that is not the switch");
    assert.ok(draw(box)[y]!.includes(CHIP.copied), "and the chip says so for a moment");
  } finally {
    setClipboardWriter(undefined);
  }
});

test("the chip lights up under the pointer, and only there", () => {
  enableHoverForTests();
  resetHover();
  try {
    const box = writeBox();
    const container = new Container();
    container.addChild(box);
    const rows = container.render(W).map(visibleText);
    const y = chipRow(rows);
    const x = columnOf(rows[y]!, CHIP.copy);
    mouse(container, "move", x, y, rows.length);
    assert.match(container.render(W)[y]!, /\x1b\[48;/, "the background is the hover band's");
    mouse(container, "move", 2, y, rows.length);
    assert.ok(!/\x1b\[48;/.test(container.render(W)[y]!), "the pointer left the chip");
  } finally {
    resetHover();
    disableHoverForTests();
  }
});

test("an `icons: false` box gets the word, and its margin still copies nothing", () => {
  resetGroups();
  patchToolBoxFrames({ icons: false, groupTools: false, splitDiff: true, splitDiffMinWidth: 72, diffLines: 8 });
  try {
    const rows = draw(writeBox());
    assert.equal(chipRow(rows, chipLabels(false).copy), 0, rows.join("\n"));
    assert.match(rows[0]!, /draft\.md copy ─/, "the word, not a glyph the reader turned off");
  } finally {
    resetGroups();
    patchToolBoxFrames({ icons: true, groupTools: false, splitDiff: true, splitDiffMinWidth: 72, diffLines: 8 });
  }
});

test("a drag along the border copies the path instead of nothing", () => {
  const rows = draw(writeBox());
  const { rows: cleaned, changed } = cleanTranscriptRows(rows, 0, 0);
  assert.equal(changed, true, "the border is chrome, and the path in it is not");
  assert.deepEqual(cleaned[0] && { text: cleaned[0].text, leftTrim: cleaned[0].leftTrim }, {
    text: SHOWN,
    // `╭─ `, the two title icons and the space after each.
    leftTrim: columnOf(rows[0]!, "~"),
  });
});

// ── The whole path, through the real alt screen ─────────────────────────────

function fakeTerminal(columns = W, screenRows = 20) {
  const state: { input?: (data: string) => void } = {};
  return {
    state, columns, rows: screenRows, kittyProtocolActive: false, isTTY: false,
    start(onInput: (data: string) => void) { state.input = onInput; },
    stop() { state.input = undefined; },
    async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, clearProgress() {},
  };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("selecting the path on the border copies it, so the copy key has something to do", async () => {
  const { installCleanCopy } = await import("../src/clean-copy.ts");
  installCleanCopy();
  const rows = draw(writeBox(), W);
  const copied: string[] = [];
  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal as any, undefined, undefined, {
    copyOnSelect: false,
    copySelection: async (text: string) => { copied.push(text); return true; },
  } as any);
  tui.addChild(new ScrollView({ render: () => [...rows], invalidate() {} } as any, {} as any) as any);
  tui.start();
  const send = (data: string) => terminal.state.input?.(data);
  try {
    await tick();
    const start = columnOf(rows[0]!, SHOWN);
    const end = start + SHOWN.length - 1;
    send(`\x1b[<0;${start + 1};1M`);
    await tick();
    send(`\x1b[<32;${end + 1};1M`);
    await tick();
    send(`\x1b[<0;${end + 1};1m`);
    await tick();
    assert.equal((tui as any).hasActiveSelection(), true, "a selection of chrome is still no selection");
    assert.equal(await (tui as any).copyActiveSelectionToClipboard(), true);
    assert.deepEqual(copied, [SHOWN]);
  } finally {
    tui.stop();
  }
});
