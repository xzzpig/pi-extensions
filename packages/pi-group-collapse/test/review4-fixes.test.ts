/**
 * Regression tests for the fourth review round. The first is a
 * correctness fix (text boundaries are per block position, not per
 * message); the rest pin the efficiency work:
 *
 * 1. a message interleaving thinking and text yields one group per
 *    independent text block (A · text1 · B · text2 · C → three groups);
 * 2. unchanged completed history is skipped from the cheap shape alone —
 *    no thinking/text field reads, and the published expand target is not
 *    recreated per scan;
 * 3. live tool-argument streaming does not invalidate the derived index
 *    for the unchanged history (no full index rebuild, no member walks);
 * 4. the assistant projection renders each child once per frame (the
 *    visible body is not rendered twice for coordinates).
 */

import { describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  MouseRegion,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";

const WIDTH = 80;

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

const text = (component: { render(w: number): string[] }, w = WIDTH) =>
  plain(component.render(w));

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function toolComponent(id: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "bash",
    id,
    { command: `echo ${id}` },
    {},
    undefined,
    stubUi() as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `RESULT-${id}` }], isError: false },
    false,
  );
  return component;
}

function makeAssistant(
  content: readonly Record<string, unknown>[],
  streaming = false,
): AssistantMessageComponent {
  const component = new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
  );
  component.updateContent(
    {
      role: "assistant",
      content: [...content],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    } as never,
    streaming,
  );
  return component;
}

function settled(runtime: GroupCollapseRuntime): void {
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_before_settle", outcome: "completed" });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
}

describe("review round 4: per-block text boundaries", () => {
  test("interleaved thinking and text form one group per text block", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const assistant = makeAssistant([
      { type: "thinking", thinking: "A" },
      { type: "text", text: "TEXT 1" },
      { type: "thinking", thinking: "B" },
      { type: "text", text: "TEXT 2" },
      { type: "thinking", thinking: "C" },
    ]);
    receiver.chatContainer.addChild(assistant);
    runtime.syncReceiver(receiver);
    settled(runtime);

    // Three independent runs, each closed by its own text boundary (the
    // last by the turn end) — no group spans a visible text block.
    const groups = runtime
      .currentSegmentsForTest()
      .map((segment) => segment.members.map((member) => member.key));
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group[0].split("#")[1])).toEqual([
      "t0",
      "t1",
      "t2",
    ]);
    const rendered = text(assistant);
    expect(rendered).toContain("TEXT 1");
    expect(rendered).toContain("TEXT 2");
    expect(rendered).toContain("1 段思考");
    runtime.onSessionShutdown();
  });

  test("a growing message still applies each block's boundary exactly once", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const assistant = makeAssistant(
      [
        { type: "text", text: "FIRST" },
        { type: "toolCall", id: "a", name: "bash" },
      ],
      true,
    );
    receiver.chatContainer.addChild(assistant);
    receiver.chatContainer.addChild(toolComponent("a"));
    runtime.syncReceiver(receiver);
    // Complete the message and add a second text block later in the
    // message: its boundary is new, the first one is not re-applied.
    assistant.updateContent(
      {
        role: "assistant",
        content: [
          { type: "text", text: "FIRST" },
          { type: "toolCall", id: "a", name: "bash" },
          { type: "text", text: "SECOND" },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      } as never,
      false,
    );
    runtime.syncReceiver(receiver);
    receiver.chatContainer.addChild(toolComponent("b"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "a" });
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "b" });
    settled(runtime);
    // FIRST closes before tool a; SECOND closes after tool a, so a and b
    // are separate groups — and the re-walk added no extra boundary.
    const groups = runtime
      .currentSegmentsForTest()
      .map((segment) => segment.members.map((member) => member.key));
    expect(groups).toEqual([["a"], ["b"]]);
    runtime.onSessionShutdown();
  });
});

