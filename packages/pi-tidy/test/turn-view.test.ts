import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, createReadToolDefinition, createEditToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../src/hover.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { cleanTranscriptRows } from "../src/clean-copy.ts";
import { clipToWidth, formatMessageTime, visibleText } from "../src/draw/frame-draw.ts";
import { DEFAULT_TOOL_ICON, toolKindIcon } from "../src/draw/icons.ts";
import { paint } from "../src/draw/paint.ts";
import { folded, TurnStore, TURN_ENTRY, turnOptions, turnStore, type CollapseTurns } from "../src/turns/turn-state.ts";
import { joinBoxCorners, replyLabel, summaryLine, railRows } from "../src/turns/turn-view.ts";
import { getTheme } from "../src/theme-access.ts";
import { jobForTool, noteJobMessage, resetJobs } from "../src/tools/background-jobs.ts";

initTheme("dark");
const cwd = process.cwd();
const W = 100;
const ui = { requestRender() {} } as any;
const user = { role: "user", content: "Fix this", timestamp: 1000 };
const first: any = { role: "assistant", provider: "openai", model: "test", timestamp: 1100, durationMs: 50, stopReason: "toolUse", content: [
  { type: "thinking", thinking: "Inspect the source carefully" }, { type: "text", text: "Checking the implementation." },
  { type: "toolCall", id: "a", name: "read", arguments: { path: `${cwd}/src/a.ts` } },
] };
const middle: any = { ...first, timestamp: 1300, content: [
  { type: "text", text: "Now I will fix the implementation." },
  { type: "toolCall", id: "b", name: "edit", arguments: { path: `${cwd}/src/a.ts`, edits: [{ oldText: "a", newText: "b" }] } },
] };
const final: any = { ...first, provider: "anthropic", model: "claude-sonnet-4-5", timestamp: 1500, stopReason: "stop", content: [
  { type: "thinking", thinking: "Verify the final result carefully" }, { type: "text", text: "Fixed the result.\n\n```ts\nconst value = 2;\n```" },
] };
function fixture(mode: CollapseTurns = "afterRun", settled = true, groupOpen = false, groupTools = true) {
  resetGroups();
  patchToolBoxFrames({ groupTools, groupOpen, icons: false, splitDiff: true });
  turnOptions.set({ ...turnOptions.get(), collapseTurns: mode, frameFinalReply: true, icons: true });
  const store = new TurnStore(); turnStore.set(store);
  store.begin(1000); store.note(user); store.note(first); store.note(middle);
  if (settled) store.note(final);
  const saved = settled ? store.settle(false, 1800) : undefined;
  const chat = new Container();
  chat.addChild(new UserMessageComponent("Fix this"));
  const read = new ToolExecutionComponent("read", "a", first.content[2].arguments, {}, createReadToolDefinition(cwd) as any, ui, cwd);
  read.setExpanded(false); read.setArgsComplete(); read.markExecutionStarted();
  read.updateResult({ content: [{ type: "text", text: "const value = 1;" }], isError: false, durationMs: 10 });
  const edit = new ToolExecutionComponent("edit", "b", middle.content[1].arguments, {}, createEditToolDefinition(cwd) as any, ui, cwd);
  edit.setExpanded(false); edit.setArgsComplete(); edit.markExecutionStarted();
  edit.updateResult({ content: [{ type: "text", text: "updated" }], isError: false, durationMs: 10, details: { diff: "-1 const value = 1;\n+1 const value = 2;", firstChangedLine: 1 } });
  chat.addChild(new AssistantMessageComponent(first, true)); chat.addChild(read);
  chat.addChild(new AssistantMessageComponent(middle, true)); chat.addChild(edit);
  const answer = new AssistantMessageComponent(final, true);
  if (settled) chat.addChild(answer);
  return { chat, store, read, edit, answer, saved };
}
function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let pass = 0; pass < 4; pass++) lines = chat.render(W);
  return lines.map(visibleText);
}
function click(chat: Container, predicate: (line: string) => boolean, last = false) {
  const lines = frame(chat);
  const indices = lines.map((line, index) => predicate(line) ? index : -1).filter((index) => index >= 0);
  const y = last ? indices.at(-1) : indices[0];
  assert.notEqual(y, undefined, lines.join("\n"));
  return chat.handleMouse({ type: "click", button: "left", x: 4, y: y!, screenX: 4, screenY: y!, width: W, height: lines.length, shift: false, alt: false, ctrl: false });
}

