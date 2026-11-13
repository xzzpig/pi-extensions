/**
 * What a transcript selection puts on the clipboard: the rules on their own, then the
 * whole path against the real `TuiAltScreen`, with rows from tidy's own drawing code
 * and a real drag. Nothing here touches the machine's clipboard: `copySelection` is
 * pi's injection point and the test owns it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
(globalThis as any)[THEME_KEY] = theme;

const { cleanCopy, cleanTranscriptRows, installCleanCopy } = await import("../src/clean-copy.ts");
const { drawFrame, labeledTopBorder } = await import("../src/draw/frame-draw.ts");
const { joinBoxCorners, railRows } = await import("../src/turns/turn-view.ts");
const { tidyEnabled } = await import("../src/live.ts");
const { patchUserMessages, USER_MESSAGE_TIME } = await import("../src/messages/user-message.ts");

const USER_ICON = "\u{f007}";

function railMessage(lines: readonly string[], width: number): string[] {
  const rule = "─".repeat(width);
  return [rule, ...lines.map((line) => `│ ${line}`.padEnd(width)), rule];
}

/** A framed box as tidy draws it: rounded edges, the text one cell in. */
function frame(lines: readonly string[], width: number, label?: string): string[] {
  const rows = drawFrame(lines.map((line) => ` ${line}`), width, theme, "accent");
  if (label) rows[0] = labeledTopBorder(width, theme, "accent", label);
  return rows;
}

const texts = (rows: ReadonlyArray<{ text: string } | null>) => rows.map((row) => (row ? row.text.trimEnd() : null));

test("a frame loses its edges, its verticals and its inset", () => {
  const lines = frame(["hello there", "second"], 30, "label 14:06");
  const { rows, changed } = cleanTranscriptRows(lines, 0, lines.length - 1);
  assert.equal(changed, true);
  assert.deepEqual(texts(rows), [null, "hello there", "second", null]);
  assert.equal(rows[1]!.leftTrim, 2);
});

test("the inset stays when a row of the frame does not have it", () => {
  const lines = drawFrame([" indented", "flush"], 20, theme, "accent");
  assert.deepEqual(texts(cleanTranscriptRows(lines, 0, 3).rows), [null, " indented", "flush", null]);
});

test("a selection inside a frame is cleaned although it holds neither edge", () => {
  const lines = ["before", ...frame(["one", "two", "three"], 20), "after"];
  const { rows, changed } = cleanTranscriptRows(lines, 3, 4);
  assert.equal(changed, true);
  assert.deepEqual(texts(rows), ["two", "three"]);
});

test("the reply's corner under an open run's rail is still a frame", () => {
  const lines = frame(["reply"], 24, "model 14:06");
  lines[0] = lines[0]!.replace("╭", "├");
  assert.deepEqual(texts(cleanTranscriptRows(lines, 0, 2).rows), [null, "reply", null]);
});

test("a box on the rail loses the rail, and its joints count as corners", () => {
  const box = joinBoxCorners(frame(["diff row"], 24, "edit"), true, true);
  const lines = railRows(box, theme, " ");
  const { rows } = cleanTranscriptRows(lines, 0, lines.length - 1);
  assert.deepEqual(texts(rows), [null, "diff row", null]);
  assert.equal(rows[1]!.leftTrim, 4);
});

test("a framed table keeps its own pipes", () => {
  const lines = drawFrame(["$ run", "│ a │ b │"], 20, theme, "accent");
  assert.deepEqual(texts(cleanTranscriptRows(lines, 0, 3).rows), [null, "$ run", "│ a │ b │", null]);
});

test("right-aligned frames come off from their column, wide text whole", () => {
  const lines = [`    ╭───── ${USER_ICON} ─╮`, "    │ 你好    │", "    ╰─────────╯"];
  const { rows } = cleanTranscriptRows(lines, 0, 2);
  assert.deepEqual(texts(rows), [null, "你好", null]);
  assert.equal(rows[1]!.leftTrim, 6);
});

test("edges pair only at one width and in one column", () => {
  assert.equal(cleanTranscriptRows(["╭────────╮", "│ inner  │", "╰──╯"], 0, 2).changed, false);
  assert.equal(cleanTranscriptRows(["    ╭────╮", "    │ hi │", "  ╰────╯"], 0, 2).changed, false);
});

test("what is not tidy's stays byte-identical", () => {
  const cases: string[][] = [
    ["┌─ one ─┬─ two ─┐", "│ a     │ b     │", "├─ ─── ─┼─ ─── ─┤", "└─ ─── ─┴─ ─── ─┘"],
    ["│ quoted text", "│ more quoted"],
    ["─".repeat(20), "plain paragraph", "─".repeat(20)],
    ["─".repeat(20), " $ ls", " │ a │ b │", "─".repeat(20)],
    ["─".repeat(20), "│ content", "─".repeat(12)],
  ];
  for (const lines of cases) {
    const { rows, changed } = cleanTranscriptRows(lines, 0, lines.length - 1);
    assert.equal(changed, false, lines[0]);
    assert.deepEqual(rows.map((row) => row?.text), lines);
  }
});

