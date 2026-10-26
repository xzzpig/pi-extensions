/**
 * Regression tests for the second review round (扩展复审). Each test
 * reproduces the reviewer's incremental-event scenario — the paths the
 * previous add-everything-then-scan tests could not see:
 *
 * 1. structural boundaries apply once: replaying old user messages across
 *    scans must not split consecutive tools into separate groups;
 * 2. a transcript rebuild re-binds replacement components instead of
 *    re-entering the rebuild forever (known count resets with the view);
 * 3. the group-wide width fallback covers thinking-carried summaries —
 *    a too-narrow width restores the whole group's display;
 * 4. a custom message content update reveals its group before
 *    re-classifying, and unchanged re-scans are not updates;
 * 5. persisted custom_message entries (Pi re-creates the message object
 *    via sessionEntryToContextMessages) still bind to the history member;
 * 6. shutdown alone releases the host receiver and branch closure — no
 *    next session is needed to break the reference (the full GC probe
 *    lives in fixtures/gc-probe.ts).
 */

import { describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import { debugRebuildPending, debugSetRebuildPending } from "../src/runtime.ts";

// Pi's own entry → context-message converter, loaded by file path: the
// host package's exports map does not expose the deep module, and the
// persisted-custom-message scenarios below depend on the exact objects Pi
// hands to components.
const sessionManagerUrl = new URL(
  "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
  import.meta.url,
);
const { sessionEntryToContextMessages } = (await import(
  `${sessionManagerUrl.pathname}`
)) as {
  sessionEntryToContextMessages: (entry: unknown) => readonly unknown[];
};

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
  content: readonly { type: string; thinking?: string; text?: string }[],
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

const segmentKeys = (runtime: GroupCollapseRuntime): string[][] =>
  runtime
    .currentSegmentsForTest()
    .map((segment) => segment.members.map((member) => member.key));

describe("rereview regression: boundaries apply once", () => {
  test("host-event replays keep consecutive tools in one group", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });

    // Real event order: each child is added and scanned separately, with
    // the older user message re-walked on every scan.
    receiver.chatContainer.addChild(
      new UserMessageComponent("user question", getMarkdownTheme()),
    );
    runtime.syncReceiver(receiver);
    receiver.chatContainer.addChild(toolComponent("a"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "a" });
    receiver.chatContainer.addChild(toolComponent("b"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "b" });
    settled(runtime);

    expect(segmentKeys(runtime)).toEqual([["a", "b"]]);
    runtime.onSessionShutdown();
  });

  test("a genuinely new user message still opens a fresh group", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("a"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "a" });
    settled(runtime);

    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(
      new UserMessageComponent("next question", getMarkdownTheme()),
    );
    receiver.chatContainer.addChild(toolComponent("b"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "b" });
    settled(runtime);

    expect(segmentKeys(runtime)).toEqual([["a"], ["b"]]);
    runtime.onSessionShutdown();
  });
});

describe("rereview regression: rebuild re-binds replacement components", () => {
  test("a replaced transcript re-binds on the next scan and stays stable", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const renderRequests: number[] = [];
    const receiver = {
      chatContainer: new Container(),
      ui: { requestRender: () => void renderRequests.push(1) },
    };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    receiver.chatContainer.addChild(toolComponent("old"));
    runtime.syncReceiver(receiver);

    // The host rebuilt the transcript in place: same container, new
    // component objects (tree navigation, compaction).
    receiver.chatContainer.clear();
    receiver.chatContainer.addChild(toolComponent("new"));

    const seen: { segments: number; keys: string[] }[] = [];
    for (let index = 0; index < 4; index++) {
      runtime.syncReceiver(receiver);
      seen.push({
        segments: runtime.debugSegmentCount(),
        keys: segmentKeys(runtime).flat(),
      });
    }
    // Scan 1 detects the shrink, rebuilds, and re-binds the fresh
    // component in the same pass; scans 2–4 are stable — no rebuild loop.
    expect(seen[0]).toEqual({ segments: 1, keys: ["new"] });
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[3]).toEqual(seen[0]);
    // Exactly one repaint was requested for the rebuilt view — the fold
    // state must reach the screen without waiting for an unrelated render.
    expect(renderRequests.length).toBe(1);
    runtime.onSessionShutdown();
  });
});

