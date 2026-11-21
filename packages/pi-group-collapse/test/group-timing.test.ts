import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";

let runtime: GroupCollapseRuntime;
let at: number;
let clock: ReturnType<typeof vi.fn<() => number>>;

function receiver(renderCustom = false) {
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    chatContainer: new Container(),
    isInitialized: true,
    programStatus: { handleEvent: () => {} },
    ui: { requestRender: vi.fn() },
    footer: { invalidate: () => {} },
    pendingTools: new Map(),
    entriesRenderedByBoundaryCompaction: new Set(),
    outputPad: 1,
    getMarkdownThemeWithSettings: getMarkdownTheme,
    getMarkdownTransformers: () => [],
    maybeShowThinkingDropNotice: () => {},
    maybeShowCacheMissNotice: () => {},
  }) as {
    chatContainer: Container;
    ui: { requestRender: ReturnType<typeof vi.fn> };
    handleEvent(event: Record<string, unknown>): void;
    streamingComponent?: AssistantMessageComponent;
  };
  Object.defineProperty(host, "session", {
    configurable: true,
    value: {
      extensionRunner: {
        getMessageRenderer: () =>
          renderCustom
            ? (message: { details: { text: string } }) =>
                new Text(
                  Object.keys(message.details).includes("text")
                    ? message.details.text
                    : "field not displayed",
                )
            : undefined,
      },
    },
  });
  return host;
}

let host: ReturnType<typeof receiver>;

function turnStart() {
  runtime.handlePiEvent({ type: "agent_start" });
}

function settle(aborted = false) {
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: aborted ? "aborted" : "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_settled", aborted });
}

function toolEvent(
  id: string,
  type: "start" | "end",
  time: number,
  parent?: string,
) {
  at = time;
  runtime.handlePiEvent({
    type: `tool_execution_${type}`,
    toolCallId: id,
    parentToolCallId: parent,
    isError: false,
  });
}

function tool(id: string) {
  const component = new ToolExecutionComponent(
    "bash",
    id,
    { command: `echo ${id}` },
    {},
    undefined,
    host.ui as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `body ${id}` }], isError: false },
    false,
  );
  host.chatContainer.addChild(component);
  runtime.syncReceiver(host);
  return component;
}

function assistant(content: unknown[] = []) {
  return {
    role: "assistant",
    stopReason: "stop",
    content,
    timestamp: 123,
    model: "test",
  };
}

function thinking(
  index: number,
  content: { type: string; thinking?: string }[],
  time: number,
  phase: "start" | "end",
  providerText = content[index]?.thinking,
) {
  at = time;
  host.handleEvent({
    type: "message_update",
    message: assistant(content),
    assistantMessageEvent: {
      type: `thinking_${phase}`,
      contentIndex: index,
      content: providerText,
    },
  });
}

function transcript(width = 120) {
  return stripTerminalSequences(host.chatContainer.render(width).join("\n"));
}

beforeEach(() => {
  initTheme();
  at = 0;
  clock = vi.fn(() => at);
  runtime = new GroupCollapseRuntime({ notify: () => {} }, clock);
  runtime.onSessionStart({
    mode: "tui",
    cwd: "/tmp/no-config-group-timing",
    getBranch: () => [],
  });
  // Avoid actual agent configuration influencing admission in the tests.
  runtime.debugApplyPolicyRules([]);
  host = receiver();
});

afterEach(() => runtime.onSessionShutdown());

