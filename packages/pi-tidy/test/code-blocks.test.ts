import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, createReadToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { cleanTranscriptRows } from "../src/clean-copy.ts";
import { setClipboardWriter } from "../src/clipboard.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../src/hover.ts";
import { visibleText } from "../src/draw/frame-draw.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { TurnStore, turnOptions, turnStore } from "../src/turns/turn-state.ts";
import { codeBlocksAvailable, TURN_LAYOUT } from "../src/turns/turn-view.ts";
import { chipLabels } from "../src/turns/code-blocks.ts";

initTheme("dark");
/** The chip as the reply tests draw it: `icons: true` in `fixture`. */
const CHIP = chipLabels(true);
const W = 100;
const FISH = ["set -l x 1", "if test -n \"$x\"", "  echo \"hi\" # note", "end"].join("\n");
const DIFF = ["-const a = 1;", "+const a = 2;", " const b = 3;"].join("\n");
const user = { role: "user", content: "show me", timestamp: 1000 } as const;

interface FixtureOptions {
  width?: number;
  codeBlocks?: boolean;
  splitDiff?: boolean;
  replyStyle?: "frame" | "rail" | "rules";
}

function fixture(text: string, options: FixtureOptions = {}) {
  const width = options.width ?? W;
  resetGroups();
  patchToolBoxFrames({ groupTools: true, groupOpen: false, icons: false, splitDiff: true });
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: true,
    replyStyle: options.replyStyle ?? "frame",
    icons: true,
    codeBlocks: options.codeBlocks ?? true,
    splitDiff: options.splitDiff ?? true,
    splitDiffMinWidth: 72,
  });
  const message: any = { role: "assistant", provider: "deepseek", model: "x", timestamp: 1100, durationMs: 10, stopReason: "stop", content: [{ type: "text", text }] };
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(1000);
  store.note(user as any);
  store.note(message);
  store.settle(false, 1800);
  const answer = new AssistantMessageComponent(message, true);
  const chat = new Container();
  chat.addChild(answer);
  let rows: string[] = [];
  for (let pass = 0; pass < 3; pass++) rows = chat.render(width);
  return { chat, answer, width, rows, plain: rows.map(visibleText) };
}

/** The `│ … │` cells come off so a row reads as the body's own text. */
function inner(line: string): string {
  return line.replace(/^│ /, "").replace(/ +│$/, "");
}

function click(chat: Container, x: number, y: number, width = W, height = 30) {
  return chat.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false });
}

/** Distinct foreground colours: one means pi had no grammar and painted the block flat. */
function foregrounds(rows: readonly string[]): number {
  return new Set(rows.flatMap((row) => row.match(/\x1b\[38;[0-9;]*m/g) ?? [])).size;
}

test("both fences become rules that join the reply's frame", () => {
  const { plain } = fixture(`Before.\n\n\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const open = plain.findIndex((line) => line.includes(" fish ") && line.includes(CHIP.copy));
  assert.ok(open >= 0, plain.join("\n"));
  assert.match(plain[open]!, new RegExp(`^├─ fish ${CHIP.copy} ─+┤$`), "the language and chip sit on the rule");
  const close = plain.findIndex((line, row) => row > open && /^├─+┤$/.test(line));
  assert.ok(close > open, plain.join("\n"));
  assert.ok(!plain.some((line) => line.includes("```")), "no fence rows left");
  assert.deepEqual(plain.slice(open + 1, close).map(inner), FISH.split("\n").map((line) => `  ${line}`));
});

test("the chip copies the block's own text and says so for a moment", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const { chat, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
    const y = plain.findIndex((line) => line.includes(" fish "));
    click(chat, plain[y]!.indexOf(CHIP.copy), y, W, plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [FISH], "pi's indent and colours are not part of the code");
    const after = chat.render(W).map(visibleText);
    assert.ok(after[y]!.includes(CHIP.copied), after[y]);
  } finally {
    setClipboardWriter(undefined);
  }
});

test("a click off the chip copies nothing and stays pi's selection", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const { chat, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
    const y = plain.findIndex((line) => line.includes(" fish "));
    const onLabel = click(chat, plain[y]!.indexOf("fish"), y, W, plain.length);
    const onCode = click(chat, plain[y + 1]!.indexOf("set"), y + 1, W, plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, []);
    assert.notEqual(onLabel?.handled, true);
    assert.notEqual(onCode?.handled, true);
  } finally {
    setClipboardWriter(undefined);
  }
});

