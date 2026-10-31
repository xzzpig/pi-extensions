import type { AsyncJobState, ForegroundRunControl } from "./shared/types.ts";

export interface GoalAutoContinueStateView {
	supervisorOwnerSessionId?: string | null;
	asyncJobs: ReadonlyMap<string, AsyncJobState>;
	foregroundControls: ReadonlyMap<string, ForegroundRunControl>;
}

export interface GoalAutoContinueStateQueries {
	/** Reuses pi-subagents' authoritative completion-owner/session-succession decision. */
	ownsAsyncRun(job: AsyncJobState): boolean;
	/** Reuses the same owning-session decision for live detached foreground controls. */
	ownsForegroundRun(control: ForegroundRunControl): boolean;
	/** Existing result watcher/notifier state; this is not a new completion counter. */
	hasOwedResultHandoff(): boolean;
	/** True only for notifier work with a native parent-turn wake still pending. */
	hasPendingNativeWake(): boolean;
}

/**
 * Read-only projection used by pi-goal-x's synchronous final-send gate.
 * It deliberately inspects only existing in-memory ownership and lifecycle state;
 * it performs no filesystem, event-log, transcript, or tool-result lookup.
 */
export function hasGoalAutoContinueWakeWork(
	state: GoalAutoContinueStateView,
	requestSessionId: string,
	queries: GoalAutoContinueStateQueries,
): boolean {
	if (!requestSessionId || state.supervisorOwnerSessionId !== requestSessionId) return false;

	for (const job of state.asyncJobs.values()) {
		if ((job.status === "queued" || job.status === "running")
			&& job.scheduleOrigin?.quiet !== true
			&& queries.ownsAsyncRun(job)) return true;
	}

	for (const control of state.foregroundControls.values()) {
		if (queries.ownsForegroundRun(control)) return true;
	}

	return queries.hasOwedResultHandoff() || queries.hasPendingNativeWake();
}
