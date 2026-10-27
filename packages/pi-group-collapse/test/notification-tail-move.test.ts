/**
 * Notification re-classification on a moved status tail (bug regression).
 *
 * Reproduced defect: an agent turn that emits
 * `2 tools → OM → 3 tools → OM → 3 tools → OM → 9 tools → OM` (OM = an
 * `Observational memory:` info notification matched by the user's `group`
 * rule) settled as **four** folded groups. Every later info notification
 * appends a new host status line, so the previously bound line loses the
 * tail pointer; the old adapter treated that `tail-moved` signal as "this
 * member is invalid" and split the run at each notification.
 *
 * Host facts this contract is built on (Pi 1.1.0, read from the shipped
 * `showStatus`/`ThemedText`):
 *
 * - a status line is `[Spacer, ThemedText]`; the line is reused **only**
 *   while it is still the last child (`last === lastStatusText &&
 *   secondLast === lastStatusSpacer`), otherwise a new pair is appended;
 * - every info line's builder reads the *receiver-wide* `lastStatusMessage`,
 *   so after any later invalidation (theme change, resize, chat
 *   invalidate) an old line repaints to the newest status text.
 *
 * Therefore a tail move is a **state change signal, not a verdict**:
 *
 * - the line's own visible text has not changed, and if the newer status is
 *   another notification that the same policy keeps in the group, the line
 *   must stay in its segment (a pure tail move never splits a run);
 * - a real content update of a line (host reuses it in place) reveals first
 *   and is re-collected for the next normal settle;
 * - a newer status that becomes `keep` — or that cannot be attributed to a
 *   proven extension notification (core status) — reveals/splits the line;
 * - a line that is already visible because its policy is `keep` is never
 *   retroactively turned into a hidden member.
 *
 * The tests stay on the real host components and the real observer/patched
 * prototype; nothing here freezes host state, so what is asserted is also
 * what the terminal would paint.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  InteractiveMode,
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import type { Segment } from "../src/model.ts";

const WIDTH = 120;

const OM_TEXTS = [
  "Observational memory: dropper running after reflection — active observation pool ~12,932 / 10,000 target tokens (129%)",
  "Observational memory: observer running on ~28,879-token chunk",
  "Observational memory: dropper running after reflection — active observation pool ~13,784 / 10,000 target tokens (138%)",
  "Observational memory: observer running on ~30,537-token chunk",
] as const;

/** Tool counts between the four notifications of the reported session. */
const TOOL_RUNS = [2, 3, 3, 9] as const;

type TestReceiver = {
  chatContainer: Container;
  ui: { requestRender(): void };
  outputPad: number;
  lastStatusMessage?: string;
  lastStatusText?: unknown;
  lastStatusSpacer?: unknown;
  showStatus(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
  showExtensionNotify(
    message: string,
    type?: "info" | "warning" | "error",
  ): void;
};

const prototype = InteractiveMode.prototype as unknown as {
  showExtensionNotify: (
    this: TestReceiver,
    message: string,
    type?: "info" | "warning" | "error",
  ) => void;
  showStatus: (this: TestReceiver, message: string) => void;
  showWarning: (this: TestReceiver, message: string) => void;
  showError: (this: TestReceiver, message: string) => void;
};

const originalMethods = {
  showExtensionNotify: prototype.showExtensionNotify,
  showStatus: prototype.showStatus,
  showWarning: prototype.showWarning,
  showError: prototype.showError,
};

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function makeReceiver(): TestReceiver {
  const receiver = Object.create(InteractiveMode.prototype) as TestReceiver;
  receiver.chatContainer = new Container();
  receiver.ui = stubUi();
  receiver.outputPad = 1;
  return receiver;
}

function plain(lines: readonly string[]): string {
  return stripTerminalSequences(lines.join("\n"));
}

/** Shape used for readable structure assertions. */
function shape(segment: Segment): string[] {
  return segment.members.map((member) =>
    member.kind === "tool" ? `tool:${member.key}` : member.kind,
  );
}

function toolComponent(callId: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "bash",
    callId,
    { command: `echo ${callId}` },
    {},
    undefined,
    stubUi() as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `result ${callId}` }], isError: false },
    false,
  );
  return component;
}

let root: string;
let priorAgentDir: string | undefined;
let runtime: GroupCollapseRuntime;
let receiver: TestReceiver;
let toolSeq: number;

function writeConfig(rules: unknown[]): void {
  writeFileSync(join(root, "group-collapse.json"), JSON.stringify({ rules }));
}

/** The user's effective OM rule: info notifications join the group. */
function omRules(): unknown[] {
  return [
    {
      kind: "notification",
      textPrefix: "Observational memory:",
      level: "info",
      action: "group",
    },
  ];
}

function startSession(rules: unknown[] = omRules()): void {
  writeConfig(rules);
  runtime = new GroupCollapseRuntime({ notify: () => {} });
  runtime.onSessionStart({ mode: "tui", cwd: root, getBranch: () => [] });
  receiver = makeReceiver();
}

function addTools(count: number): void {
  for (let index = 0; index < count; index++) {
    const callId = `tool-${++toolSeq}`;
    receiver.chatContainer.addChild(toolComponent(callId) as never);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: callId,
      isError: false,
    });
  }
}