test("a folded turn's summary counts what its jobs reported", () => {
  const { store } = fixture("afterRun", true);
  const turn = store.byTool.get("a")!;
  const theme = getTheme()!;
  assert.ok(!summaryLine(turn, theme, W, false, 2000).includes("matched"), "nothing reported yet");
  resetJobs();
  jobForTool({
    toolName: "process", toolCallId: "a", args: { action: "start" }, isPartial: false,
    result: { details: { process: { id: "p1", name: "ticker", status: "running", startTime: 1000 } } },
  });
  noteJobMessage({ customType: "ad-process:notification", details: {
    kind: "log_match", processId: "p1", timestamp: 1900, logMatch: { pattern: "tick", stream: "stdout", line: "tick 5" },
  } });
  const line = summaryLine(turn, theme, W, false, 2000);
  assert.ok(line.includes("1 matched"), line);
  turn.open = true;
  assert.ok(!summaryLine(turn, theme, W, false, 2000).includes("matched"), "opened, the row itself carries it");
  resetJobs(); // the store is global: later fixtures must not inherit this job
});

test("the summary line is cached per frame but rebuilt when a second passes or the turn moves", () => {
  const { store } = fixture("afterRun", false);
  const turn = store.current!;
  const theme = getTheme()!;
  const early = summaryLine(turn, theme, W, false, 2500);
  // 1500 ms and 1600 ms of wall time both read "2s", so the cache may serve.
  assert.equal(summaryLine(turn, theme, W, false, 2600), early);
  assert.notEqual(summaryLine(turn, theme, W, false, 3500), early, "a later second repaints");
  const before = summaryLine(turn, theme, W, false, 4000);
  store.note({ role: "toolResult", toolCallId: "a", toolName: "read", isError: true, content: [], timestamp: 1650 } as any);
  const after = summaryLine(turn, theme, W, false, 4000);
  assert.ok(after.includes("1 failed"), after);
  assert.notEqual(after, before, "a failure the turn gained lands on the next frame");
});

/**
 * The folded turn's summary at `width`. A fresh turn per call: `summaryCache`
 * keys on the turn and the width, and these reads are the same turn twice.
 */
function summaryAt(width: number, icons: boolean): string {
  const { store } = fixture();
  turnOptions.set({ ...turnOptions.get(), icons });
  return summaryLine(store.byTool.get("a")!, getTheme()!, width, false, 4000);
}

test("the summary's counts and its LLM time wear the kind and provider glyphs", () => {
  const line = summaryAt(W, true);
  assert.ok(visibleWidth(line) <= W, line);
  const text = visibleText(line);
  assert.ok(text.includes("\u{f06e} read×1"), text);
  assert.ok(text.includes("\u{f044} edit×1"), text);
  assert.ok(text.includes("\uec82 LLM "), "anthropic's glyph, the one the reply's border draws");
  assert.ok(text.includes("2 calls"), "the call total has no kind to name");
});

test("a row too narrow for the glyphs comes back as the plain line, count for count", () => {
  const icon = summaryAt(W, true);
  const plain = summaryAt(W, false);
  const room = visibleWidth(icon);
  assert.ok(room > visibleWidth(plain), "the glyphs cost cells");
  assert.equal(summaryAt(room, true), icon, "its own width still fits the glyphs");
  const tight = summaryAt(room - 1, true);
  assert.equal(tight, summaryAt(room - 1, false), "the fallback is the current line, byte for byte");
  const text = visibleText(tight);
  assert.ok(!text.includes("\u{f06e}") && !text.includes("\uec82"), text);
  assert.ok(text.includes("read×1") && text.includes("edit×1"), `the tail truncation must not eat a count:\n${text}`);
});

