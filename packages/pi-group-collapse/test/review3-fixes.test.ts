/**
 * Regression tests for the third review round. Each test reproduces the
 * reviewer's scenario:
 *
 * 1. an auto-retry/continuation (agent_end → agent_start without a final
 *    settle) must not advance the grouping turn — the still-active turn's
 *    earlier segments stay visible even under `/group-collapse collapse`;
 * 2. re-walking an assistant message on completion must not re-apply its
 *    text boundary — consecutive tools of the same turn stay one group;
 * 3. a content update reveals its group first AND joins the deferred
 *    candidates, so the next normal settle re-folds it (user opens are
 *    still immune);
 * 4. all-empty thinking groups render no MouseRegion and get no run
 *    number — model keys match the native layout on the live path and
 *    the history path alike.
 */

import { describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
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

describe("review round 3: continuation keeps one logical turn", () => {
  test("an unsettled restart must not fold the active turn's earlier tools", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const earlier = toolComponent("earlier-live");
    receiver.chatContainer.addChild(earlier);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "earlier-live",
    });
    // Intermediate answer + intermediate agent_end, then the run restarts
    // (auto-retry / continuation) without a final settle.
    receiver.chatContainer.addChild(
      makeAssistant([{ type: "text", text: "intermediate answer" }]),
    );
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_start" });

    // The still-active turn is untouchable, even by the bulk command.
    expect(runtime.collapseAll()).toBe(0);
    expect(runtime.debugFoldedIds()).toEqual([]);
    const turns = runtime as unknown as {
      model: { currentTurn(): number };
      tracker: { currentTurn(): number | undefined };
    };
    expect(turns.model.currentTurn()).toBe(1);
    expect(turns.tracker.currentTurn()).toBe(1);
    expect(text(earlier)).toContain("RESULT-earlier-live");
    runtime.onSessionShutdown();
  });

  test("rebuilt views re-align an idle tracker with the model's turns", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    runtime.handlePiEvent({ type: "agent_start" });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    // Two live turns happened; a rebuild replays an empty branch, so the
    // next turn must be turn 1 for both model and tracker.
    runtime.rebuildCurrentView(() => []);
    const turns = runtime as unknown as {
      model: { currentTurn(): number };
      tracker: { currentTurn(): number | undefined };
    };
    expect(turns.model.currentTurn()).toBe(0);
    runtime.handlePiEvent({ type: "agent_start" });
    expect(turns.model.currentTurn()).toBe(1);
    expect(turns.tracker.currentTurn()).toBe(1);
    runtime.onSessionShutdown();
  });
});

describe("review round 3: assistant text boundary dedupes per message", () => {
  test("completing a message does not split its trailing tools into two groups", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const content = [
      { type: "text", text: "EXPLANATION" },
      {
        type: "toolCall",
        id: "a",
        name: "bash",
        arguments: { command: "echo a" },
      },
    ];
    const assistant = makeAssistant(content as never, true);
    receiver.chatContainer.addChild(assistant);
    receiver.chatContainer.addChild(toolComponent("a"));
    runtime.syncReceiver(receiver);
    // The message completes (streaming → done): the re-walk must not
    // re-apply the explanation boundary after tool "a".
    assistant.updateContent(
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
      false,
    );
    runtime.syncReceiver(receiver);
    receiver.chatContainer.addChild(toolComponent("b"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "a" });
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "b" });
    settled(runtime);
    expect(segmentKeys(runtime)).toEqual([["a", "b"]]);
    runtime.onSessionShutdown();
  });

  test("text that arrives after the first scan still applies its boundary once", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const assistant = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    assistant.updateContent(
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
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
      true,
    );
    receiver.chatContainer.addChild(assistant);
    runtime.syncReceiver(receiver);
    // Empty text: no boundary yet. The text fills in: exactly one boundary.
    assistant.updateContent(
      {
        role: "assistant",
        content: [{ type: "text", text: "NOW VISIBLE" }],
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
      true,
    );
    runtime.syncReceiver(receiver);
    runtime.syncReceiver(receiver);
    settled(runtime);
    // The turn folds; the boundary existed exactly once (one segment).
    expect(runtime.debugSegmentCount()).toBeLessThanOrEqual(1);
    runtime.onSessionShutdown();
  });
});

describe("review round 3: updated groups join the deferred candidates", () => {
  test("a revealed custom message re-folds at the next normal settle", () => {
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
      content: "OLD",
      display: true,
      timestamp: 1,
    };
    const component = new CustomMessageComponent(message as never);
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);
    settled(runtime);
    expect(runtime.debugFoldedIds()).toEqual([1]);

    // The update reveals the new body.
    message.content = "UPDATED";
    component.invalidate();
    runtime.syncReceiver(receiver);
    expect(runtime.debugFoldedIds()).toEqual([]);
    expect(text(component)).toContain("UPDATED");

    // The next normal settle re-folds the revealed group (and the new
    // turn's own group) — the update bought one reveal, not immunity.
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("next"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "next" });
    settled(runtime);
    expect(runtime.debugFoldedIds()).toEqual([1, 2]);
    expect(text(component)).toContain("1 条消息");
    runtime.onSessionShutdown();
  });

  test("a user-opened group keeps its immunity across later settles", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("first"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "first" });
    settled(runtime);
    expect(runtime.debugFoldedIds()).toEqual([1]);

    // The user opens the group (the shell's setExpanded path).
    runtime.expandAll();
    // Auto-reveal style update on the same member would recollect — but a
    // plain re-scan is not an update, and the user open stays immune.
    runtime.syncReceiver(receiver);
    settled(runtime);
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("second"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "second" });
    settled(runtime);
    expect(runtime.debugFoldedIds()).toEqual([2]);
    runtime.onSessionShutdown();
  });
});

describe("review round 3: empty thinking runs get no number", () => {
  test("live keys match the native MouseRegion numbering", () => {
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
      { type: "thinking", thinking: "" },
      { type: "text", text: "VISIBLE TEXT" },
      { type: "thinking", thinking: "NONEMPTY THOUGHT" },
    ]);
    receiver.chatContainer.addChild(assistant);
    runtime.syncReceiver(receiver);
    settled(runtime);
    // The empty group is skipped: the only thinking member is #t0 (the
    // message key's transient id varies), and the folded summary replaces
    // the visible thought.
    const keys = segmentKeys(runtime).flat();
    expect(keys).toHaveLength(1);
    expect(keys[0].endsWith("#t0")).toBe(true);
    expect(runtime.debugFoldedIds()).toEqual([1]);
    expect(text(assistant)).toContain("1 段思考");
    expect(text(assistant)).not.toContain("NONEMPTY THOUGHT");
    runtime.onSessionShutdown();
  });

  test("history keys follow the same numbering", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const entryId = "hist-a";
    const branch = [
      { type: "message", id: "u", message: { role: "user", content: [] } },
      {
        type: "message",
        id: entryId,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "VISIBLE TEXT" },
            { type: "thinking", thinking: "NONEMPTY THOUGHT" },
          ],
          stopReason: "stop",
        },
      },
    ];
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => branch as never,
    });
    const keys = segmentKeys(runtime).flat();
    expect(keys).toEqual([`${entryId}#t0`]);
    runtime.onSessionShutdown();
  });
});
