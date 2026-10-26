/**
 * Abnormal-turn deferred folding tests (change task 2.4).
 *
 * Pins: a single abnormal turn defers, consecutive abnormal turns
 * accumulate without merging, the next normal settle folds its own and all
 * still-quiet deferred segments as separate groups, unquiet segments stay
 * visible and pending, and a group the user opened is never re-folded by a
 * later settle.
 */

import { describe, expect, test } from "vitest";
import {
  GroupStateStore,
  PendingFoldCollection,
  planFolding,
} from "../src/fold-state.ts";
import type { TurnOutcome } from "../src/lifecycle.ts";
import type { Member, Segment } from "../src/model.ts";

const quiet = (_segment: unknown) => true;

function segmentsOfTurn(turn: number, count: number): Segment[] {
  return Array.from(
    { length: count },
    (_, index): Segment => ({
      id: turn * 100 + index,
      members: [] as Member[],
      turn,
    }),
  );
}

type TestSegment = ReturnType<typeof segmentsOfTurn>[number];

function plan(
  turn: number,
  outcome: TurnOutcome,
  segments: readonly TestSegment[],
  pending: readonly TestSegment[] = [],
  isQuiet: (segment: TestSegment) => boolean = quiet,
) {
  return planFolding({
    turn,
    outcome,
    segmentsOfTurn: segments,
    pendingSegments: pending,
    isQuiet,
  });
}

describe("pending fold collection", () => {
  test("a single abnormal turn defers its quiet segments", () => {
    const pending = new PendingFoldCollection();
    const segments = segmentsOfTurn(1, 2);
    const decision = plan(1, "abnormal", segments);
    expect(decision.foldNow).toEqual([]);
    pending.add(decision.stillPending);
    expect(pending.ids()).toEqual([100, 101]);
  });

  test("consecutive abnormal turns accumulate without merging", () => {
    const pending = new PendingFoldCollection();
    pending.add(plan(1, "abnormal", segmentsOfTurn(1, 1)).stillPending);
    pending.add(plan(2, "unknown", segmentsOfTurn(2, 1)).stillPending);
    expect(pending.ids()).toEqual([100, 200]);
  });

  test("the next normal settle folds its own and all pending segments", () => {
    const pending = new PendingFoldCollection();
    pending.add(plan(1, "abnormal", segmentsOfTurn(1, 1)).stillPending);
    pending.add(plan(2, "unknown", segmentsOfTurn(2, 2)).stillPending);

    const pendingSegments = segmentsOfTurn(1, 1).concat(segmentsOfTurn(2, 2));
    const decision = plan(3, "normal", segmentsOfTurn(3, 1), pendingSegments);
    // Every segment folds as its own group; ids keep their turn identity.
    expect(decision.foldNow).toEqual([100, 200, 201, 300]);
    pending.consume(decision.foldNow);
    expect(pending.ids()).toEqual([]);
  });

  test("unknown outcomes defer like abnormal ones", () => {
    const decision = plan(1, "unknown", segmentsOfTurn(1, 1));
    expect(decision.foldNow).toEqual([]);
    expect(decision.stillPending).toEqual([100]);
  });

  test("unquiet segments stay visible and pending across settles", () => {
    const pending = new PendingFoldCollection();
    const stale = segmentsOfTurn(1, 1);
    // The old call is still running: the stale segment is not quiet, but
    // the new turn's own segment is.
    let decision = plan(
      2,
      "normal",
      segmentsOfTurn(2, 1),
      stale,
      (segment) => segment.id !== 100,
    );
    expect(decision.foldNow).toEqual([200]);
    expect(decision.stillPending).toEqual([100]);
    // The stale segment must remain pending, so a later settle retries it.
    pending.add(decision.stillPending);
    expect(pending.ids()).toEqual([100]);

    // Later it becomes quiet and the next normal settle takes it.
    decision = plan(3, "normal", segmentsOfTurn(3, 1), stale);
    expect(decision.foldNow).toEqual([100, 300]);
    pending.consume(decision.foldNow);
    expect(pending.ids()).toEqual([]);
  });

  test("an abnormal turn defers its unquiet segments too (they stay visible)", () => {
    const decision = plan(
      1,
      "abnormal",
      segmentsOfTurn(1, 2),
      [],
      (segment) => segment.id === 101,
    );
    // Both stay pending: the quiet one folds at the next normal settle,
    // the unquiet one only once it can be confirmed settled.
    expect(decision.stillPending).toEqual([100, 101]);
  });
});

describe("group state store", () => {
  test("auto-fold folds, user-opened groups are immune to later auto-folds", () => {
    const store = new GroupStateStore();
    store.applyAutoFold([100]);
    expect(store.isFolded(100)).toBe(true);

    // The user opens the historical normal group.
    store.open(100);
    expect(store.isFolded(100)).toBe(false);
    expect(store.isUserOpened(100)).toBe(true);

    // A later turn's auto-fold batch must not re-fold it.
    store.applyAutoFold([100, 200]);
    expect(store.isFolded(100)).toBe(false);
    expect(store.isFolded(200)).toBe(true);
  });

  test("user-collapsed groups stay collapsed", () => {
    const store = new GroupStateStore();
    store.close(100);
    expect(store.isFolded(100)).toBe(true);
    // Opening then collapsing again keeps the user's latest choice.
    store.open(100);
    store.close(100);
    expect(store.isFolded(100)).toBe(true);
    expect(store.isUserOpened(100)).toBe(false);
  });

  test("retain drops states for segments that left the view", () => {
    const store = new GroupStateStore();
    store.applyAutoFold([100, 200]);
    store.retain(new Set([100]));
    store.applyAutoFold([]);
    expect(store.isFolded(100)).toBe(true);
    // 200 is gone from the view: its state was forgotten, not restored.
    expect(store.isFolded(200)).toBe(false);
    expect(store.isUserOpened(200)).toBe(false);
  });
});
