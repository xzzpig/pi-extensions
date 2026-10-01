/**
 * Flow recovery and base-divergence detection (design D10; openspec change
 * add-pi-openspec-x, task 6.4).
 *
 * `/opsx:implement` runs on a persistent pi-goal-x goal, so the flow's
 * durability is goal-x's durability: after a crash or a compaction, the goal
 * (objective, task tree, ledger) is still on disk and goal-x's own
 * `/goal-resume` reattaches execution. This module is the plugin's read-only
 * half of that contract:
 *
 * - it recognizes the goals the plugin itself created, by the objective marker
 *   the assembler writes (`Implement the OpenSpec change "<id>".`), so a
 *   resumed session can offer the recovery entry for exactly those goals and
 *   never for a user's ordinary `/goal`;
 * - it detects when the session's active opsx flow and the goal base have
 *   diverged (the user cleared, paused, or completed the base goal), and
 *   reports the fork with explicit options instead of silently continuing;
 * - diagnosis is read-only. Every repair (resume, re-mirror, terminate) is an
 *   action the user confirms; nothing here mutates a goal.
 *
 * The module is pure: callers feed it goal summaries (see ./goal-base.ts for
 * the disk reader) and get decisions back.
 */

/** The minimal goal state this module reasons about. */
export interface GoalBaseSummary {
  id: string;
  /** goal-x GoalStatus: active | paused | blocked | budget_limited | complete. */
  status: string;
  objective: string;
}

/** A goal this plugin created for an openspec change. */
export interface OpsxGoalRef {
  goalId: string;
  changeId: string;
  status: string;
}

/** The objective marker the assembler writes; also the ownership test. */
const OPSX_OBJECTIVE_RE = /^Implement the OpenSpec change "([^"]+)"/m;

/** Extract the change id from an objective, when it is an opsx objective. */
export function opsxChangeIdFromObjective(
  objective: string,
): string | undefined {
  const match = OPSX_OBJECTIVE_RE.exec(objective);
  return match ? match[1] : undefined;
}

/** goal-x considers every status but `complete` unfinished. */
export function isUnfinishedGoalStatus(status: string): boolean {
  return status !== "complete";
}

/** Every opsx-created goal in the base, in the order given. */
export function findOpsxGoals(
  goals: readonly GoalBaseSummary[],
): OpsxGoalRef[] {
  const refs: OpsxGoalRef[] = [];
  for (const goal of goals) {
    const changeId = opsxChangeIdFromObjective(goal.objective);
    if (changeId) {
      refs.push({ goalId: goal.id, changeId, status: goal.status });
    }
  }
  return refs;
}

export interface RecoveryEntry {
  goal: OpsxGoalRef;
  /** User-facing prompt; recovery itself stays goal-x's `/goal-resume`. */
  message: string;
}

export type RecoveryResolution =
  | { kind: "none" }
  | { kind: "resume"; entry: RecoveryEntry }
  | { kind: "ambiguous"; candidates: OpsxGoalRef[]; message: string };

/**
 * Decide the recovery entry for a session start. With `changeId` the search is
 * scoped to that change; without it, a single unfinished opsx goal is offered
 * and several are reported as ambiguous rather than guessed.
 */
export function resolveRecoveryEntry(
  goals: readonly GoalBaseSummary[],
  options: { changeId?: string } = {},
): RecoveryResolution {
  const unfinished = findOpsxGoals(goals).filter((ref) =>
    isUnfinishedGoalStatus(ref.status),
  );
  const candidates = options.changeId
    ? unfinished.filter((ref) => ref.changeId === options.changeId)
    : unfinished;

  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) {
    const goal = candidates[0]!;
    return {
      kind: "resume",
      entry: {
        goal,
        message: `An unfinished opsx implementation goal for change "${goal.changeId}" is in the goal base (${goal.goalId}, ${goal.status}). Run /goal-resume to reattach execution, or /goal-clear to abandon it.`,
      },
    };
  }
  return {
    kind: "ambiguous",
    candidates,
    message: `Several unfinished opsx implementation goals exist (${candidates
      .map((ref) => `${ref.goalId} → ${ref.changeId}`)
      .join(
        ", ",
      )}). Pick the change explicitly (or focus a goal with /goal-focus) before resuming.`,
  };
}

