/**
 * Turn tracking and conservative outcome classification (change task 2.3).
 *
 * A turn spans the first `agent_start` of a user-initiated run to the final
 * `agent_settled` — the settle that pi guarantees has no automatic retry,
 * compaction continuation, or queued follow-up behind it. Everything in
 * between (intermediate `agent_end`s, auto-retries, compaction recovery,
 * queued continuations, waiting UI) only *updates candidate evidence*; it
 * never closes the turn and never folds anything.
 *
 * The classifier is deliberately conservative:
 *
 * - an explicit abort is abnormal;
 * - an explicit error/length/abort stop reason at settle time is abnormal;
 * - `settled.aborted === false` alone is NOT success — a missing outcome
 *   with an unknown stop reason stays `unknown`;
 * - a `toolUse` stop reason is acceptable only with an explicit completed
 *   evidence (`agent_before_settle.outcome === "completed"`); plain `stop`
 *   is acceptable on its own;
 * - after retries, only the latest candidate counts: an intermediate error
 *   never permanently poisons a turn that later completes.
 *
 * `unknown` is folded like `abnormal` (defer to the next normal settle),
 * because treating missing evidence as success is the one mistake the
 * spec forbids.
 */

/** Evidence as observed at settle time; `undefined` means "not reported". */
export type SettleEvidence = {
  /** From the settled event; absent on hosts that do not report it. */
  readonly aborted?: boolean;
  /** Stop reason of the last assistant message of the run. */
  readonly lastStopReason?: string;
  /** `agent_before_settle.outcome`, when the host ran that event. */
  readonly beforeSettleOutcome?: "completed" | "aborted" | "error";
};

export type TurnOutcome = "normal" | "abnormal" | "unknown";

const ABNORMAL_STOP_REASONS = new Set(["error", "aborted", "length"]);

export function classifySettle(evidence: SettleEvidence): TurnOutcome {
  if (evidence.aborted === true) return "abnormal";
  if (evidence.beforeSettleOutcome === "aborted") return "abnormal";
  if (evidence.beforeSettleOutcome === "error") return "abnormal";

  const stopReason = evidence.lastStopReason;
  if (stopReason !== undefined && ABNORMAL_STOP_REASONS.has(stopReason)) {
    return "abnormal";
  }

  if (evidence.beforeSettleOutcome === "completed") return "normal";
  if (stopReason === "stop") return "normal";
  // toolUse terminates acceptably only with explicit completed evidence,
  // which the check above already honored.
  return "unknown";
}

/** Pi event slice the tracker consumes (mapped by the runtime wiring). */
export type LifecycleEvent =
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end";
      /** Stop reasons of assistant messages, in message order. */
      readonly assistantStopReasons: readonly (string | undefined)[];
    }
  | {
      readonly type: "agent_before_settle";
      readonly outcome?: "completed" | "aborted" | "error";
    }
  | { readonly type: "agent_settled"; readonly aborted?: boolean }
  | { readonly type: "compaction"; readonly willRetry: boolean };

export type SettledTurn = {
  /** 1-based turn number within the view. */
  readonly turn: number;
  readonly outcome: TurnOutcome;
};

export type TurnTrackerCallbacks = {
  /** Fired exactly once per settled turn; never for intermediate ends. */
  onSettled: (settled: SettledTurn) => void;
};

export class TurnTracker {
  private readonly callbacks: TurnTrackerCallbacks;
  private openTurn: number | undefined;
  private nextTurn = 1;
  private settledCount = 0;
  /** Latest candidate evidence for the open turn. */
  private candidate: SettleEvidence = {};

  constructor(callbacks: TurnTrackerCallbacks) {
    this.callbacks = callbacks;
  }

  /** True while a turn runs (between its first start and final settle). */
  isRunning(): boolean {
    return this.openTurn !== undefined;
  }

  currentTurn(): number | undefined {
    return this.openTurn;
  }

  settledTurns(): number {
    return this.settledCount;
  }

  /**
   * Re-align turn numbering with a rebuilt model: history replays number
   * their own turns, and the next live turn must continue from the
   * model's count so the two never diverge. Ignored while a turn runs —
   * a rebuild cannot renumber an open logical turn.
   */
  resync(nextTurn: number): void {
    if (this.isRunning()) return;
    this.openTurn = undefined;
    this.nextTurn = Math.max(1, nextTurn);
    this.candidate = {};
  }

  apply(event: LifecycleEvent): void {
    switch (event.type) {
      case "agent_start":
        // Retries and continuations restart the loop without closing the
        // turn: only the first start of a run opens one.
        if (this.openTurn === undefined) {
          this.openTurn = this.nextTurn++;
          this.candidate = {};
        }
        break;
      case "agent_end": {
        // Intermediate ends only refresh the candidate stop reason; the
        // latest one wins, so a retried error does not poison the turn.
        const last =
          event.assistantStopReasons.length > 0
            ? event.assistantStopReasons[event.assistantStopReasons.length - 1]
            : undefined;
        this.candidate = { ...this.candidate, lastStopReason: last };
        break;
      }
      case "agent_before_settle":
        this.candidate = {
          ...this.candidate,
          beforeSettleOutcome: event.outcome,
        };
        break;
      case "compaction":
        // Compaction with a retry behind it is just another continuation;
        // it never settles anything by itself.
        break;
      case "agent_settled": {
        const turn = this.openTurn;
        if (turn === undefined) break;
        this.openTurn = undefined;
        this.settledCount += 1;
        const outcome = classifySettle({
          ...this.candidate,
          aborted: event.aborted,
        });
        this.candidate = {};
        this.callbacks.onSettled({ turn, outcome });
        break;
      }
    }
  }
}
