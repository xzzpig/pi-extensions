/**
 * History rebuild and epoch invalidation tests (change task 2.5).
 *
 * Pins: rebuild follows the loaded rules (persisted custom messages join
 * only when selected), normal quiet history folds by default, an abnormal
 * tail turn stays visible, abnormal turns fold only when a later normal
 * turn exists on the same branch, rebuilds drop candidates from branches
 * that tree navigation or compaction removed, late events from an old
 * epoch never reach the new view, and nothing fabricates unpersisted
 * temporary notifications.
 */

import { describe, expect, test } from "vitest";
import {
  EpochGuard,
  rebuildFromBranch,
  withEpoch,
  type HistoryEntry,
} from "../src/history.ts";
import { compileRules, type Rule } from "../src/rules.ts";

const policyOf = (rules: readonly Rule[] = []) => compileRules(rules);

describe("rebuildFromBranch", () => {
  const selectedAudit: readonly Rule[] = [
    {
      kind: "customMessage",
      customType: "pi-goal-audit-event",
      action: "group",
    },
  ];

  function branch(entries: readonly HistoryEntry[], rules = policyOf()) {
    return rebuildFromBranch(entries, rules, 1);
  }

  const assistantWithTool = (
    messageKey: string,
    toolCallId: string,
    stopReason?: string,
  ): HistoryEntry[] => [
    { type: "user" },
    {
      type: "assistant",
      messageKey,
      blocks: [
        { kind: "thinking", nonEmpty: true },
        { kind: "toolCall", toolCallId, toolName: "bash" },
      ],
      stopReason: "toolUse",
    },
    { type: "toolResult", toolCallId, isError: false },
    {
      type: "assistant",
      messageKey: `${messageKey}-final`,
      blocks: [{ kind: "text", nonEmpty: true }],
      stopReason: "stop",
    },
  ];

  test("normal quiet history folds by default", () => {
    const result = branch(assistantWithTool("m1", "t1"));
    const segments = result.model.currentSegments();
    expect(segments.length).toBe(1);
    expect(result.store.isFolded(segments[0].id)).toBe(true);
    expect(result.pending.ids()).toEqual([]);
  });

  test("persisted custom messages rebuild per the loaded rules", () => {
    const entries: HistoryEntry[] = [
      { type: "user" },
      {
        type: "customMessage",
        key: "cm1",
        customType: "pi-goal-audit-event",
        display: true,
      },
      {
        type: "customMessage",
        key: "cm2",
        customType: "unrelated-type",
        display: true,
      },
      {
        type: "assistant",
        messageKey: "m1",
        blocks: [{ kind: "text", nonEmpty: true }],
        stopReason: "stop",
      },
    ];
    const selected = rebuildFromBranch(entries, policyOf(selectedAudit), 1);
    const segments = selected.model.currentSegments();
    // cm1 joined the tool-less thinking-less run; cm2 split it.
    expect(segments.map((s) => s.members.map((m) => m.key))).toEqual([["cm1"]]);

    // Without the rule, the same branch leaves everything visible.
    const unselected = rebuildFromBranch(entries, policyOf(), 1);
    expect(unselected.model.currentSegments().length).toBe(0);
  });

  test("an abnormal tail turn stays visible and pending", () => {
    const entries: HistoryEntry[] = [
      { type: "user" },
      {
        type: "assistant",
        messageKey: "m1",
        blocks: [{ kind: "toolCall", toolCallId: "t1", toolName: "bash" }],
        stopReason: "error",
      },
      { type: "toolResult", toolCallId: "t1", isError: true },
    ];
    const result = branch(entries);
    const segments = result.model.currentSegments();
    expect(segments.length).toBe(1);
    expect(result.store.isFolded(segments[0].id)).toBe(false);
    expect(result.pending.ids()).toEqual([segments[0].id]);
  });

  test("an abnormal turn folds once a later normal turn exists", () => {
    const entries: HistoryEntry[] = [
      { type: "user" },
      {
        type: "assistant",
        messageKey: "m1",
        blocks: [{ kind: "toolCall", toolCallId: "t1", toolName: "bash" }],
        stopReason: "aborted",
      },
      { type: "toolResult", toolCallId: "t1", isError: false },
      ...assistantWithTool("m2", "t2"),
    ];
    const result = branch(entries);
    const segments = result.model.currentSegments();
    // Aborted turn's segment folded thanks to the later normal turn.
    expect(segments.length).toBe(2);
    expect(result.store.isFolded(segments[0].id)).toBe(true);
    expect(result.store.isFolded(segments[1].id)).toBe(true);
    expect(result.pending.ids()).toEqual([]);
  });

  test("an unknown tail (no stop reason) stays visible", () => {
    const entries: HistoryEntry[] = [
      { type: "user" },
      {
        type: "assistant",
        messageKey: "m1",
        blocks: [{ kind: "toolCall", toolCallId: "t1", toolName: "bash" }],
      },
      { type: "toolResult", toolCallId: "t1", isError: false },
    ];
    const result = branch(entries);
    const segments = result.model.currentSegments();
    expect(result.store.isFolded(segments[0].id)).toBe(false);
  });

  test("missing tool results keep a normal-stop turn visible", () => {
    const entries: HistoryEntry[] = [
      { type: "user" },
      {
        type: "assistant",
        messageKey: "m1",
        blocks: [
          { kind: "toolCall", toolCallId: "t1", toolName: "bash" },
          { kind: "toolCall", toolCallId: "t2", toolName: "read" },
        ],
        stopReason: "stop",
      },
      { type: "toolResult", toolCallId: "t1", isError: false },
      // t2 never received its persisted result.
    ];
    const result = branch(entries);
    const segments = result.model.currentSegments();
    expect(result.model.member("t2")?.status).toBe("pending");
    expect(result.store.isFolded(segments[0].id)).toBe(false);
    expect(result.pending.ids()).toEqual([segments[0].id]);
  });

  test("rebuilding a different branch drops the old candidates", () => {
    const abnormal: HistoryEntry[] = [
      { type: "user" },
      {
        type: "assistant",
        messageKey: "m1",
        blocks: [{ kind: "toolCall", toolCallId: "t1", toolName: "bash" }],
        stopReason: "error",
      },
    ];
    const first = branch(abnormal);
    expect(first.pending.ids().length).toBe(1);

    // Tree navigation: the new branch has none of those entries. Segment
    // ids are view-local, so the proof is member identity: the old
    // candidate's members do not exist in the new view at all, and the new
    // view's pending collection is empty.
    const second = branch(assistantWithTool("fresh", "f1"));
    expect(second.pending.ids()).toEqual([]);
    const oldMembers = first.model
      .currentSegments()
      .flatMap((segment) => segment.members.map((member) => member.key));
    const newMembers = second.model
      .currentSegments()
      .flatMap((segment) => segment.members.map((member) => member.key));
    for (const key of oldMembers) {
      expect(newMembers).not.toContain(key);
      expect(second.model.member(key)).toBeUndefined();
    }
  });

  test("no rebuild output contains fabricated notifications", () => {
    const entries: HistoryEntry[] = assistantWithTool("m1", "t1");
    const result = rebuildFromBranch(
      entries,
      policyOf([
        {
          kind: "notification",
          textPrefix: "Observational memory:",
          level: "info",
          action: "group",
        },
      ]),
      1,
    );
    const kinds = result.model
      .currentSegments()
      .flatMap((segment) => segment.members.map((member) => member.kind));
    expect(kinds).not.toContain("notification");
  });

  test("diagnostics rebuild as visible boundaries", () => {
    const entries: HistoryEntry[] = [
      { type: "user" },
      {
        type: "assistant",
        messageKey: "m1",
        blocks: [{ kind: "toolCall", toolCallId: "t1", toolName: "bash" }],
        stopReason: "stop",
      },
      { type: "toolResult", toolCallId: "t1", isError: false },
      { type: "diagnostic" },
      {
        type: "assistant",
        messageKey: "m2",
        blocks: [{ kind: "toolCall", toolCallId: "t2", toolName: "bash" }],
        stopReason: "stop",
      },
      { type: "toolResult", toolCallId: "t2", isError: false },
    ];
    const result = branch(entries);
    expect(result.model.currentSegments().length).toBe(2);
  });
});

describe("EpochGuard", () => {
  test("late events from an old epoch never reach the new view", () => {
    const guard = new EpochGuard();
    const firstEpoch = guard.invalidate();
    const received: string[] = [];
    const sink = withEpoch<string>(guard, firstEpoch, (event) =>
      received.push(event),
    );

    sink("before-invalidation");
    expect(received).toEqual(["before-invalidation"]);

    const secondEpoch = guard.invalidate();
    expect(secondEpoch).not.toBe(firstEpoch);
    expect(guard.isCurrent(firstEpoch)).toBe(false);

    // A late event stamped with the dead epoch is refused.
    sink("late-from-old-view");
    expect(received).toEqual(["before-invalidation"]);

    const freshSink = withEpoch<string>(guard, secondEpoch, (event) =>
      received.push(event),
    );
    freshSink("current");
    expect(received).toEqual(["before-invalidation", "current"]);
  });

  test("rebuilds carry the epoch they were created under", () => {
    const guard = new EpochGuard();
    guard.invalidate();
    const epoch = guard.invalidate();
    const result = rebuildFromBranch([], policyOf(), epoch);
    expect(result.epoch).toBe(epoch);
    expect(guard.isCurrent(result.epoch)).toBe(true);
  });
});
