/** Assistant layout and input must agree after thinking restyles and edge trimming. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/frame.ts";
import { agentRunning, tidyEnabled } from "../src/live.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";

initTheme("dark");
const options = { icons: false, groupTools: true };
patchToolBoxFrames(options);
const strip = (line: string) => line.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "");

beforeEach(() => {
  resetGroups();
  tidyEnabled.set(true);
  agentRunning.set(false);
  patchToolBoxFrames(options);
});

function message(content: any[]) {
  return new AssistantMessageComponent({ role: "assistant", content, stopReason: "stop" } as any, true);
}
const thinking = (text = "Consider the layout.\nAnd its second line.") => ({ type: "thinking", thinking: text });
const text = (value: string) => ({ type: "text", text: value });
const kids = (component: AssistantMessageComponent): any[] => (component as any).contentContainer.children;
function firstMarkdown(component: AssistantMessageComponent) {
  const child = kids(component).find(child => child instanceof Markdown);
  assert.ok(child);
  return child as Markdown & { handleMouse?: (event: TuiMouseEvent) => any };
}

function transcript(component: AssistantMessageComponent) {
  const chat = new Container();
  chat.addChild(new Text("Earlier transcript row", 0, 0));
  chat.addChild(component);
  return chat;
}

function eventAt(chat: Container, needle: string, width = 80, type: TuiMouseEvent["type"] = "press", button: TuiMouseEvent["button"] = "left") {
  const lines = chat.render(width).map(strip);
  const y = lines.findIndex(line => line.includes(needle));
  assert.ok(y >= 0, `missing ${needle}:\n${lines.join("\n")}`);
  const x = lines[y].indexOf(needle);
  return {
    type, button, x, y, screenX: x + 7, screenY: y + 19,
    width, height: lines.length, shift: false, alt: false, ctrl: false,
  } satisfies TuiMouseEvent;
}

/** Stand in for an interactive Markdown extension without taking over its rendering. */
function probe(component: AssistantMessageComponent, needle: string) {
  const markdown = kids(component).find(child => child instanceof Markdown && child.render(80).some((line: string) => strip(line).includes(needle)));
  assert.ok(markdown, `no Markdown containing ${needle}`);
  const events: TuiMouseEvent[] = [];
  markdown.handleMouse = (event: TuiMouseEvent) => {
    events.push(event);
    return { handled: true, ...(event.type === "press" ? { capture: true } : {}) };
  };
  return { markdown, events };
}

for (const width of [36, 80, 120]) {
  for (const shape of ["text", "collapsed", "expanded", "interleaved"] as const) {
    test(`Markdown receives its own coordinates: ${shape}, width ${width}`, () => {
      const component = message([
        ...(shape === "interleaved" ? [thinking("First run."), text("Between runs.")] : []),
        ...(shape !== "text" ? [thinking()] : []),
        text("[COPY]\n\nCode body"),
      ]);
      if (shape === "expanded" || shape === "interleaved") {
        (component as any).thinkingVisibilityOverrides.set(0, false);
        component.updateContent((component as any).lastMessage);
      }
      const { markdown, events } = probe(component, "[COPY]");
      const chat = transcript(component);
      const press = eventAt(chat, "[COPY]", width);
      const result = chat.handleMouse(press);
      const localLines = markdown.render(width).map(strip);
      assert.equal(events.length, 1);
      assert.equal(events[0].y, localLines.findIndex((line: string) => line.includes("[COPY]")));
      assert.equal(events[0].x, press.x);
      assert.equal(events[0].width, width);
      assert.equal(events[0].height, localLines.length);
      assert.equal(events[0].screenY, press.screenY);
      assert.ok(result?.capture);
      assert.ok(result?.target);
      assert.equal(result.target.component, markdown, "capture and multi-click identity stay on the original child");

      // The host uses this target for captured drag/release, even after another render.
      chat.render(width);
      const target = result.target;
      for (const type of ["drag", "release"] as const) {
        target.component.handleMouse?.({
          ...press, type,
          x: press.screenX - target.originX, y: press.screenY - target.originY,
          width: target.width, height: target.height,
        });
      }
      assert.deepEqual(events.map(e => e.type), ["press", "drag", "release"]);
      assert.ok(events.every(e => e.y === events[0].y));

      // A plain click (e.g. folding raw code) must not be swallowed by rethink.
      chat.handleMouse({ ...press, type: "click" });
      assert.equal(events.at(-1)?.type, "click");
      assert.equal(events.at(-1)?.y, events[0].y);
    });
  }
}

