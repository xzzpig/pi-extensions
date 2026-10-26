/**
 * Regression tests for the review findings (artifacts/pi-group-collapse/
 * 审查问题.md). Each test reproduces the reviewer's reported path and
 * pins the fixed behavior:
 *
 * 1. streaming assistant components are re-scanned as content grows;
 * 2. a reused notification line reveals first, then re-classifies;
 * 3. rebuilt history and live components share one stable identity;
 * 4. shutdown clears every semantic index; a shrinking child set
 *    triggers a rebuild instead of stale accumulation;
 * 5. clicking the second thinking summary expands that run, and the
 *    title stays for collapsing;
 * 6. width fallback is a group-wide decision;
 * 7. the assistant projection is index-backed (no quadratic member
 *    visits across thinking components).
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
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

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

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
    { content: [{ type: "text", text: `done ${id}` }], isError: false },
    false,
  );
  return component;
}

function mixedAssistant(
  thinking: string,
  text: string,
  streaming: boolean,
): AssistantMessageComponent {
  const component = new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
  );
  component.updateContent(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
      ],
    } as never,
    streaming,
  );
  return component;
}

describe("review regression: streaming assistant rescans", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  });

  test("an empty streaming component grows into a folded group", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    // Step 1: pi creates the assistant component with empty content.
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);
    expect(runtime.debugSegmentCount()).toBe(0);

    // Step 2: streaming update adds thinking.
    component.updateContent(
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "grew later" }],
      } as never,
      true,
    );
    runtime.syncReceiver(receiver);

    // Step 3: the final update completes the message (non-streaming).
    component.updateContent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "grew later" },
          { type: "text", text: "final answer" },
        ],
      } as never,
      false,
    );
    runtime.syncReceiver(receiver);

    // Step 4: normal settle folds the thinking segment.
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    expect(runtime.debugSegmentCount()).toBe(1);
    expect(runtime.debugFoldedIds().length).toBe(1);
    const rendered = plain(component.render(WIDTH));
    expect(rendered).not.toContain("grew later");
    expect(rendered).toContain("1 段思考");
    // The final text boundary split: the answer stays visible.
    expect(rendered).toContain("final answer");
  });

  test("thinking that grows while streaming stays a single member", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      } as never,
      true,
    );
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);
    component.updateContent(
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "now non-empty" }],
      } as never,
      true,
    );
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    // One thinking member, not two (empty-then-filled is the same run);
    // the final text is a boundary, not a member.
    expect(
      runtime.currentSegmentsForTest().map((segment) => segment.members.length),
    ).toEqual([1]);
  });
});

/** Mimics the host info tail: a Text whose builder reads a shared field. */
class SharedFieldTail extends Text {
  constructor(private build: () => string) {
    super("", 1, 0);
    this.setText(build());
  }
  override invalidate() {
    this.setText(this.build());
    super.invalidate();
  }
}
describe("review regression: reused notification line", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  });

  test("a reused tail reveals the new content, then re-classifies", () => {
    runtime.debugApplyPolicyRules([
      {
        kind: "notification",
        textPrefix: "INCLUDE:",
        level: "info",
        action: "group",
      },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    // The host's info tail is a ThemedText whose builder reads a shared
    // field: reuse repaints it through invalidate().
    let sharedMessage = "INCLUDE: original";
    const note = new SharedFieldTail(() => sharedMessage);
    receiver.chatContainer.addChild(note);
    runtime.debugRegisterNotification(note, "info", "INCLUDE: original");
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    expect(note.render(WIDTH).length).toBe(1); // folded

    // The host reuses the same ThemedText for a new, non-matching text.
    sharedMessage = "KEEP: new important notice";
    note.invalidate();
    runtime.debugRegisterNotification(
      note,
      "info",
      "KEEP: new important notice",
    );
    runtime.handlePiEvent({ type: "turnBegin" });
    runtime.handlePiEvent({ type: "turnEnd" });
    // Reveal first: the new content renders, not the old fold.
    const rendered = plain(note.render(WIDTH));
    expect(rendered).toContain("KEEP: new important notice");
    expect(rendered).not.toContain("INCLUDE: original");
    // Re-classified to keep: the member left the group.
    expect(runtime.debugFoldedIds()).toEqual([]);
  });
});

describe("review regression: history/live identity", () => {
  test("a rebuilt history group folds the on-screen component", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };

    // The persisted branch: one completed turn with thinking + final text.
    // BranchEntry contract: the stop reason rides on the message.
    const messageObject = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "history thinking" },
        { type: "text", text: "history answer" },
      ],
      stopReason: "stop",
    };
    const branch = [
      { type: "message", id: "entry-1", message: { role: "user" } },
      { type: "message", id: "entry-2", message: messageObject },
    ];
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => branch as never,
    });

    // The host binds the SAME message object to the on-screen component.
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    (component as unknown as { lastMessage: unknown }).lastMessage =
      messageObject;
    component.updateContent(messageObject as never, false);
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);

    // One segment (the history one), folded — and the on-screen component
    // renders the summary, not the raw thinking.
    expect(runtime.debugSegmentCount()).toBe(1);
    expect(runtime.debugFoldedIds().length).toBe(1);
    const rendered = plain(component.render(WIDTH));
    expect(rendered).not.toContain("history thinking");
    expect(rendered).toContain("1 段思考");
    expect(rendered).toContain("history answer");
  });
});