test("a rail message loses its rules and rail, on a selection without its edges too", () => {
  const lines = ["earlier", ...railMessage(["one", "two"], 20)];
  assert.deepEqual(texts(cleanTranscriptRows(lines, 1, 4).rows), [null, "one", "two", null]);
  assert.deepEqual(texts(cleanTranscriptRows(lines, 3, 3).rows), ["two"]);
});

test("a rail message's padding rows and the text's own indent are handled", () => {
  const padded = ["─".repeat(20), "│", "│ hello", "│", "─".repeat(20)];
  assert.deepEqual(texts(cleanTranscriptRows(padded, 0, 4).rows), [null, "", "hello", "", null]);
  const plain = ["─".repeat(20), "│ first", "│   indented", "─".repeat(20)];
  assert.deepEqual(texts(cleanTranscriptRows(plain, 0, 3).rows), [null, "first", "  indented", null]);
});

test("a labelled top rule opens a rail message, and opens only", () => {
  const top = `─ ${USER_ICON} 14:06 ${"─".repeat(10)}`;
  const close = "─".repeat(top.length);
  assert.deepEqual(texts(cleanTranscriptRows([top, "│ one", close], 0, 2).rows), [null, "one", null]);
  const two = [top, "│ one", close, top, "│ two", close];
  assert.deepEqual(texts(cleanTranscriptRows(two, 0, 5).rows), [null, "one", null, null, "two", null]);
  // A rule of another width, or a row without the rail, is not this shape.
  assert.equal(cleanTranscriptRows([top, "│ one", "─".repeat(5)], 0, 2).changed, false);
  assert.equal(cleanTranscriptRows([top, "plain", close], 0, 2).changed, false);
});

test("what tidy draws for a rail message, at either end, copies as its text", () => {
  for (const align of ["left", "right"] as const) {
    patchUserMessages({ style: "rail", railColor: "accent", ruleColor: "border", paddingY: 1, icons: true, time: true, align, timeFormat: "auto", headerStyle: "inline" });
    const component: any = new UserMessageComponent("first\n\nsecond" as never);
    component[USER_MESSAGE_TIME] = Date.now();
    const lines: string[] = component.render(40);
    assert.match(stripVTControlCharacters(lines[0]!), /\d\d:\d\d/, "the label is on the rule");
    const { rows } = cleanTranscriptRows(lines, 0, lines.length - 1);
    assert.deepEqual(texts(rows).filter((row) => row), ["first", "second"]);
    assert.equal(rows[0], null);
    assert.equal(rows.at(-1), null);
  }
});

test("a split header copies clean, framed or on a rail, and so does a rule written into the time format", () => {
  const label = "model \u2500\u2500 13:09";
  const framed = drawFrame([" hello"], 30, theme, "accent");
  framed[0] = labeledTopBorder(30, theme, "accent", label, "left", 2);
  assert.deepEqual(texts(cleanTranscriptRows(framed, 0, framed.length - 1).rows), [null, "hello", null]);
  const literal = drawFrame([" hello"], 40, theme, "accent");
  literal[0] = labeledTopBorder(40, theme, "accent", "model \u2500\u2500 11\u67085\u65e5 \u2500 13:09");
  assert.deepEqual(texts(cleanTranscriptRows(literal, 0, literal.length - 1).rows), [null, "hello", null]);
  for (const align of ["left", "right"] as const) {
    patchUserMessages({ style: "rail", railColor: "accent", ruleColor: "border", paddingY: 1, icons: true, time: true, align, timeFormat: "HH:mm", headerStyle: "split" });
    const component: any = new UserMessageComponent("first" as never);
    component[USER_MESSAGE_TIME] = Date.now();
    const lines: string[] = component.render(40);
    assert.match(stripVTControlCharacters(lines[0]!), /\u2500\u2500 \d\d:\d\d/);
    assert.deepEqual(texts(cleanTranscriptRows(lines, 0, lines.length - 1).rows).filter((row) => row), ["first"]);
  }
});

