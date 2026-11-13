/**
 * The whole tool box is the expand switch.
 *
 * A split diff is painted by Tidy, not by pi, so pi's own mouse layout keeps
 * whatever height it measured before the preview arrived — in a real session
 * that is the streaming frame, two or three rows tall. Clicks below it used to
 * fall through and do nothing. These tests click every row of a card, including
 * the borders and the rows an unframed body shifts by the gutter.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";

initTheme("dark");

let renders = 0;
const ui = { requestRender: () => renders++ };
const cwd = process.cwd();
const editDef = createEditToolDefinition(cwd);
const bashDef = createBashToolDefinition(cwd);
const W = 150;

patchToolBoxFrames({ icons: true, groupTools: true, splitDiff: true, splitDiffMinWidth: 72, diffLines: 8 });
resetGroups();

const DIFF = Array.from({ length: 24 }, (_, i) => (i < 12 ? `-${i + 1} old ${i + 1}` : `+${i - 11} new ${i - 11}`)).join("\n");

let nextId = 0;

/**
 * `streamFirst` is the real sequence: pi paints the card while the call runs,
 * long before `details.diff` exists, and only then does the split replace it.
 */
function edit(streamFirst: boolean) {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent(
    "edit",
    id,
    { path: `${cwd}/src/x.ts`, edits: [{ oldText: "a", newText: "b" }] },
    {},
    editDef as any,
    ui as any,
    cwd,
  );
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  if (streamFirst) draw(c);
  c.updateResult(
    {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      durationMs: 20,
      details: { diff: DIFF, firstChangedLine: 1 },
    } as any,
    false,
  );
  return c as any;
}

function bash() {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent("bash", id, { command: "pnpm test" }, {}, bashDef as any, ui as any, cwd);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult(
    {
      content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") }],
      isError: false,
      durationMs: 150,
    } as any,
    false,
  );
  return { id, c: c as any };
}

function draw(component: any, width = W): string[] {
  const host = new Container();
  host.addChild(component);
  after(host, width);
  return host.render(width);
}

/** Let the frame settle: renders that ask for another frame. */
function after(host: Container, width = W): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    const before = renders;
    lines = host.render(width);
    if (renders === before) break;
  }
  return lines;
}

function click(host: Container, y: number, height: number): unknown {
  return host.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: W,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  } as any);
}

test("every row of a streamed split edit box expands it, borders included", () => {
  const preview = new Container();
  const sample = edit(true);
  preview.addChild(sample);
  const height = after(preview).length;
  assert.ok(height > 4, `expected a split body, got ${height} rows`);

  for (let y = 0; y < height; y++) {
    const host = new Container();
    const tool = edit(true);
    host.addChild(tool);
    after(host);
    assert.equal(tool.expanded, false);
    click(host, y, height);
    assert.equal(tool.expanded, true, `row ${y} did not expand the box`);
  }
});

test("every row also folds the expanded box back", () => {
  const host = new Container();
  const tool = edit(true);
  host.addChild(tool);
  const height = after(host).length;
  tool.setExpanded(true);
  after(host);

  for (let y = 0; y < height; y++) {
    tool.setExpanded(true);
    after(host);
    click(host, y, height);
    assert.equal(tool.expanded, false, `row ${y} did not fold the box`);
  }
});

test("the last rows of an unframed box inside an open group are clickable", () => {
  const chat = new Container();
  const a = bash();
  const text = (t: string) =>
    new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop" } as any);
  const textStep = (t: string, id: string) =>
    new AssistantMessageComponent(
      {
        role: "assistant",
        content: [{ type: "text", text: t }, { type: "toolCall", id, name: "bash", arguments: {} }],
        stopReason: "toolUse",
      } as any,
    );
  chat.addChild(textStep("Working.", a.id));
  chat.addChild(a.c);
  chat.addChild(text("Done."));
  resetGroups();

  const rowOf = (needle: string) => after(chat).findIndex((line) => strip(line).includes(needle));
  after(chat);
  // open the group, then the call
  click(chat, rowOf("▸"), 40);
  after(chat);
  click(chat, rowOf("pnpm test"), 40);
  const lines = after(chat);
  assert.equal(a.c.expanded, true, "the call row opened the box");

  const metrics = lines.findIndex((line) => strip(line).includes("Took"));
  assert.ok(metrics > 0, `no metrics row:\n${lines.map(strip).join("\n")}`);
  click(chat, metrics, lines.length);
  assert.equal(a.c.expanded, false, "the metrics row did not fold the box");
});

const strip = (s: string) =>
  s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "");
