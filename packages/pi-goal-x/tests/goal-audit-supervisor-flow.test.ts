import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor-delegation.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
} from "@xzzpig/pi-subagents/delegation";
import { SUPERVISOR_RESPONDER_REGISTER_EVENT } from "@xzzpig/pi-subagents/supervisor-routing";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Ship the audited change.",
		status: "active",
		autoContinue: true,
		sisyphus: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		activePath: ".pi/goals/active_goal_g1.md",
		revision: 0,
		...overrides,
	} as GoalRecord;
}

interface Bus {
	on(event: string, handler: (value: unknown) => void): () => void;
	emit(event: string, value: unknown): void;
}

function createBus(): Bus & { order: string[]; registration: Record<string, unknown> | undefined } {
	const handlers = new Map<string, Array<(value: unknown) => void>>();
	const order: string[] = [];
	const bus = {
		order,
		registration: undefined as Record<string, unknown> | undefined,
		on(event: string, handler: (value: unknown) => void) {
			const entries = handlers.get(event) ?? [];
			entries.push(handler);
			handlers.set(event, entries);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, value: unknown) {
			if (event === SUPERVISOR_RESPONDER_REGISTER_EVENT) {
				const request = value as Record<string, unknown>;
				if (request && request.result === undefined) {
					order.push("register");
					bus.registration = request;
					let disposed = false;
					request.result = {
						ok: true,
						registration: {
							dispose: () => {
								if (disposed) return;
								disposed = true;
							},
						},
					};
				}
			}
			if (event === SUBAGENT_DELEGATION_REQUEST_EVENT) order.push("request");
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

function baseArgs(events: Bus) {
	return {
		ctx: ctx(),
		events: events as never,
		goal: goal(),
		detailedSummary: "Goal: ship\nStatus: active",
		skipPreflight: true,
		timeouts: { startedMs: 5_000, terminalMs: 30_000, cancellationMs: 50 },
	};
}

describe("audit supervisor coordination lifecycle", () => {
	it("registers the responder before emitting the delegation request", async () => {
		const bus = createBus();
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
			const identity = value as { requestId: string; ownerRunId: string; nodeId: string };
			bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
				...identity,
				status: "completed",
				result: { kind: "structured", value: { verdict: "approved", report: "ok", findings: [] } },
			});
		});
		const result = await runGoalCompletionAuditor(baseArgs(bus));
		assert.deepEqual(bus.order.slice(0, 2), ["register", "request"]);
		assert.equal(result.approved, true);
		assert.equal(result.supervisorHandoff, undefined, "no question => no handoff field");
		assert.ok(bus.registration, "the responder registration must have been requested");
		const scope = bus.registration!.scope as Record<string, unknown>;
		assert.equal(scope.sessionId, "test-session");
		assert.equal(scope.ownerRunId, "g1");
		assert.equal(scope.requestId, result.requestId);
	});

	it("locks a coordination error, cancels the exact attempt, and never turns a late approval into success", async () => {
		const bus = createBus();
		const cancellations: unknown[] = [];
		bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (value) => {
			cancellations.push(value);
			// Acknowledge the cancellation with a completed, approved verdict: it is
			// only an acknowledgement and must not approve the goal.
			bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
				...(value as object),
				status: "completed",
				result: { kind: "structured", value: { verdict: "approved", report: "late approval", findings: [] } },
			});
		});
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
			// Simulate the dispatcher reporting an unanswerable claimed ask.
			const onFailure = bus.registration?.onFailure as ((error: Error) => void) | undefined;
			assert.equal(typeof onFailure, "function");
			onFailure!(new Error("unresolved: needs a new user authorisation"));
		});
		const result = await runGoalCompletionAuditor(baseArgs(bus));
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.notEqual(result.cancelled, true, "a coordination failure is not a user cancellation");
		assert.match(String(result.error), /needs a new user authorisation/);
		assert.equal(cancellations.length, 1, "exactly one cancellation is emitted");
		const identity = cancellations[0] as Record<string, unknown>;
		assert.equal(identity.requestId, result.requestId);
		assert.equal(identity.ownerRunId, "g1");
		assert.equal(identity.nodeId, "goal-completion:g1:0");
	});

	it("parks on Escape without freezing the handoff, then resumes the same attempt", async () => {
		const bus = createBus();
		const controller = new AbortController();
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
		});
		const pending = runGoalCompletionAuditor({
			...baseArgs(bus),
			parkOnAbort: true,
			signal: controller.signal,
		});
		// Let the request be emitted, then Escape.
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		const parked = await pending;
		assert.equal(parked.interrupted, true);
		assert.equal(parked.cancelled, true);
		assert.equal(parked.supervisorHandoff, undefined, "park must not freeze or return the handoff");
		assert.ok(parked.session, "park hands back the same-attempt session handle");
		// Continue: the SAME attempt settles with the child's real terminal.
		const resumed = parked.session!.resume();
		bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
			requestId: parked.requestId,
			ownerRunId: "g1",
			nodeId: "goal-completion:g1:0",
			status: "completed",
			result: { kind: "structured", value: { verdict: "approved", report: "ok after park", findings: [] } },
		});
		const terminal = await resumed;
		assert.equal(terminal.approved, true);
		assert.equal(terminal.interrupted, undefined);
	});

	it("cancels the parked attempt only when the user chooses the bypass", async () => {
		const bus = createBus();
		const controller = new AbortController();
		const cancellations: unknown[] = [];
		bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (value) => {
			cancellations.push(value);
			bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { ...(value as object), status: "cancelled" });
		});
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
		});
		const pending = runGoalCompletionAuditor({ ...baseArgs(bus), parkOnAbort: true, signal: controller.signal });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		const parked = await pending;
		assert.equal(parked.interrupted, true);
		const cancelled = parked.session!.cancel();
		const terminal = await cancelled;
		assert.equal(terminal.cancelled, true);
		assert.equal(cancellations.length, 1, "only the user bypass cancels the child");
	});

	it("keeps the coordination error when the attempt times out first", async () => {
		const bus = createBus();
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
			const onFailure = bus.registration?.onFailure as ((error: Error) => void) | undefined;
			onFailure!(new Error("unresolved: needs a new user authorisation"));
		});
		const result = await runGoalCompletionAuditor({
			...baseArgs(bus),
			timeouts: { startedMs: 5_000, terminalMs: 30_000, cancellationMs: 20 },
		});
		assert.equal(result.approved, false);
		assert.match(String(result.error), /needs a new user authorisation/);
	});
	it("never echoes an external exception body when responder registration fails", async () => {
		const handlers = new Map<string, Array<(value: unknown) => void>>();
		const bus = {
			on(event: string, handler: (value: unknown) => void) {
				const entries = handlers.get(event) ?? [];
				entries.push(handler);
				handlers.set(event, entries);
				return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
			},
			emit(event: string, value: unknown) {
				if (event === SUPERVISOR_RESPONDER_REGISTER_EVENT) {
					throw new Error("AUDIT_SYNTHETIC_REGISTRATION_EXCEPTION_7928");
				}
				for (const handler of handlers.get(event) ?? []) handler(value);
			},
		};
		const requests: unknown[] = [];
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => requests.push(value));
		const result = await runGoalCompletionAuditor(baseArgs(bus as never));
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.match(String(result.error), /error details omitted/);
		assert.equal(String(result.error).includes("AUDIT_SYNTHETIC_REGISTRATION_EXCEPTION_7928"), false);
		assert.equal(requests.length, 0, "no child is launched without a responder");
	});

	it("does not cancel after an approved terminal already locked the attempt", async () => {
		const bus = createBus();
		const cancellations: unknown[] = [];
		bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (value) => cancellations.push(value));
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
			// The real terminal arrives first and locks the attempt…
			bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
				...(value as object),
				status: "completed",
				result: { kind: "structured", value: { verdict: "approved", report: "ok", findings: [] } },
			});
			// …so a later coordination failure must not emit another cancel.
			const onFailure = bus.registration?.onFailure as ((error: Error) => void) | undefined;
			onFailure?.(new Error("delivery_failed: synthetic"));
		});
		const result = await runGoalCompletionAuditor(baseArgs(bus));
		assert.equal(result.approved, true);
		assert.equal(cancellations.length, 0, "a locked terminal is never cancelled by coordination noise");
	});



	it("settles with a fixed diagnostic when the session scope cannot be captured", async () => {
		const bus = createBus();
		const requests: unknown[] = [];
		bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => requests.push(value));
		const args = baseArgs(bus);
		(args as { ctx: unknown }).ctx = {
			...(args.ctx as object),
			sessionManager: {
				getSessionId: () => {
					throw new Error("AUDIT_SYNTHETIC_SESSION_SCOPE_EXCEPTION_9430");
				},
				getEntries: () => [],
				getLeafId: () => null,
			},
		};
		const started = Date.now();
		const result = await runGoalCompletionAuditor(args);
		assert.ok(Date.now() - started < 250, "the attempt converges instead of hanging");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.equal(String(result.error), "Goal auditor delegation failed: error details omitted");
		assert.equal(String(result.error).includes("AUDIT_SYNTHETIC_SESSION_SCOPE_EXCEPTION_9430"), false);
		assert.equal(requests.length, 0, "no child is launched");
	});

	it("never echoes an external body from a failing cancel or request emit", async () => {
		const handlers = new Map<string, Array<(value: unknown) => void>>();
		const bus = {
			registration: undefined as Record<string, unknown> | undefined,
			on(event: string, handler: (value: unknown) => void) {
				const entries = handlers.get(event) ?? [];
				entries.push(handler);
				handlers.set(event, entries);
				return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
			},
			emit(event: string, value: unknown) {
				if (event === SUPERVISOR_RESPONDER_REGISTER_EVENT) {
					const request = value as Record<string, unknown>;
					bus.registration = request;
					request.result = { ok: true, registration: { dispose: () => {} } };
					return;
				}
				if (event === SUBAGENT_DELEGATION_REQUEST_EVENT) {
					throw new Error("SYNTHETIC_EXTERNAL_REQUEST_BODY_2026");
				}
				for (const handler of [...(handlers.get(event) ?? [])]) handler(value);
			},
		};
		const result = await runGoalCompletionAuditor(baseArgs(bus as never));
		assert.equal(String(result.error).includes("SYNTHETIC_EXTERNAL_REQUEST_BODY_2026"), false);
		assert.equal(String(result.error), "Could not start goal auditor delegation: error details omitted");
	});

});
