/**
 * A `codemode` box with grouping off: the same call list a group opens into,
 * in a frame of its own, under the row a group would show for the call. pi's
 * real ToolExecutionComponent, a renderer that truncates the way pi's codemode
 * renderer does while collapsed, and clicks dispatched through pi-tui's
 * Container the way a terminal click arrives.
 *
 * Runs in its own process, so the options set here stay here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/frame.ts";
import { tidyEnabled } from "../src/live.ts";
import { enableHoverForTests, resetHover } from "../src/hover.ts";

initTheme("dark");
patchToolBoxFrames({ icons: false, groupTools: false });
tidyEnabled.set(true);

const W = 100;
const ui = { requestRender: () => {} };

/**
 * pi's codemode renderer, collapsed and expanded: collapsed it keeps ten script
 * lines, the last eight calls and the head of the output, which is exactly what
 * the framed list must not be built from.
 */
const codemodeDef = {
  name: "codemode",
  renderCall(args: any, _theme: any, context: any) {
    const code = String(args?.code ?? "").split("\n");
    const shown = context.expanded || code.length <= 10
      ? code
      : [...code.slice(0, 10), `... (${code.length - 10} more lines, ctrl+o to expand)`];
    return new Text(["codemode", ...shown].join("\n"), 0, 0);
  },
  renderResult(result: any, options: any) {
    const calls = result.details?.calls ?? [];
    const shown = options.expanded ? calls : calls.slice(-8);
    const rows = shown.map((call: any) => `✓ ${call.name} ${call.args} ${Math.round(call.durationMs)}ms`);
    if (shown.length < calls.length) rows.unshift(`... (${calls.length - shown.length} earlier calls, ctrl+o to expand)`);
    const output = (result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text);
    return new Text([...rows, "", ...output, "", "Took 0.1s"].join("\n"), 0, 0);
  },
};

const CODE = Array.from({ length: 14 }, (_, i) => `const step${i + 1} = await tools.bash({ command: "echo ${i + 1}" });`).join("\n");
const CALLS = Array.from({ length: 10 }, (_, i) => ({
  id: `c/${i + 1}`,
  name: "bash",
  args: JSON.stringify({ command: `echo ${i + 1}` }),
  status: "ok",
  durationMs: 10,
}));

let nextId = 0;

function codemode() {
  const component = new ToolExecutionComponent(
    "codemode",
    `call-${++nextId}`,
    { code: CODE },
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
      content: [{ type: "text", text: "==> text 1/1 <==\nall ten steps done" }],
      isError: false,
      durationMs: 120,
      details: { calls: CALLS },
    } as any,
    false,
  );
  const chat = new Container();
  chat.addChild(component);
  return { component: component as any, chat };
}

const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "").trimEnd();

function frame(chat: Container): string[] {
  return chat.render(W);
}

function mouse(chat: Container, type: "click" | "move", needle: string): unknown {
  const lines = frame(chat).map(strip);
  const row = lines.findIndex((line) => line.includes(needle));
  assert.ok(row >= 0, `no row containing ${JSON.stringify(needle)}:\n${lines.join("\n")}`);
  const x = lines[row]!.indexOf(needle);
  return chat.handleMouse({
    type,
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

test("a framed codemode box is the call list, under the row a group would show", () => {
  const { component, chat } = codemode();
  const lines = frame(chat).map(strip);
  const body = lines.join("\n");
  // The row a group would draw above the box is the box's title, the way a
  // read or write path is: in the top border, not inside it.
  assert.match(lines[0]!, /^╭─ ✓ codemode\s+bash×10\s+0\.1s ─+╮$/, `the summary row is the title:\n${body}`);
  assert.match(lines[1]!, /^│ ▸ script · 14 lines/, `the body starts right under the border:\n${body}`);
  assert.ok(!lines.some((line) => /^│ ✓ codemode/.test(line)), "the row is not repeated as body");
  // pi's collapsed view keeps the last eight calls; the list has all ten.
  for (let i = 1; i <= 10; i++) assert.ok(body.includes(`echo ${i}`), `call ${i} is listed:\n${body}`);
  assert.ok(!body.includes("earlier calls"), "no truncation notice from pi's collapsed view");
  assert.ok(body.includes("▸ script · 14 lines"), `the whole script is counted, not pi's preview:\n${body}`);
  assert.ok(body.includes("▸ output · 1 item"), body);
  assert.ok(!body.includes("const step1"), "the script is folded away");
  assert.ok(!body.includes("all ten steps done"), "the output is folded away");
  assert.ok(!body.includes("Took 0.1s"), "the title carries the time");
  assert.equal(component.expanded, false, "pi's own flag is left alone");
});

test("a fold row opens its own section, in full", () => {
  const { chat } = codemode();
  mouse(chat, "click", "▸ script");
  const body = frame(chat).map(strip).join("\n");
  assert.ok(body.includes("▾ script · 14 lines"), body);
  assert.ok(body.includes("const step14"), "the whole script, past pi's ten-line preview");
  assert.ok(body.includes("▸ output · 1 item"), "the output stays folded");

  mouse(chat, "click", "▾ script");
  assert.ok(frame(chat).map(strip).join("\n").includes("▸ script · 14 lines"), "and shuts again");
});

test("a click anywhere else in the box opens both sections, and the next shuts them", () => {
  const { component, chat } = codemode();
  mouse(chat, "click", "codemode");
  const open = frame(chat).map(strip).join("\n");
  assert.equal(component.expanded, true, "the click expands the box");
  assert.ok(open.includes("▾ script") && open.includes("const step14"), open);
  assert.ok(open.includes("▾ output") && open.includes("all ten steps done"), open);

  mouse(chat, "click", "echo 3");
  const shut = frame(chat).map(strip).join("\n");
  assert.equal(component.expanded, false);
  assert.ok(shut.includes("▸ script") && shut.includes("▸ output"), shut);
});

test("ctrl+o's expand-all opens both sections, and collapse-all shuts them", () => {
  const { component, chat } = codemode();
  component.setExpanded(true);
  const open = frame(chat).map(strip).join("\n");
  assert.ok(open.includes("const step14") && open.includes("all ten steps done"), open);
  component.setExpanded(false);
  const shut = frame(chat).map(strip).join("\n");
  assert.ok(!shut.includes("const step1") && !shut.includes("all ten steps done"), shut);
});

test("the fold row under the pointer wears the band inside the frame, open or shut", () => {
  resetHover();
  enableHoverForTests();
  const { chat } = codemode();
  const band = (needle: string) => {
    const row = frame(chat).find((line) => strip(line).includes(needle));
    assert.ok(row, `no row containing ${needle}`);
    return /\x1b\[48;/.test(row!);
  };

  mouse(chat, "move", "▸ script");
  assert.ok(band("▶ script"), "a shut row lights up and points");
  assert.ok(!band("▸ output"), "only the row under the pointer");

  mouse(chat, "move", "▸ output");
  assert.ok(!band("▸ script"), "the band moves with the pointer");
  assert.ok(band("▶ output"));

  // Open, the row reads the same hovered or not: only the band says which, so
  // the box must not hand back the frame it drew while the row was lit.
  mouse(chat, "click", "▸ script");
  mouse(chat, "move", "▾ script");
  assert.ok(band("▾ script"), "an open row lights up too");
  resetHover(); // the pointer left the box: the alt screen's hook forgets the row
  assert.ok(!band("▾ script"), "and lets go, though its text has not changed");
});