test("thinking, a gap and overlapping tools produce one stable span, not an accumulated duration", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const blocks = [
    { type: "thinking", thinking: "alpha" },
    { type: "thinking", thinking: "beta" },
  ];
  thinking(0, blocks.slice(0, 1), 0, "start");
  thinking(0, blocks.slice(0, 1), 100, "end");
  thinking(1, blocks, 150, "start");
  thinking(1, blocks, 550, "end");
  host.handleEvent({ type: "message_end", message: assistant(blocks) });
  toolEvent("a", "start", 1500);
  tool("b");
  toolEvent("b", "start", 2000);
  toolEvent("a", "end", 2500);
  tool("a");
  toolEvent("b", "end", 3200);
  expect(transcript()).not.toContain("耗时");
  at = 5000;
  settle();
  expect(transcript()).toMatch(/▸ 耗时 3\.2s · 分组 .*思考×1.*bash×2/u);
  const builds = runtime.debugIndexBuilds();
  host.ui.requestRender.mockClear();
  at = 25000;
  expect(transcript()).toContain("耗时 3.2s");
  expect(runtime.debugIndexBuilds()).toBe(builds);
  expect(host.ui.requestRender).not.toHaveBeenCalled();
  expect(runtime.expandAll()).toBe(1);
  expect(transcript()).toMatch(/▾.*耗时 3\.2s/u);
});

test("one turn can have different spans, including a pure thinking group", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const a = { type: "thinking", thinking: "Rendered label · first" };
  const b = { type: "thinking", thinking: "second" };
  const boundary = { type: "text", text: "keep visible" };
  thinking(0, [a], 100, "start");
  thinking(0, [a], 600, "end", "first");
  thinking(2, [a, boundary, b], 800, "start");
  thinking(2, [a, boundary, b], 1700, "end");
  host.handleEvent({
    type: "message_end",
    message: assistant([a, boundary, b]),
  });
  settle();
  expect(transcript()).toMatch(
    /耗时 0\.5s[\s\S]*keep visible[\s\S]*耗时 0\.9s/u,
  );
});

test.each(["replacement thought", " \t\n "])(
  "outside text preserves timings; changing the second run to %j revokes only its proof",
  (replacement) => {
    turnStart();
    host.handleEvent({ type: "message_start", message: assistant() });
    const component = host.streamingComponent!;
    const firstThought = vi.fn(() => "first thought");
    const first = {
      type: "thinking",
      get thinking() {
        return firstThought();
      },
    };
    const invisible = { type: "thinking", thinking: "" };
    const middle = { type: "text", text: "initial separator" };
    const redundant = { type: "text", text: "extra separator paragraph" };
    const second = { type: "thinking", thinking: "second thought" };
    const reply = { type: "text", text: "initial answer" };
    thinking(0, [first], 100, "start");
    thinking(0, [first], 1100, "end");
    thinking(4, [first, invisible, middle, redundant, second], 1200, "start");
    thinking(4, [first, invisible, middle, redundant, second], 3200, "end");
    const originalExtra = { type: "text", text: "original extra answer" };
    const final = assistant([
      first,
      invisible,
      middle,
      redundant,
      second,
      reply,
      originalExtra,
    ]);
    host.handleEvent({ type: "message_end", message: final });
    settle();
    expect(transcript()).toMatch(/耗时 1\.0s[\s\S]*耗时 2\.0s/u);
    const builds = runtime.debugIndexBuilds();

    middle.text = " \n ";
    redundant.text = " \t ";
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(/耗时 1\.0s[\s\S]*耗时 2\.0s/u);
    expect(runtime.debugIndexBuilds()).toBe(builds);
    redundant.text = "extra separator paragraph";
    middle.text = "new visible separator";
    reply.text = "new visible answer";
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(
      /耗时 1\.0s[\s\S]*new visible separator[\s\S]*耗时 2\.0s[\s\S]*new visible answer/u,
    );
    expect(runtime.debugIndexBuilds()).toBe(builds);

    redundant.text = " \n ";
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(
      /耗时 1\.0s[\s\S]*new visible separator[\s\S]*耗时 2\.0s/u,
    );
    expect(transcript()).not.toContain("extra separator paragraph");
    expect(runtime.debugIndexBuilds()).toBe(builds);
    final.content.splice(3, 1);
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(/耗时 1\.0s[\s\S]*耗时 2\.0s/u);
    expect(runtime.debugIndexBuilds()).toBe(builds);

    final.content.pop();
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(
      /耗时 1\.0s[\s\S]*耗时 2\.0s[\s\S]*new visible answer/u,
    );
    expect(transcript()).not.toContain("original extra answer");
    expect(runtime.debugIndexBuilds()).toBe(builds);

    final.content.push(originalExtra, {
      type: "text",
      text: "appended visible answer",
    });
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(
      /耗时 1\.0s[\s\S]*耗时 2\.0s[\s\S]*appended visible answer/u,
    );
    expect(runtime.debugIndexBuilds()).toBe(builds);

    firstThought.mockClear();
    for (let i = 0; i < 5; i++) runtime.syncReceiver(host);
    expect(firstThought).not.toHaveBeenCalled();

    invisible.thinking = " \t\n ";
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(/耗时 1\.0s[\s\S]*耗时 2\.0s/u);
    expect(runtime.debugIndexBuilds()).toBe(builds);

    // Remove every visible trailing answer while leaving the inter-run
    // separator untouched. A tail is not a boundary between these runs.
    final.content.splice(4);
    reply.text = " \n ";
    final.content.push(reply);
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(
      /耗时 1\.0s[\s\S]*new visible separator[\s\S]*耗时 2\.0s/u,
    );
    expect(transcript()).not.toContain("new visible answer");
    expect(runtime.debugIndexBuilds()).toBe(builds);
    reply.text = "restored visible answer";
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(
      /耗时 1\.0s[\s\S]*耗时 2\.0s[\s\S]*restored visible answer/u,
    );
    expect(runtime.debugIndexBuilds()).toBe(builds);

    final.content.unshift({ type: "text", text: "inserted leading answer" });
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript()).toMatch(
      /inserted leading answer[\s\S]*耗时 1\.0s[\s\S]*耗时 2\.0s/u,
    );
    expect(runtime.debugIndexBuilds()).toBe(builds);

    second.thinking = replacement;
    component.updateContent(final as never, false);
    host.chatContainer.invalidate();
    expect(transcript().match(/耗时/g)).toHaveLength(1);
    expect(transcript()).toMatch(/耗时 1\.0s[\s\S]*new visible separator/u);
    if (replacement.trim()) {
      expect(transcript()).toMatch(
        /new visible separator[\s\S]*▸ 分组 思考×1/u,
      );
      runtime.expandAll();
      expect(transcript()).toMatch(/耗时 1\.0s[\s\S]*replacement thought/u);
    }
    expect(transcript()).not.toContain("耗时 2.0s");
  },
);