test("the chip lights up and takes the hand while the pointer is on it", () => {
  enableHoverForTests();
  resetHover();
  const { chat, plain } = fixture("```fish\n" + FISH + "\n```\n");
  const y = plain.findIndex((line) => line.includes(` fish ${CHIP.copy} `));
  assert.ok(y >= 0, plain.join("\n"));
  const x = plain[y]!.indexOf(CHIP.copy);
  const move = (cx: number, cy: number) => chat.handleMouse({ type: "move", button: "none", x: cx, y: cy, screenX: cx, screenY: cy, width: W, height: plain.length, shift: false, alt: false, ctrl: false });
  move(x, y);
  const hot = chat.render(W).find((row) => row.includes(CHIP.copy))!;
  assert.ok(/\x1b\[48;/.test(hot), "the chip wears the selected background under the pointer");
  move(x, y + 1);
  const cold = chat.render(W).find((row) => row.includes(CHIP.copy))!;
  assert.ok(!/\x1b\[48;/.test(cold), "and gives it back when the pointer leaves");
  resetHover();
  disableHoverForTests();
});

test("codeBlocks off leaves pi's own fences and code rows", () => {
  const { plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { codeBlocks: false });
  assert.ok(!plain.some((line) => line.includes(CHIP.copy)), plain.join("\n"));
  assert.ok(plain.some((line) => line.includes("```fish")), "the fences are pi's");
  assert.ok(plain.some((line) => inner(line) === `  ${FISH.split("\n")[0]}`), "and so is the indent");
});

test("fish gets a grammar, so its rows are not one flat colour", () => {
  const off = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { codeBlocks: false });
  const on = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const body = ({ rows, plain }: { rows: string[]; plain: string[] }) => {
    const start = plain.findIndex((line) => line.includes("fish")) + 1;
    return rows.slice(start, start + FISH.split("\n").length);
  };
  assert.equal(foregrounds(body(off)), 2, "pi has no fish grammar: the border and one flat colour");
  assert.ok(foregrounds(body(on)) > 2, "bash's grammar colours keywords, strings and comments");
});

test("a diff block goes side by side through the same switch as an edit", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`);
  const open = plain.findIndex((line) => line.includes(" diff ") && line.includes(CHIP.copy));
  assert.ok(open >= 0, plain.join("\n"));
  const panes = plain.slice(open + 1, open + 5).join("\n");
  assert.match(panes, /old\s+│\s+new/, `two labelled panes:\n${panes}`);
  assert.match(panes, /const a = 2;/, panes);
});

test("a narrow row keeps the unified body between the same rules", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`, { width: 60 });
  const open = plain.findIndex((line) => line.includes(" diff "));
  assert.ok(open >= 0, plain.join("\n"));
  assert.deepEqual(plain.slice(open + 1, open + 4).map(inner), DIFF.split("\n").map((line) => `  ${line}`));
});

test("splitDiff off keeps the unified body", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`, { splitDiff: false });
  const open = plain.findIndex((line) => line.includes(" diff "));
  assert.ok(!plain.slice(open + 1).join("\n").includes("old"));
  assert.deepEqual(plain.slice(open + 1, open + 4).map(inner), DIFF.split("\n").map((line) => `  ${line}`));
});

test("an info string shows only its language, and a bare fence says code", () => {
  const withInfo = fixture(`\`\`\`ts title="a.ts"\nconst a = 1;\n\`\`\`\n`);
  const open = withInfo.plain.findIndex((line) => line.includes(" ts "));
  assert.ok(open >= 0, withInfo.plain.join("\n"));
  assert.ok(!withInfo.plain[open]!.includes("title"), "the whole info string is not the label");
  const bare = fixture("```\nplain text\n```\n");
  assert.ok(bare.plain.some((line) => new RegExp(`^├─ code ${CHIP.copy} ─+┤$`).test(line)), bare.plain.join("\n"));
});

test("a railed reply joins the rules to its rail", () => {
  const { plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { replyStyle: "rail" });
  const open = plain.findIndex((line) => line.includes(" fish ") && line.includes(CHIP.copy));
  assert.ok(open >= 0, plain.join("\n"));
  assert.match(plain[open]!, new RegExp(`^├─ fish ${CHIP.copy} ─+$`), "no right corner: a rail has no right edge");
  assert.ok(plain[open]!.endsWith("─"), plain[open]);
});

test("every rule row is exactly the terminal width", () => {
  const { rows } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n\n\`\`\`diff\n${DIFF}\n\`\`\`\n`);
  assert.ok(rows.every((row) => visibleWidth(row) === W), rows.map((row) => `${visibleWidth(row)}:${visibleText(row).slice(0, 12)}`).join("\n"));
});