test("with icons off the summary is exactly the line it was before", () => {
  const theme = getTheme()!;
  const muted = (text: string) => theme.fg("muted", text);
  const expected = [
    paint(theme, turnOptions.get().assistantColor, "▸ took 1s"),
    muted("LLM 0s"), muted("tools 0s"), theme.fg("toolTitle", "2 calls"), muted("read×1"), muted("edit×1"),
  ].join(muted(" · "));
  assert.equal(summaryAt(W, false), expected);
  assert.equal(summaryAt(20, false), clipToWidth(expected, 20, "…"), "a clipped line clips the same way");
});

test("codemode has a glyph of its own, one cell wide like its neighbours", () => {
  const glyph = toolKindIcon("codemode");
  assert.notEqual(glyph, DEFAULT_TOOL_ICON);
  assert.equal(visibleWidth(glyph), 1);
  assert.equal(toolKindIcon("no-such-tool"), DEFAULT_TOOL_ICON, "an unmapped name keeps the wrench");
  assert.equal(toolKindIcon("mcp"), "\u{f12e}", "mcp is still its own kind");
});

test("outer fold hides all process including thinking and always-shown edits; summary stays before final reply", () => {
  const { chat } = fixture();
  const folded = frame(chat).join("\n");
  assert.ok(folded.includes("took 1s"));
  assert.match(folded, /took.*\d+ calls/, "folded, the summary is the only count");
  assert.ok(folded.includes("Fixed the result"));
  assert.ok(folded.includes("claude-sonnet-4-5"));
  assert.ok(!folded.includes("Checking the implementation"));
  assert.ok(!folded.includes("thinking"));
  assert.ok(!folded.includes("diff"));
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  assert.ok(opened.join("\n").includes("Checking the implementation"));
  assert.ok(opened.join("\n").includes("diff"));
  assert.equal(opened.filter((line) => line.includes("took")).length, 1);
  assert.doesNotMatch(opened.find((line) => line.includes("took"))!, /calls/, "open, the group headers count the calls");
  assert.ok(opened.findIndex((line) => line.includes("took")) < opened.findIndex((line) => line.includes("Checking the implementation")), "an opened turn keeps its summary at the top");
  assert.ok(opened.findIndex((line) => line.includes("took")) < opened.findIndex((line) => line.includes("claude-sonnet-4-5")));
  click(chat, (line) => line.includes("took"));
  assert.equal(frame(chat).join("\n"), folded);
});

test("an open turn hangs its process on a rail, and the reply stands clear of it at full width", () => {
  const { chat, read } = fixture("afterRun", true, true);
  assert.ok(!frame(chat).some((line) => line.startsWith("│ ▾") || line.startsWith("│ │")), "folded: no rail");
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  const top = opened.findIndex((line) => line.includes("took"));
  const reply = opened.findIndex((line) => line.includes("claude-sonnet-4-5"));
  const process = opened.slice(top + 1, reply).filter((line) => line.trim());
  assert.ok(process.length > 2, opened.join("\n"));
  assert.ok(process.every((line) => line.startsWith("│")), opened.join("\n"));
  assert.ok(process.some((line) => line.startsWith("│ ▾ ") && line.includes("call")), `the group sits one level in:\n${opened.join("\n")}`);
  assert.ok(opened[top]!.startsWith("▾ took"), "the rail runs down from the summary's marker");
  assert.ok(opened[reply]!.startsWith("├─ "), `the rail runs into the reply's corner:\n${opened.join("\n")}`);
  assert.ok(opened.slice(reply + 1).every((line) => !line.startsWith("│ ▾")), opened.join("\n"));
  assert.equal(opened[reply]!.length, W, "the reply keeps the full width");
  assert.ok(opened.every((line) => visibleWidth(line) <= W), opened.join("\n"));

  // A click reaches the call through the rail.
  const y = opened.findIndex((line) => line.startsWith("│ │") && line.includes("read"));
  assert.ok(y >= 0, opened.join("\n"));
  chat.handleMouse({ type: "click", button: "left", x: 20, y, screenX: 20, screenY: y, width: W, height: opened.length, shift: false, alt: false, ctrl: false } as any);
  assert.equal((read as any).expanded, true);

  click(chat, (line) => line.includes("took"));
  const closed = frame(chat);
  assert.ok(!closed.some((line) => line.startsWith("│ ▾") || line.startsWith("│ │")), "folded again: no rail");
  assert.ok(closed.some((line) => line.startsWith("╭─ ") && line.includes("claude-sonnet-4-5")), `no rail, no join:\n${closed.join("\n")}`);
});