test("old assistant repaints cannot split a newer active tool group", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const component = host.streamingComponent!;
  const first = { type: "thinking", thinking: "old first" };
  const separator = { type: "text", text: "old separator" };
  const second = { type: "thinking", thinking: "old second" };
  const reply = { type: "text", text: "old answer" };
  thinking(0, [first], 100, "start");
  thinking(0, [first], 1100, "end");
  thinking(2, [first, separator, second], 1200, "start");
  thinking(2, [first, separator, second], 3200, "end");
  const final = assistant([first, separator, second, reply]);
  host.handleEvent({ type: "message_end", message: final });
  settle();
  expect(transcript()).toMatch(/耗时 1\.0s[\s\S]*耗时 2\.0s/u);

  final.content.unshift({ type: "text", text: "old leading answer" });
  component.updateContent(final as never, false);
  runtime.syncReceiver(host);
  turnStart();
  tool("new-a");
  toolEvent("new-a", "start", 5000);
  toolEvent("new-a", "end", 5500);

  const repainted = assistant(
    final.content.map((block) =>
      block === second ? { type: "thinking", thinking: " \n " } : block,
    ),
  );
  component.updateContent(repainted as never, false);
  host.chatContainer.invalidate();
  runtime.syncReceiver(host);
  tool("new-b");
  toolEvent("new-b", "start", 6000);
  toolEvent("new-b", "end", 6500);
  settle();
  const output = transcript();
  expect(output).toContain("耗时 1.0s");
  expect(output).not.toContain("耗时 2.0s");
  expect(output).toContain("耗时 1.5s · 分组 工具调用×2 · bash×2");
  expect(output).not.toContain("bash×1");
});

