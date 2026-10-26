/**
 * Deferred folding of abnormal turns (change task 2.4).
 *
 * Abnormal, aborted, truncated, or unclassifiable turns keep their original
 * display: their quiet segments join a *pending* collection instead of
 * folding. The next normal settle on the same view folds both that turn's
 * own quiet segments and every still-quiet pending segment — each as its
 * own group, never merged across turns or user messages. Segments that
 * cannot be confirmed quiet (a call still pending) stay visible and stay
 * pending.
 *
 * The group state store keeps auto-folding away from groups the user has
 * opened: a historical normal group a user expanded is never re-folded by
 * a later turn's settle.
 */

import type { Segment } from "./model.ts";
import type { TurnOutcome } from "./lifecycle.ts";

export type GroupState = {
  folded: boolean;
  /** True once the user opened the group; auto-fold then leaves it alone. */
  userOpened: boolean;
};

export class GroupStateStore {
  private readonly states = new Map<number, GroupState>();

  /** The user opened a group (summary click or expand command). */
  open(segmentId: number): void {
    const state = this.states.get(segmentId) ?? {
      folded: false,
      userOpened: false,
    };
    this.states.set(segmentId, { ...state, folded: false, userOpened: true });
  }

  /** The user collapsed a group (summary click or collapse command). */
  close(segmentId: number): void {
    const state = this.states.get(segmentId) ?? {
      folded: false,
      userOpened: false,
    };
    this.states.set(segmentId, { ...state, folded: true, userOpened: false });
  }

  isFolded(segmentId: number): boolean {
    return this.states.get(segmentId)?.folded ?? false;
  }

  isUserOpened(segmentId: number): boolean {
    return this.states.get(segmentId)?.userOpened ?? false;
  }

  /** Forget states for segments that left the view (epoch invalidation). */
  retain(segmentIds: ReadonlySet<number>): void {
    for (const id of [...this.states.keys()]) {
      if (!segmentIds.has(id)) this.states.delete(id);
    }
  }

  /** Mark segments folded; groups the user opened keep their choice. */
  applyAutoFold(segmentIds: readonly number[]): void {
    for (const id of segmentIds) {
      if (this.isUserOpened(id)) continue;
      const state = this.states.get(id) ?? {
        folded: false,
        userOpened: false,
      };
      this.states.set(id, { ...state, folded: true });
    }
  }

  /**
   * Auto-reveal: an updated or invalidated member's group shows its content
   * again. Unlike a user open, this grants no immunity — a later normal
   * settle may fold the (possibly re-classified) group again.
   */
  reveal(segmentIds: readonly number[]): void {
    for (const id of segmentIds) {
      if (!this.states.has(id)) continue;
      const state = this.states.get(id)!;
      this.states.set(id, { ...state, folded: false });
    }
  }
}

export type FoldDecisionInput = {
  readonly turn: number;
  readonly outcome: TurnOutcome;
  readonly segmentsOfTurn: readonly Segment[];
  /** All segments still pending from earlier abnormal turns. */
  readonly pendingSegments: readonly Segment[];
  /** Segments created after the previous settle (late notifications...). */
  readonly postSettleSegments?: readonly Segment[];
  readonly isQuiet: (segment: Segment) => boolean;
};

/**
 * Decide which segments fold at a settle. Returns the ids to auto-fold and
 * the ids that remain pending (visible, waiting for a later normal settle).
 */
export function planFolding(input: FoldDecisionInput): {
  foldNow: readonly number[];
  stillPending: readonly number[];
} {
  const postSettle = input.postSettleSegments ?? [];
  const quietOfTurn = input.segmentsOfTurn.filter(input.isQuiet);
  if (input.outcome !== "normal") {
    return {
      foldNow: [],
      // Everything waits: earlier pending segments, every segment of the
      // abnormal turn, and the deferred post-settle items (their old
      // evidence never becomes valid retroactively).
      stillPending: [
        ...input.pendingSegments.map((segment) => segment.id),
        ...input.segmentsOfTurn.map((segment) => segment.id),
        ...postSettle.map((segment) => segment.id),
      ],
    };
  }
  const foldNow = [
    ...input.pendingSegments.filter(input.isQuiet).map((s) => s.id),
    ...quietOfTurn.map((s) => s.id),
    ...postSettle.filter(input.isQuiet).map((s) => s.id),
  ];
  // Everything not confirmably quiet stays visible and stays pending for a
  // later normal settle: earlier deferred segments, this turn's own
  // still-running calls, and post-settle items that keep updating.
  const stillPending = [
    ...input.pendingSegments
      .filter((segment) => !input.isQuiet(segment))
      .map((segment) => segment.id),
    ...input.segmentsOfTurn
      .filter((segment) => !input.isQuiet(segment))
      .map((segment) => segment.id),
    ...postSettle
      .filter((segment) => !input.isQuiet(segment))
      .map((segment) => segment.id),
  ];
  return { foldNow, stillPending };
}

/**
 * Tracks which segments wait for a normal settle. The coordinator owns no
 * view state: folding is executed against a `GroupStateStore` by the
 * caller, so user choices and auto-folding stay separated.
 */
export class PendingFoldCollection {
  private readonly segmentIds = new Set<number>();

  add(segmentIds: readonly number[]): void {
    for (const id of segmentIds) this.segmentIds.add(id);
  }

  /** All pending ids; the caller pairs them with live segments. */
  ids(): readonly number[] {
    return [...this.segmentIds];
  }

  /** Drop ids that left the view or folded in this batch. */
  consume(segmentIds: readonly number[]): void {
    for (const id of segmentIds) this.segmentIds.delete(id);
  }

  clear(): void {
    this.segmentIds.clear();
  }
}
