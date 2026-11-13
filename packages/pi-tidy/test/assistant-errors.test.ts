/**
 * A request that fails for good is drawn inside its assistant message, not as
 * a chat row of its own (#45): `Error: 401 …` must wear the same error frame
 * as a retried failure.
 *
 * The patch hooks the message's `updateContent`. 0.7.2's error rows rendered
 * children outside the frame's top-to-bottom pass, and the tool grouping reads
 * that order (see boundary-order.test.ts), so the replay below also asserts
 * that no component renders outside a frame, under the turn options this
 * change can meet. Its own process: the prototype patches are global.
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
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import factory from "../src/index.ts";
import { installErrorLines, patchErrorLines } from "../src/messages/error-lines.ts";
import { getTheme } from "../src/theme-access.ts";
import { turnOptions } from "../src/turns/turn-state.ts";
import { harness, loadTidy } from "./renderer-harness.ts";

initTheme("dark");

// Every render of a container must come from inside a chat frame. Installed
// before tidy, at the bottom of every component's render chain.
let activeChat: Container | undefined;
let depth = 0;
const outOfFrame: string[] = [];
const containerRender = Container.prototype.render;
Container.prototype.render = function (this: Container, width: number) {
  if (this === activeChat) {
    depth++;
    try {
      return containerRender.call(this, width);
    } finally {
      depth--;
    }
  }
  if (activeChat && depth === 0) outOfFrame.push(this.constructor?.name ?? "?");
  return containerRender.call(this, width);
};

const h = harness();
loadTidy(factory, h.pi, { groupTools: true, groupOpen: true, collapseTurns: "afterRun", frameFinalReply: true, icons: false });

const W = 100;
let pending = 0;
const ui = { requestRender: () => pending++ } as any;
const cwd = process.cwd();
const bashDef = createBashToolDefinition(cwd);
const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "").trimEnd();
// A group header; `afterRun` adds the turn's own summary line (`▾ running …`) above it.
const headers = (lines: string[]) => lines.filter((line) => /^\s*(?:│ )?[▾▸] \d+ calls? · /.test(line));
const errorTops = (lines: string[]) => lines.filter((line) => /╭─ error/.test(line));
const BODY = '401: {"message":"API 密钥无效","type":"invalid_api_key"}';

function fire(name: string, event: any = {}): void {
  for (const handler of h.handlers.get(name) ?? []) handler(event, { ui: { notify() {} } });
}

function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = pending;
    lines = chat.render(W).map(strip);
    if (pending === before) break;
  }
  return lines;
}

const failed = (content: unknown[] = [], stopReason = "error", errorMessage = BODY): any => ({
  role: "assistant",
  content,
  stopReason,
  errorMessage,
  timestamp: 1,
  provider: "test",
  model: "test",
});

test("a request that failed with nothing else to show wears the error frame", () => {
  const rows = new AssistantMessageComponent(failed(), false).render(80).map(strip);
  const top = rows.findIndex((line) => /^╭─ error ─+╮$/.test(line));
  assert.ok(top >= 0, `an error frame:\n${rows.join("\n")}`);
  assert.match(rows[top + 1]!, /^│ Error: 401/, "the body keeps pi's text");
  assert.match(rows.at(-1)!, /^╰─+╯$/);
});

test("a length stop with nothing else to show is framed too", () => {
  const rows = new AssistantMessageComponent(failed([], "length", ""), false).render(80).map(strip);
  assert.equal(errorTops(rows).length, 1, rows.join("\n"));
  assert.ok(rows.some((line) => line.includes("Response was truncated")));
});

test("an error after streamed text stays with that text, unframed", () => {
  const rows = new AssistantMessageComponent(failed([{ type: "text", text: "先说一半" }]), false).render(80).map(strip);
  assert.equal(errorTops(rows).length, 0, rows.join("\n"));
  assert.ok(rows.some((line) => line.includes("Error: 401")));
});

test("an abort is the user's own Esc and stays as pi drew it", () => {
  const rows = new AssistantMessageComponent(failed([], "aborted", "Request was aborted"), false).render(80).map(strip);
  assert.equal(errorTops(rows).length, 0, rows.join("\n"));
  assert.ok(rows.some((line) => line.includes("Operation aborted")));
});

test("dedupeErrors: false leaves the line as pi drew it", () => {
  const component = new AssistantMessageComponent(failed(), false);
  patchErrorLines({ enabled: false });
  try {
    const rows = component.render(80).map(strip);
    assert.equal(errorTops(rows).length, 0, rows.join("\n"));
    assert.ok(rows.some((line) => line.includes("Error: 401")));
  } finally {
    patchErrorLines({ enabled: true });
  }
});

let nextId = 0;
let timestamp = Date.now() - 60_000;

/** pi's handlers for one step, a frame after every event. */
function streamStep(chat: Container, calls: number, fail = false): void {
  const message: any = { role: "assistant", content: [], timestamp: timestamp++, provider: "test", model: "test" };
  const component = new AssistantMessageComponent(undefined as any, false);
  chat.addChild(component);
  component.updateContent(structuredClone(message), true);
  fire("message_start", { message: structuredClone(message) });
  frame(chat);
  message.content.push({ type: "thinking", thinking: "" });
  for (const word of ["先", "看看", "这几个目录。"]) {
    message.content[0].thinking += word;
    component.updateContent(structuredClone(message), true);
    fire("message_update", { message: structuredClone(message) });
    frame(chat);
  }
  if (fail) {
    message.stopReason = "error";
    message.errorMessage = BODY;
    component.updateContent(structuredClone(message), false);
    fire("message_end", { message: structuredClone(message) });
    frame(chat);
    return;
  }
  const tools = new Map<string, ToolExecutionComponent>();
  for (let i = 0; i < calls; i++) {
    const id = `call-${++nextId}`;
    message.content.push({ type: "toolCall", id, name: "bash", arguments: { command: `echo ${nextId}` } });
    const snapshot = structuredClone(message);
    component.updateContent(snapshot, true);
    fire("message_update", { message: snapshot });
    const tool = new ToolExecutionComponent("bash", id, snapshot.content.at(-1).arguments, {}, bashDef as any, ui, cwd);
    tool.setExpanded(false);
    chat.addChild(tool);
    tools.set(id, tool);
    frame(chat);
  }
  message.stopReason = "toolUse";
  component.updateContent(structuredClone(message), false);
  fire("message_end", { message: structuredClone(message) });
  for (const tool of tools.values()) tool.setArgsComplete();
  frame(chat);
  for (const [id, tool] of tools) {
    fire("tool_execution_start", { toolCallId: id });
    tool.markExecutionStarted();
    frame(chat);
  }
  for (const [id, tool] of tools) {
    tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 30 } as any);
    fire("tool_execution_end", { toolCallId: id });
    frame(chat);
  }
}