test("stable host rebuilds never serialize an already observed long thought", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const component = host.streamingComponent!;
  const block = {
    type: "thinking",
    thinking: "observed long thought ".repeat(5300),
  };
  thinking(0, [block], 100, "start");
  thinking(0, [block], 1700, "end");
  const final = assistant([block]);
  host.handleEvent({ type: "message_end", message: final });
  settle();
  expect(transcript()).toContain("耗时 1.6s");
  const indexBuilds = runtime.debugIndexBuilds();
  const stringify = vi.spyOn(JSON, "stringify");
  let repaintsWithTiming = 0;
  let serializations = -1;
  try {
    for (let i = 0; i < 100; i++) {
      component.updateContent(final as never, false);
      host.chatContainer.invalidate();
      if (transcript().includes("耗时 1.6s")) repaintsWithTiming += 1;
    }
    serializations = stringify.mock.calls.length;
  } finally {
    stringify.mockRestore();
  }
  expect(serializations).toBe(0);
  expect(repaintsWithTiming).toBe(100);
  expect(runtime.debugIndexBuilds()).toBe(indexBuilds);
}, 30000);

test("unobserved replacements revoke a previously completed thinking interval, even in place", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const component = host.streamingComponent!;
  const block = { type: "thinking", thinking: "original" };
  thinking(0, [block], 100, "start");
  thinking(0, [block], 2000, "end");
  const final = assistant([block]);
  host.handleEvent({ type: "message_end", message: final });
  settle();
  expect(transcript()).toContain("耗时 1.9s");
  component.updateContent(final as never, false);
  expect(transcript()).toContain("耗时 1.9s");
  block.thinking = "new, not observed";
  component.updateContent(final as never, false);
  expect(transcript()).toMatch(/▸ 分组 思考×1/u);
  expect(transcript()).not.toContain("耗时");
  runtime.expandAll();
  expect(transcript()).toMatch(/▾ 分组 思考×1/u);
  expect(transcript()).not.toContain("耗时");
});

test("streaming deltas and stable frames do not read the timing clock", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const block = { type: "thinking", thinking: "a" };
  thinking(0, [block], 100, "start");
  expect(clock).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) {
    block.thinking += "a";
    host.handleEvent({
      type: "message_update",
      message: assistant([block]),
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
  }
  expect(clock).toHaveBeenCalledTimes(1);
  thinking(0, [block], 700, "end");
  host.handleEvent({ type: "message_end", message: assistant([block]) });
  settle();
  expect(transcript()).toContain("耗时 0.6s");
  transcript();
  expect(clock).toHaveBeenCalledTimes(2);
});

test("disagreeing host and model run boundaries cannot attribute a partial span", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const first = { type: "thinking", thinking: "first" };
  const second = { type: "thinking", thinking: "second" };
  const blocks = [first, { type: "unknown" }, second];
  thinking(0, [first], 100, "start");
  thinking(0, [first], 400, "end");
  thinking(2, blocks, 600, "start");
  thinking(2, blocks, 1200, "end");
  host.handleEvent({ type: "message_end", message: assistant(blocks) });
  toolEvent("tail", "start", 1500);
  tool("tail");
  toolEvent("tail", "end", 2300);
  settle();
  expect(transcript()).not.toContain("耗时");
});

test("incomplete thinking and nested tool events do not yield a partial span", () => {
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  const blocks = [{ type: "thinking", thinking: "missing start" }];
  thinking(0, blocks, 400, "end");
  host.handleEvent({ type: "message_end", message: assistant(blocks) });
  tool("top");
  toolEvent("top", "start", 500, "parent");
  toolEvent("top", "end", 1500);
  settle();
  expect(transcript()).toContain("bash×1");
  expect(transcript()).not.toContain("耗时");
});

