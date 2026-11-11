/**
 * Fork-only pure-model coverage for /goal-tweak candidate construction:
 * contract extraction, task progress merge, budget retention/removal, auditor
 * state, and the existing paused/blocked/budget_limited resume admission rules.
 * No goal files, session manager, settings loader, or service transaction is
 * involved — the helper is the shared rule set, not the transaction.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { GoalRecord, GoalTask, GoalTaskList } from "../extensions/goal-record.ts";
import type { GoalSchedulerState } from "../extensions/goal-scheduler-state.ts";
import {
	projectTweakCandidate,
	type TweakProjectionContext,
	type TweakProposalInput,
} from "../extensions/goal-tweak-projection.ts";

const NOW = "2026-11-04T12:00:00.000Z";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "goal-1",
		objective: "Original objective",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		revision: 7,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-02T00:00:00.000Z",
		...overrides,
	};
}

function makeContext(overrides: Partial<TweakProjectionContext> = {}): TweakProjectionContext {
	return {
		disableContracts: false,
		sessionId: "session-1",
		maxAutonomousRuns: 5,
		now: NOW,
		schedulerGeneration: "generation-new",
		...overrides,
	};
}

function makeProposal(overrides: Partial<TweakProposalInput> = {}): TweakProposalInput {
	return { objective: "Original objective", auditorEnabled: true, ...overrides };
}

function makeScheduler(overrides: Partial<GoalSchedulerState> = {}): GoalSchedulerState {
	return {
		version: 1,
		owner: "session-1",
		generation: "generation-old",
		used: 1,
		phase: "idle",
		repairUsed: false,
		...overrides,
	};
}

function makeTask(id: string, overrides: Partial<GoalTask> = {}): GoalTask {
	return { id, title: `Task ${id}`, status: "pending", ...overrides };
}

function makeTaskList(tasks: GoalTask[], blockCompletion = false): GoalTaskList {
	return { tasks, blockCompletion, proposedAt: "2026-11-03T00:00:00.000Z" };
}

// ── Omitted vs explicit task list, budget, and contract ─────────────────────

test("omitted optional fields retain the task list, budget, current task, and existing contract", () => {
	const taskList = makeTaskList([
		makeTask("a", { status: "complete", evidence: "verified" }),
		makeTask("b"),
	], true);
	const goal = makeGoal({
		objective: "Original objective",
		verificationContract: "legacy evidence",
		taskList,
		currentTaskId: "b",
		tokenBudget: 50,
		skipAuditor: true,
	});
	const result = projectTweakCandidate(goal, makeProposal(), makeContext());

	assert.equal(result.candidate.taskList, goal.taskList, "omitted tasks retain the same list");
	assert.equal(result.candidate.tokenBudget, 50, "omitted budget retains the current budget");
	assert.equal(result.candidate.currentTaskId, "b", "current task is untouched without a new list");
	assert.equal(result.candidate.verificationContract, "legacy evidence", "omitted contract retains the old contract");
	assert.equal(result.candidate.objective, "Original objective");
	assert.equal(result.candidate.skipAuditor, false, "an enabled auditor clears the previous skip flag");
	assert.equal(result.candidate.status, "active");
	assert.equal(result.resumed, false);
	assert.equal(result.wantsResume, false);
	assert.equal(result.budgetExhausted, false);
});

test("an explicit empty task list is a real proposal that clears tasks and the current task", () => {
	const goal = makeGoal({
		taskList: makeTaskList([makeTask("a"), makeTask("b")]),
		currentTaskId: "b",
	});
	const proposal = makeProposal({
		taskList: { tasks: [], blockCompletion: false, proposedAt: "2026-11-04T00:00:00.000Z" },
	});
	const result = projectTweakCandidate(goal, proposal, makeContext());

	assert.ok(result.candidate.taskList, "explicit empty tasks stay an explicit list");
	assert.deepEqual(result.candidate.taskList.tasks, []);
	assert.equal(result.candidate.taskList.blockCompletion, false);
	assert.equal(result.candidate.currentTaskId, undefined, "removing the current task clears the reference");
	assert.equal(result.candidate.objective, "Original objective");
});

// ── Task progress merge and currentTaskId ───────────────────────────────────

test("task merge preserves status and evidence by id while new ids start pending", () => {
	const goal = makeGoal({
		taskList: makeTaskList([
			makeTask("keep", {
				title: "Old title",
				status: "complete",
				evidence: "node --test passes",
				completedAt: "2026-11-02T01:00:00.000Z",
				subtasks: [makeTask("nested", { status: "skipped", skipReason: "out of scope", skippedAt: "2026-11-02T02:00:00.000Z" })],
			}),
			makeTask("remove"),
		]),
		currentTaskId: "remove",
	});
	const proposedTasks: GoalTask[] = [
		{
			id: "keep",
			title: "New title",
			status: "pending",
			subtasks: [{ id: "nested", title: "Nested retitled", status: "pending" }],
		},
		{ id: "added", title: "Added task", status: "pending" },
	];
	const snapshot = structuredClone(goal);
	const result = projectTweakCandidate(
		goal,
		makeProposal({ taskList: makeTaskList(proposedTasks) }),
		makeContext(),
	);

	assert.deepEqual(goal, snapshot, "projection never mutates the authoritative goal");
	assert.equal(result.candidate.taskList?.tasks[0]?.title, "New title", "structural title comes from the proposal");
	assert.equal(result.candidate.taskList?.tasks[0]?.status, "complete", "completed status survives the merge");
	assert.equal(result.candidate.taskList?.tasks[0]?.evidence, "node --test passes", "evidence survives the merge");
	assert.equal(result.candidate.taskList?.tasks[0]?.completedAt, "2026-11-02T01:00:00.000Z");
	assert.equal(result.candidate.taskList?.tasks[0]?.subtasks?.[0]?.status, "skipped", "nested progress survives");
	assert.equal(result.candidate.taskList?.tasks[0]?.subtasks?.[0]?.skipReason, "out of scope");
	assert.equal(result.candidate.taskList?.tasks[1]?.id, "added");
	assert.equal(result.candidate.taskList?.tasks[1]?.status, "pending", "new ids start pending");
	assert.equal(result.candidate.currentTaskId, undefined, "a removed current task id is cleared");
	assert.equal(result.candidate.taskList?.tasks.length, 2);
});

test("currentTaskId survives while its task remains pending in the merged tree", () => {
	const goal = makeGoal({
		taskList: makeTaskList([{ id: "a", title: "A", status: "pending", subtasks: [{ id: "child", title: "Child", status: "pending" }] }]),
		currentTaskId: "child",
	});
	const result = projectTweakCandidate(
		goal,
		makeProposal({
			taskList: makeTaskList([
				{ id: "a", title: "A retitled", status: "pending", subtasks: [{ id: "child", title: "Child retitled", status: "pending" }] },
			]),
		}),
		makeContext(),
	);
	assert.equal(result.candidate.currentTaskId, "child", "nested pending current task stays focused");
});

// ── Budget retention / removal / replacement ────────────────────────────────

test("budget semantics: undefined retains, null removes, a number replaces", () => {
	const goal = makeGoal({ tokenBudget: 100, usage: { tokensUsed: 10, activeSeconds: 0 } });

	const retained = projectTweakCandidate(goal, makeProposal(), makeContext());
	assert.equal(retained.candidate.tokenBudget, 100);

	const removed = projectTweakCandidate(goal, makeProposal({ tokenBudget: null }), makeContext());
	assert.equal(removed.candidate.tokenBudget, undefined);

	const replaced = projectTweakCandidate(goal, makeProposal({ tokenBudget: 250 }), makeContext());
	assert.equal(replaced.candidate.tokenBudget, 250);
});

// ── Contract extraction and disableContracts ────────────────────────────────

test("contract extraction strips the contract line from the objective and records the contract", () => {
	const objective = "Body line\nVerification contract: unit tests pass\nTail line";
	const result = projectTweakCandidate(makeGoal(), makeProposal({ objective }), makeContext());
	assert.equal(result.candidate.objective, "Body line\nTail line");
	assert.equal(result.candidate.verificationContract, "unit tests pass");
});

test("disableContracts keeps the raw objective line and retains the existing effective contract", () => {
	const objective = "Body line\nVerification contract: new evidence\nTail line";
	const goal = makeGoal({ verificationContract: "old evidence" });
	const result = projectTweakCandidate(
		goal,
		makeProposal({ objective }),
		makeContext({ disableContracts: true }),
	);
	assert.equal(result.candidate.objective, objective, "contract text stays inside the objective");
	assert.equal(result.candidate.verificationContract, "old evidence", "the old effective contract is retained");
});

test("an objective without a contract keeps the existing goal contract", () => {
	const goal = makeGoal({ verificationContract: "keep me" });
	const result = projectTweakCandidate(goal, makeProposal({ objective: "Only body" }), makeContext());
	assert.equal(result.candidate.verificationContract, "keep me");
});

// ── Auditor choice ──────────────────────────────────────────────────────────

test("the confirmation auditor state is persisted as skipAuditor", () => {
	const disabled = projectTweakCandidate(makeGoal(), makeProposal({ auditorEnabled: false }), makeContext());
	assert.equal(disabled.candidate.skipAuditor, true);

	const enabled = projectTweakCandidate(makeGoal({ skipAuditor: true }), makeProposal({ auditorEnabled: true }), makeContext());
	assert.equal(enabled.candidate.skipAuditor, false);
});

// ── Existing resume / exhausted admission rules ─────────────────────────────

test("paused and blocked goals resume when owned, unexhausted, and allowance remains", () => {
	for (const status of ["paused", "blocked"] as const) {
		const goal = makeGoal({
			status,
			autoContinue: false,
			stopReason: "user",
			pauseReason: "waiting",
			pauseSuggestedAction: "resume later",
			scheduler: makeScheduler({ used: 4 }),
		});
		const result = projectTweakCandidate(goal, makeProposal(), makeContext({ maxAutonomousRuns: 5 }));
		assert.equal(result.resumed, true, `${status} resumes`);
		assert.equal(result.wantsResume, true);
		assert.equal(result.candidate.status, "active");
		assert.equal(result.candidate.autoContinue, true, "resume enables automatic continuation");
		assert.equal(result.candidate.stopReason, undefined);
		assert.equal(result.candidate.pauseReason, undefined);
		assert.equal(result.candidate.pauseSuggestedAction, undefined);
		assert.equal(result.candidate.updatedAt, NOW);
	}
});

test("a budget_limited goal resumes only when the proposal explicitly changes the budget", () => {
	const goal = makeGoal({
		status: "budget_limited",
		tokenBudget: 100,
		usage: { tokensUsed: 100, activeSeconds: 0 },
		scheduler: makeScheduler({ used: 2 }),
	});

	const retained = projectTweakCandidate(goal, makeProposal(), makeContext());
	assert.equal(retained.wantsResume, false, "omitted token_budget does not clear the resource gate");
	assert.equal(retained.resumed, false);
	assert.equal(retained.candidate.status, "budget_limited");

	const removed = projectTweakCandidate(goal, makeProposal({ tokenBudget: null }), makeContext());
	assert.equal(removed.budgetExhausted, false);
	assert.equal(removed.wantsResume, true);
	assert.equal(removed.resumed, true);
	assert.equal(removed.candidate.status, "active");
	assert.equal(removed.candidate.tokenBudget, undefined);

	const raised = projectTweakCandidate(goal, makeProposal({ tokenBudget: 500 }), makeContext());
	assert.equal(raised.resumed, true);
	assert.equal(raised.candidate.status, "active");
	assert.equal(raised.candidate.tokenBudget, 500);
});

test("a frozen budget change that is still exhausted stays budget_limited without resume", () => {
	const goal = makeGoal({
		status: "budget_limited",
		tokenBudget: 100,
		usage: { tokensUsed: 90, activeSeconds: 0 },
		scheduler: makeScheduler(),
	});
	const result = projectTweakCandidate(goal, makeProposal({ tokenBudget: 50 }), makeContext());
	assert.equal(result.budgetExhausted, true);
	assert.equal(result.wantsResume, false, "an explicit change does not clear an exhausted budget");
	assert.equal(result.resumed, false);
	assert.equal(result.candidate.status, "budget_limited");
});

test("resume admission rejects foreign, interrupted, or claimed schedulers", () => {
	for (const scheduler of [
		makeScheduler({ owner: "other-session" }),
		makeScheduler({ phase: "interrupted" }),
		makeScheduler({ phase: "claimed", dispatch: { id: "d", kind: "ready", claimedAt: 1 } }),
	]) {
		const goal = makeGoal({
			status: "paused",
			autoContinue: false,
			scheduler,
		});
		const result = projectTweakCandidate(goal, makeProposal(), makeContext());
		assert.equal(result.wantsResume, true);
		assert.equal(result.resumed, false, `${scheduler.owner}/${scheduler.phase} is not owned`);
		assert.equal(result.candidate.status, "paused");
		assert.equal(result.candidate.autoContinue, false);
	}
});

test("resume admission enforces the maxAutonomousRuns allowance", () => {
	const goal = makeGoal({ status: "paused", scheduler: makeScheduler({ used: 5 }) });
	const blocked = projectTweakCandidate(goal, makeProposal(), makeContext({ maxAutonomousRuns: 5 }));
	assert.equal(blocked.resumed, false);
	assert.equal(blocked.candidate.status, "paused");

	const unlimited = projectTweakCandidate(
		makeGoal({ status: "paused", scheduler: makeScheduler({ used: 999 }) }),
		makeProposal(),
		makeContext({ maxAutonomousRuns: undefined }),
	);
	assert.equal(unlimited.resumed, true, "no configured cap means unlimited allowance");

	const disabled = projectTweakCandidate(
		makeGoal({ status: "paused", scheduler: makeScheduler({ used: 0 }) }),
		makeProposal(),
		makeContext({ maxAutonomousRuns: 0 }),
	);
	assert.equal(disabled.resumed, false, "a zero allowance disables automatic resume");
});

test("a paused goal without scheduler state is owned and may resume", () => {
	const result = projectTweakCandidate(makeGoal({ status: "paused" }), makeProposal(), makeContext());
	assert.equal(result.resumed, true);
	assert.equal(result.candidate.scheduler, undefined);
});

test("an exhausted active goal becomes budget_limited and resets owned scheduler metadata", () => {
	const goal = makeGoal({
		tokenBudget: 100,
		usage: { tokensUsed: 100, activeSeconds: 30 },
		scheduler: makeScheduler({
			used: 3,
			phase: "waiting",
			decision: { kind: "wait" },
			wait: { id: "w", token: "t", reason: "poll", deadline: 10, intervalMs: 1000, remainingChecks: 2, nextCheckAt: 20 },
			idle: { runs: 2, nextAt: 30 },
		}),
	});
	const result = projectTweakCandidate(goal, makeProposal(), makeContext());
	assert.equal(result.budgetExhausted, true);
	assert.equal(result.resumed, false);
	assert.equal(result.wantsResume, false);
	assert.equal(result.schedulerReset, true);
	assert.equal(result.candidate.status, "budget_limited");
	assert.equal(result.candidate.scheduler?.generation, "generation-new");
	assert.equal(result.candidate.scheduler?.phase, "idle");
	assert.equal(result.candidate.scheduler?.used, 3, "spent allowance is preserved");
	assert.equal(result.candidate.scheduler?.decision, undefined);
	assert.equal(result.candidate.scheduler?.wait, undefined);
	assert.equal(result.candidate.scheduler?.dispatch, undefined);
	assert.deepEqual(result.candidate.scheduler?.idle, { runs: 2, nextAt: 30 });
});

test("an exhausted active goal with a foreign scheduler stays budget_limited without resetting it", () => {
	const scheduler = makeScheduler({ owner: "other-session", phase: "ready", decision: { kind: "ready", purpose: "ready" } });
	const goal = makeGoal({ tokenBudget: 100, usage: { tokensUsed: 120, activeSeconds: 0 }, scheduler });
	const result = projectTweakCandidate(goal, makeProposal(), makeContext());
	assert.equal(result.budgetExhausted, true);
	assert.equal(result.schedulerReset, false);
	assert.equal(result.candidate.status, "budget_limited");
	assert.equal(result.candidate.scheduler, scheduler, "foreign scheduling state is untouched");
});

test("exhaustion wins over resume admission for a paused goal", () => {
	const goal = makeGoal({
		status: "paused",
		tokenBudget: 100,
		usage: { tokensUsed: 100, activeSeconds: 0 },
		scheduler: makeScheduler(),
	});
	const result = projectTweakCandidate(goal, makeProposal({ tokenBudget: 100 }), makeContext());
	assert.equal(result.wantsResume, true);
	assert.equal(result.budgetExhausted, true);
	assert.equal(result.resumed, false);
	assert.equal(result.candidate.status, "budget_limited", "exhaustion is the observable lifecycle state");
});

// ── Identity and untouched bookkeeping ─────────────────────────────────────

test("the candidate keeps goal identity and bookkeeping the reveal must not rewrite", () => {
	const goal = makeGoal({ tokenBudget: 42, usage: { tokensUsed: 10, activeSeconds: 20 }, sisyphus: true });
	const result = projectTweakCandidate(goal, makeProposal({ objective: "New objective" }), makeContext());
	assert.equal(result.candidate.id, goal.id);
	assert.equal(result.candidate.usage, goal.usage);
	assert.equal(result.candidate.revision, goal.revision);
	assert.equal(result.candidate.createdAt, goal.createdAt);
	assert.equal(result.candidate.sisyphus, goal.sisyphus);
	assert.equal(result.candidate.updatedAt, NOW);
	assert.equal(result.candidate.tokenBudget, 42, "omitted token_budget retains the lifetime budget");
});