test("a pi whose Markdown has no renderToken reports no code blocks", () => {
  const proto = Markdown.prototype as unknown as { renderToken?: unknown };
  const original = proto.renderToken;
  assert.equal(codeBlocksAvailable(), true);
  proto.renderToken = undefined;
  try {
    assert.equal(codeBlocksAvailable(), false, "the hook is gone, and the warning path is what runs");
  } finally {
    proto.renderToken = original;
  }
  assert.equal(codeBlocksAvailable(), true);
});

test("copying across a block takes the rules out and keeps the code", () => {
  const { rows, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const open = plain.findIndex((line) => line.includes(" fish ") && line.includes(CHIP.copy));
  const close = plain.findIndex((line, row) => row > open && /^├─+┤$/.test(line));
  const cleaned = cleanTranscriptRows(rows, open, close);
  assert.equal(cleaned.changed, true);
  assert.equal(cleaned.rows[0], null, "the opening rule is chrome");
  assert.equal(cleaned.rows.at(-1), null, "and so is the closing one");
  const text = cleaned.rows.slice(1, -1).filter((row) => row).map((row) => row!.text.trimEnd()).join("\n");
  assert.ok(text.includes("set -l x 1"), text);
  assert.ok(!text.includes("─") && !text.includes(CHIP.copy), text);
});

/**
 * A settled turn with one tool call in it, so the reply can have a header, a rail or a
 * frame depending on what it is. `process` puts the fenced block in the message before
 * the tool: that is the one an open turn hangs on its rail.
 */
function turnFixture(text: string, options: { frame?: boolean; process?: boolean; openTurn?: boolean; width?: number } = {}) {
  const width = options.width ?? W;
  const cwd = process.cwd();
  resetGroups();
  patchToolBoxFrames({ groupTools: true, groupOpen: false, icons: false, splitDiff: true });
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: options.frame ?? true,
    replyStyle: "frame",
    icons: true,
    codeBlocks: true,
    splitDiff: true,
    splitDiffMinWidth: 72,
  });
  const first: any = { role: "assistant", provider: "openai", model: "x", timestamp: 1100, durationMs: 50, stopReason: "toolUse", content: [
    { type: "text", text: options.process ? text : "Checking." },
    { type: "toolCall", id: "a", name: "read", arguments: { path: `${cwd}/src/a.ts` } },
  ] };
  const final: any = { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", timestamp: 1500, durationMs: 40, stopReason: "stop", content: [{ type: "text", text: options.process ? "Done." : text }] };
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(1000);
  store.note(user as any);
  store.note(first);
  store.toolStart("a", undefined);
  store.toolEnd("a", undefined);
  store.note(final);
  store.settle(false, 1800);
  const chat = new Container();
  chat.addChild(new UserMessageComponent("show me"));
  const head = new AssistantMessageComponent(first, true);
  chat.addChild(head);
  const tool = new ToolExecutionComponent("read", "a", first.content[1].arguments, {}, createReadToolDefinition(cwd) as any, { requestRender() {} } as any, cwd);
  tool.setExpanded(false);
  tool.setArgsComplete();
  tool.markExecutionStarted();
  tool.updateResult({ content: [{ type: "text", text: "x" }], isError: false, durationMs: 10 } as any);
  chat.addChild(tool);
  const answer = new AssistantMessageComponent(final, true);
  chat.addChild(answer);
  if (options.openTurn) for (const turn of new Set(store.byMessage.values())) turn.open = true;
  let rows: string[] = [];
  for (let pass = 0; pass < 3; pass++) rows = chat.render(width);
  return { chat, head, answer, width, rows, plain: rows.map(visibleText) };
}

/** Click every chip on the screen, at the column the screen puts it in. */
async function clickEachChip(fx: { chat: Container; width: number; plain: string[] }, written: string[]): Promise<void> {
  written.length = 0;
  for (const [y, line] of fx.plain.entries()) {
    if (!line.includes(CHIP.copy)) continue;
    const x = line.indexOf(CHIP.copy);
    click(fx.chat, x, y, fx.width, fx.plain.length);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a reply with no frame and no header still copies from its chip", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const fx = turnFixture(`Done.\n\n\`\`\`fish\n${FISH}\n\`\`\`\n`, { frame: false });
    const y = fx.plain.findIndex((line) => line.includes(" fish ") && line.includes(CHIP.copy));
    assert.ok(y >= 0, fx.plain.join("\n"));
    assert.ok((fx.answer as any)[TURN_LAYOUT], "the chip is hit through the layout the frame used to bring");
    assert.ok(!fx.plain.some((line) => line.includes("├") || line.includes("╭")), `a reply that asked for no chrome has none:\n${fx.plain.join("\n")}`);
    click(fx.chat, fx.plain[y]!.indexOf(CHIP.copy), y, W, fx.plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [FISH]);
  } finally {
    setClipboardWriter(undefined);
  }
});

