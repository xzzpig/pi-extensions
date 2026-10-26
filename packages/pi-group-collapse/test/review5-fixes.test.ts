/**
 * Regression tests for the fifth review round — two ways the derived
 * index could hide content after an update:
 *
 * 1. notification invalidation and level changes must invalidate the
 *    derived index (member removal is topology, a level change alters the
 *    summary statistics) — otherwise a core status line overwriting a
 *    folded notification stays hidden behind a stale summary;
 * 2. removeMemberAndSplit must search closed segments when the member is
 *    not in the open one — otherwise an old group keeps a removed member
 *    and folds content that should now be visible;
 * 3. the assistant geometry cache is dropped on invalidate(), so a
 *    thinking-visibility or theme change re-measures row heights.
 */

import { describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
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

function settled(runtime: GroupCollapseRuntime): void {
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_before_settle", outcome: "completed" });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
}

/** A minimal InteractiveMode receiver for the real notification patches. */
function hostReceiver(): {
  chatContainer: Container;
  ui: { requestRender(): void };
  outputPad: number;
} {
  return {
    chatContainer: new Container(),
    ui: { requestRender: () => {} },
    outputPad: 0,
  };
}

describe("review round 5: notification invalidation refreshes the index", () => {
  test("a core status overwrite surfaces the new line, not the old summary", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const host = Object.assign(
      Object.create(InteractiveMode.prototype) as object,
      hostReceiver(),
    ) as unknown as {
      chatContainer: Container;
      ui: { requestRender(): void };
      outputPad: number;
      showExtensionNotify(text: string, level?: string): void;
      showStatus(text: string): void;
    };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.debugApplyPolicyRules([
      { kind: "notification", textPrefix: "INCLUDE:", action: "group" },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    host.showExtensionNotify("INCLUDE: original", "info");
    runtime.syncReceiver(host);
    settled(runtime);
    expect(text(host.chatContainer)).toContain("▸ 1 条消息");

    // The core status overwrites the same line: the member is removed
    // (topology change) and the derived index must see it.
    host.showStatus("CORE IMPORTANT NOTICE");
    runtime.syncReceiver(host);
    expect(runtime.debugSegmentCount()).toBe(0);
    const rendered = text(host.chatContainer);
    expect(rendered).toContain("CORE IMPORTANT NOTICE");
    expect(rendered).not.toContain("▸ 1 条消息");
    runtime.onSessionShutdown();
  });

  test("an info → error update adds the failure marker to the summary", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.debugApplyPolicyRules([
      { kind: "notification", textPrefix: "INCLUDE:", action: "group" },
    ]);
    const notification = new Text("INCLUDE: info");
    receiver.chatContainer.addChild(notification);
    runtime.handlePiEvent({ type: "agent_start" });
    runtime.observeNotification(notification, "info", "INCLUDE: info");
    runtime.syncReceiver(receiver);
    settled(runtime);
    expect(text(notification)).toContain("▸ 1 条消息");
    expect(text(notification)).not.toContain("✗");

    notification.setText("INCLUDE: error");
    runtime.observeNotification(notification, "error", "INCLUDE: error");
    runtime.handlePiEvent({ type: "agent_start" });
    settled(runtime);
    // The level change invalidates the statistics: the summary carries
    // the failure marker.
    expect(text(notification)).toContain("✗");
    runtime.onSessionShutdown();
  });
});

describe("review round 5: removal searches closed segments", () => {
  test("an old group loses its member while a new group is open", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-review",
      getBranch: () => [],
    });
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "include", action: "group" },
    ]);
    // Turn 1: the custom message joins a group and folds.
    runtime.handlePiEvent({ type: "agent_start" });
    const message = {
      role: "custom",
      customType: "include",
      content: "ORIGINAL",
      display: true,
      timestamp: 1,
    };
    const component = new CustomMessageComponent(message as never);
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);
    settled(runtime);
    expect(runtime.debugFoldedIds()).toEqual([1]);

    // Turn 2 starts and a new group accumulates; then the OLD message is
    // reclassified to "keep" — its removal must find the closed segment.
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("live"));
    runtime.syncReceiver(receiver);
    message.customType = "keep";
    message.content = "KEEP NEW";
    component.invalidate();
    runtime.syncReceiver(receiver);
    expect(
      runtime
        .currentSegmentsForTest()
        .map((segment) => segment.members.map((member) => member.key)),
    ).toEqual([["live"]]);
    runtime.handlePiEvent({ type: "tool_execution_end", toolCallId: "live" });
    settled(runtime);

    // Only the new turn's group folds; the updated message renders its
    // new body instead of a summary of the old group.
    expect(runtime.debugFoldedIds()).toEqual([2]);
    const rendered = text(component);
    expect(rendered).toContain("KEEP NEW");
    expect(rendered).not.toContain("▸ 1 条消息");
    runtime.onSessionShutdown();
  });
});

describe("review round 5: geometry cache invalidation", () => {
  test("invalidating the assistant re-measures hidden run heights", () => {
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
        content: [
          { type: "thinking", thinking: "hidden thought" },
          { type: "text", text: "visible answer" },
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
    receiver.chatContainer.addChild(assistant);
    runtime.syncReceiver(receiver);
    settled(runtime);
    assistant.render(WIDTH); // warm the geometry cache

    const instrumentHiddenRuns = (): { count(): number } => {
      let renders = 0;
      const children = (
        assistant as unknown as {
          contentContainer: {
            children: readonly { render(w: number): string[] }[];
          };
        }
      ).contentContainer.children;
      for (const child of children) {
        if (child.constructor.name === "MouseRegion") {
          const original = child.render.bind(child);
          child.render = (width: number) => {
            renders += 1;
            return original(width);
          };
        }
      }
      return { count: () => renders };
    };

    const cached = instrumentHiddenRuns();
    assistant.render(WIDTH);
    expect(cached.count()).toBe(0); // cache hit: hidden content untouched

    // invalidate() may rebuild the content children, so re-instrument the
    // current ones after the hook has dropped the geometry cache.
    assistant.invalidate();
    const remeasured = instrumentHiddenRuns();
    assistant.render(WIDTH);
    expect(remeasured.count()).toBe(1); // re-measured after invalidation
    runtime.onSessionShutdown();
  });
});