test("a message with only rules copies as its text; a model's own rules stay", () => {
  const rule = "\u2500".repeat(30);
  const lines = [`\u2500 model 13:09 ${"\u2500".repeat(16)}`, " first", " \u2500\u2500\u2500\u2500", "", " second", rule];
  const { rows } = cleanTranscriptRows(lines, 0, lines.length - 1);
  assert.deepEqual(texts(rows), [null, "first", "\u2500\u2500\u2500\u2500", "", "second", null]);
  assert.equal(rows[1]!.leftTrim, 1);

  // No label: nothing tells these from rules a model wrote, so they stay.
  const unlabeled = [rule, " text", rule];
  assert.deepEqual(texts(cleanTranscriptRows(unlabeled, 0, 2).rows), [rule, " text", rule]);

  // A label with no closing rule of its width, before the next message, closes nothing.
  const open = [`\u2500 a ${"\u2500".repeat(26)}`, " text", `\u2500 b ${"\u2500".repeat(26)}`, " more", rule];
  assert.deepEqual(texts(cleanTranscriptRows(open, 0, 4).rows), [open[0], " text", null, "more", null]);
});

test("two rail messages in a row do not pair across their gap", () => {
  const lines = [...railMessage(["first"], 20), ...railMessage(["second"], 20)];
  assert.deepEqual(texts(cleanTranscriptRows(lines, 0, 5).rows), [null, "first", null, null, "second", null]);
});

test("a selection past the end of the buffer reads as empty rows", () => {
  const lines = railMessage(["short"], 10);
  const { rows } = cleanTranscriptRows(lines, 1, 4);
  assert.deepEqual(texts(rows), ["short", null, "", ""]);
});

// ── The real path ───────────────────────────────────────────────────────────

function fakeTerminal(columns = 60, rows = 20) {
  const state: { input?: (data: string) => void } = {};
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
    write() {},
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

/** A real alt screen holding `rows`. Coordinates of `drag` are 0-based cells. */
async function screenWith(rows: readonly string[], copyOnSelect: boolean) {
  const copied: string[] = [];
  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal as any, undefined, undefined, {
    copyOnSelect,
    copySelection: async (text: string) => {
      copied.push(text);
      return true;
    },
  } as any);
  tui.addChild(new ScrollView({ render: () => [...rows], invalidate() {} } as any, {} as any) as any);
  tui.start();
  await tick();
  const send = (data: string) => terminal.state.input?.(data);
  return {
    tui,
    copied,
    async drag(from: [number, number], to: [number, number]) {
      send(`\x1b[<0;${from[0] + 1};${from[1] + 1}M`);
      await tick();
      send(`\x1b[<32;${to[0] + 1};${to[1] + 1}M`);
      await tick();
      send(`\x1b[<0;${to[0] + 1};${to[1] + 1}m`);
      await tick();
    },
    stop: () => tui.stop(),
  };
}

const REPLY = frame(["first line of the reply", "second line"], 40, "model 14:06");

installCleanCopy();

test("select-to-copy puts the text on the clipboard, without the frame", async () => {
  const screen = await screenWith(REPLY, true);
  try {
    await screen.drag([0, 0], [39, 3]);
    assert.deepEqual(screen.copied, ["first line of the reply\nsecond line"]);
  } finally {
    screen.stop();
  }
});

test("the copy key does the same", async () => {
  const screen = await screenWith(REPLY, false);
  try {
    await screen.drag([0, 0], [39, 3]);
    assert.deepEqual(screen.copied, []);
    await screen.tui.copyActiveSelectionToClipboard();
    assert.deepEqual(screen.copied, ["first line of the reply\nsecond line"]);
  } finally {
    screen.stop();
  }
});

test("a drag that starts mid-row keeps the characters it covered", async () => {
  const screen = await screenWith(REPLY, true);
  try {
    // Row 1 is `│ first line of the reply…`: column 8 is the `l` of `line`.
    await screen.drag([8, 1], [12, 1]);
    assert.deepEqual(screen.copied, ["line"]);
  } finally {
    screen.stop();
  }
});

test("a selection of nothing but a border copies nothing, and is still a selection", async () => {
  const screen = await screenWith(REPLY, false);
  try {
    await screen.drag([2, 0], [20, 0]);
    assert.equal(screen.tui.hasActiveSelection(), true, "pi's copy key must not fall back to the last reply");
    assert.equal(await screen.tui.copyActiveSelectionToClipboard(), false);
    assert.deepEqual(screen.copied, []);
  } finally {
    screen.stop();
  }
});

test("`cleanCopy: false` and `enabled: false` copy what pi would", async () => {
  for (const off of [() => cleanCopy.set(false), () => tidyEnabled.set(false)]) {
    off();
    const screen = await screenWith(REPLY, true);
    try {
      await screen.drag([0, 1], [39, 1]);
      assert.equal(screen.copied.length, 1);
      assert.match(screen.copied[0]!, /^│ first line of the reply +│$/);
    } finally {
      screen.stop();
      cleanCopy.set(true);
      tidyEnabled.set(true);
    }
  }
});