describe("rereview regression: group-wide width fallback", () => {
  test("a thinking-carried summary restores the whole group when narrow", () => {
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
      { type: "thinking", thinking: "VISIBLE-THOUGHT" },
    ]);
    const tail = toolComponent("tail");
    receiver.chatContainer.addChild(assistant);
    receiver.chatContainer.addChild(tail);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "tail" });
    settled(runtime);

    // Comfortable width: the folded group renders its summary.
    expect(text(receiver.chatContainer)).toContain("1 段思考");
    // Width 5: the summary cannot fit — the whole group renders through:
    // the thinking body is visible (the 4-column wrap keeps only "VIS"
    // contiguous), no summary row renders, and the tool body is not
    // hidden behind a hide projection.
    const narrow = text(receiver.chatContainer, 5);
    expect(narrow).toContain("VIS");
    expect(narrow).not.toContain("▸");
    expect(tail.render(5).length).toBeGreaterThan(0);
    runtime.onSessionShutdown();
  });
});

describe("rereview regression: custom message update reveals first", () => {
  test("a content update surfaces the new body, unchanged scans do not", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "audit", action: "group" },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    const message = {
      role: "custom",
      customType: "audit",
      content: "OLD AUDIT",
      display: true,
      timestamp: 1,
    };
    const component = new CustomMessageComponent(message as never);
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);
    settled(runtime);
    expect(text(component)).toContain("1 条消息");

    // The provider rewrites the message body in place and invalidates.
    message.content = "NEW AUDIT";
    component.invalidate();
    runtime.syncReceiver(receiver);
    const revealed = text(component);
    expect(revealed).toContain("NEW AUDIT");
    expect(runtime.debugFoldedIds()).not.toContain(1);

    // Re-fold (user collapse), then re-scan without any change: no
    // spurious reveal — unchanged re-scans are not updates.
    expect(runtime.collapseAll()).toBeGreaterThan(0);
    const foldedAgain = runtime.debugFoldedIds();
    expect(foldedAgain).toContain(1);
    runtime.syncReceiver(receiver);
    runtime.syncReceiver(receiver);
    expect(runtime.debugFoldedIds()).toEqual(foldedAgain);
    expect(text(component)).toContain("1 条消息");
    runtime.onSessionShutdown();
  });
});

