import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { visibleText } from "../src/draw/frame-draw.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { claimHover, disableHoverForTests, enableHoverForTests, resetHover } from "../src/hover.ts";
import { expandTurnForTool, TurnStore, TURN_ENTRY, turnOptions, turnStore, type CollapseTurns } from "../src/turns/turn-state.ts";

initTheme("dark");
const cwd = process.cwd();
const W = 100;
let nextId = 0;

/** No assistant text boundary may mask the boundary supplied by the pinned tool. */
function fixture(mode: CollapseTurns, groupOpen: boolean, pinned = "edit", expanded = false, restored = true) {
  resetGroups(); resetHover();
  patchToolBoxFrames({ groupTools: true, groupOpen, icons: false, alwaysShowTools: ["edit", "write", "codemode"] });
  turnOptions.set({ ...turnOptions.get(), collapseTurns: mode, frameFinalReply: true, icons: false });
  const user = { role: "user", timestamp: 1000, content: "Go" };
  const messages: any[] = ["read", pinned, "read"].map((name, i) => ({
    role: "assistant", timestamp: 1100 + i * 100, provider: "openai", model: "test", durationMs: 10, stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: `THOUGHT_${i}` },
      { type: "toolCall", id: `call-${++nextId}`, name, arguments: name === "edit"
        ? { path: `${cwd}/x.ts`, edits: [{ oldText: "a", newText: "b" }] }
        : name === "write" ? { path: `${cwd}/x.ts`, content: "b" }
        : name === "codemode" ? { code: "text(1)" } : { path: `${cwd}/x.ts` } },
    ],
  }));
  const final: any = { ...messages[0], timestamp: 1500, stopReason: "stop", content: [{ type: "text", text: "Done" }] };
  const chat = new Container(); chat.addChild(new UserMessageComponent("Go"));
  for (const message of messages) {
    chat.addChild(new AssistantMessageComponent(message, true));
    const call = message.content[1];
    const definition = call.name === "read" ? createReadToolDefinition(cwd)
      : call.name === "edit" ? createEditToolDefinition(cwd)
      : call.name === "write" ? createWriteToolDefinition(cwd) : undefined;
    const tool = new ToolExecutionComponent(call.name, call.id, call.arguments, {}, definition as any, { requestRender() {} } as any, cwd);
    tool.setExpanded(expanded && call.name === pinned);
    tool.setArgsComplete(); tool.markExecutionStarted();
    tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 10 });
    chat.addChild(tool);
  }
  chat.addChild(new AssistantMessageComponent(final, true));
  const store = new TurnStore(); turnStore.set(store);
  store.begin(1000);
  for (const message of [user, ...messages, final]) store.note(message, true);
  if (restored) {
    const saved = store.settle(false, 1800);
    store.restore([
      ...[user, ...messages, final].map(message => ({ type: "message", message })),
      { type: "custom", customType: TURN_ENTRY, data: saved },
    ]);
  }
  return { chat, store };
}

