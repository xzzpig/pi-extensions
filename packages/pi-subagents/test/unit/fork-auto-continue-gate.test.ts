import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import {
	GOAL_AUTO_CONTINUE_GATE_EVENT,
	registerGoalAutoContinueGate,
	type GoalAutoContinueGateDependencies,
} from "../../src/goal-auto-continue-gate.ts";
import { createResultDeliveryOwnership } from "../../src/runs/background/result-delivery-ownership.ts";
import type { AsyncJobState, ForegroundRunControl, SubagentState } from "../../src/shared/types.ts";

type Defer = (input: { owner: string; reason: string }) => void;

function createPi() {
	const emitter = new EventEmitter();
	return {
		events: {
			on(event: string, listener: (value: unknown) => void) {
			emitter.on(event, listener);
			return () => emitter.off(event, listener);
			},
			emit(event: string, value: unknown) {
				return emitter.emit(event, value);
			},
			listenerCount(event: string) {
				return emitter.listenerCount(event);
			},
		},
	};
}

function dependencies(overrides: Partial<GoalAutoContinueGateDependencies> = {}): GoalAutoContinueGateDependencies {
	return {
		state: {
			supervisorOwnerSessionId: "parent-uuid",
			currentSessionId: "/sessions/parent.jsonl",
			asyncJobs: new Map(),
			foregroundControls: new Map(),
		} as unknown as SubagentState,
		ownership: { owns: () => false } as GoalAutoContinueGateDependencies["ownership"],
		notifier: { hasPendingWake: () => false },
		parentWake: { isPending: () => false },
		isHeld: () => false,
		owedResultRunIds: new Set(),
		...overrides,
	};
}

function request(sessionId = "parent-uuid", defer: Defer) {
	return { version: 1 as const, sessionId, goalId: "goal-1", defer };
}

it("makes owner-confirmed native async work defer synchronously for the current parent only", () => {
	const pi = createPi();
	const job = { asyncId: "async-1", asyncDir: "/unused", status: "running", sessionId: "/sessions/parent.jsonl", completionOwnerId: "owner-a" } as AsyncJobState;
	const state = {
		supervisorOwnerSessionId: "parent-uuid",
		currentSessionId: "/sessions/parent.jsonl",
		completionOwnerId: "owner-a",
		asyncJobs: new Map([[job.asyncId, job]]),
		foregroundControls: new Map(),
	} as unknown as SubagentState;
	const owned = dependencies({ state, ownership: createResultDeliveryOwnership(state) });
	const dispose = registerGoalAutoContinueGate(pi as never, owned);
	try {
		const decisions: Array<{ owner: string; reason: string }> = [];
		let dispatchReturned = false;
		pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("other-parent", () => assert.fail("foreign session must not be blocked")));
		pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", (decision) => {
			assert.equal(dispatchReturned, false, "the decision is synchronous within event dispatch");
			decisions.push(decision);
		}));
		dispatchReturned = true;
		assert.deepEqual(decisions, [{ owner: "pi-subagents", reason: "parent-wake-pending" }]);
	} finally {
		dispose();
	}
});

it("covers an accepted result piggybacking on a reserved parent wake until it starts", () => {
	const pi = createPi();
	const dispose = registerGoalAutoContinueGate(pi as never, dependencies({ parentWake: { isPending: () => true } }));
	try {
		const decisions: Array<{ owner: string; reason: string }> = [];
		pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", (decision) => decisions.push(decision)));
		assert.deepEqual(decisions, [{ owner: "pi-subagents", reason: "parent-wake-pending" }]);
	} finally {
		dispose();
	}

	const heldPi = createPi();
	const disposeHeld = registerGoalAutoContinueGate(heldPi as never, dependencies({
		parentWake: { isPending: () => true },
		isHeld: () => true,
	}));
	try {
		const decisions: Array<{ owner: string; reason: string }> = [];
		heldPi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", (decision) => decisions.push(decision)));
		assert.deepEqual(decisions, [], "a held parent has no native result wake promise");
	} finally {
		disposeHeld();
	}
});