test("without a frame the reply still stands clear of the rail, and while running nothing is the reply yet", () => {
  const { chat } = fixture("afterRun", true, true);
  turnOptions.set({ ...turnOptions.get(), frameFinalReply: false });
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  const reply = opened.find((line) => line.includes("Fixed the result"))!;
  assert.ok(!reply.startsWith("│"), opened.join("\n"));
  assert.ok(opened.some((line) => line.startsWith("│ ▾ ")), opened.join("\n"));
  const running = fixture("afterRun", false, true);
  turnOptions.set({ ...turnOptions.get(), frameFinalReply: false });
  const live = frame(running.chat);
  assert.ok(live.some((line) => line.startsWith("│")), live.join("\n"));
  assert.ok(!live.some((line) => line.includes("running") && line.startsWith("│")), "the summary itself is not on the rail");
});

test("a framed box on the rail takes the pointer in its own coordinates", () => {
  const { chat, edit } = fixture("afterRun", true, false);
  click(chat, (line) => line.includes("took"));
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes("x.ts") || line.includes("╭"));
  assert.ok(y >= 0, lines.join("\n"));
  const seen: number[] = [];
  const target = (edit as any).getRenderShell() === "self" ? (edit as any).selfRenderContainer : (edit as any).contentBox;
  const geometry = (edit as any).__frameGeometry;
  assert.ok(geometry, "the edit drew a frame");
  target.handleMouse = (event: any) => { seen.push(event.x); return { handled: true }; };
  // Past the rail and its gap (2) and the left border (1), column 7 of the screen is column 4 of the source.
  (edit as any).handleMouse({ type: "press", button: "left", x: 7, y: geometry.top + 1, width: W, height: 10 });
  assert.deepEqual(seen, [4]);
});

test("the rail takes the colour of the reply it runs into", () => {
  const painted: string[] = [];
  const theme: any = { fg: (color: string, value: string) => { painted.push(color); return value; } };
  railRows(["one"], theme);
  assert.deepEqual(painted, ["accent"]);
});

test("box corners join only where asked, and the frame's other rows stay put", () => {
  const box = ["\x1b[36m╭─ a ─╮\x1b[39m", "│ ╭ x │", "│ ╰ y │", "\x1b[36m╰─────╯\x1b[39m"];
  assert.equal(joinBoxCorners(box, false, false), box);
  assert.deepEqual(joinBoxCorners(box, true, false), ["\x1b[36m├─ a ─╮\x1b[39m", box[1], box[2], box[3]]);
  assert.deepEqual(joinBoxCorners(box, false, true), [box[0], box[1], box[2], "\x1b[36m├─────╯\x1b[39m"]);
  const both = joinBoxCorners(box, true, true);
  assert.equal(joinBoxCorners(box, true, true), both, "the same rows come back as the same array");
  assert.equal(box[0], "\x1b[36m╭─ a ─╮\x1b[39m", "the box's own rows are not written to");
});

test("the rail starts after a row's opening prompt marker", () => {
  const theme: any = { fg: (_: string, value: string) => value };
  const rows = ["\x1b]133;A\x07one", "two\x1b]133;B\x07"];
  const railed = railRows(rows, theme);
  assert.deepEqual(railed, ["\x1b]133;A\x07│one", "│two\x1b]133;B\x07"]);
  assert.equal(railRows(rows, theme), railed, "the same rows come back as the same array");
});