/** One attempt pi retries: added empty, then failed before any output. */
function failedAttempt(chat: Container, error = BODY): AssistantMessageComponent {
  const message: any = { role: "assistant", content: [], timestamp: timestamp++, provider: "test", model: "test" };
  const component = new AssistantMessageComponent(undefined as any, false);
  chat.addChild(component);
  component.updateContent(structuredClone(message), true);
  fire("message_start", { message: structuredClone(message) });
  frame(chat);
  message.stopReason = "error";
  message.errorMessage = error;
  component.updateContent(structuredClone(message), false);
  fire("message_end", { message: structuredClone(message) });
  frame(chat);
  return component;
}

/** pi's `showError` when the retries run out. */
function retriesExhausted(chat: Container, attempts: number, error = BODY): void {
  chat.addChild(new Spacer(1));
  chat.addChild(new Text(getTheme()!.fg("error", `Error: Retry failed after ${attempts} attempts: ${error}`), 1, 0));
  frame(chat);
}

function errorChat(): Container {
  const chat = new Container();
  installErrorLines(chat as any);
  return chat;
}

test("retried attempts that fail the same way share one box, counting as they go", () => {
  const chat = errorChat();
  chat.addChild(new UserMessageComponent("hi"));
  for (let attempt = 1; attempt <= 4; attempt++) {
    failedAttempt(chat);
    const lines = frame(chat);
    assert.equal(errorTops(lines).length, 1, lines.join("\n"));
    assert.match(errorTops(lines)[0]!, attempt === 1 ? /╭─ error ─/ : new RegExp(`╭─ error ×${attempt} ─`), lines.join("\n"));
  }
});

test("pi's 'Retry failed' row takes the place of the attempts' box", () => {
  const chat = errorChat();
  chat.addChild(new UserMessageComponent("hi"));
  for (let attempt = 0; attempt < 4; attempt++) failedAttempt(chat);
  retriesExhausted(chat, 3);
  const lines = frame(chat);
  assert.equal(errorTops(lines).length, 1, lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("Retry failed after 3 attempts")), lines.join("\n"));
  assert.ok(!lines.some((line) => line.includes("×")), lines.join("\n"));
});