/** The session's active opsx flow, as the plugin tracks it in memory. */
export interface ActiveFlowRef {
  goalId: string;
  changeId: string;
}

export type FlowDivergenceKind =
  | "goal_cleared"
  | "goal_paused"
  | "goal_completed";

export interface FlowDivergence {
  kind: FlowDivergenceKind;
  goalId: string;
  changeId: string;
  message: string;
  /** The user's choices; no repair runs without confirmation. */
  options: string[];
}

/**
 * Detect that the session's active opsx flow no longer matches the goal base:
 * the goal was cleared (gone), paused/blocked, or completed out from under the
 * flow. `undefined` means the flow and the base still agree.
 */
export function detectFlowDivergence(
  active: ActiveFlowRef | undefined,
  goals: readonly GoalBaseSummary[],
): FlowDivergence | undefined {
  if (!active) return undefined;
  const goal = goals.find((candidate) => candidate.id === active.goalId);
  if (!goal) {
    return {
      kind: "goal_cleared",
      goalId: active.goalId,
      changeId: active.changeId,
      message: `The opsx implementation flow for change "${active.changeId}" was running on goal ${active.goalId}, but that goal is no longer in the base (cleared or archived).`,
      options: [
        "Recreate the goal from tasks.md and resume the flow.",
        "Terminate the flow and leave the change as it is.",
      ],
    };
  }
  if (goal.status === "paused" || goal.status === "blocked") {
    return {
      kind: "goal_paused",
      goalId: active.goalId,
      changeId: active.changeId,
      message: `The base goal ${active.goalId} for change "${active.changeId}" is ${goal.status}; the flow cannot advance until it is resumed.`,
      options: [
        "Run /goal-resume to continue the existing goal.",
        "Terminate the flow and leave the change as it is.",
      ],
    };
  }
  if (goal.status === "complete") {
    return {
      kind: "goal_completed",
      goalId: active.goalId,
      changeId: active.changeId,
      message: `The base goal ${active.goalId} for change "${active.changeId}" is already complete while the flow still considers itself active.`,
      options: [
        "Accept the completed goal and move to the archive step.",
        "Start a fresh goal for the remaining work.",
      ],
    };
  }
  return undefined;
}

export interface FlowDiagnosis {
  /** False when a divergence was found. */
  ok: boolean;
  /** Read-only observations, safe to show without any mutation. */
  notices: string[];
  divergence?: FlowDivergence;
  recovery?: RecoveryEntry;
  /** Every suggested repair is an explicit user-confirmed action. */
  repairRequiresConfirmation: true;
}

/**
 * Read-only diagnosis for a session: what the base holds for this change, and
 * whether the active flow diverged from it. Never mutates; the returned
 * notices/options are for the caller to surface.
 */
export function diagnoseFlow(input: {
  active?: ActiveFlowRef;
  goals: readonly GoalBaseSummary[];
  changeId?: string;
}): FlowDiagnosis {
  const notices: string[] = [];
  const divergence = detectFlowDivergence(input.active, input.goals);
  if (divergence) notices.push(divergence.message);

  const recovery = resolveRecoveryEntry(input.goals, {
    changeId: input.changeId,
  });
  if (recovery.kind === "resume") notices.push(recovery.entry.message);
  else if (recovery.kind === "ambiguous") notices.push(recovery.message);

  return {
    ok: !divergence,
    notices,
    ...(divergence ? { divergence } : {}),
    ...(recovery.kind === "resume" ? { recovery: recovery.entry } : {}),
    repairRequiresConfirmation: true,
  };
}