test("abnormal deferral never counts the wait for the later turn", () => {
  turnStart();
  toolEvent("a", "start", 500);
  tool("a");
  toolEvent("a", "end", 1400);
  at = 5100;
  settle(true);
  expect(transcript()).not.toContain("耗时");
  turnStart();
  toolEvent("b", "start", 12000);
  tool("b");
  toolEvent("b", "end", 12200);
  at = 16000;
  settle();
  expect(transcript()).toMatch(/耗时 0\.9s[\s\S]*耗时 0\.2s/u);
});

test("actual custom and notification appearances provide points; reuse replaces the old point", () => {
  runtime.debugApplyPolicyRules([
    { kind: "customMessage", customType: "included", action: "group" },
    { kind: "notification", textPrefix: "included", action: "group" },
  ]);
  turnStart();
  const notification = new Text("included initial");
  host.chatContainer.addChild(notification);
  at = 100;
  runtime.debugRegisterNotification(notification, "info", "included initial");
  at = 600;
  runtime.debugRegisterNotification(
    notification,
    "warning",
    "included replacement",
  );
  at = 1700;
  host.handleEvent({
    type: "message_start",
    message: {
      role: "custom",
      customType: "included",
      display: true,
      content: "custom",
      timestamp: 123,
    },
  });
  settle();
  expect(transcript()).toMatch(/耗时 1\.1s · 分组 消息×2 · 通知警告×1/u);
});

test.each(["replace", "mutate"] as const)(
  "a custom message array %s revokes its appearance interval",
  (change) => {
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "included", action: "group" },
    ]);
    turnStart();
    const first = {
      role: "custom",
      customType: "included",
      display: true,
      content: [{ type: "text", text: "first" }],
      timestamp: 123,
    };
    const second = {
      ...first,
      content: [{ type: "text", text: "second" }],
      timestamp: 124,
    };
    at = 100;
    host.handleEvent({ type: "message_start", message: first });
    at = 1700;
    host.handleEvent({ type: "message_start", message: second });
    settle();
    expect(transcript()).toContain("耗时 1.6s · 分组 消息×2");
    const component = host.chatContainer.children.at(-1);
    expect(component).toBeInstanceOf(CustomMessageComponent);
    if (!(component instanceof CustomMessageComponent))
      throw new Error("Missing live custom component");
    host.chatContainer.invalidate();
    expect(transcript()).toContain("耗时 1.6s · 分组 消息×2");
    if (change === "replace")
      second.content = [{ type: "text", text: "new body" }];
    else second.content[0].text = "new body";
    host.chatContainer.invalidate();
    expect(transcript()).toContain("new body");
    expect(transcript()).not.toContain("耗时");
    turnStart();
    settle();
    expect(transcript()).toContain("▸ 分组 消息×2");
    expect(transcript()).not.toContain("耗时");
    expect(runtime.expandAll()).toBe(1);
    expect(transcript()).toContain("▾ 分组 消息×2");
    expect(transcript()).toContain("new body");
    expect(transcript()).not.toContain("耗时");
  },
);

test.each(["replace", "mutate", "hide field"] as const)(
  "custom renderer details %s does not time or reopen the group on repaint",
  (change) => {
    host = receiver(true);
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "included", action: "group" },
    ]);
    turnStart();
    const first = {
      role: "custom",
      customType: "included",
      display: true,
      content: "fixture",
      details: { text: "first" },
      timestamp: 1,
    };
    const second = { ...first, details: { text: "second" }, timestamp: 2 };
    at = 100;
    host.handleEvent({ type: "message_start", message: first });
    at = 1700;
    host.handleEvent({ type: "message_start", message: second });
    settle();
    expect(transcript()).toContain("▸ 分组 消息×2");
    expect(transcript()).not.toContain("耗时");
    if (change === "replace") second.details = { text: "new details" };
    else if (change === "mutate") second.details.text = "new details";
    else Object.defineProperty(second.details, "text", { enumerable: false });
    const expected =
      change === "hide field" ? "field not displayed" : "new details";
    host.chatContainer.invalidate();
    expect(transcript()).not.toContain(expected);
    expect(transcript()).toContain("▸ 分组 消息×2");
    expect(transcript()).not.toContain("耗时");
    runtime.expandAll();
    expect(transcript()).toContain("▾ 分组 消息×2");
    expect(transcript()).toContain(expected);
    expect(transcript()).not.toContain("耗时");
  },
);