test("a retry that succeeds keeps the attempts' box above the reply", () => {
  const chat = errorChat();
  chat.addChild(new UserMessageComponent("hi"));
  failedAttempt(chat);
  failedAttempt(chat);
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "你好" }], stopReason: "stop", timestamp: timestamp++ } as any, false));
  const lines = frame(chat);
  assert.equal(errorTops(lines).length, 1, lines.join("\n"));
  assert.match(errorTops(lines)[0]!, /error ×2/);
  assert.ok(lines.some((line) => line.includes("你好")));
});

test("different failures keep their own boxes", () => {
  const chat = errorChat();
  chat.addChild(new UserMessageComponent("hi"));
  failedAttempt(chat, "429: rate limit");
  failedAttempt(chat, "500: upstream exploded");
  const lines = frame(chat);
  assert.equal(errorTops(lines).length, 2, lines.join("\n"));
  assert.ok(!lines.some((line) => line.includes("×")), lines.join("\n"));
});

test("a resumed session folds the attempts it rebuilds", () => {
  // Resuming builds each message filled in, then adds it to the chat.
  const chat = errorChat();
  chat.addChild(new UserMessageComponent("hi"));
  for (let attempt = 0; attempt < 3; attempt++) chat.addChild(new AssistantMessageComponent(failed(), false));
  const lines = frame(chat);
  assert.equal(errorTops(lines).length, 1, lines.join("\n"));
  assert.match(errorTops(lines)[0]!, /error ×3/);
});

/**
 * Two tool steps, then a step whose request fails, on a chat with the
 * error-row patch. `retries`: pi retries it three more times and gives up.
 */
function failingReply(prompt: string, retries: boolean): { frames: string[][]; streamed: string[]; settled: string[] } {
  const chat = new Container();
  installErrorLines(chat as any);
  activeChat = chat;
  chat.addChild(new UserMessageComponent(prompt));
  fire("before_agent_start");
  fire("agent_start");
  const frames: string[][] = [];
  const watch = chat.render.bind(chat);
  chat.render = (width: number) => {
    const lines = watch(width);
    frames.push(lines.map(strip));
    return lines;
  };
  streamStep(chat, 3);
  streamStep(chat, 3);
  streamStep(chat, 0, true);
  if (retries) {
    for (let attempt = 0; attempt < 3; attempt++) failedAttempt(chat);
    retriesExhausted(chat, 3);
  }
  const streamed = frames.at(-1)!;
  fire("agent_end");
  fire("agent_settled", { aborted: false });
  const settled = frame(chat);
  chat.render = watch;
  activeChat = undefined;
  return { frames, streamed, settled };
}

for (const options of [
  { collapseTurns: "afterRun", frameFinalReply: true },
  { collapseTurns: "off", frameFinalReply: false },
] as const) for (const retries of [false, true]) {
  test(`a reply that ends in a failure keeps its group whole (collapseTurns ${options.collapseTurns}, frameFinalReply ${options.frameFinalReply}${retries ? ", retried" : ""})`, () => {
    turnOptions.set({ ...turnOptions.get(), ...options });
    outOfFrame.length = 0;
    const { frames, streamed, settled } = failingReply(`fail with ${options.collapseTurns}`, retries);
    assert.deepEqual(outOfFrame, [], "a component rendered outside the chat's frame");
    const above = frames.find((lines) => {
      const header = lines.findIndex((line) => /^\s*(?:│ )?[▾▸] \d+ calls? · /.test(line));
      return header > 0 && lines.slice(0, header).some((line) => line.includes("thinking"));
    });
    assert.equal(above, undefined, `a thinking row above the header:\n${above?.join("\n")}`);
    const split = frames.find((lines) => headers(lines).length > 1);
    assert.equal(split, undefined, `a frame drew two headers:\n${split?.join("\n")}`);
    assert.match(headers(streamed)[0] ?? "", /6 calls · bash×6/, streamed.join("\n"));
    assert.equal(errorTops(streamed).length, 1, `one error frame while it streams:\n${streamed.join("\n")}`);
    // A failure with no text is no final reply, and it still stays out of the fold.
    assert.equal(errorTops(settled).length, 1, `one error frame once settled:\n${settled.join("\n")}`);
    if (options.collapseTurns !== "off") assert.match(settled.join("\n"), /▸ .*· error · /, settled.join("\n"));
    // Not a frame inside another frame.
    assert.ok(!settled.some((line) => /^\s*│.*╭─ error/.test(line)), settled.join("\n"));
  });
}