describe("review round 4: unchanged history is not re-read", () => {
  test("no thinking reads and no resolver churn across no-op scans", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    let reads = 0;
    const body = "historical thought ".repeat(20);
    const components: AssistantMessageComponent[] = [];
    for (let index = 0; index < 40; index++) {
      const block = {
        type: "thinking",
        get thinking() {
          reads += 1;
          return body;
        },
      };
      const component = makeAssistant([block as never]);
      components.push(component);
      receiver.chatContainer.addChild(component);
    }
    runtime.syncReceiver(receiver);
    settled(runtime);
    receiver.chatContainer.render(WIDTH);
    reads = 0;

    const target = Symbol.for("@xzzpig/transcript-expand-target.v1");
    const before = (components[0] as unknown as Record<symbol, unknown>)[
      target
    ];
    for (let index = 0; index < 20; index++) {
      runtime.syncReceiver(receiver);
    }
    expect(reads).toBe(0);
    expect((components[0] as unknown as Record<symbol, unknown>)[target]).toBe(
      before,
    );
    runtime.onSessionShutdown();
  });
});

describe("review round 4: live activity does not invalidate history", () => {
  test("tool argument streaming leaves the derived index cached", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    for (let index = 0; index < 40; index++) {
      receiver.chatContainer.addChild(toolComponent(`h${index}`));
    }
    runtime.syncReceiver(receiver);
    for (let index = 0; index < 40; index++) {
      runtime.handlePiEvent({
        type: "tool_execution_end",
        toolCallId: `h${index}`,
      });
    }
    settled(runtime);
    // The next turn: one live tool, then repeated argument streaming.
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("live"));
    runtime.syncReceiver(receiver);
    receiver.chatContainer.render(WIDTH);
    const before = runtime.debugIndexBuilds();
    for (let index = 0; index < 20; index++) {
      runtime.handlePiEvent({
        type: "tool_execution_update",
        toolCallId: "live",
      });
      receiver.chatContainer.render(WIDTH);
    }
    expect(runtime.debugIndexBuilds()).toBe(before);
    runtime.onSessionShutdown();
  });
});

describe("review round 4: assistant projection renders each child once", () => {
  test("stable repaint renders the visible body once per frame", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const assistant = makeAssistant([
      { type: "thinking", thinking: "hidden thought" },
      { type: "text", text: "visible answer" },
    ]);
    receiver.chatContainer.addChild(assistant);
    runtime.syncReceiver(receiver);
    settled(runtime);
    assistant.render(WIDTH); // warm-up: geometry computed once

    const counts: Record<string, number> = {};
    const children = (
      assistant as unknown as {
        contentContainer: {
          children: readonly { render(w: number): string[] }[];
        };
      }
    ).contentContainer.children;
    for (const child of children) {
      const name = child.constructor.name;
      const original = child.render.bind(child);
      (child as { render(w: number): string[] }).render = (width: number) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return original(width);
      };
    }
    for (let frame = 0; frame < 10; frame++) assistant.render(WIDTH);

    // The visible body renders exactly once per frame; the hidden run's
    // geometry is cached after the warm-up frame, so hidden content is
    // not rendered again at all (review round 5 geometry cache).
    expect(counts.Markdown).toBe(10);
    expect(counts.MouseRegion ?? 0).toBe(0);
    // The folded thinking body stays hidden.
    expect(text(assistant)).not.toContain("hidden thought");
    expect(text(assistant)).toContain("visible answer");
    runtime.onSessionShutdown();
  });

  test("the hidden run is skipped when its geometry is cached", () => {
    // Sanity for the merge itself: a second frame never renders any child
    // more than once (no double traversal).
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const assistant = makeAssistant([
      { type: "thinking", thinking: "hidden thought" },
      { type: "text", text: "visible answer" },
    ]);
    receiver.chatContainer.addChild(assistant);
    runtime.syncReceiver(receiver);
    settled(runtime);
    assistant.render(WIDTH);
    let regionRenders = 0;
    let markdownRenders = 0;
    const children = (
      assistant as unknown as {
        contentContainer: {
          children: readonly { render(w: number): string[] }[];
        };
      }
    ).contentContainer.children;
    for (const child of children) {
      if (child instanceof MouseRegion) {
        const original = child.render.bind(child);
        child.render = (width: number) => {
          regionRenders += 1;
          return original(width);
        };
      } else if (child.constructor.name === "Markdown") {
        const original = child.render.bind(child);
        child.render = (width: number) => {
          markdownRenders += 1;
          return original(width);
        };
      }
    }
    assistant.render(WIDTH);
    expect(markdownRenders).toBe(1);
    // Warm-up measured the hidden run; the cached frame skips it.
    expect(regionRenders).toBe(0);
    runtime.onSessionShutdown();
  });
});
