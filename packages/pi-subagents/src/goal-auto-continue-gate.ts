import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ownsRun } from "./runs/shared/run-ownership.ts";
import type { ResultDeliveryOwnership } from "./runs/background/result-delivery-ownership.ts";
import type { ParentWake } from "./shared/parent-wake.ts";
import { scheduledCompletionTriggersTurn, type CompletionNotifier } from "./runs/background/notify.ts";
import { hasGoalAutoContinueWakeWork } from "./goal-auto-continue-state.ts";
import type { SubagentState } from "./shared/types.ts";

export const GOAL_AUTO_CONTINUE_GATE_EVENT = "pi-goal:before-auto-continue:v1";
export const GOAL_AUTO_CONTINUE_GATE_VERSION = 1 as const;

interface GoalAutoContinueGateRequest {
	version: typeof GOAL_AUTO_CONTINUE_GATE_VERSION;
	sessionId: string;
	goalId: string;
	defer(input: { owner: string; reason: string }): void;
}

export interface GoalAutoContinueGateDependencies {
	state: SubagentState;
	ownership: Pick<ResultDeliveryOwnership, "owns">;
	notifier: Pick<CompletionNotifier, "hasPendingWake">;
	parentWake: Pick<ParentWake, "isPending">;
	isHeld(): boolean;
	owedResultRunIds: ReadonlySet<string>;
}

function gateRequest(value: unknown): GoalAutoContinueGateRequest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<GoalAutoContinueGateRequest>;
	if (typeof candidate.defer !== "function") return undefined;
	return candidate as GoalAutoContinueGateRequest;
}

/** Install one synchronous listener for the current parent runtime; dispose it on session replacement/reload. */
export function registerGoalAutoContinueGate(
	pi: Pick<ExtensionAPI, "events">,
	dependencies: GoalAutoContinueGateDependencies,
): () => void {
	return pi.events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, (value: unknown) => {
		const request = gateRequest(value);
		if (!request) return;
		try {
			if (request.version !== GOAL_AUTO_CONTINUE_GATE_VERSION || typeof request.sessionId !== "string" || typeof request.goalId !== "string") {
				request.defer({ owner: "pi-subagents", reason: "gate-protocol-invalid" });
				return;
			}
			const { state } = dependencies;
			if (state.supervisorOwnerSessionId !== request.sessionId) return;
			const blocked = hasGoalAutoContinueWakeWork(state, request.sessionId, {
				ownsAsyncRun: (job) => typeof job.sessionId === "string" && dependencies.ownership.owns(job.sessionId, job.completionOwnerId),
				ownsForegroundRun: (control) => typeof control.sessionId === "string" && ownsRun(state.currentSessionId, control.sessionId),
				hasOwedResultHandoff: () => {
					if (dependencies.isHeld()) return false;
					for (const runId of dependencies.owedResultRunIds) {
						const job = state.asyncJobs.get(runId);
						if (!job) return true;
						const outcome = job.status === "complete" ? "completed" : job.status;
						if (scheduledCompletionTriggersTurn(job.scheduleOrigin, outcome)) return true;
					}
					return false;
				},
				hasPendingNativeWake: () => !dependencies.isHeld()
					&& (dependencies.notifier.hasPendingWake() || dependencies.parentWake.isPending()),
			});
			if (blocked) request.defer({ owner: "pi-subagents", reason: "parent-wake-pending" });
		} catch {
			// The host event bus swallows listener errors. Fail this send closed using only bounded local diagnostics.
			try {
				request.defer({ owner: "pi-subagents", reason: "state-unavailable" });
			} catch {
				// A malformed or already-closed gate request cannot be recovered by this listener.
			}
			console.error("[pi-subagents] Goal auto-continuation state unavailable; deferring this send attempt.");
		}
	});
}
