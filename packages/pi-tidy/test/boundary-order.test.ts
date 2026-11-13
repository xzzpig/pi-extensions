/**
 * The group boundaries are seen through a wrapper on the message components'
 * render, and that wrapper only works while it is the *outermost* layer. A
 * restyle patch that draws on its own and never calls down — tidy's own user
 * message rail or frame, or another extension's — hides it.
 *
 * When it was hidden, the user message stopped opening a group until the first
 * grouped tool rendered and put the wrapper back on top. By then the first
 * reply of the process had already sent part of its calls to the group built
 * at import time; every call after that went to the user message's group, and
 * one reply read as two `▾` headers.
 *
 * This file loads tidy through its entry point, in the order pi does, and
 * replays pi's streaming handlers on its real components. Its own process
 * (node --test isolates files), because the prototype patches are global.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import factory from "../src/index.ts";
import { installErrorLines } from "../src/messages/error-lines.ts";
import { harness, loadTidy } from "./renderer-harness.ts";

initTheme("dark");
const h = harness();
loadTidy(factory, h.pi, { groupTools: true, groupOpen: true, collapseTurns: "off", frameFinalReply: false, icons: false });

const W = 100;
let pending = 0;
const ui = { requestRender: () => pending++ } as any;
const cwd = process.cwd();
const bashDef = createBashToolDefinition(cwd);
const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "").trimEnd();
const headers = (lines: string[]) => lines.filter((line) => /^\s*[▾▸] /.test(line));

function fire(name: string): void {
  for (const handler of h.handlers.get(name) ?? []) handler({}, { ui: { notify() {} } });
}

/** Render until the patch stops asking pi for another frame. */
function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = pending;
    lines = chat.render(W).map(strip);
    if (pending === before) break;
  }
  return lines;
}

let nextId = 0;
let timestamp = 1_000;

/**
 * pi's `message_start` / `message_update` / `message_end` and tool execution
 * handlers for one step: thinking streams in, then `calls` tool calls, then
 * they run in parallel. A frame after every event, the worst case for order.
 */
function streamStep(chat: Container, calls: number): void {
  const message: any = { role: "assistant", content: [], timestamp: timestamp++, provider: "test", model: "test" };
  const component = new AssistantMessageComponent(undefined as any, false);
  chat.addChild(component);
  component.updateContent(structuredClone(message), true);
  frame(chat);
  message.content.push({ type: "thinking", thinking: "" });
  for (const word of ["先", "看看", "这几个目录。"]) {
    message.content[0].thinking += word;
    component.updateContent(structuredClone(message), true);
    frame(chat);
  }
  const tools = new Map<string, ToolExecutionComponent>();
  for (let i = 0; i < calls; i++) {
    const id = `call-${++nextId}`;
    message.content.push({ type: "toolCall", id, name: "bash", arguments: {} });
    for (const args of [{}, { command: `echo ${nextId}` }]) {
      message.content[message.content.length - 1].arguments = args;
      const snapshot = structuredClone(message);
      component.updateContent(snapshot, true);
      for (const block of snapshot.content) {
        if (block.type !== "toolCall") continue;
        const known = tools.get(block.id);
        if (known) {
          known.updateArgs(block.arguments);
          continue;
        }
        const tool = new ToolExecutionComponent("bash", block.id, block.arguments, {}, bashDef as any, ui, cwd);
        tool.setExpanded(false);
        chat.addChild(tool);
        tools.set(block.id, tool);
      }
      frame(chat);
    }
  }
  message.stopReason = "toolUse";
  component.updateContent(structuredClone(message), false);
  for (const tool of tools.values()) tool.setArgsComplete();
  frame(chat);
  for (const tool of tools.values()) {
    tool.markExecutionStarted();
    frame(chat);
  }
  for (const tool of tools.values()) {
    tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 30 } as any);
    frame(chat);
  }
}

/** A user prompt and a two-step reply, the way pi runs one. */
function reply(chat: Container, prompt: string): string[][] {
  chat.addChild(new UserMessageComponent(prompt));
  fire("before_agent_start");
  fire("agent_start");
  const seen: string[][] = [];
  const watch = chat.render.bind(chat);
  chat.render = (width: number) => {
    const lines = watch(width);
    seen.push(lines.map(strip));
    return lines;
  };
  streamStep(chat, 3);
  streamStep(chat, 3);
  chat.render = watch;
  fire("agent_end");
  return seen;
}

test("the first reply of the process streams as one group, not two", () => {
  const chat = new Container();
  const frames = reply(chat, "run it");
  const split = frames.find((lines) => headers(lines).length > 1);
  assert.equal(split, undefined, `a frame drew two headers:\n${split?.join("\n")}`);
  const last = headers(frame(chat));
  assert.equal(last.length, 1);
  assert.match(last[0]!, /6 calls · bash×6 · 2 thoughts/);
});

test("a user message restyled after tidy loaded still opens a group", () => {
  // Another extension draws the user message on its own and never calls
  // down, after tidy's load: the run's start puts the boundary back on top.
  const proto = UserMessageComponent.prototype as any;
  proto.render = function (this: unknown, width: number) {
    return [`» ${(this as any).text ?? ""}`.slice(0, width)];
  };
  const chat = new Container();
  const frames = reply(chat, "again");
  const split = frames.find((lines) => headers(lines).length > 1);
  assert.equal(split, undefined, `a frame drew two headers:\n${split?.join("\n")}`);
  const last = headers(frame(chat));
  assert.equal(last.length, 1);
  // One visible header is not enough: the calls before the wrapper came back
  // would sit in the previous reply's group, out of this count.
  assert.match(last[0]!, /6 calls · bash×6 · 2 thoughts/);
});

test("the error-row patch on the chat does not render a child out of frame order", () => {
  // pi's chat wears tidy's error-row patch (`dedupeErrors`), which looks at
  // every child as it is added. Rendering a child there, outside the frame's
  // top-to-bottom pass, let a tool join its group before the step that issued
  // it — that step then lost the summary line to the call, and its thinking
  // row hung above the header — and read a message pi had not filled in yet
  // as a boundary.
  const chat = new Container();
  installErrorLines(chat as any);
  const frames = reply(chat, "with the error-row patch");
  const above = frames.find((lines) => {
    const header = lines.findIndex((line) => /^\s*[▾▸] /.test(line));
    return header > 0 && lines.slice(0, header).some((line) => line.includes("thinking"));
  });
  assert.equal(above, undefined, `a thinking row above the header:\n${above?.join("\n")}`);
  const split = frames.find((lines) => headers(lines).length > 1);
  assert.equal(split, undefined, `a frame drew two headers:\n${split?.join("\n")}`);
  const last = headers(frame(chat));
  assert.equal(last.length, 1);
  assert.match(last[0]!, /6 calls · bash×6 · 2 thoughts/);
});
