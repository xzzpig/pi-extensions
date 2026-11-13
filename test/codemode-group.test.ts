/**
 * A grouped `codemode` box end to end: pi's real ToolExecutionComponent, a tool
 * definition that draws the way pi's codemode renderer draws, and clicks
 * dispatched through pi-tui's Container the way a terminal click arrives.
 *
 * The point of the test is the fold: the body opens as a call list, the script
 * and the output sit on one row each, and clicking those rows opens them in
 * place without touching the call rows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { tidyEnabled } from "../src/live.ts";
import { enableHoverForTests, resetHover } from "../src/hover.ts";

initTheme("dark");
patchToolBoxFrames({ icons: false, groupTools: true });
tidyEnabled.set(true);

const W = 80;
const renders = { count: 0 };
const ui = { requestRender: () => renders.count++ };

/** pi's codemode renderer, in the shape the tests need: script, calls, output. */
const codemodeDef = {
  name: "codemode",
  renderCall(args: any) {
    return new Text(["codemode", ...String(args?.code ?? "").split("\n")].join("\n"), 0, 0);
  },
  renderResult(result: any) {
    const calls = result.details?.calls ?? [];
    const rows = calls.map(
      (call: any) => `✓ ${call.name} ${call.args}${call.durationMs ? ` ${Math.round(call.durationMs)}ms` : ""}`,
    );
    const output = (result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text);
    return new Text([...rows, "", ...output, "", "Took 0.1s"].join("\n"), 0, 0);
  },
};

const details = {
  calls: [
    { id: "c/1", name: "bash", args: '{"command":"pwd"}', status: "ok", durationMs: 50 },
    { id: "c/2", name: "read", args: '{"path":"src/app.ts"}', status: "ok", durationMs: 1 },
  ],
};

let nextId = 0;
function codemode() {
  const id = `call-${++nextId}`;
  const component = new ToolExecutionComponent(
    "codemode",
    id,
    { code: "const a = await tools.bash({ command: 'pwd' });" },
    {},
    codemodeDef as any,
    ui as any,
    process.cwd(),
  );
  component.setExpanded(false);
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult(
    {
      content: [{ type: "text", text: "==> text 1/1 <==\n#0 ok exit=0 \"/tmp\"" }],
      isError: false,
      durationMs: 100,
      details,
    } as any,
    false,
  );
  return { id, component };
}

function transcript() {
  const chat = new Container();
  const call = codemode();
  const step = new AssistantMessageComponent(
    { role: "assistant", content: [{ type: "text", text: "Running." }, { type: "toolCall", id: call.id, name: "codemode", arguments: {} }], stopReason: "toolUse" } as any,
  );
  chat.addChild(step);
  chat.addChild(call.component);
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } as any));
  return chat;
}

/** The header opens the group; the call row under it opens the box. */
function openBox(chat: Container) {
  click(chat, "1 call");
  click(chat, "bash×1");
}

const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "").trimEnd();

function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = renders.count;
    lines = chat.render(W);
    if (renders.count === before) break;
  }
  return lines.map(strip);
}

function click(chat: Container, needle: string): unknown {
  const lines = frame(chat);
  const row = lines.findIndex((line) => line.includes(needle));
  assert.ok(row >= 0, `no row containing ${JSON.stringify(needle)}:\n${lines.join("\n")}`);
  const x = lines[row]!.indexOf(needle);
  return chat.handleMouse({
    type: "click",
    button: "left",
    x,
    y: row,
    screenX: x,
    screenY: row,
    width: W,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  } as any);
}

test("an opened codemode call shows its call rows, with the script and output folded", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  const lines = frame(chat);
  const body = lines.join("\n");
  assert.ok(body.includes("▸ script · 1 line"), body);
  assert.ok(body.includes("▸ output · 1 item"), body);
  assert.ok(body.includes("bash"), "call row kept");
  assert.ok(body.includes("read"), "call row kept");
  assert.ok(!body.includes("const a = await"), "script folded away");
  assert.ok(!body.includes("Took 0.1s"), "pi's elapsed row is the row above's job");
});

test("clicking the script row opens it in place, and clicking again closes it", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  click(chat, "▸ script");
  const open = frame(chat).join("\n");
  assert.ok(open.includes("▾ script · 1 line"), open);
  assert.ok(open.includes("const a = await tools.bash"), "script shown");
  assert.ok(open.includes("bash"), "the call rows stay below it");

  click(chat, "▾ script");
  const closed = frame(chat).join("\n");
  assert.ok(closed.includes("▸ script · 1 line"), closed);
  assert.ok(!closed.includes("const a = await"), "script folded away again");
});

test("clicking the output row opens the items, without pi's markers", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  click(chat, "▸ output");
  const body = frame(chat).join("\n");
  assert.ok(body.includes("▾ output · 1 item"), body);
  assert.ok(body.includes('#0 ok exit=0 "/tmp"'), "the item is shown");
  assert.ok(!body.includes("==> text 1/1 <=="), "the marker became the count on the row");
});

test("the fold rows light up under the pointer before they are clicked", () => {
  resetGroups();
  resetHover();
  enableHoverForTests();
  const chat = transcript();
  openBox(chat);

  const rows = frame(chat);
  const row = rows.findIndex((line) => line.includes("▸ script"));
  assert.ok(row >= 0, rows.join("\n"));
  const x = rows[row]!.indexOf("▸ script");
  chat.handleMouse({
    type: "move",
    x,
    y: row,
    screenX: x,
    screenY: row,
    width: W,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
  } as any);
  const hovered = frame(chat).join("\n");
  assert.ok(hovered.includes("▶ script"), hovered);
  assert.ok(!hovered.includes("▸ script"), "only the hovered row changes glyph");
  resetHover();
});

test("every body row starts on the same rail, icons on or off", () => {
  for (const icons of [false, true]) {
    resetGroups();
    patchToolBoxFrames({ icons, groupTools: true });
    const chat = transcript();
    openBox(chat);
    const body = frame(chat).filter((line) => line.trim().startsWith("│"));
    assert.ok(body.length >= 4, body.join("\n"));
    // ` │   │ <row>`: the group's rail, then the body's. The fold labels used to
    // take the kind icon in front of them and lose the column.
    for (const line of body) assert.match(line, /^ │ {3}│ /, line);
  }
  patchToolBoxFrames({ icons: false, groupTools: true });
});