function rawFrame(chat: Container): string[] {
  let rows: string[] = [];
  for (let pass = 0; pass < 5; pass++) rows = chat.render(W);
  return rows;
}
const frame = (chat: Container) => rawFrame(chat).map(visibleText);
const headers = (chat: Container) => frame(chat).filter(line => /\b1 call\b/.test(line));
function send(chat: Container, type: "click" | "move", predicate: (line: string, y: number) => boolean) {
  const lines = frame(chat);
  const y = lines.findIndex(predicate);
  assert.ok(y >= 0, lines.join("\n"));
  return chat.handleMouse({ type, button: type === "click" ? "left" : "none", x: 4, y,
    screenX: 4, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
}
const summary = (line: string) => line.includes("took") || line.includes("running");
function openTurn(chat: Container, mode: CollapseTurns) {
  if (mode !== "off") send(chat, "click", summary);
}
function openGroups(chat: Container) {
  for (let group = 0; group < 2; group++) {
    if (headers(chat).some(line => line.includes("▸"))) {
      send(chat, "click", line => /\b1 call\b/.test(line) && line.includes("▸"));
    }
  }
  assert.ok(headers(chat).every(line => line.includes("▾")));
}

test("restored folded turns keep thoughts in the groups split by pinned tools", () => {
  for (const mode of ["off", "afterRun", "live"] as const) for (const groupOpen of [false, true]) {
    for (const pinned of ["edit", "write", "codemode"]) for (const expanded of [false, true]) {
      const { chat } = fixture(mode, groupOpen, pinned, expanded);
      const initial = frame(chat);
      if (mode !== "off") assert.ok(!initial.some(line => line.includes("THOUGHT_")));
      openTurn(chat, mode); openGroups(chat);
      const groups = headers(chat);
      const context = `${mode}, groupOpen=${groupOpen}, ${pinned}, expanded=${expanded}`;
      assert.equal(groups.length, 2, context);
      assert.match(groups[0], /2 thoughts\b/, context);
      assert.match(groups[1], /1 thought\b/, context);
      const rows = frame(chat);
      assert.ok(rows.findIndex(line => line.includes("THOUGHT_2")) > rows.findIndex(line => line === groups[1]), context);
    }
  }
});

test("on the rail, a pinned box joins the groups' rail at the corners that meet it", () => {
  const row = (lines: string[], corner: RegExp) => lines.find((line) => corner.test(line));
  // Whatever `alwaysShowTools` names, not only the file tools.
  for (const pinned of ["edit", "write", "codemode"]) {
    // Open group above, calls below: both corners are joints.
    const open = fixture("afterRun", true, pinned);
    openTurn(open.chat, "afterRun");
    const both = frame(open.chat);
    assert.ok(row(both, /^│ ├─.*╮$/), `${pinned}:\n${both.join("\n")}`);
    assert.ok(row(both, /^│ ├─+╯$/), `${pinned}:\n${both.join("\n")}`);
    assert.ok(!row(both, /^│ [╭╰]/), `${pinned}:\n${both.join("\n")}`);

    // A folded group has no rail, on either side of the box.
    const folded = fixture("afterRun", false, pinned);
    openTurn(folded.chat, "afterRun");
    const neither = frame(folded.chat);
    assert.ok(row(neither, /^│ ╭─.*╮$/), `${pinned}:\n${neither.join("\n")}`);
    assert.ok(row(neither, /^│ ╰─+╯$/), `${pinned}:\n${neither.join("\n")}`);

    // Each corner follows the group on its own side as that group opens and folds.
    const nth = (lines: string[], n: number) => lines.map((line, y) => (/\b1 call\b/.test(line) ? y : -1)).filter((y) => y >= 0)[n]!;
    const toggle = (n: number) => {
      const lines = frame(folded.chat);
      const y = nth(lines, n);
      folded.chat.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
      return frame(folded.chat);
    };
    let lines = toggle(1);
    assert.ok(row(lines, /^│ ╭─.*╮$/) && row(lines, /^│ ├─+╯$/), `the group below opened:\n${lines.join("\n")}`);
    lines = toggle(0);
    assert.ok(row(lines, /^│ ├─.*╮$/) && row(lines, /^│ ├─+╯$/), `both open:\n${lines.join("\n")}`);
    lines = toggle(1);
    assert.ok(row(lines, /^│ ├─.*╮$/) && row(lines, /^│ ╰─+╯$/), `the group below folded:\n${lines.join("\n")}`);
  }

  // With the turn folded, nothing is on a rail.
  const closed = fixture("afterRun", true);
  assert.ok(!frame(closed.chat).some((line) => /^│ ├/.test(line)));
});

test("a pinned box with nothing listed around it keeps its corners", () => {
  resetGroups();
  const { chat } = fixture("off", true);
  const off = frame(chat);
  assert.ok(off.some((line) => line.startsWith("╭─")), `no rail, no joints:\n${off.join("\n")}`);
  assert.ok(!off.some((line) => /^\s*├─.*╮$/.test(line)), off.join("\n"));
});

test("on the rail, no row is wider than the screen, lit or not", () => {
  enableHoverForTests();
  try {
    const { chat } = fixture("afterRun", true);
    frame(chat); openTurn(chat, "afterRun");
    const rows = frame(chat);
    assert.ok(rows.some((line) => line.startsWith("│ │ thinking")), rows.join("\n"));
    for (const [y, line] of rows.entries()) {
      if (!line.startsWith("│")) continue;
      send(chat, "move", (_, at) => at === y);
      for (const drawn of rawFrame(chat)) assert.ok(visibleWidth(drawn) <= W, `hovering ${line}:\n${visibleText(drawn)}`);
    }
  } finally {
    resetHover(); disableHoverForTests();
  }
});

test("a running live-folded turn registers pinned boundaries before settlement", () => {
  const { chat, store } = fixture("live", true, "edit", false, false);
  assert.ok(!frame(chat).some(line => line.includes("THOUGHT_")));
  openTurn(chat, "live");
  assert.match(headers(chat)[0], /2 thoughts\b/);
  assert.match(headers(chat)[1], /1 thought\b/);
  store.settle(false, 1800);
  assert.match(headers(chat)[0], /2 thoughts\b/);
  assert.match(headers(chat)[1], /1 thought\b/);
});

test("closing the first group cannot hide a later group's thinking", () => {
  for (const groupOpen of [false, true]) {
    const { chat } = fixture("afterRun", groupOpen);
    frame(chat); openTurn(chat, "afterRun"); openGroups(chat);
    send(chat, "click", line => /\b1 call\b/.test(line));
    const closed = frame(chat);
    assert.ok(!closed.some(line => line.includes("THOUGHT_0") || line.includes("THOUGHT_1")));
    assert.ok(closed.some(line => line.includes("THOUGHT_2")));
    send(chat, "click", summary); send(chat, "click", summary);
    assert.deepEqual(frame(chat), closed, "outer toggling preserves both groups' independent state");
  }
});

test("turn and group headers on one carrier have independent hover and click targets", () => {
  enableHoverForTests();
  try {
    const { chat } = fixture("afterRun", true);
    frame(chat); openTurn(chat, "afterRun");
    for (const target of [summary, (line: string) => /\b1 call\b/.test(line)]) {
      send(chat, "move", target);
      const lit = rawFrame(chat).filter(line => summary(visibleText(line)) || /\b1 call\b/.test(visibleText(line)))
        .filter(line => /\x1b\[48;/.test(line)).map(visibleText);
      assert.equal(lit.length, 1, lit.join("\n"));
      assert.ok(target(lit[0]));
    }
    send(chat, "click", line => /\b1 call\b/.test(line));
    assert.ok(frame(chat).some(line => line.includes("THOUGHT_2")));
    assert.ok(!frame(chat).some(line => line.includes("THOUGHT_0")));
    send(chat, "click", summary);
    assert.ok(!frame(chat).some(line => line.includes("THOUGHT_")));
  } finally {
    resetHover(); disableHoverForTests();
  }
});

test("a settled carrier hands back the same rows until something on them changes", () => {
  const { chat } = fixture("afterRun", true, "read");
  // Not the group's first step: it has no header, and no other cache above it.
  const carrier = chat.children[3] as any;
  const tool = chat.children[2] as any;
  chat.render(W);
  expandTurnForTool(tool.toolCallId, true);
  chat.render(W);

  // Pi renders the whole transcript per frame: this is what keeps a long one cheap.
  const rows = carrier.render(W);
  assert.match(visibleText(rows.join("\n")), /THOUGHT_1/);
  assert.equal(carrier.render(W), rows, "same array, so the rail's cache hits as well");

  const narrow = carrier.render(W - 20);
  assert.notEqual(narrow, rows, "a new width redraws");
  assert.ok(narrow.every((line: string) => visibleWidth(line) <= W - 20));
  const wide = carrier.render(W);
  assert.deepEqual(wide, rows, "and coming back draws the same bytes");

  enableHoverForTests();
  const before = carrier.render(W);
  claimHover(carrier, "row");
  const lit = carrier.render(W);
  assert.notDeepEqual(lit, before, "the hovered row wears its band");
  claimHover(null, null);
  assert.deepEqual(carrier.render(W), before, "and loses it again");
  disableHoverForTests();

  carrier.lastMessage.content[0].thinking = "A_NEW_THOUGHT";
  assert.match(visibleText(carrier.render(W).join("\n")), /A_NEW_THOUGHT/, "new text is drawn, not served from the last frame");
});