test("untrusted custom metadata never runs proxy traps or interrupts host repaint", () => {
  runtime.debugApplyPolicyRules([
    { kind: "customMessage", customType: "included", action: "group" },
  ]);
  const ownKeys = vi.fn(() => {
    throw new Error("must not reflect on proxy");
  });
  const message = {
    role: "custom",
    customType: "included",
    display: true,
    content: "original",
    timestamp: 1,
    details: {},
  };
  turnStart();
  host.handleEvent({ type: "message_start", message });
  settle();
  expect(transcript()).toContain("耗时 0.0s");
  message.details = new Proxy({}, { ownKeys });
  message.content = "body after opaque update";
  expect(() => host.chatContainer.invalidate()).not.toThrow();
  expect(transcript()).toContain("body after opaque update");
  expect(transcript()).not.toContain("耗时");
  expect(ownKeys).not.toHaveBeenCalled();
  const getter = vi.fn(() => {
    throw new Error("must not read details getter");
  });
  Object.defineProperty(message, "details", { get: getter });
  message.content = "body after getter update";
  expect(() => host.chatContainer.invalidate()).not.toThrow();
  expect(transcript()).toContain("body after getter update");
  expect(transcript()).not.toContain("耗时");
  expect(getter).not.toHaveBeenCalled();
});

test("replacing an equal object breaks the originally observed renderer reference relationship", () => {
  host = receiver(false);
  Object.defineProperty(host, "session", {
    value: {
      extensionRunner: {
        getMessageRenderer:
          () =>
          (message: {
            details: { primary: { text: string }; selected: { text: string } };
          }) =>
            new Text(
              message.details.primary === message.details.selected
                ? "selected is primary"
                : "selected is independent",
            ),
      },
    },
  });
  runtime.debugApplyPolicyRules([
    { kind: "customMessage", customType: "included", action: "group" },
  ]);
  const primary = { text: "same" };
  const message = {
    role: "custom",
    customType: "included",
    display: true,
    content: "fallback",
    timestamp: 1,
    details: { primary, selected: primary },
  };
  turnStart();
  host.handleEvent({ type: "message_start", message });
  settle();
  expect(transcript()).not.toContain("耗时");
  message.details.selected = { text: "same" };
  host.chatContainer.invalidate();
  expect(transcript()).toContain("▸ 分组 消息×1");
  runtime.expandAll();
  expect(transcript()).toContain("selected is independent");
  expect(transcript()).not.toContain("耗时");
});

test("default message metadata change only withdraws timing, not its fold", () => {
  runtime.debugApplyPolicyRules([
    { kind: "customMessage", customType: "included", action: "group" },
  ]);
  const message = {
    role: "custom",
    customType: "included",
    display: true,
    content: "body",
    timestamp: 1,
    details: { version: 1 },
  };
  turnStart();
  host.handleEvent({ type: "message_start", message });
  settle();
  expect(transcript()).toContain("▸ 耗时 0.0s · 分组 消息×1");
  message.details.version += 1;
  host.chatContainer.invalidate();
  expect(transcript()).toContain("▸ 分组 消息×1");
  expect(transcript()).not.toContain("耗时");
});

test("default text block metadata can revoke evidence without revealing the group", () => {
  runtime.debugApplyPolicyRules([
    { kind: "customMessage", customType: "included", action: "group" },
  ]);
  const block = { type: "text", text: "body", textSignature: "first" };
  const first = {
    role: "custom",
    customType: "included",
    display: true,
    content: "first",
    timestamp: 1,
  };
  const second = { ...first, content: [block], timestamp: 2 };
  turnStart();
  at = 100;
  host.handleEvent({ type: "message_start", message: first });
  at = 1700;
  host.handleEvent({ type: "message_start", message: second });
  settle();
  expect(transcript()).toContain("▸ 耗时 1.6s · 分组 消息×2");
  block.textSignature = "replacement proof";
  host.chatContainer.invalidate();
  expect(transcript().trim()).toBe("▸ 分组 消息×2");
});

