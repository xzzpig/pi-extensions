import { budgetReached } from "./goal-accounting.ts";
import { extractVerificationContract } from "./goal-contract.ts";
import { currentTaskIdIsPending, type GoalRecord, type GoalStatus, type GoalTaskList } from "./goal-record.ts";
import type { GoalSchedulerState } from "./goal-scheduler-state.ts";
import { mergeTasksWithExisting } from "./goal-task-tools.ts";

/**
 * Pure candidate construction for a /goal-tweak confirmation.
 *
 * This mirrors the business fields the tweak mutate callback writes:
 * verification-contract extraction, budget retention/removal, task progress
 * merge, current-task clearing, and the existing paused/blocked/
 * budget_limited resume admission rules. It performs no I/O and reads no
 * settings itself — the caller passes the already-loaded values and the
 * authoritative goal snapshot, so preview and apply can share one rule set.
 */
export interface TweakProposalInput {
	/** Trimmed, non-empty objective argument from propose_goal_draft. */
	objective: string;
	/** undefined retains the current budget, null removes it, a positive integer replaces it. */
	tokenBudget?: number | null;
	/**
	 * Converted proposed task list. undefined retains the current list; an
	 * explicit empty list is a real proposal that clears the task list.
	 */
	taskList?: GoalTaskList;
	/** Auditor checkbox state from the confirmation; false persists skipAuditor. */
	auditorEnabled: boolean;
}

/** Fixed inputs the apply path would otherwise read from ctx/settings inside the transaction. */
export interface TweakProjectionContext {
	/** settings.disableContracts: skip extraction and keep the raw objective text. */
	disableContracts: boolean;
	/** Current session id; the apply path resolves an absent id to "unknown-session". */
	sessionId?: string;
	/** settings.maxAutonomousRuns; undefined means no autonomous-run cap. */
	maxAutonomousRuns?: number;
	/** Timestamp written to the candidate's updatedAt. */
	now: string;
	/**
	 * Replacement scheduler generation used when an exhausted budget resets
	 * owned scheduling metadata. Required so preview and submit can share a
	 * fully deterministic candidate; callers pass a fresh UUID per proposal.
	 */
	schedulerGeneration: string;
}

export interface TweakProjectionResult {
	/** The complete effective goal the tweak would persist (service owns revision). */
	candidate: GoalRecord;
	/** True when this confirmation transitions a stalled goal back to active. */
	resumed: boolean;
	/** True when already-accounted usage meets the candidate budget. */
	budgetExhausted: boolean;
	/** True when the existing admission rules want to leave paused/blocked/budget_limited. */
	wantsResume: boolean;
	/** True when the exhausted branch replaces owned scheduler metadata. */
	schedulerReset: boolean;
}

export function projectTweakCandidate(
	goal: GoalRecord,
	proposal: TweakProposalInput,
	context: TweakProjectionContext,
): TweakProjectionResult {
	const extracted = context.disableContracts
		? { objective: proposal.objective, verificationContract: undefined }
		: extractVerificationContract(proposal.objective);
	// undefined retains a tweak budget; null removes it.
	const proposedBudget = proposal.tokenBudget === undefined ? goal.tokenBudget : proposal.tokenBudget ?? undefined;
	const mergedTaskList = proposal.taskList && goal.taskList
		? { ...proposal.taskList, tasks: mergeTasksWithExisting(goal.taskList.tasks, proposal.taskList.tasks) }
		: proposal.taskList;
	const taskList = mergedTaskList ?? goal.taskList;
	const currentTaskId = mergedTaskList && goal.currentTaskId && !currentTaskIdIsPending(mergedTaskList.tasks, goal.currentTaskId)
		? undefined
		: goal.currentTaskId;
	const exhausted = budgetReached({ ...goal, tokenBudget: proposedBudget });
	const wantsResume = goal.status === "paused"
		|| goal.status === "blocked"
		|| (goal.status === "budget_limited" && proposal.tokenBudget !== undefined && !exhausted);
	const scheduler = goal.scheduler;
	const owned = !scheduler || (
		scheduler.owner === (context.sessionId || "unknown-session")
		&& scheduler.phase !== "interrupted"
		&& scheduler.phase !== "claimed"
	);
	const limit = context.maxAutonomousRuns;
	const allowance = limit === undefined || (scheduler?.used ?? 0) < limit;
	const stalled = wantsResume && !exhausted && owned && allowance;
	const schedulerReset = exhausted && owned && scheduler !== undefined;
	const status: GoalStatus = exhausted && (goal.status === "active" || goal.status === "budget_limited" || wantsResume)
		? "budget_limited"
		: stalled
			? "active"
			: wantsResume
				? "paused"
				: goal.status;
	const nextScheduler: GoalSchedulerState | undefined = schedulerReset && scheduler
		? {
			...scheduler,
			generation: context.schedulerGeneration,
			phase: "idle",
			decision: undefined,
			dispatch: undefined,
			wait: undefined,
		}
		: scheduler;
	const candidate: GoalRecord = {
		...goal,
		tokenBudget: proposedBudget,
		...(schedulerReset ? { scheduler: nextScheduler } : {}),
		objective: extracted.objective,
		verificationContract: extracted.verificationContract ?? goal.verificationContract,
		taskList,
		currentTaskId,
		skipAuditor: !proposal.auditorEnabled,
		status,
		autoContinue: stalled ? true : goal.autoContinue,
		stopReason: stalled ? undefined : goal.stopReason,
		pauseReason: stalled ? undefined : goal.pauseReason,
		pauseSuggestedAction: stalled ? undefined : goal.pauseSuggestedAction,
		updatedAt: context.now,
	};
	return {
		candidate,
		resumed: stalled,
		budgetExhausted: exhausted,
		wantsResume,
		schedulerReset,
	};
}
