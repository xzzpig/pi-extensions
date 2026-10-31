import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Synchronous, process-local veto point before an automatic goal checkpoint is sent. */
export const GOAL_AUTO_CONTINUE_GATE_EVENT = "pi-goal:before-auto-continue:v1";
export const GOAL_AUTO_CONTINUE_GATE_VERSION = 1 as const;

export interface GoalAutoContinueIdentity {
	sessionId: string;
	goalId: string;
}

export interface GoalAutoContinueDeferral {
	/** Short stable identifier for the extension that owns the deferral. */
	owner: string;
	/** Bounded diagnostic only; it is never persisted or added to model context. */
	reason: string;
}

export interface GoalAutoContinueGateRequest extends GoalAutoContinueIdentity {
	readonly version: typeof GOAL_AUTO_CONTINUE_GATE_VERSION;
	/** A deferral is monotonic and is effective only during this synchronous dispatch. */
	defer(input: GoalAutoContinueDeferral): void;
}

/**
 * Ask synchronous listeners whether a goal checkpoint should be deferred.
 *
 * Pi's EventBus.emit() returns void and does not await handlers. Listeners must
 * inspect their already-available runtime state and call defer before their
 * handler returns (an async handler may do so before its first await). No reason
 * or listener state is retained here; the event is not a model-context channel.
 */
export function shouldDeferGoalAutoContinue(
	events: Pick<EventBus, "emit">,
	identity: GoalAutoContinueIdentity,
): boolean {
	let dispatching = true;
	let deferred = false;
	const request: GoalAutoContinueGateRequest = Object.freeze({
		version: GOAL_AUTO_CONTINUE_GATE_VERSION,
		sessionId: identity.sessionId,
		goalId: identity.goalId,
		defer: (_input: GoalAutoContinueDeferral) => {
			if (dispatching) deferred = true;
		},
	});

	try {
		events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request);
	} catch {
		// A failed gate dispatch must not authorize a checkpoint by default.
		deferred = true;
	} finally {
		dispatching = false;
	}

	return deferred;
}