test("with turn folding off there is no rail", () => {
  const { chat } = fixture("off", true, true);
  assert.ok(!frame(chat).some((line) => line.startsWith("│ ▾") || line.startsWith("│ │")), frame(chat).join("\n"));
});

test("outer toggling preserves groupOpen and a manually opened tool box", () => {
  const { chat, read } = fixture("afterRun", true, true);
  click(chat, (line) => line.includes("took"));
  assert.ok(frame(chat).some((line) => line.includes("✓") && line.includes("read")));
  click(chat, (line) => line.includes("✓") && line.includes("read"));
  assert.equal((read as any).expanded, true);
  click(chat, (line) => line.includes("took"));
  click(chat, (line) => line.includes("took"));
  assert.equal((read as any).expanded, true);
  assert.ok(frame(chat).join("\n").includes("const value = 1;"));
});

test("afterRun keeps an active run open; live folds it and replaces its latest text", () => {
  const active = fixture("afterRun", false);
  assert.ok(frame(active.chat).join("\n").includes("Checking the implementation"));
  const live = fixture("live", false);
  assert.ok(!frame(live.chat).join("\n").includes("Checking the implementation"));
  assert.ok(frame(live.chat).join("\n").includes("Now I will fix"));
  live.store.note(final); live.chat.addChild(live.answer);
  assert.ok(!frame(live.chat).join("\n").includes("Now I will fix"));
  assert.ok(!frame(live.chat).join("\n").includes("claude-sonnet-4-5"), "streaming final text is not boxed yet");
  live.store.settle(false, 1800);
  assert.ok(frame(live.chat).join("\n").includes("claude-sonnet-4-5"));
});

test("the final reply frame never carries the message's thinking", () => {
  const { chat } = fixture();
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat).join("\n");
  assert.ok(opened.includes("Fixed the result"));
  assert.ok(!opened.includes("Verify the final result carefully"), "the answer frame holds only the answer");
  assert.ok(opened.includes("Inspect the source carefully"), "process thinking still shows outside it");
});

test("outer folding works without grouping and ctrl+o can open hidden calls", () => {
  const { chat, read, edit } = fixture("afterRun", true, false, false);
  assert.ok(!frame(chat).join("\n").includes("diff"));
  read.setExpanded(true); edit.setExpanded(true);
  assert.ok(frame(chat).join("\n").includes("diff"));
  read.setExpanded(false); edit.setExpanded(false);
  assert.ok(!frame(chat).join("\n").includes("diff"));
});

test("existing component caches cannot retain a previous runtime's turn click handler", () => {
  const { chat, store, saved } = fixture();
  frame(chat);
  const oldTurn = store.byTool.get("a")!;
  const rebuilt = new TurnStore();
  rebuilt.restore([...[user, first, middle, final].map((message) => ({ type: "message", message })),
    { type: "custom", customType: TURN_ENTRY, data: saved }]);
  turnStore.set(rebuilt);
  click(chat, (line) => line.includes("took"));
  assert.equal(folded(rebuilt.byTool.get("a")!), false);
  assert.equal(folded(oldTurn), true);
});

test("provider errors with no text or tools remain visible and can be inspected", () => {
  const error = { ...final, timestamp: 1200, stopReason: "error", content: [], errorMessage: "Provider timed out" };
  for (const historical of [false, true]) {
    const store = new TurnStore(); turnStore.set(store);
    if (historical) store.restore([user, error].map((message) => ({ type: "message", message })));
    else { store.begin(1000); store.note(user); store.note(error); store.settle(false, 1800); }
    turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: true, icons: true });
    const chat = new Container(); chat.addChild(new AssistantMessageComponent(error, true));
    assert.ok(frame(chat).join("\n").includes("error"));
    click(chat, (line) => line.includes("took"));
    assert.ok(frame(chat).join("\n").includes("Provider timed out"));
  }
  const retried = new TurnStore(); turnStore.set(retried);
  retried.begin(1000); retried.note(user); retried.note(error); retried.note(final); retried.settle(false, 1800);
  const chat = new Container(); chat.addChild(new AssistantMessageComponent(error, true)); chat.addChild(new AssistantMessageComponent(final, true));
  const rendered = frame(chat).join("\n");
  assert.ok(rendered.includes("1 LLM failed"));
  assert.ok(rendered.includes("Fixed the result"));
});

