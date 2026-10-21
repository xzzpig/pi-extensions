import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { appendGoalEvent, readGoalLedger, type GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import { excludeGoalModelAuditUsage, projectGoalModelLedgerEvents } from "../extensions/goal-model-view.ts";

function tempCtx() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "audit-supervisor-usage-"));
	return { cwd };
}

function sideUsage(overrides: Partial<{ tokens: number; turns: number }> = {}): GoalLedgerEvent {
	return {
		type: "audit_supervisor_usage",
		goalId: "g1",
		auditRequestId: "delegation-1",
		tokens: 15,
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 1,
		cacheWriteTokens: 2,
		costUsd: 0.01,
		turns: 1,
		at: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as GoalLedgerEvent;
}

describe("independent side-channel accounting", () => {
	it("records one audit_supervisor_usage row distinct from audit_usage", () => {
		const ctx = tempCtx();
		const result = appendGoalEvent(ctx, sideUsage());
		assert.equal(result.ok, true);
		const read = readGoalLedger(ctx);
		const types = read.events.map((event) => event.type);
		assert.ok(types.includes("audit_supervisor_usage"));
		assert.equal(types.includes("audit_usage"), false, "the auditor row stays auditor-only");
		const row = read.events.find((event) => event.type === "audit_supervisor_usage") as Record<string, unknown>;
		assert.equal(row.auditRequestId, "delegation-1");
		assert.equal(row.tokens, 15);
		assert.equal(row.turns, 1);
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	});

	it("refuses a row with a non-finite or negative counter", () => {
		const ctx = tempCtx();
		appendGoalEvent(ctx, sideUsage({ tokens: Number.NaN }));
		appendGoalEvent(ctx, sideUsage({ tokens: -5 }));
		appendGoalEvent(ctx, sideUsage({ turns: -1 }));
		const read = readGoalLedger(ctx);
		assert.equal(
			read.events.filter((event) => event.type === "audit_supervisor_usage").length + read.malformed,
			read.malformed,
			"invalid counters must never surface as a valid ledger row",
		);
		assert.ok(read.malformed > 0, "invalid rows are counted as malformed, not silently accepted");
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	});

	it("keeps the row out of both model-facing ledger views", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "audit_usage", goalId: "g1", tokens: 5, inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 1, at: "2026-01-01T00:00:00.000Z" } as GoalLedgerEvent,
			sideUsage(),
			{ type: "goal_completed", goalId: "g1", at: "2026-01-01T00:00:00.000Z" } as GoalLedgerEvent,
		];
		// The authoritative ledger still holds both rows.
		assert.equal(events.filter((event) => event.type === "audit_supervisor_usage").length, 1);
		assert.deepEqual(excludeGoalModelAuditUsage(events).map((event) => event.type), ["goal_completed"]);
		const projected = JSON.stringify(projectGoalModelLedgerEvents(events));
		assert.equal(projected.includes("audit_supervisor_usage"), false);
		assert.equal(projected.includes("audit_usage"), false);
		assert.match(projected, /goal_completed/);
	});
});