describe("rereview regression: persisted custom_message identity", () => {
  test("a re-created message object binds to its history member", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    runtime.onSessionStart({ mode: "tui", cwd: "/tmp/no-config-review" });
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "audit", action: "group" },
    ]);
    const entry = {
      type: "custom_message",
      id: "custom-entry",
      customType: "audit",
      content: "HISTORICAL AUDIT",
      display: true,
      timestamp: "2026-10-25T00:00:00Z",
    };
    const branch = [
      { type: "message", id: "u", message: { role: "user", content: [] } },
      entry,
      {
        type: "message",
        id: "a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ];
    runtime.rebuildCurrentView(() => branch as never);

    // Pi converts persisted custom_message entries into fresh message
    // objects; the component binds the conversion, not the entry.
    const message = sessionEntryToContextMessages(entry as never)[0];
    const component = new CustomMessageComponent(message as never);
    const receiver = { chatContainer: new Container() };
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);

    // One history segment, folded, and the on-screen component renders
    // the summary — not an unfolded duplicate showing the raw body.
    expect(runtime.debugSegmentCount()).toBe(1);
    expect(runtime.debugFoldedIds()).toEqual([1]);
    expect(text(component)).toContain("1 条消息");
    expect(text(component)).not.toContain("HISTORICAL AUDIT");
    runtime.onSessionShutdown();
  });

  test("identical history customs bind in entry order, not to one key", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    runtime.onSessionStart({ mode: "tui", cwd: "/tmp/no-config-review" });
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "audit", action: "group" },
    ]);
    const makeEntry = (id: string) => ({
      type: "custom_message",
      id,
      customType: "audit",
      content: "SAME BODY",
      display: true,
      timestamp: "2026-10-25T00:00:00Z",
    });
    const branch = [
      makeEntry("c1"),
      makeEntry("c2"),
      {
        type: "message",
        id: "a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    ];
    runtime.rebuildCurrentView(() => branch as never);

    const first = new CustomMessageComponent(
      sessionEntryToContextMessages(makeEntry("live1") as never)[0] as never,
    );
    const second = new CustomMessageComponent(
      sessionEntryToContextMessages(makeEntry("live2") as never)[0] as never,
    );
    const receiver = { chatContainer: new Container() };
    receiver.chatContainer.addChild(first);
    receiver.chatContainer.addChild(second);
    runtime.syncReceiver(receiver);

    // Both history members are accounted for: no third (transient) member
    // appeared, and the two components render their own summaries.
    expect(runtime.debugSegmentCount()).toBe(1);
    const keys = runtime
      .currentSegmentsForTest()[0]
      .members.map((member) => member.key);
    expect(keys).toEqual(["c1", "c2"]);
    runtime.onSessionShutdown();
  });
});

describe("rereview regression: shutdown releases the host view", () => {
  test("no receiver, branch closure, or rebind marker survives shutdown", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    const getBranch = (): readonly never[] => [];
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch,
    });
    receiver.chatContainer.addChild(toolComponent("kept"));
    runtime.syncReceiver(receiver);
    runtime.onSessionShutdown();

    const slots = runtime as unknown as {
      activeReceiver?: unknown;
      lastGetBranch?: unknown;
      reboundAfterRebuild?: unknown;
    };
    expect(slots.activeReceiver).toBeUndefined();
    expect(slots.lastGetBranch).toBeUndefined();
    expect(slots.reboundAfterRebuild).toBeUndefined();
    expect(debugRebuildPending()).toBeUndefined();
  });

  test("a transcript rebuilt between sessions re-binds at session start", () => {
    initTheme();
    // `/reload` rebuilds the transcript while the runtime is between
    // sessions; the replacement receiver is recorded as a WeakRef and the
    // next session start must bind it to the rebuilt (folded) model and
    // request one repaint.
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    const renderRequests: number[] = [];
    const rebuiltReceiver = {
      chatContainer: new Container(),
      ui: { requestRender: () => void renderRequests.push(1) },
    };
    // A persisted, normally settled tool turn: the rebuilt model folds it.
    const getBranch = (): readonly never[] =>
      [
        { type: "message", id: "u", message: { role: "user", content: [] } },
        {
          type: "message",
          id: "a",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "fresh", name: "bash" }],
            stopReason: "stop",
          },
        },
        {
          type: "message",
          id: "r",
          message: { role: "toolResult", toolCallId: "fresh", content: [] },
        },
      ] as never;
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch,
    });
    receiver.chatContainer.addChild(toolComponent("old"));
    runtime.syncReceiver(receiver);
    runtime.onSessionShutdown();

    // The host rebuilt the chat while inactive: record, don't retain.
    debugSetRebuildPending(rebuiltReceiver);
    rebuiltReceiver.chatContainer.addChild(toolComponent("fresh"));

    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch,
    });
    // The fresh component is bound to the rebuilt model (one folded
    // history segment), and one repaint was requested.
    expect(runtime.debugSegmentCount()).toBe(1);
    expect(runtime.debugFoldedIds()).toEqual([1]);
    expect(renderRequests.length).toBe(1);
    expect(debugRebuildPending()).toBeUndefined();
    runtime.onSessionShutdown();
  });
});