test("repeated outer toggling leaves one stable summary and no stale click geometry", () => {
  const { chat } = fixture();
  const initial = frame(chat);
  for (let pass = 0; pass < 30; pass++) {
    click(chat, (line) => line.includes("took"));
    assert.equal(frame(chat).filter((line) => line.includes("took")).length, 1);
    click(chat, (line) => line.includes("took"));
    assert.deepEqual(frame(chat), initial);
  }
});

test("framed reply Markdown retains its native capture target and resized coordinates", () => {
  const { chat, answer } = fixture();
  const markdown = (answer as any).contentContainer.children.find((child: any) => child instanceof Markdown);
  const events: TuiMouseEvent[] = [];
  markdown.handleMouse = (event: TuiMouseEvent) => { events.push(event); return { handled: true, capture: event.type === "press" }; };
  for (const width of [40, 100]) {
    const lines = chat.render(width).map(visibleText);
    const y = lines.findIndex((line) => line.includes("Fixed the result"));
    const x = lines[y].indexOf("Fixed");
    const press: TuiMouseEvent = { type: "press", button: "left", x, y, screenX: x + 7, screenY: y + 19, width, height: lines.length, shift: false, alt: false, ctrl: false };
    const result = chat.handleMouse(press);
    assert.equal(result?.target?.component, markdown);
    assert.equal(events.at(-1)?.width, width - 2);
    assert.equal(events.at(-1)?.x, x - 1);
    assert.equal(events.at(-1)?.y, 0);
    const target = result!.target!;
    chat.render(width);
    target.component.handleMouse?.({ ...press, type: "drag", x: press.screenX - target.originX, y: press.screenY - target.originY, width: target.width, height: target.height });
    assert.equal(events.at(-1)?.y, 0);
  }
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "off", frameFinalReply: false, icons: true });
  const lines = chat.render(W).map(visibleText);
  const y = lines.findIndex((line) => line.includes("Fixed the result"));
  const x = lines[y].indexOf("Fixed");
  const result = chat.handleMouse({ type: "press", button: "left", x, y, screenX: x, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false });
  assert.equal(result?.target?.component, markdown);
  assert.equal(events.at(-1)?.width, W);
  assert.equal(events.at(-1)?.x, x, "turn features off must remove the frame's mouse transform too");
});

test("caught nested failures remain visible, and final framing can be disabled independently", () => {
  const { chat, store } = fixture();
  // A calling tool may succeed while one of its nested calls fails.
  const turn = store.byTool.get("a")!;
  turn.tools.get("a")!.nestedFailed = 1;
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: false, icons: true });
  const lines = frame(chat).join("\n");
  assert.ok(lines.includes("1 nested failed"));
  assert.ok(lines.includes("Fixed the result"));
  assert.ok(!lines.includes("claude-sonnet-4-5"));
  assert.ok(!lines.includes("╭"));
});

test("OSC 133 zones stay at the frame's row edges, never inside it", () => {
  const { chat } = fixture();
  const raw = chat.render(W);
  const start = raw.find((line) => line.includes("\x1b]133;A\x07") && line.includes("Fixed the result"));
  assert.ok(start, "the first body row carries zone A");
  assert.ok(start.startsWith("\x1b]133;A\x07"), "zone A must open the row, before the border");
  assert.ok(start.indexOf("│") > 0, "the border follows the marker");
  // The reply's own last row: a folded turn's hidden rows carry their markers too.
  let end: string | undefined;
  for (let row = raw.length - 1; row >= 0; row--) if (raw[row]!.includes("\x1b]133;B\x07")) { end = raw[row]; break; }
  assert.ok(end, "the last body row carries zone B/C");
  assert.ok(end.endsWith("\x1b]133;B\x07\x1b]133;C\x07"), "zone B/C must close the row, after the border");
});