test.each([undefined, null, 0, 4096, 4097])(
  "restored custom message (%s blocks) keeps its historical fold",
  (count) => {
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "included", action: "group" },
    ]);
    const custom = {
      type: "custom_message",
      id: "history-custom",
      parentId: "user",
      customType: "included",
      display: true,
      timestamp: "2026-11-21T00:00:00.000Z",
      ...(count === undefined
        ? {}
        : {
            content:
              count === null
                ? null
                : Array.from({ length: count }, () => ({
                    type: "text",
                    text: "history",
                  })),
          }),
    };
    const branch = [
      { type: "message", id: "user", message: { role: "user" } },
      custom,
      {
        type: "message",
        id: "done",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      },
    ];
    runtime.rebuildCurrentView(() => branch as never);
    const [rendered] = sessionEntryToContextMessages(custom as never);
    host.chatContainer.addChild(
      new CustomMessageComponent(rendered as never, undefined),
    );
    runtime.syncReceiver(host);
    expect(runtime.currentSegmentsForTest()).toHaveLength(1);
    expect(transcript().trim()).toBe("▸ 分组 消息×1");
  },
);

test("opaque renderer state changes and a throwing array map accessor do not borrow timing or interrupt history binding", () => {
  let label = "initial renderer";
  host = receiver();
  Object.defineProperty(host, "session", {
    value: {
      extensionRunner: { getMessageRenderer: () => () => new Text(label) },
    },
  });
  const branch = [
    {
      type: "custom_message",
      id: "history",
      customType: "included",
      display: true,
      content: [{ type: "text", text: "history" }],
    },
  ];
  runtime.rebuildCurrentView(() => branch as never);
  const map = vi.fn(() => {
    throw new Error("must not read array.map");
  });
  const content = [{ type: "text", text: "live" }];
  Object.defineProperty(content, "map", { get: map });
  turnStart();
  expect(() =>
    host.handleEvent({
      type: "message_start",
      message: {
        role: "custom",
        customType: "included",
        display: true,
        content,
        timestamp: 1,
      },
    }),
  ).not.toThrow();
  settle();
  label = "new renderer body";
  host.chatContainer.invalidate();
  expect(transcript()).not.toContain("耗时");
  expect(map).not.toHaveBeenCalled();
});

test.each(["history", "live"] as const)(
  "large %s rows do not inspect details while invalidating",
  (origin) => {
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "included", action: "group" },
    ]);
    const details = Array.from({ length: 4000 }, (_, index) => index);
    const message = {
      role: "custom" as const,
      customType: "included",
      display: true,
      content: "custom row",
      timestamp: 1,
      details,
    };
    turnStart();
    if (origin === "history") {
      host.chatContainer.addChild(
        new CustomMessageComponent(message, undefined),
      );
      runtime.syncReceiver(host);
    } else {
      host.handleEvent({ type: "message_start", message });
    }
    settle();
    expect(transcript()).toContain("消息×1");
    expect(transcript()).not.toContain("耗时");
    const original = Object.getOwnPropertyDescriptor;
    const reads = vi.fn();
    const spy = vi
      .spyOn(Object, "getOwnPropertyDescriptor")
      .mockImplementation((value, key) => {
        if (value === details) reads();
        return original(value, key);
      });
    try {
      for (let i = 0; i < 100; i++) {
        host.chatContainer.invalidate();
        transcript();
      }
    } finally {
      spy.mockRestore();
    }
    expect(reads).not.toHaveBeenCalled();
    expect(transcript()).toContain("消息×1");
    expect(transcript()).not.toContain("耗时");
  },
);

