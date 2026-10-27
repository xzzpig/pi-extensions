/**
 * One host status change, many notification members (review P1: the whole
 * chain, not just the observer, must be linear).
 *
 * The re-classification direction keeps every proven notification line as a
 * tracked member, so a single status change can invalidate or re-classify
 * *all* of them at once. The observer already walks its tracked set once, but
 * each affected line used to reach `model.notificationUpdate` /
 * `model.memberInvalidated` individually, and every one of those removals
 * scanned the transcript from the first segment. With N members that is
 * 1 + 2 + … + N segment checks (N(N+1)/2) for one status change.
 *
 * The fix keeps one call per status change: the observer reports the batch,
 * the runtime hands the keys to the model, and the model removes them in a
 * single pass. These tests drive the real chain — patched host prototype →
 * observer → runtime → model → segments — and measure the model's own
 * segment/member visits, not a mock's callback array.
 *
 * They also pin the structure the batch must preserve: member order, turn
 * numbers, non-member boundaries (a kept tool), the open segment staying
 * open, and the fold state of the pieces that keep their segment id.
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
import { Container, Spacer } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import type { Segment } from "../src/model.ts";

const WIDTH = 120;

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

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function makeReceiver(): TestReceiver {
  const receiver = Object.create(InteractiveMode.prototype) as TestReceiver;
  receiver.chatContainer = new Container();
  receiver.ui = stubUi();
  receiver.outputPad = 1;
  return receiver;
}

/** Shape used for readable structure assertions. */
function shape(segment: Segment): string[] {
  return segment.members.map((member) =>
    member.kind === "tool" ? `tool:${member.key}` : member.kind,
  );
}

function toolComponent(
  callId: string,
  toolName = "bash",
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    toolName,
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

/** `Observational memory:` info notifications join the group. */
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

const KEEP_RULE = {
  kind: "notification",
  textPrefix: "Notice: urgent",
  action: "keep",
};

const KEEP_TOOL_RULE = { kind: "tool", name: "update_goal", action: "keep" };

function writeConfig(rules: unknown[]): void {
  writeFileSync(join(root, "group-collapse.json"), JSON.stringify({ rules }));
}

function startSession(rules: unknown[] = omRules()): void {
  writeConfig(rules);
  runtime = new GroupCollapseRuntime({ notify: () => {} });
  runtime.onSessionStart({ mode: "tui", cwd: root, getBranch: () => [] });
  receiver = makeReceiver();
}

function omText(index: number): string {
  return `Observational memory: observer running on ~${(index + 1) * 1_111}-token chunk`;
}

/** Add one settled tool call and let the runtime scan it in. */
function addTool(toolName = "bash"): string {
  const callId = `tool-${++toolSeq}`;
  receiver.chatContainer.addChild(toolComponent(callId, toolName) as never);
  runtime.syncReceiver(receiver);
  if (toolName === "bash") {
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: callId,
      isError: false,
    });
  }
  return callId;
}

/** An extension info notification through the patched host entry. */
function notify(text: string): void {
  prototype.showExtensionNotify.call(receiver, text, "info");
  runtime.syncReceiver(receiver);
  receiver.chatContainer.render(WIDTH);
}

/**
 * A notification that appends a fresh line: an inert spacer keeps the host
 * from reusing the previous status line in place, so *every* older line is
 * tail-moved and the status change is one batch (no single-line reuse path).
 */
function notifyAppended(text: string): void {
  receiver.chatContainer.addChild(new Spacer(1) as never);
  notify(text);
}