test("the chip on a reply with no frame lights up and takes the hand", () => {
  enableHoverForTests();
  resetHover();
  const fx = turnFixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { frame: false });
  const y = fx.plain.findIndex((line) => line.includes(` fish ${CHIP.copy} `));
  assert.ok(y >= 0, fx.plain.join("\n"));
  const x = fx.plain[y]!.indexOf(CHIP.copy);
  const move = (cx: number, cy: number) => fx.chat.handleMouse({ type: "move", button: "none", x: cx, y: cy, screenX: cx, screenY: cy, width: W, height: fx.plain.length, shift: false, alt: false, ctrl: false });
  move(x, y);
  assert.ok(/\x1b\[48;/.test(fx.chat.render(W).find((row) => row.includes(CHIP.copy))!), "the chip wears the selected background");
  move(x, y + 1);
  assert.ok(!/\x1b\[48;/.test(fx.chat.render(W).find((row) => row.includes(CHIP.copy))!), "and gives it back when the pointer leaves");
  resetHover();
  disableHoverForTests();
});

test("a reply with no chip and no frame keeps the fast path", () => {
  const fx = turnFixture("Done, nothing to copy.", { frame: false });
  assert.equal((fx.answer as any)[TURN_LAYOUT], undefined, "no layout, no mouse wrapper, nothing to measure");
  assert.ok(!fx.plain.some((line) => line.includes("─")), fx.plain.join("\n"));
});

test("an open turn's rail joins a code block's rules and keeps its chip live", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const fx = turnFixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { process: true, openTurn: true });
    const open = fx.plain.findIndex((line) => line.includes(" fish ") && line.includes(CHIP.copy));
    assert.ok(open >= 0, fx.plain.join("\n"));
    assert.match(fx.plain[open]!, new RegExp(`^├─ fish ${CHIP.copy} ─+$`), "the rule joins the rail and keeps its own lead");
    assert.equal(visibleWidth(fx.plain[open]!), W, "and runs the full width");
    click(fx.chat, fx.plain[open]!.indexOf(CHIP.copy), open, W, fx.plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [FISH], "the chip on a railed reply copies its block");
    written.length = 0;
    click(fx.chat, fx.plain[open]!.indexOf(CHIP.copy) - 1, open, W, fx.plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [], "the cell in front of it is not the chip");
  } finally {
    setClipboardWriter(undefined);
  }
});

test("a block in a quote or a list item keeps its chip and stays off the frame", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const quoted = FISH.split("\n")[0]!;
    const text = [
      "Quoted:", "", "> ```fish", `> ${quoted}`, "> ```", "",
      "Listed:", "", "1. ```fish", `   ${quoted}`, "   ```", "",
      "Plain:", "", "```fish", FISH, "```",
    ].join("\n");
    const fx = turnFixture(`${text}\n`, { frame: true });
    const rows = fx.plain.map((line, y) => ({ line, y })).filter(({ line }) => line.includes(CHIP.copy));
    assert.equal(rows.length, 3, fx.plain.join("\n"));
    await clickEachChip(fx, written);
    assert.deepEqual(written, [quoted, quoted, FISH], "each chip copies its own block, prefixes and all");
    const joints = fx.plain.filter((line) => line.startsWith("├─") && line.includes(" fish "));
    assert.equal(joints.length, 1, "only the top-level block joins the frame");
    assert.ok(fx.plain.some((line) => line.includes(" 1.  fish ")), "the list's own rule keeps its marker");
  } finally {
    setClipboardWriter(undefined);
  }
});

test("a rule too narrow for its label leaves nothing to click", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const fx = turnFixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { frame: true, width: 12 });
    assert.ok(!fx.plain.some((line) => line.includes(CHIP.copy)), fx.plain.join("\n"));
    for (const [y, line] of fx.plain.entries()) {
      for (let x = 0; x < visibleWidth(line); x++) click(fx.chat, x, y, 12, fx.plain.length);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [], "no chip was drawn, so no cell copies one");
  } finally {
    setClipboardWriter(undefined);
  }
});

test("blocks whose text repeats still each copy their own", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const text = ["```fish", FISH, "```", "Same again:", "```fish", FISH, "```", "And another:", "```ts", "const a = 1;", "```"].join("\n");
    const dup = turnFixture(`${text}\n`, { frame: true });
    await clickEachChip(dup, written);
    assert.deepEqual(written, [FISH, FISH, "const a = 1;"], "a repeated block is the same block, and the third is its own");
  } finally {
    setClipboardWriter(undefined);
  }
});