test("unrelated streaming and repaint do not access image getters or serialize large stable fields", () => {
  runtime.debugApplyPolicyRules([
    { kind: "customMessage", customType: "included", action: "group" },
  ]);
  turnStart();
  const image = "a".repeat(1024 * 1024);
  const readData = vi.fn(() => image);
  for (let i = 0; i < 3; i++) {
    at = 100 + i * 100;
    const block = { type: "image", mimeType: "image/png", data: image };
    if (i === 2) Object.defineProperty(block, "data", { get: readData });
    host.handleEvent({
      type: "message_start",
      message: {
        role: "custom",
        customType: "included",
        display: true,
        timestamp: i,
        content: [block],
      },
    });
  }
  settle();
  expect(transcript()).toContain("▸ 分组 消息×3");
  expect(transcript()).not.toContain("耗时");
  expect(readData).not.toHaveBeenCalled();
  turnStart();
  host.handleEvent({ type: "message_start", message: assistant() });
  for (let i = 0; i < 100; i++) {
    host.handleEvent({
      type: "message_update",
      message: assistant([{ type: "thinking", thinking: `delta ${i}` }]),
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
  }
  const stringify = vi.spyOn(JSON, "stringify");
  for (let i = 0; i < 100; i++) {
    host.chatContainer.invalidate();
    transcript();
  }
  const serializations = stringify.mock.calls.length;
  stringify.mockRestore();
  expect(serializations).toBe(0);
  expect(readData).not.toHaveBeenCalled();
  expect(transcript()).toContain("▸ 分组 消息×3");
});

test.each([false, true])(
  "rebuild inside an open turn records only new intervals (subsequent agent_start: %s)",
  (restartsLoop) => {
    const branch = [{ type: "message", id: "user", message: { role: "user" } }];
    turnStart();
    toolEvent("across-rebuild", "start", 100);
    runtime.syncReceiver(host);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });

    runtime.rebuildCurrentView(() => branch as never);
    if (restartsLoop) turnStart();
    tool("across-rebuild");
    toolEvent("across-rebuild", "end", 3100);
    // The first group has only an end in the new view; the next one has
    // both endpoints, with no intervening agent_settled to start a turn.
    host.handleEvent({ type: "message_start", message: assistant() });
    host.handleEvent({
      type: "message_end",
      message: assistant([{ type: "text", text: "split the two groups" }]),
    });
    toolEvent("after-rebuild", "start", 4000);
    tool("after-rebuild");
    toolEvent("after-rebuild", "end", 5500);
    settle();

    const text = transcript();
    expect(text).toMatch(
      /▸ 分组 工具调用×1 · bash×1[\s\S]*split the two groups[\s\S]*▸ 耗时 1\.5s · 分组 工具调用×1 · bash×1/u,
    );
    expect(text.match(/耗时/g)).toHaveLength(1);
  },
);

test("rebuild and restart do not borrow timings even when tool IDs recur in history", () => {
  turnStart();
  toolEvent("old", "start", 0);
  tool("old");
  toolEvent("old", "end", 3900);
  settle();
  expect(transcript()).toContain("耗时 3.9s");
  const branch = [
    { type: "message", id: "user", message: { role: "user" } },
    {
      type: "message",
      id: "call",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "old", name: "bash" }],
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "result",
      message: {
        role: "toolResult",
        toolCallId: "old",
        isError: false,
        durationMs: 3900,
      },
    },
    {
      type: "message",
      id: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
    },
  ];
  runtime.rebuildCurrentView(() => branch as never);
  expect(transcript()).toContain("bash×1");
  expect(transcript()).not.toContain("耗时");
  runtime.onSessionShutdown();
  runtime.onSessionStart({
    mode: "tui",
    cwd: "/tmp/no-config-group-timing",
    getBranch: () => branch as never,
  });
  runtime.syncReceiver(host);
  turnStart();
  toolEvent("old", "start", 4000);
  toolEvent("old", "end", 4500);
  toolEvent("new", "start", 5000);
  tool("new");
  toolEvent("new", "end", 5300);
  settle();
  const text = transcript();
  expect(text.match(/耗时/g)).toHaveLength(1);
  expect(text).toContain("耗时 0.3s");
});
