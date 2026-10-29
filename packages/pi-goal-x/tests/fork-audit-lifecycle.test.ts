import assert from "node:assert/strict";
import test from "node:test";
import { createAuditLifecycle } from "../extensions/fork-audit-lifecycle.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import type { GoalStorageContext } from "../extensions/storage/goal-root.ts";

function fixture() {
	const events: GoalLedgerEvent[] = [];
	const storage = { cwd: "/original" } as GoalStorageContext;
	let stopped = 0;
	let invalidated = 0;
	const core = {
		activeAudit: null,
		auditProgress: {},
		stopAuditAnimation: () => { stopped++; },
		goalWidgetComponentRef: { current: { invalidate: () => { invalidated++; } } },
		goalService: { appendEvents: (ctx: GoalStorageContext, rows: GoalLedgerEvent[], opts: { immediate: boolean }) => {
			assert.equal(ctx, storage);
			assert.equal(opts.immediate, true);
			events.push(...rows);
			return true;
		} },
	} as unknown as GoalCore;
	const lifecycle = createAuditLifecycle(core, storage, "goal-1", "audit-1");
	core.activeAudit = lifecycle.run;
	return { core, events, ...lifecycle, stopped: () => stopped, invalidated: () => invalidated };
}

test("lifecycle cancellation aborts and settles the original audit exactly once", () => {
	const h = fixture();
	h.run.cancel("Goal focus changed during completion audit.");
	h.run.cancel("second cancellation");
	assert.equal(h.run.controller.signal.aborted, true);
	assert.equal(h.run.phase, "settled");
	assert.equal(h.core.activeAudit, null);
	assert.equal(h.events.length, 1);
	assert.deepEqual({ ...h.events[0], at: undefined }, { type: "audit_result", auditId: "audit-1", goalId: "goal-1", verdict: "error", report: "Goal focus changed during completion audit.", at: undefined });
	assert.equal(h.stopped(), 1);
	assert.equal(h.invalidated(), 1);
});

test("a stale audit cannot clear a replacement audit's UI", () => {
	const h = fixture();
	const replacement = { controller: new AbortController(), phase: "running" as const, cancel() {} };
	h.core.activeAudit = replacement;
	assert.equal(h.settle({ type: "audit_result", auditId: "audit-1", goalId: "goal-1", verdict: "error", report: "retired", at: "now" }), true);
	assert.equal(h.core.activeAudit, replacement);
	assert.equal(h.stopped(), 0);
	assert.equal(h.invalidated(), 0);
});
