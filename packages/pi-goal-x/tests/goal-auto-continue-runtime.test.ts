import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalRuntime } from "../extensions/goal-runtime.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

const goal = { id: "goal-1", status: "active", autoContinue: true, revision: 3 } as GoalRecord;
const ctx = {
	cwd: "/tmp/goal-runtime-gate",
	isIdle: () => true,
	hasPendingMessages: () => false,
} as unknown as ExtensionContext;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("veto ends this send attempt without claiming allowance, messages, or a retry", async () => {
	let veto = true;
	let gateCalls = 0;
	let authorizationCalls = 0;
	const snapshots: number[] = [];
	const followUps: Record<string, unknown>[] = [];
	const runtime = new GoalRuntime({
		authorize: () => {
			authorizationCalls++;
			return { generation: "generation-1", dispatchId: "dispatch-1" };
		},
		shouldDeferAutoContinue: () => {
			gateCalls++;
			return veto;
		},
		sendFollowUp: (_content, details) => followUps.push(details),
		sendStateSnapshot: (_ctx, _goal, checkpointSeq) => snapshots.push(checkpointSeq),
		getGoal: () => goal,
		isActionable: goalId => goalId === goal.id,
	});

	runtime.queueContinuation(ctx, goal, true);
	await wait(140);

	assert.equal(gateCalls, 1, "a veto does not start a retry timer");
	assert.equal(authorizationCalls, 0, "veto happens before allowance claim");
	assert.deepEqual(snapshots, [], "veto does not append a state snapshot");
	assert.deepEqual(followUps, [], "veto does not send a checkpoint");
	assert.equal(runtime.continuationPendingFor(goal.id), false);

	// A later legitimate scheduler entry is a fresh attempt. The veto consumed
	// neither authorization nor checkpoint sequence state.
	veto = false;
	runtime.queueContinuation(ctx, goal, true);
	await wait(30);
	assert.equal(gateCalls, 2);
	assert.equal(authorizationCalls, 1);
	assert.deepEqual(snapshots, [1]);
	assert.equal(Number(followUps.length), 1);
	const sentCheckpoint = (followUps as unknown as ReadonlyArray<Record<string, unknown>>).at(0);
	assert.equal(sentCheckpoint?.["checkpointSeq"], 1);
	runtime.clearContinuationState();
});

test("a synchronous gate focus switch is revalidated before stale-goal authorization", async () => {
	const replacement = { ...goal, id: "goal-2" } as GoalRecord;
	let currentGoal = goal;
	let gateCalls = 0;
	let authorizationCalls = 0;
	let snapshotCalls = 0;
	let followUpCalls = 0;
	const runtime = new GoalRuntime({
		authorize: () => {
			authorizationCalls++;
			return { generation: "generation-1", dispatchId: "dispatch-1" };
		},
		shouldDeferAutoContinue: () => {
			gateCalls++;
			currentGoal = replacement;
			return false;
		},
		sendFollowUp: () => { followUpCalls++; },
		sendStateSnapshot: () => { snapshotCalls++; },
		getGoal: () => currentGoal,
		isActionable: goalId => goalId === currentGoal.id,
	});

	runtime.queueContinuation(ctx, goal, true);
	await wait(30);

	assert.equal(gateCalls, 1, "the original goal reaches the synchronous gate before focus changes");
	assert.equal(currentGoal.id, replacement.id);
	assert.equal(authorizationCalls, 0);
	assert.equal(snapshotCalls, 0);
	assert.equal(followUpCalls, 0);
	runtime.clearContinuationState();
});

test("a gate that queues a pending host message cannot preempt it", async () => {
	let pending = false;
	let gateCalls = 0;
	let authorizationCalls = 0;
	let followUpCalls = 0;
	const pendingCtx = {
		...ctx,
		hasPendingMessages: () => pending,
	} as unknown as ExtensionContext;
	const runtime = new GoalRuntime({
		authorize: () => {
			authorizationCalls++;
			return { generation: "generation-1", dispatchId: "dispatch-1" };
		},
		shouldDeferAutoContinue: () => {
			gateCalls++;
			if (gateCalls === 1) pending = true;
			return false;
		},
		sendFollowUp: () => { followUpCalls++; },
		sendStateSnapshot: () => {},
		getGoal: () => goal,
		isActionable: goalId => goalId === goal.id,
	});

	runtime.queueContinuation(pendingCtx, goal, true);
	await wait(25);
	assert.equal(gateCalls, 1);
	assert.equal(authorizationCalls, 0);
	assert.equal(followUpCalls, 0);

	pending = false;
	await wait(80);
	assert.equal(gateCalls, 2);
	assert.equal(authorizationCalls, 1);
	assert.equal(followUpCalls, 1);
	runtime.clearContinuationState();
});

test("a gate that changes a goal to paused or complete cannot authorize it", async () => {
	for (const status of ["paused", "complete"] as const) {
		let currentGoal = goal;
		let authorizationCalls = 0;
		let snapshotCalls = 0;
		let followUpCalls = 0;
		const runtime = new GoalRuntime({
			authorize: () => {
				authorizationCalls++;
				return { generation: "generation-1", dispatchId: "dispatch-1" };
			},
			shouldDeferAutoContinue: () => {
				currentGoal = { ...goal, status, autoContinue: false } as GoalRecord;
				return false;
			},
			sendFollowUp: () => { followUpCalls++; },
			sendStateSnapshot: () => { snapshotCalls++; },
			getGoal: () => currentGoal,
			isActionable: goalId => goalId === currentGoal.id && currentGoal.status === "active" && currentGoal.autoContinue,
		});

		runtime.queueContinuation(ctx, goal, true);
		await wait(25);
		assert.equal(authorizationCalls, 0, `${status} goal is not authorized`);
		assert.equal(snapshotCalls, 0, `${status} goal gets no snapshot`);
		assert.equal(followUpCalls, 0, `${status} goal gets no checkpoint`);
		runtime.clearContinuationState();
	}
});

test("a gate that makes the host busy reuses the existing readiness retry", async () => {
	let idle = true;
	let gateCalls = 0;
	let authorizationCalls = 0;
	let snapshotCalls = 0;
	let followUpCalls = 0;
	const changingCtx = {
		...ctx,
		isIdle: () => idle,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const runtime = new GoalRuntime({
		authorize: () => {
			authorizationCalls++;
			return { generation: "generation-1", dispatchId: "dispatch-1" };
		},
		shouldDeferAutoContinue: () => {
			gateCalls++;
			if (gateCalls === 1) idle = false;
			return false;
		},
		sendFollowUp: () => { followUpCalls++; },
		sendStateSnapshot: () => { snapshotCalls++; },
		getGoal: () => goal,
		isActionable: goalId => goalId === goal.id,
	});

	runtime.queueContinuation(changingCtx, goal, true);
	await wait(25);
	assert.equal(gateCalls, 1);
	assert.equal(authorizationCalls, 0);
	assert.equal(snapshotCalls, 0);
	assert.equal(followUpCalls, 0);

	// Host work settles and the unchanged readiness loop retries after 50ms.
	idle = true;
	await wait(80);
	assert.equal(gateCalls, 2);
	assert.equal(authorizationCalls, 1);
	assert.equal(snapshotCalls, 1);
	assert.equal(followUpCalls, 1);
	runtime.clearContinuationState();
});
