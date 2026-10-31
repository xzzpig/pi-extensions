import assert from "node:assert/strict";
import { it } from "node:test";
import { hasGoalAutoContinueWakeWork, type GoalAutoContinueStateQueries } from "../../src/goal-auto-continue-state.ts";
import type { AsyncJobState, ForegroundRunControl } from "../../src/shared/types.ts";

function state(overrides: Partial<Parameters<typeof hasGoalAutoContinueWakeWork>[0]> = {}) {
	return {
		supervisorOwnerSessionId: "parent-uuid",
		asyncJobs: new Map<string, AsyncJobState>(),
		foregroundControls: new Map<string, ForegroundRunControl>(),
		...overrides,
	};
}

function queries(overrides: Partial<GoalAutoContinueStateQueries> = {}): GoalAutoContinueStateQueries {
	return {
		ownsAsyncRun: () => false,
		ownsForegroundRun: () => false,
		hasOwedResultHandoff: () => false,
		hasPendingNativeWake: () => false,
		...overrides,
	};
}

it("scopes the projection to the exact parent-session UUID before consulting run owners", () => {
	let ownerChecks = 0;
	const active = { asyncId: "run-a", asyncDir: "/not-read", status: "running" } as AsyncJobState;
	const view = state({ asyncJobs: new Map([[active.asyncId, active]]) });
	assert.equal(hasGoalAutoContinueWakeWork(view, "another-parent", queries({ ownsAsyncRun: () => { ownerChecks++; return true; } })), false);
	assert.equal(ownerChecks, 0);
});

it("blocks only for owner-confirmed queued or running async work", () => {
	for (const status of ["queued", "running"] as const) {
		const job = { asyncId: `run-${status}`, asyncDir: "/not-read", status } as AsyncJobState;
		assert.equal(hasGoalAutoContinueWakeWork(state({ asyncJobs: new Map([[job.asyncId, job]]) }), "parent-uuid", queries({ ownsAsyncRun: () => true })), true);
	}
	const terminal = { asyncId: "run-done", asyncDir: "/not-read", status: "complete" } as AsyncJobState;
	assert.equal(hasGoalAutoContinueWakeWork(state({ asyncJobs: new Map([[terminal.asyncId, terminal]]) }), "parent-uuid", queries({ ownsAsyncRun: () => true })), false);
	const foreign = { asyncId: "foreign", asyncDir: "/not-read", status: "running" } as AsyncJobState;
	assert.equal(hasGoalAutoContinueWakeWork(state({ asyncJobs: new Map([[foreign.asyncId, foreign]]) }), "parent-uuid", queries()), false);
	const quiet = { asyncId: "quiet", asyncDir: "/not-read", status: "running", scheduleOrigin: { id: "nightly", quiet: true } } as AsyncJobState;
	assert.equal(hasGoalAutoContinueWakeWork(state({ asyncJobs: new Map([[quiet.asyncId, quiet]]) }), "parent-uuid", queries({ ownsAsyncRun: () => true })), false);
});

it("uses live foreground ownership and existing terminal/result handoff state", () => {
	const control = { runId: "foreground", sessionId: "/sessions/parent.jsonl", mode: "single" } as ForegroundRunControl;
	assert.equal(hasGoalAutoContinueWakeWork(state({ foregroundControls: new Map([[control.runId, control]]) }), "parent-uuid", queries({ ownsForegroundRun: () => true })), true);
	assert.equal(hasGoalAutoContinueWakeWork(state(), "parent-uuid", queries({ hasOwedResultHandoff: () => true })), true);
	assert.equal(hasGoalAutoContinueWakeWork(state(), "parent-uuid", queries({ hasPendingNativeWake: () => true })), true);
});

it("does not infer wake work from arbitrary result fields or task text", () => {
	const job = {
		asyncId: "quiet-or-unrecognized",
		asyncDir: "/not-read",
		status: "running",
		toolResult: { status: "running", id: "tool-supplied-id", triggerTurn: false },
		description: "background work that mentions a future result",
	} as AsyncJobState;
	assert.equal(hasGoalAutoContinueWakeWork(state({ asyncJobs: new Map([[job.asyncId, job]]) }), "parent-uuid", queries()), false);
});
