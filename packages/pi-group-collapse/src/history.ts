/**
 * Current-branch history rebuild and epoch invalidation (change task 2.5).
 *
 * On reload, resume, fork, tree navigation, or compaction, the view is
 * rebuilt from what the current branch alone can prove: persisted user and
 * assistant messages with their stop reasons, paired tool results, persisted
 * custom messages, and visible diagnostics. Nothing else is invented:
 *
 * - temporary notifications that the session never persisted are not
 *   fabricated, not copied into the model, and never written to the model
 *   context or the session log — rebuild input simply has no such entries;
 * - a turn is *normal* in history only when its last assistant message
 *   carries an acceptable stop reason and every call paired with a result;
 *   unknown evidence keeps the tail visible;
 * - normal quiet history folds by default; abnormal turns fold only when a
 *   later turn on the same branch is provably normal (deferred folding,
 *   exactly like the live path);
 * - every rebuild produces a fresh model, fold-state store, and pending
 *   collection under a new epoch, so candidates from a branch that tree
 *   navigation or compaction removed disappear with the old view, and late
 *   events stamped with an old epoch are refused before they can touch the
 *   new one.
 */

import { classifySettle } from "./lifecycle.ts";
import { GroupingModel, type MemberPolicy, type Segment } from "./model.ts";
import {
  GroupStateStore,
  PendingFoldCollection,
  planFolding,
} from "./fold-state.ts";

/**
 * The persisted-entry projection the runtime maps from
 * `sessionManager.getBranch()`. Only persisted shapes exist here.
 */
export type HistoryEntry =
  | { readonly type: "user" }
  | {
      readonly type: "assistant";
      readonly messageKey: string;
      /** Content blocks in order, as the message persisted them. */
      readonly blocks: readonly (
        | { readonly kind: "thinking"; readonly nonEmpty: boolean }
        | { readonly kind: "text"; readonly nonEmpty: boolean }
        | {
            readonly kind: "toolCall";
            readonly toolCallId: string;
            readonly toolName: string;
          }
      )[];
      readonly stopReason?: string;
    }
  | {
      readonly type: "toolResult";
      readonly toolCallId: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "customMessage";
      readonly key: string;
      readonly customType: string;
      readonly display: boolean;
    }
  | { readonly type: "diagnostic" };

export type RebuildResult = {
  readonly epoch: number;
  readonly model: GroupingModel;
  readonly store: GroupStateStore;
  /** Candidates still waiting for a later normal settle (visible). */
  readonly pending: PendingFoldCollection;
};

/**
 * Rebuild the grouping view for the current branch under `epoch`.
 *
 * The caller supplies the epoch from `EpochGuard.invalidate()`; the guard
 * then refuses any event stamped with an older one.
 */
export function rebuildFromBranch(
  entries: readonly HistoryEntry[],
  policy: MemberPolicy,
  epoch: number,
): RebuildResult {
  void epoch; // the number is owned by the guard; the rebuild is pure
  const model = new GroupingModel(policy);
  const store = new GroupStateStore();
  const pending = new PendingFoldCollection();

  const isQuiet = (segment: Segment) => model.segmentIsQuiet(segment);

  // A turn ends at the next user message or at the end of the branch.
  let lastStopReason: string | undefined;
  let sawAnyAssistant = false;

  const settleTurn = () => {
    if (!sawAnyAssistant) {
      // Nothing provable in this turn (e.g. only a user message): reset
      // and leave whatever non-member entries produced no segments alone.
      lastStopReason = undefined;
      return;
    }
    const turn = model.currentTurn();
    const turnSegments = model
      .currentSegments()
      .filter((segment) => segment.turn === turn);
    const outcome = classifySettle({ lastStopReason });
    const decision = planFolding({
      turn,
      outcome,
      segmentsOfTurn: turnSegments,
      pendingSegments: pendingSegmentSnapshot(model, pending),
      isQuiet,
    });
    store.applyAutoFold(decision.foldNow);
    pending.consume(decision.foldNow);
    pending.add(decision.stillPending);
    lastStopReason = undefined;
    sawAnyAssistant = false;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        settleTurn();
        model.apply({ type: "userMessage" });
        model.apply({ type: "turnBegin" });
        break;
      case "assistant": {
        sawAnyAssistant = true;
        lastStopReason = entry.stopReason;
        let thinkingRun = 0;
        for (const block of entry.blocks) {
          if (block.kind === "thinking") {
            // An all-empty thinking group renders as nothing in the native
            // component (no MouseRegion, no run number); the live walk
            // skips it too, so both paths number the same visible runs.
            if (!block.nonEmpty) continue;
            model.apply({
              type: "thinkingRun",
              messageKey: entry.messageKey,
              runIndex: thinkingRun++,
              nonEmpty: true,
            });
          } else if (block.kind === "text") {
            // Every non-empty text block is its own boundary position,
            // exactly like the live walk: a message may interleave
            // thinking and text, and each independent text block splits
            // its own run.
            if (block.nonEmpty) {
              model.apply({
                type: "assistantText",
                messageKey: entry.messageKey,
                nonEmpty: true,
              });
            }
          } else {
            model.apply({
              type: "toolCall",
              toolCallId: block.toolCallId,
              toolName: block.toolName,
            });
          }
        }
        // Persisted assistant entries are complete messages: their
        // thinking runs are final, exactly like a live message_end.
        model.apply({ type: "messageEnd", messageKey: entry.messageKey });
        break;
      }
      case "toolResult":
        model.apply({
          type: "toolResult",
          toolCallId: entry.toolCallId,
          isError: entry.isError,
        });
        break;
      case "customMessage":
        model.apply({
          type: "customMessage",
          key: entry.key,
          customType: entry.customType,
          display: entry.display,
        });
        break;
      case "diagnostic":
        model.apply({ type: "nativeDiagnostic" });
        break;
    }
  }
  // The branch tail: settle whatever evidence exists. Unknown or abnormal
  // tails stay visible (and pending for the live continuation).
  settleTurn();
  model.apply({ type: "turnEnd" });

  store.retain(new Set(model.currentSegments().map((segment) => segment.id)));
  return { epoch, model, store, pending };
}

function pendingSegmentSnapshot(
  model: GroupingModel,
  pending: PendingFoldCollection,
): Segment[] {
  const byId = new Map(
    model.currentSegments().map((segment) => [segment.id, segment]),
  );
  return pending
    .ids()
    .map((id) => byId.get(id))
    .filter((segment): segment is Segment => segment !== undefined);
}

/**
 * Guards the current view against late events from a replaced one.
 * Rebuilds, session replacement, tree navigation, and compaction call
 * `invalidate()`; event wiring stamps every event with `stamp()` and drops
 * anything the guard no longer considers current.
 */
export class EpochGuard {
  private current = 0;

  /** Advance the epoch; returns the new value the rebuild must use. */
  invalidate(): number {
    this.current += 1;
    return this.current;
  }

  currentEpoch(): number {
    return this.current;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.current;
  }
}

/**
 * Route an event to `sink` only while `epoch` is still current. Late
 * events from a replaced view never reach the new one.
 */
export function withEpoch<T>(
  guard: EpochGuard,
  epoch: number,
  sink: (event: T) => void,
): (event: T) => void {
  return (event) => {
    if (guard.isCurrent(epoch)) sink(event);
  };
}
