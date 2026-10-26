/**
 * Member-update and deferred post-settle tests (change task 2.6).
 *
 * Pins: an updated member is re-classified under its new identity (a
 * turning-keep item splits its group), invalidation removes the member and
 * reveals, component reuse stays one member, items arriving after a settle
 * wait for the NEXT normal settle (an abnormal settle keeps deferring
 * them), and a normal settle folds only its own targets without touching
 * unrelated groups.
 */

import { describe, expect, test } from "vitest";
import { GroupingModel } from "../src/model.ts";
import { GroupStateStore, planFolding } from "../src/fold-state.ts";
import { compileRules, type Rule } from "../src/rules.ts";

const rulesOf = (rules: readonly Rule[] = []) => compileRules(rules);

const auditGroup: readonly Rule[] = [
  { kind: "customMessage", customType: "pi-goal-audit-event", action: "group" },
];

const memoryInfo: readonly Rule[] = [
  {
    kind: "notification",
    textPrefix: "Observational memory:",
    level: "info",
    action: "group",
  },
];

describe("member updates", () => {
  test("an update to a keep identity removes the member and splits the group", () => {
    const model = new GroupingModel(rulesOf(auditGroup));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      {
        type: "customMessage",
        key: "cm1",
        customType: "pi-goal-audit-event",
        display: true,
      },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
    ]);
    expect(model.currentSegments().length).toBe(1);

    // The provider rewrote the message under a different type that no rule
    // selects: it turns keep and must split the run.
    model.apply({
      type: "customMessageUpdate",
      key: "cm1",
      customType: "renamed-type",
      display: true,
    });
    expect(model.member("cm1")).toBeUndefined();
    const segments = model.currentSegments();
    expect(segments.map((s) => s.members.map((m) => m.key))).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  test("a notification whose new content misses the rule leaves the group", () => {
    const model = new GroupingModel(rulesOf(memoryInfo));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      {
        type: "notification",
        key: "n1",
        level: "info",
        text: "Observational memory: saved",
      },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
    ]);
    expect(model.currentSegments().length).toBe(1);

    model.apply({
      type: "notificationUpdate",
      key: "n1",
      level: "warning",
      text: "Observational memory: warn",
    });
    expect(model.member("n1")).toBeUndefined();
    expect(
      model.currentSegments().map((s) => s.members.map((m) => m.key)),
    ).toEqual([["a"], ["b"]]);
  });

  test("an update that stays grouped bumps the version without splitting", () => {
    const model = new GroupingModel(rulesOf(memoryInfo));
    model.applyAll([
      { type: "turnBegin" },
      {
        type: "notification",
        key: "n1",
        level: "info",
        text: "Observational memory: saved",
      },
    ]);
    const before = model.member("n1")?.version ?? 0;
    model.apply({
      type: "notificationUpdate",
      key: "n1",
      level: "info",
      text: "Observational memory: saved more",
    });
    expect(model.member("n1")?.version).toBe(before + 1);
    expect(model.currentSegments().length).toBe(1);
  });

  test("invalidation removes the member and splits the group", () => {
    const model = new GroupingModel(rulesOf(memoryInfo));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      {
        type: "notification",
        key: "n1",
        level: "info",
        text: "Observational memory: saved",
      },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
      { type: "turnEnd" },
    ]);
    model.apply({ type: "memberInvalidated", key: "n1" });
    expect(model.member("n1")).toBeUndefined();
    expect(
      model.currentSegments().map((s) => s.members.map((m) => m.key)),
    ).toEqual([["a"], ["b"]]);
  });

  test("an update for a never-included item classifies it fresh", () => {
    const model = new GroupingModel(rulesOf(memoryInfo));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
    ]);
    model.apply({
      type: "notificationUpdate",
      key: "n-late",
      level: "info",
      text: "Observational memory: late",
    });
    expect(model.member("n-late")).toMatchObject({ kind: "notification" });
    expect(model.currentSegments()[0].members.map((m) => m.key)).toEqual([
      "a",
      "n-late",
    ]);
  });
});

describe("post-settle deferral", () => {
  function settledModel() {
    const model = new GroupingModel(rulesOf(memoryInfo));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      { type: "turnEnd" },
    ]);
    model.noteSettled();
    return model;
  }

  test("items after a settle are post-settle candidates", () => {
    const model = settledModel();
    expect(model.postSettleSegmentIds()).toEqual([]);

    model.apply({
      type: "notification",
      key: "n-late",
      level: "info",
      text: "Observational memory: late",
    });
    const ids = model.postSettleSegmentIds();
    expect(ids.length).toBe(1);
  });

  test("an abnormal next settle keeps deferring post-settle items", () => {
    const model = settledModel();
    model.apply({
      type: "notification",
      key: "n-late",
      level: "info",
      text: "Observational memory: late",
    });
    const postSettle = model
      .currentSegments()
      .filter((segment) => model.postSettleSegmentIds().includes(segment.id));
    const decision = planFolding({
      turn: 2,
      outcome: "abnormal",
      segmentsOfTurn: [],
      pendingSegments: [],
      postSettleSegments: postSettle,
      isQuiet: (segment) => model.segmentIsQuiet(segment),
    });
    expect(decision.foldNow).toEqual([]);
    expect(decision.stillPending).toEqual(postSettle.map((s) => s.id));
  });

  test("a normal next settle folds quiet post-settle items", () => {
    const model = settledModel();
    model.apply({
      type: "notification",
      key: "n-late",
      level: "info",
      text: "Observational memory: late",
    });
    const postSettle = model
      .currentSegments()
      .filter((segment) => model.postSettleSegmentIds().includes(segment.id));
    const store = new GroupStateStore();
    const decision = planFolding({
      turn: 2,
      outcome: "normal",
      segmentsOfTurn: [],
      pendingSegments: [],
      postSettleSegments: postSettle,
      isQuiet: (segment) => model.segmentIsQuiet(segment),
    });
    expect(decision.foldNow).toEqual(postSettle.map((s) => s.id));
    store.applyAutoFold(decision.foldNow);
    for (const segment of postSettle) {
      expect(store.isFolded(segment.id)).toBe(true);
    }
  });

  test("auto-reveal shows a folded group without user-open immunity", () => {
    const store = new GroupStateStore();
    store.applyAutoFold([1]);
    expect(store.isFolded(1)).toBe(true);
    store.reveal([1]);
    expect(store.isFolded(1)).toBe(false);
    expect(store.isUserOpened(1)).toBe(false);
    // A later settle may fold it again.
    store.applyAutoFold([1]);
    expect(store.isFolded(1)).toBe(true);
  });

  test("a normal settle folds its own targets without resetting others", () => {
    const store = new GroupStateStore();
    // An old group the user opened stays open.
    store.applyAutoFold([10]);
    store.open(10);
    const decision = planFolding({
      turn: 3,
      outcome: "normal",
      segmentsOfTurn: [
        { id: 30, members: [], turn: 3 },
        { id: 31, members: [], turn: 3 },
      ],
      pendingSegments: [],
      isQuiet: () => true,
    });
    store.applyAutoFold(decision.foldNow);
    expect(store.isFolded(30)).toBe(true);
    expect(store.isFolded(31)).toBe(true);
    expect(store.isFolded(10)).toBe(false);
    expect(store.isUserOpened(10)).toBe(true);
  });
});