/** A core status that appends a fresh line instead of reusing the tail. */
function coreStatus(text: string): void {
  receiver.chatContainer.addChild(new Spacer(1) as never);
  prototype.showStatus.call(receiver, text);
  runtime.syncReceiver(receiver);
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

/**
 * N settled rounds, each one its own closed segment `[tool, notification]`,
 * with every notification line still in the transcript and still tracked.
 */
function buildClosedRounds(rounds: number): void {
  for (let index = 0; index < rounds; index++) {
    runtime.handlePiEvent({ type: "agent_start" });
    addTool();
    notify(omText(index));
    settleNormally();
  }
}

type ScanCounts = { segmentVisits: number; memberVisits: number };

function scanDelta(before: ScanCounts): ScanCounts {
  const after = runtime.debugRemovalScanCounts();
  return {
    segmentVisits: after.segmentVisits - before.segmentVisits,
    memberVisits: after.memberVisits - before.memberVisits,
  };
}

/** Build N closed rounds, then drop every member with one keep status. */
function measureKeepBatch(rounds: number): {
  counts: ScanCounts;
  before: readonly Segment[];
  after: readonly Segment[];
  folded: readonly number[];
} {
  startSession([...omRules(), KEEP_RULE]);
  buildClosedRounds(rounds);
  const before = runtime.currentSegmentsForTest();
  expect(before).toHaveLength(rounds);
  expect(runtime.debugFoldedIds()).toHaveLength(rounds);
  const folded = [...runtime.debugFoldedIds()];

  const countsBefore = runtime.debugRemovalScanCounts();
  // A newer status that the policy keeps: every older shared line may
  // repaint to it, so every one of them leaves its group in one batch.
  notifyAppended("Notice: urgent: rate limited");
  const counts = scanDelta(countsBefore);

  return {
    counts,
    before,
    after: runtime.currentSegmentsForTest(),
    folded,
  };
}

beforeEach(() => {
  initTheme();
  root = mkdtempSync(join(tmpdir(), "group-collapse-notification-batch-"));
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  toolSeq = 0;
});

afterEach(() => {
  runtime?.onSessionShutdown();
  expect(prototype.showStatus).toBe(originalMethods.showStatus);
  expect(prototype.showExtensionNotify).toBe(
    originalMethods.showExtensionNotify,
  );
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("one status change drops many members", () => {
  test("a keep notification removes N members in one transcript pass", () => {
    const N = 30;
    const { counts, after, folded } = measureKeepBatch(N);

    // One pass over the transcript, not one pass per removed member (the
    // per-key path costs N(N+1)/2 = 465 segment visits and N(N+1) = 930
    // member visits here).
    expect(counts).toEqual({ segmentVisits: N, memberVisits: 2 * N });

    // Every notification left its group; the tools kept their order, their
    // turn, and (the before-piece keeps the segment id) their fold state.
    expect(after.map(shape)).toEqual(
      Array.from({ length: N }, (_, index) => [`tool:tool-${index + 1}`]),
    );
    expect(after.map((segment) => segment.turn)).toEqual(
      Array.from({ length: N }, (_, index) => index + 1),
    );
    expect(runtime.debugFoldedIds()).toEqual(folded);
    // Every surviving tool-only piece folds to its own one-line summary; no
    // notification member is left anywhere.
    const transcript = receiver.chatContainer.render(WIDTH).join("\n");
    expect(transcript.split("▸").length - 1).toBe(N);
    expect(transcript).not.toContain("条消息");
    // The lines themselves are revealed again (the host paints their cached
    // text until its next invalidate; that is the host's business).
    expect(transcript).toContain("Observational memory:");
  });

  test("a core status invalidates N members in one transcript pass", () => {
    const N = 30;
    startSession([...omRules()]);
    buildClosedRounds(N);
    expect(runtime.debugFoldedIds()).toHaveLength(N);

    const countsBefore = runtime.debugRemovalScanCounts();
    // Unattributable core text: every shared line may repaint to it.
    coreStatus("Session compacted 1 time");
    const counts = scanDelta(countsBefore);

    // The invalidation batch is the same single pass as the keep batch.
    expect(counts).toEqual({ segmentVisits: N, memberVisits: 2 * N });

    const after = runtime.currentSegmentsForTest();
    expect(after.map(shape)).toEqual(
      Array.from({ length: N }, (_, index) => [`tool:tool-${index + 1}`]),
    );
    const transcript = receiver.chatContainer.render(WIDTH).join("\n");
    expect(transcript).toContain("Session compacted 1 time");
    expect(transcript).not.toContain("条消息");
  });

  test("doubling the transcript doubles the batch cost (linear)", () => {
    const small = measureKeepBatch(20);
    runtime.onSessionShutdown();
    toolSeq = 0;
    const large = measureKeepBatch(40);

    // N(N+1)/2 would grow by ~4x when N doubles; one pass grows by ~2x.
    expect(small.counts).toEqual({ segmentVisits: 20, memberVisits: 40 });
    expect(large.counts).toEqual({ segmentVisits: 40, memberVisits: 80 });
    expect(large.counts.segmentVisits).toBeLessThanOrEqual(
      2 * small.counts.segmentVisits + 2,
    );
    expect(large.counts.memberVisits).toBeLessThanOrEqual(
      2 * small.counts.memberVisits + 2,
    );
    expect(large.after).toHaveLength(40);
  });

  test("several members per segment, across segments, open and closed", () => {
    // Layout: one closed segment holding two notifications and one kept
    // (visible, non-member) tool boundary, a second closed segment with one
    // notification, and an open segment with the last notification.
    startSession([...omRules(), KEEP_TOOL_RULE]);
    runtime.handlePiEvent({ type: "agent_start" });
    addTool(); // tool-1
    notify(omText(0));
    addTool(); // tool-2
    notify(omText(1));
    addTool("update_goal"); // tool-3: a kept tool, a visible non-member boundary
    addTool(); // tool-4
    notify(omText(2));
    settleNormally();
    runtime.handlePiEvent({ type: "agent_start" });
    addTool(); // tool-5
    notify(omText(3));
    addTool(); // tool-6
    notify(omText(4));
    addTool(); // tool-7

    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1", "notification", "tool:tool-2", "notification"],
      ["tool:tool-4", "notification"],
      [
        "tool:tool-5",
        "notification",
        "tool:tool-6",
        "notification",
        "tool:tool-7",
      ],
    ]);

    const countsBefore = runtime.debugRemovalScanCounts();
    coreStatus("Session compacted 1 time");
    const counts = scanDelta(countsBefore);

    // One cut per hole, in order, keeping every non-member boundary: the
    // kept tool still separates the first two pieces, and the open segment
    // stays open with its trailing tool (two holes, three pieces).
    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1"],
      ["tool:tool-2"],
      ["tool:tool-4"],
      ["tool:tool-5"],
      ["tool:tool-6"],
      ["tool:tool-7"],
    ]);
    // 2 closed segments (4 + 2 members) and the open segment (5 members)
    // were each visited once.
    expect(counts).toEqual({ segmentVisits: 2, memberVisits: 11 });
  });

  test("a keep batch splits the open segment at each hole", () => {
    // The newer keep status reuses the still-tail line, so that member is
    // dropped by the real-update path and the remaining ones by the batch;
    // both must land on the same, correctly cut topology.
    startSession([...omRules(), KEEP_RULE]);
    runtime.handlePiEvent({ type: "agent_start" });
    addTool(); // tool-1
    notify(omText(0));
    addTool(); // tool-2
    notify(omText(1));
    addTool(); // tool-3

    notify("Notice: urgent: rate limited");

    expect(runtime.currentSegmentsForTest().map(shape)).toEqual([
      ["tool:tool-1"],
      ["tool:tool-2"],
      ["tool:tool-3"],
    ]);
    const transcript = receiver.chatContainer.render(WIDTH).join("\n");
    expect(transcript).toContain("Notice: urgent: rate limited");
    expect(transcript).not.toContain("条消息");
  });
});