test("trimming into a Markdown card keeps its original row coordinates and OSC zones", () => {
  const component = message([text("card")]);
  const markdown = firstMarkdown(component);
  // Like pi-code-render: blank card padding before and after the button.
  markdown.render = () => ["", "  [COPY]", "  code", ""];
  const events: TuiMouseEvent[] = [];
  markdown.handleMouse = (event: TuiMouseEvent) => { events.push(event); return { handled: true }; };
  const chat = transcript(component);
  const lines = chat.render(80);
  assert.ok(lines.some(line => line.includes("\x1b]133;A\x07")));
  assert.ok(lines.some(line => line.includes("\x1b]133;B\x07\x1b]133;C\x07")));
  chat.handleMouse(eventAt(chat, "[COPY]"));
  assert.equal(events[0]?.y, 1, "two trimmed rows: message spacer plus card padding");
  assert.equal(events[0]?.height, 4);
});

test("multiple thinking runs use independent MouseRegions; later Markdown stays interactive", () => {
  const component = message([thinking("Run one."), text("Middle"), thinking("Run two."), text("[COPY]")]);
  const chat = transcript(component);
  for (const needle of ["Run two.", "Run one.", "Run two."]) {
    chat.handleMouse(eventAt(chat, needle, 80, "click"));
    const { events } = probe(component, "[COPY]");
    chat.handleMouse(eventAt(chat, "[COPY]"));
    assert.equal(events[0]?.y, 0);
  }
  const overrides = (component as any).thinkingVisibilityOverrides;
  assert.equal(overrides.get(0), false);
  assert.equal(overrides.get(1), true);
});

test("resizing and replacing streamed text do not retain the previous view", () => {
  const component = message([thinking(), text("A paragraph long enough to wrap on a narrow terminal.\n\n[COPY]")]);
  const chat = transcript(component);
  for (const width of [80, 24, 100]) {
    const { markdown, events } = probe(component, "[COPY]");
    chat.handleMouse(eventAt(chat, "[COPY]", width));
    assert.equal(events[0]?.y, markdown.render(width).map(strip).findIndex((line: string) => line.includes("[COPY]")));
  }
  component.updateContent({ role: "assistant", content: [text("Replacement\n\n[COPY]")], stopReason: "stop" } as any);
  const { markdown, events } = probe(component, "[COPY]");
  chat.handleMouse(eventAt(chat, "[COPY]"));
  assert.equal(events[0]?.y, markdown.render(80).map(strip).findIndex((line: string) => line.includes("[COPY]")));
});

for (const disable of ["grouping", "extension"] as const) {
  test(`disabling ${disable} clears the transformed view and restores native routing`, () => {
    const component = message([thinking(), text("[COPY]")]);
    const chat = transcript(component);
    chat.render(80);
    if (disable === "grouping") patchToolBoxFrames({ ...options, groupTools: false });
    else tidyEnabled.set(false);
    try {
      const { events } = probe(component, "[COPY]");
      chat.handleMouse(eventAt(chat, "[COPY]", 80, "click"));
      assert.equal(events[0]?.y, 0);
      patchToolBoxFrames(options);
      tidyEnabled.set(true);
      chat.handleMouse(eventAt(chat, "[COPY]", 80, "click"));
      assert.equal(events[1]?.y, 0);
    } finally {
      patchToolBoxFrames(options);
      tidyEnabled.set(true);
    }
  });
}

test("focus and capture keep the original child identity across repaints", () => {
  const component = message([thinking(), text("[COPY]")]);
  const markdown = Object.assign(firstMarkdown(component), { handleInput() {} });
  markdown.handleMouse = () => ({ handled: true, focus: true, capture: true });
  const chat = transcript(component);
  for (let i = 0; i < 3; i++) {
    const result = chat.handleMouse(eventAt(chat, "[COPY]"));
    assert.equal(result?.target.component, markdown);
    assert.equal(result?.focusTarget, markdown);
  }
});

for (const withText of [false, true]) {
  test(`a final thinking block preserves OSC zones, withText=${withText}`, () => {
    const component = message([...(withText ? [text("Before thinking.")] : []), thinking()]);
    const chat = transcript(component);
    for (let i = 0; i < 3; i++) {
      const lines = chat.render(80);
      const zones = lines.join("").match(/\x1b\]133;[ABC]\x07/g);
      assert.deepEqual(zones, ["\x1b]133;A\x07", "\x1b]133;B\x07", "\x1b]133;C\x07"]);
      assert.ok(lines.at(-1)?.endsWith("\x1b]133;B\x07\x1b]133;C\x07"));
      chat.handleMouse(eventAt(chat, "thinking", 80, "click"));
    }
  });
}

test("unhandled Markdown events remain available to native selection and scrolling", () => {
  const component = message([thinking(), text("[COPY]")]);
  const markdown = firstMarkdown(component);
  const events: TuiMouseEvent[] = [];
  markdown.handleMouse = (event: TuiMouseEvent) => { events.push(event); return undefined; };
  const chat = transcript(component);
  for (const type of ["press", "drag", "release", "click", "move"] as const) {
    assert.equal(chat.handleMouse(eventAt(chat, "[COPY]", 80, type)), undefined);
  }
  assert.deepEqual(events.map(event => event.type), ["press", "drag", "release", "click", "move"]);
  assert.ok(events.every(event => event.y === 0));
});
