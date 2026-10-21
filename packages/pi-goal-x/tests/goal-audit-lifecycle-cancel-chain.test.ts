import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SUPERVISOR_RESPONDER_REGISTER_EVENT } from "@xzzpig/pi-subagents/supervisor-routing";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
} from "@xzzpig/pi-subagents/delegation";
import { invalidateAuditSidechannelsForOwner } from "../extensions/goal-audit-sidechannel.ts";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor-delegation.ts";

type Handler = (value: unknown) => void;

/** Minimal event bus that acknowledges responder registration like pi-subagents does. */
function createBus() {
	const handlers = new Map<string, Handler[]>();
	const bus = {
		registration: undefined as Record<string, unknown> | undefined,
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, value: unknown) {
			if (event === SUPERVISOR_RESPONDER_REGISTER_EVENT) {
				const request = value as Record<string, unknown>;
				bus.registration = request;
				request.result = { ok: true, registration: { dispose() {} } };
				return;
			}
			for (const handler of [...(handlers.get(event) ?? [])]) handler(value);
		},
	};
	return bus;
}

function ctx() {
	return {
		cwd: "/repo",
		sessionManager: { getSessionId: () => "test-session", getEntries: () => [], getLeafId: () => null },
		model: { provider: "mock", id: "mock-model" },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "mock-model" }] },
		getSystemPrompt: () => "SYSTEM",
	} as never;
}

function args(events: ReturnType<typeof createBus>) {
	return {
		ctx: ctx(),
		events: events as never,
		goal: { id: "g1", revision: 0, objective: "o", status: "active", tasks: [], createdAt: new Date().toISOString() },
		detailedSummary: "Goal: g1",
		skipPreflight: true,
		timeouts: { startedMs: 5_000, terminalMs: 30_000, cancellationMs: 50 },
	} as never;
}

/**
 * Success criterion 6, full chain: a REAL lifecycle revocation must go through the production
 * callback (which calls cancelAttempt("lifecycle_revoked")), emit exactly ONE precise cancel for the
 * original identity, and a LATE approved structured response must not authorise completion.
 */
describe("audit lifecycle cancel chain", () => {
	it("one precise cancel, late approval cannot authorise, and a second revocation is a no-op", async () => {
		const bus = createBus();
		const cancels: Array<Record<string, unknown>> = [];
		let identity: Record<string, unknown> | undefined;
		bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (value) => cancels.push(value as Record<string, unknown>));
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			identity = value as Record<string, unknown>;
			bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
		});
		const pending = runGoalCompletionAuditor(args(bus));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(identity, "the audit request was emitted");
		// REAL production seam: focus/status revocation through the side-channel registry.
		invalidateAuditSidechannelsForOwner("test-session", "g1", "focus_changed");
		invalidateAuditSidechannelsForOwner("test-session", "g1", "focus_changed");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(cancels.length, 1, "exactly one precise cancel is emitted");
		const cancel = cancels[0]!;
		assert.equal(cancel.requestId, identity!.requestId, "the cancel carries the original requestId");
		assert.equal(cancel.ownerRunId, identity!.ownerRunId, "…the original ownerRunId");
		assert.equal(cancel.nodeId, identity!.nodeId, "…and the original nodeId");
		// A LATE, schema-valid approval arrives after the revocation.
		bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
			...(identity as object),
			status: "completed",
			result: { kind: "structured", value: { verdict: "approved", report: "late", findings: [] } },
		});
		const result = await pending;
		assert.equal(result.approved, false, "a late approval cannot authorise completion");
		assert.ok(
			result.cancelled === true || result.disapproved === true,
			"the attempt is reported as cancelled/disapproved",
		);
		assert.equal(cancels.length, 1, "the terminal does not emit another cancel");
	});
});