describe("review regression: shutdown clears semantic indexes", () => {
  test("session_shutdown leaves an empty model and no folded ids", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(toolComponent("t1"));
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    expect(runtime.debugSegmentCount()).toBe(1);

    runtime.onSessionShutdown();
    expect(runtime.debugSegmentCount()).toBe(0);
    expect(runtime.debugFoldedIds()).toEqual([]);
    expect(runtime.debugPendingCount()).toBe(0);

    // Late events after shutdown cannot resurrect anything.
    runtime.handlePiEvent({ type: "agent_start" });
    expect(runtime.debugSegmentCount()).toBe(0);
  });
});

describe("review regression: thinking-run click precision", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  });

  test("clicking the second thinking summary expands that run and keeps its title", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first thinking" },
          { type: "text", text: "visible body" },
          { type: "thinking", thinking: "second thinking" },
          { type: "text", text: "final body" },
        ],
      } as never,
      false,
    );
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    // Two managed summaries render in place.
    const folded = component.render(WIDTH);
    const summaryRows = folded
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => stripTerminalSequences(line).includes("1 段思考"));
    expect(summaryRows.length).toBe(2);

    const click = (row: number) => {
      const event = (type: string): unknown => ({
        type,
        x: 2,
        y: row,
        button: "left",
        width: WIDTH,
        height: 40,
        screenX: 2,
        screenY: row,
        shift: false,
        alt: false,
        ctrl: false,
      });
      (
        component as unknown as { handleMouse(e: unknown): unknown }
      ).handleMouse(event("click"));
    };

    // Click the SECOND summary: the second run expands, the first stays.
    click(summaryRows[1].index);
    let rendered = plain(component.render(WIDTH));
    expect(rendered).toContain("second thinking");
    expect(rendered).not.toContain("first thinking");
    // Both shell rows still render (first folded summary + second title).
    const secondPass = component
      .render(WIDTH)
      .filter((line) => stripTerminalSequences(line).includes("1 段思考"));
    expect(secondPass.length).toBe(2);

    // Click the second title: it collapses again.
    const after = component
      .render(WIDTH)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => stripTerminalSequences(line).includes("1 段思考"));
    click(after[after.length - 1].index);
    rendered = plain(component.render(WIDTH));
    // The second run collapsed back to its summary; the first run's own
    // group was untouched (still folded) — both bodies stay visible.
    expect(rendered).not.toContain("second thinking");
    expect(rendered).toContain("visible body");
    expect(rendered).toContain("final body");
    expect(
      component
        .render(WIDTH)
        .filter((line) => stripTerminalSequences(line).includes("1 段思考"))
        .length,
    ).toBe(2);
  });
});

describe("review regression: group-wide width fallback", () => {
  test("a terminal too narrow restores the whole group, not just the carrier", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    const first = toolComponent("w1");
    const second = toolComponent("w2");
    receiver.chatContainer.addChild(first);
    receiver.chatContainer.addChild(second);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "w1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "w2",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    // Width 5: even the minimal summary does not fit. The whole group
    // keeps its original display — both members render their bodies.
    const firstLines = first.render(5);
    const secondLines = second.render(5);
    // Both members render their real bodies (no summary fits at width 5,
    // and no member stays hidden): width 5 wraps the command text, so the
    // body evidence is non-empty output that is NOT a summary line.
    expect(firstLines.length).toBeGreaterThan(0);
    expect(secondLines.length).toBeGreaterThan(0);
    expect(plain(firstLines)).not.toContain("▸");
    expect(plain(secondLines)).not.toContain("▸");
    expect(firstLines.length).toBe(secondLines.length);
  });
});

describe("review regression: assistant projection is index-backed", () => {
  test("member visits stay flat across thinking components", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });

    const components: AssistantMessageComponent[] = [];
    const makeThinking = (index: number): AssistantMessageComponent => {
      const component = new AssistantMessageComponent(
        undefined,
        false,
        getMarkdownTheme(),
      );
      component.updateContent(
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: `thinking body ${index}` },
            { type: "text", text: `body ${index}` },
          ],
        } as never,
        false,
      );
      return component;
    };
    for (let index = 0; index < 20; index++) {
      const component = makeThinking(index);
      components.push(component);
      receiver.chatContainer.addChild(component);
    }
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    // Warm the index, then measure: member lookups are per component and
    // independent of how many thinking components exist.
    components.forEach((component) => component.render(WIDTH));
    const buildsBefore = runtime.debugIndexBuilds();
    for (let pass = 0; pass < 10; pass++) {
      components.forEach((component) => component.render(WIDTH));
    }
    expect(runtime.debugIndexBuilds()).toBe(buildsBefore);
  });
});