it("matches detached foreground ownership by its session-file identity while scoping the request by UUID", () => {
	const pi = createPi();
	const control = { runId: "foreground-1", sessionId: "/sessions/parent.jsonl", mode: "single" } as ForegroundRunControl;
	const state = {
		supervisorOwnerSessionId: "parent-uuid",
		currentSessionId: "/sessions/parent.jsonl",
		asyncJobs: new Map(),
		foregroundControls: new Map([[control.runId, control]]),
	} as unknown as SubagentState;
	const dispose = registerGoalAutoContinueGate(pi as never, dependencies({ state }));
	try {
		const decisions: Array<{ owner: string; reason: string }> = [];
		pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", (decision) => decisions.push(decision)));
		assert.deepEqual(decisions, [{ owner: "pi-subagents", reason: "parent-wake-pending" }]);
	} finally {
		dispose();
	}
});

it("does not defer an explicitly quiet successful completion awaiting non-waking delivery", () => {
	const pi = createPi();
	const job = {
		asyncId: "quiet-result",
		asyncDir: "/unused",
		status: "complete",
		scheduleOrigin: { id: "nightly", quiet: true },
	} as AsyncJobState;
	const state = {
		supervisorOwnerSessionId: "parent-uuid",
		currentSessionId: "/sessions/parent.jsonl",
		asyncJobs: new Map([[job.asyncId, job]]),
		foregroundControls: new Map(),
	} as unknown as SubagentState;
	const owned = dependencies({ state, owedResultRunIds: new Set([job.asyncId]) });
	const dispose = registerGoalAutoContinueGate(pi as never, owned);
	try {
		const decisions: Array<{ owner: string; reason: string }> = [];
		pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", (decision) => decisions.push(decision)));
		assert.deepEqual(decisions, []);
	} finally {
		dispose();
	}
});

it("defers terminal owned failures until result handoff and the parent wake are both complete", () => {
	const pi = createPi();
	const job = { asyncId: "failed-result", asyncDir: "/unused", status: "failed" } as AsyncJobState;
	const owedResultRunIds = new Set([job.asyncId]);
	let pendingWake = false;
	const state = {
		supervisorOwnerSessionId: "parent-uuid",
		currentSessionId: "/sessions/parent.jsonl",
		asyncJobs: new Map([[job.asyncId, job]]),
		foregroundControls: new Map(),
	} as unknown as SubagentState;
	const dispose = registerGoalAutoContinueGate(pi as never, dependencies({
		state,
		owedResultRunIds,
		notifier: { hasPendingWake: () => pendingWake },
	}));
	try {
		const decisions: Array<{ owner: string; reason: string }> = [];
		const evaluate = () => pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", (decision) => decisions.push(decision)));
		evaluate();
		assert.deepEqual(decisions, [{ owner: "pi-subagents", reason: "parent-wake-pending" }], "terminal state alone does not prove the result was handed off");
		owedResultRunIds.delete(job.asyncId);
		pendingWake = true;
		evaluate();
		assert.deepEqual(decisions, [{ owner: "pi-subagents", reason: "parent-wake-pending" }, { owner: "pi-subagents", reason: "parent-wake-pending" }]);
		pendingWake = false;
		evaluate();
		assert.equal(decisions.length, 2, "once the native wake handoff is complete the gate allows the next legal attempt");
	} finally {
		dispose();
	}
});

it("fails this gate closed on local ownership-read errors and releases the listener on dispose", () => {
	const pi = createPi();
	const dispose = registerGoalAutoContinueGate(pi as never, dependencies({
		state: {
			supervisorOwnerSessionId: "parent-uuid",
			currentSessionId: "/sessions/parent.jsonl",
			completionOwnerId: "owner-a",
			asyncJobs: new Map([["broken", { asyncId: "broken", asyncDir: "/unused", status: "running", sessionId: "/sessions/parent.jsonl", completionOwnerId: "owner-a" } as AsyncJobState]]),
			foregroundControls: new Map(),
		} as unknown as SubagentState,
		ownership: { owns: () => { throw new Error("unavailable"); } },
	}));
	const decisions: Array<{ owner: string; reason: string }> = [];
	pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", (decision) => decisions.push(decision)));
	assert.deepEqual(decisions, [{ owner: "pi-subagents", reason: "state-unavailable" }]);
	assert.equal(pi.events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 1);
	dispose();
	assert.equal(pi.events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 0);
	pi.events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, request("parent-uuid", () => assert.fail("disposed listener must not run")));
});