function notify(text: string): void {
  prototype.showExtensionNotify.call(receiver, text, "info");
  runtime.syncReceiver(receiver);
  // The host calls ui.requestRender() inside showStatus: a frame paints the
  // line at its own text before any later status can move the tail.
  receiver.chatContainer.render(WIDTH);
}

function settleNormally(): void {
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_before_settle", outcome: "completed" });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
}

/** The reported session: 2→OM→3→OM→3→OM→9→OM in one turn. */
function runReportedSession(): void {
  runtime.handlePiEvent({ type: "agent_start" });
  for (let index = 0; index < TOOL_RUNS.length; index++) {
    addTools(TOOL_RUNS[index]);
    notify(OM_TEXTS[index]);
  }
}

function renderedTranscript(): string {
  return plain(receiver.chatContainer.render(WIDTH));
}

function summaryOccurrences(text: string): number {
  return text.split("▸").length - 1;
}

beforeEach(() => {
  initTheme();
  root = mkdtempSync(join(tmpdir(), "group-collapse-tail-move-"));
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  toolSeq = 0;
});

afterEach(() => {
  runtime?.onSessionShutdown();
  // The observer must restore every prototype method it wrapped.
  expect(prototype.showStatus).toBe(originalMethods.showStatus);
  expect(prototype.showExtensionNotify).toBe(
    originalMethods.showExtensionNotify,
  );
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("notification tail moves", () => {
  test("17 tools and four matching notifications fold as one group", () => {
    startSession();
    runReportedSession();
    settleNormally();

    const segments = runtime.currentSegmentsForTest();
    // Members keep their display order: each notification sits between the
    // tool runs that surrounded it on screen, all inside one segment.
    const expected: string[] = [];
    let tool = 1;
    for (const count of TOOL_RUNS) {
      for (let index = 0; index < count; index++) {
        expected.push(`tool:tool-${tool++}`);
      }
      expected.push("notification");
    }
    expect(segments.map(shape)).toEqual([expected]);
    expect(runtime.debugFoldedIds()).toEqual([segments[0].id]);

    const transcript = renderedTranscript();
    expect(summaryOccurrences(transcript)).toBe(1);
    expect(transcript).toContain("17 次工具调用");
    expect(transcript).toContain("4 条消息");
    // Folded members are not painted individually.
    expect(transcript).not.toContain("Observational memory:");
  });

  test("a theme/resize invalidation does not hide foreign content", () => {
    startSession();
    runReportedSession();
    settleNormally();
    const segments = runtime.currentSegmentsForTest();
    expect(segments).toHaveLength(1);

    // Theme change, resize, chat invalidate: every host status line
    // rebuilds from the shared field.
    receiver.chatContainer.invalidate();
    receiver.chatContainer.render(WIDTH);

    expect(runtime.currentSegmentsForTest().map(shape)).toEqual(
      segments.map(shape),
    );
    expect(runtime.debugFoldedIds()).toEqual([segments[0].id]);
    const transcript = renderedTranscript();
    expect(summaryOccurrences(transcript)).toBe(1);
    expect(transcript).not.toContain("Observational memory:");

    // Opening the group must only reveal group content: the host repaints
    // moved lines from the newest status text (Pi core's shared field), so
    // whatever a line shows now has to still be one of the matching
    // notifications — never a kept or core status.
    runtime.expandAll();
    const expanded = renderedTranscript();
    expect(expanded).toContain("Observational memory:");
    expect(expanded).not.toContain("Session compacted");
    const notificationLines = expanded
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("Observational memory:"));
    expect(notificationLines).toHaveLength(4);
    for (const line of notificationLines) {
      expect(OM_TEXTS.some((text) => line.includes(text.split(" — ")[0]))).toBe(
        true,
      );
    }
  });

  test("a notification that becomes keep splits at its own position", () => {
    startSession([
      ...omRules(),
      {
        kind: "notification",
        textPrefix: "Notice: urgent",
        action: "keep",
      },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    addTools(2);
    notify("Observational memory: observer running on chunk A");
    addTools(3);

    // The newer status is a keep notification: the line may repaint to it,
    // so it must leave the group and split the run where it sits.
    notify("Notice: urgent: rate limited");
    runtime.syncReceiver(receiver);

    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1", "tool:tool-2"],
      ["tool:tool-3", "tool:tool-4", "tool:tool-5"],
    ]);
    settleNormally();
    for (const segment of runtime.currentSegmentsForTest()) {
      expect(shape(segment)).not.toContain("notification");
    }
    // The old line is visible again (its own text until the host repaints).
    const transcript = renderedTranscript();
    expect(transcript).toContain("Observational memory:");
    expect(transcript).toContain("▸ 分组 2 次工具调用");
    expect(transcript).toContain("▸ 分组 3 次工具调用");
  });

  test("a visible keep line is never retroactively hidden by a group move", () => {
    startSession([
      {
        kind: "notification",
        textPrefix: "Notice:",
        action: "group",
      },
      {
        kind: "notification",
        textPrefix: "Notice: urgent",
        action: "keep",
      },
    ]);
    runtime.handlePiEvent({ type: "agent_start" });
    addTools(2);
    notify("Notice: urgent: rate limited");
    addTools(1);
    // A later group notification moves the tail over the visible line.
    notify("Notice: routine tick");

    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1", "tool:tool-2"],
      ["tool:tool-3", "notification"],
    ]);
    settleNormally();
    // The kept line still renders through as a boundary — never a hidden
    // member, and the groups on both sides stay separate.
    const transcript = renderedTranscript();
    expect(transcript).toContain("Notice: urgent: rate limited");
    expect(transcript).toContain("▸ 分组 2 次工具调用");
    expect(transcript).toContain("▸ 分组 1 次工具调用 · 1 条消息");
    expect(runtime.debugFoldedIds()).toHaveLength(2);
  });

  test("a core status overwriting the tail reveals the whole group", () => {
    startSession();
    runtime.handlePiEvent({ type: "agent_start" });
    addTools(3);
    notify(OM_TEXTS[0]);
    settleNormally();
    expect(runtime.debugFoldedIds()).toHaveLength(1);

    // A core status reuses the still-tail notification line: its content is
    // no longer attributable to a proven notification, and every older
    // status line repaints from the same shared field.
    prototype.showStatus.call(receiver, "Session compacted 1 time");
    runtime.syncReceiver(receiver);

    // The affected line leaves the group and shows the core content; the
    // untouched tool members keep their fold (only the changed content must
    // be revealed).
    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1", "tool:tool-2", "tool:tool-3"],
    ]);
    expect(runtime.debugFoldedIds()).toHaveLength(1);
    const transcript = renderedTranscript();
    expect(transcript).toContain("Session compacted 1 time");
    expect(transcript).toContain("▸ 分组 3 次工具调用");
    expect(transcript).not.toContain("条消息");
  });

  test("an own-coupled member survives a core status on the tail", () => {
    startSession();
    runtime.handlePiEvent({ type: "agent_start" });
    addTools(3);
    notify(OM_TEXTS[0]);
    settleNormally();
    const folded = runtime.debugFoldedIds();
    expect(folded).toHaveLength(1);
    const memberLine = receiver.lastStatusText as { build?: () => string };
    // An independent snapshot builder: this line provably keeps its own
    // notification text, whatever the shared status field holds later.
    memberLine.build = () => OM_TEXTS[0];

    // An unrelated core status arrives as a new tail (an inert spacer keeps
    // the previous line from being reused in place); it must not revoke a
    // line that cannot render it.
    receiver.chatContainer.addChild(new Spacer(1) as never);
    prototype.showStatus.call(receiver, "Session compacted 1 time");
    runtime.syncReceiver(receiver);

    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1", "tool:tool-2", "tool:tool-3", "notification"],
    ]);
    expect(runtime.debugFoldedIds()).toEqual(folded);
    const transcript = renderedTranscript();
    expect(transcript).toContain("▸ 分组 3 次工具调用 · 1 条消息");
    // The core status line itself is visible, the member is still folded.
    expect(transcript).toContain("Session compacted 1 time");
  });

  test("a real content update reveals first, then re-folds at next settle", () => {
    startSession();
    runtime.handlePiEvent({ type: "agent_start" });
    addTools(3);
    notify(OM_TEXTS[0]);
    settleNormally();
    const folded = runtime.debugFoldedIds();
    expect(folded).toHaveLength(1);
    expect(renderedTranscript()).not.toContain("Observational memory:");

    // The host reuses the tail line for a new notification: the new content
    // is a real update and must be visible immediately.
    notify("Observational memory: observer running on ~99,999-token chunk");
    const revealed = renderedTranscript();
    expect(revealed).toContain("~99,999-token chunk");
    expect(runtime.debugFoldedIds()).toEqual([]);

    // The next normal settle collects the revealed group again as the same
    // member (no duplicate line, no new group).
    runtime.handlePiEvent({ type: "agent_start" });
    settleNormally();
    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1", "tool:tool-2", "tool:tool-3", "notification"],
    ]);
    expect(runtime.debugFoldedIds()).toEqual([folded[0]]);
    const refolded = renderedTranscript();
    expect(refolded).toContain("▸ 分组 3 次工具调用 · 1 条消息");
    expect(refolded).not.toContain("~99,999-token chunk");
  });

  test("shutdown stops observation and leaves no live binding", () => {
    startSession();
    runtime.handlePiEvent({ type: "agent_start" });
    addTools(2);
    notify(OM_TEXTS[0]);
    settleNormally();
    expect(runtime.debugFoldedIds()).toHaveLength(1);

    runtime.onSessionShutdown();
    // The session's indexes die with it; a notification after teardown is
    // not claimed by anyone (the observer is uninstalled) and cannot
    // resurrect a member or a fold.
    prototype.showExtensionNotify.call(
      receiver,
      "Observational memory: after shutdown",
      "info",
    );
    runtime.syncReceiver(receiver);
    expect(runtime.currentSegmentsForTest()).toEqual([]);
    expect(runtime.debugFoldedIds()).toEqual([]);
  });
});