test("the turn summary lights up and takes the hand like a group row", () => {
  enableHoverForTests();
  resetHover();
  const { chat } = fixture();
  const y = frame(chat).findIndex((line) => line.includes("took"));
  assert.ok(y >= 0);
  const move = (row: number) => chat.handleMouse({ type: "move", button: "none", x: 4, y: row, screenX: 4, screenY: row, width: W, height: 40, shift: false, alt: false, ctrl: false });
  move(y);
  const hot = chat.render(W).find((line) => line.includes("took"))!;
  assert.ok(hot.includes("▶"), "the marker turns solid under the pointer");
  assert.ok(/\x1b\[48;/.test(hot), "the row wears the selected background");
  move(y + 1);
  const cold = chat.render(W).find((line) => line.includes("took"))!;
  assert.ok(cold.includes("▸"));
  assert.ok(!/\x1b\[48;/.test(cold), "the band goes away with the pointer");
  resetHover();
  disableHoverForTests();
});

test("the clock is local and gains a date when it is not today", () => {
  const at = new Date(2026, 10, 1, 9, 5).getTime();
  assert.equal(formatMessageTime(at, "auto", new Date(2026, 10, 1, 23, 0).getTime()), "09:05");
  assert.equal(formatMessageTime(at, "auto", new Date(2026, 10, 2, 1, 0).getTime()), "11-01 09:05");
});

test("a time pattern reads tokens and leaves literal text alone", () => {
  const at = new Date(2026, 10, 5, 13, 9, 32).getTime();
  assert.equal(formatMessageTime(at, "M月D日 HH:mm:ss"), "11月5日 13:09:32");
  assert.equal(formatMessageTime(at, "YYYY-MM-DD H:mm"), "2026-11-05 13:09");
  assert.equal(formatMessageTime(new Date(2026, 0, 2, 3, 4).getTime(), "M/D H MM DD HH"), "1/2 3 01 02 03");
});

test("the final frame takes the assistant color and the time format", () => {
  const { chat } = fixture();
  const options = turnOptions.get();
  turnOptions.set({ ...options, assistantColor: "#cfd1a6", timeFormat: "YYYY" });
  try {
    const rows = chat.render(W);
    const top = rows.find((line) => line.includes("claude-sonnet-4-5"));
    // Truecolor, or the nearest 256-color entry on a terminal without it.
    assert.match(top ?? "", /\x1b\[38;(?:2;207;209;166|5;\d+)m/, "the border is the configured hex");
    assert.ok(top?.includes(String(new Date(final.timestamp).getFullYear())));
  } finally {
    turnOptions.set(options);
  }
});

test("a railed final reply has rules and a left rail, and copies as its text", () => {
  const { chat } = fixture();
  const options = turnOptions.get();
  turnOptions.set({ ...options, replyStyle: "rail" });
  try {
    const rows = chat.render(W);
    const plain = rows.map(visibleText);
    const top = plain.findIndex((line) => line.includes("claude-sonnet-4-5"));
    assert.match(plain[top]!, /^[─├]─* .*claude-sonnet-4-5.* ─+$/);
    assert.ok(!plain[top]!.includes("╮"));
    assert.equal(visibleWidth(rows[top]!), W);
    const bottom = plain.findIndex((line, row) => row > top && /^─+$/.test(line));
    assert.ok(bottom > top + 1);
    assert.equal(visibleWidth(rows[bottom]!), W);
    // A code block's rules meet the rail with a corner, and the rest keep it.
    for (const line of plain.slice(top + 1, bottom)) assert.match(line, /^[│├]/, line);
    const cleaned = cleanTranscriptRows(rows, top, bottom).rows;
    assert.equal(cleaned[0], null);
    assert.equal(cleaned.at(-1), null);
    assert.ok(cleaned.slice(1, -1).every((row) => !row || !row.text.startsWith("│")), cleaned.slice(1, -1).map((row) => (row ? row.text : "NULL")).join("\n"));
    assert.ok(cleaned.some((row) => row?.text.trim() === "const value = 2;"), "the code is still what copies");
  } finally {
    turnOptions.set(options);
  }
});

test("a final reply with only rules has no verticals, keeps its width, and copies as its text", () => {
  const { chat } = fixture();
  const options = turnOptions.get();
  turnOptions.set({ ...options, replyStyle: "rules" });
  try {
    const rows = chat.render(W);
    const plain = rows.map(visibleText);
    const top = plain.findIndex((line) => line.includes("claude-sonnet-4-5"));
    const bottom = plain.findIndex((line, row) => row > top && /^─+$/.test(line));
    assert.ok(bottom > top + 1);
    assert.equal(visibleWidth(rows[top]!), W);
    assert.equal(visibleWidth(rows[bottom]!), W);
    for (const line of plain.slice(top + 1, bottom)) {
      assert.doesNotMatch(line, /^│/);
      assert.doesNotMatch(line, /│\s*$/);
    }
    const cleaned = cleanTranscriptRows(rows, top, bottom).rows;
    assert.equal(cleaned[0], null);
    assert.equal(cleaned.at(-1), null);
    assert.ok(cleaned.slice(1, -1).some((row) => row && row.text.trim().length > 0 && !row.text.startsWith(" ")));
  } finally {
    turnOptions.set(options);
  }
});

test("the final frame carries the message's clock next to the model", () => {
  const { chat } = fixture();
  const top = chat.render(W).find((line) => line.includes("claude-sonnet-4-5"));
  assert.ok(top);
  assert.ok(top.includes(formatMessageTime(final.timestamp)));
});

test("the whale glyph keeps the final frame at the terminal width", () => {
  const { provider, model } = final;
  final.provider = "deepseek";
  final.model = "deepseek-v4-pro";
  try {
    const { chat } = fixture();
    const lines = frame(chat);
    const top = lines.find((line) => line.includes("deepseek-v4-pro"));
    assert.ok(top);
    assert.ok(top.includes("\u{1f433} deepseek-v4-pro"));
    assert.equal(visibleWidth(top), W);
  } finally {
    final.provider = provider;
    final.model = model;
  }
});

test("pure chat gets no empty process summary; the final frame names the model, not the provider", () => {
  const { chat } = fixture("off");
  const plainChat = frame(chat).join("\n");
  assert.ok(!plainChat.includes("took"));
  assert.ok(plainChat.includes("claude-sonnet-4-5"), "the model is the name on the border");
  assert.ok(!plainChat.includes("anthropic"), "the vendor is the glyph's job");
  assert.equal(replyLabel("unknown-provider", "some-model", true), "\u{f06a9} some-model");
  assert.equal(replyLabel("deepseek", "deepseek-chat", true), "\u{1f433} deepseek-chat");
  assert.equal(replyLabel("deepseek", "deepseek-chat", false), "deepseek-chat");
  assert.equal(replyLabel("openai-codex", "gpt-6.1-sol", true), "\uec81 gpt-6.1-sol");
  assert.equal(replyLabel("anthropic", undefined, false), "anthropic", "no model recorded: the provider is the best name left");
  assert.equal(replyLabel(undefined, undefined, true), "\u{f06a9} agent");
  assert.ok(frame(chat).every((line) => visibleWidth(line) <= W));
  const store = new TurnStore(); turnStore.set(store);
  const plain = { ...final, content: [{ type: "text", text: "Just chatting" }] };
  store.begin(1000); store.note(user); store.note(plain); store.settle(false, 1800);
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: true, icons: true });
  const only = new Container(); only.addChild(new AssistantMessageComponent(plain, true));
  const rendered = frame(only).join("\n");
  const raw = only.render(W).join("\n");
  for (const marker of ["A", "B", "C"]) assert.equal((raw.match(new RegExp(`\\x1b\\]133;${marker}\\x07`, "g")) ?? []).length, 1);
  assert.ok(rendered.includes("claude-sonnet-4-5"));
  assert.ok(!rendered.includes("took"));
});
