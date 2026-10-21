import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
} from "@xzzpig/pi-subagents/delegation";
import { SUPERVISOR_RESPONDER_REGISTER_EVENT } from "@xzzpig/pi-subagents/supervisor-routing";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor-delegation.ts";
import { registerGoalEvents } from "../extensions/goal-events.ts";
import { createGoalCore } from "../extensions/goal-state.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Outcome = { kind: string; code?: string };

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const SEAMS = ["focus_away_back", "same_id_removal", "session_start", "session_tree", "session_shutdown", "reload"] as const;
const GOAL_SCOPED = new Set(["focus_away_back", "same_id_removal"]);

/**
 * Success criterion 6: for EVERY lifecycle seam, the in-flight ask lives INSIDE the original
 * attempt's registered responder (so the production cancel callback and the dropped answer belong to
 * the same attempt), and cleanup is observed rather than assumed.
 */
function makeSessionFactory() {
	const counters = { subscribe: 0, unsubscribe: 0, abort: 0, dispose: 0, prompt: 0 };
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ref: { execute?: (id: string, args: unknown) => Promise<unknown> } = {};
	let enterPrompt: (() => void) | undefined;
	const promptEntered = new Promise<void>((resolve) => {
		enterPrompt = resolve;
	});
	const factory = async (input: never) => {
		const tools = (input as { customTools?: Array<{ execute?: (id: string, args: unknown) => Promise<unknown> }> }).customTools ?? [];
		ref.execute = tools[0]?.execute;
		return {
			prompt: async () => {
				counters.prompt += 1;
				enterPrompt?.();
				await gate;
			},
			waitForIdle: async () => {},
			abort: async () => {
				counters.abort += 1;
			},
			dispose: () => {
				counters.dispose += 1;
			},
			subscribeMessageEnd: () => {
				counters.subscribe += 1;
				return () => {
					counters.unsubscribe += 1;
				};
			},
		};
	};
	return { factory: factory as never, ref, counters, promptEntered, release: () => release?.() };
}

async function startAudit(options: { goalId: string; sessionId: string; dir: string }) {
	const handlers = new Map<string, Handler[]>();
	const bus = {
		registration: undefined as Record<string, unknown> | undefined,
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
		},
		emit(event: string, value: unknown) {
			if (event === SUPERVISOR_RESPONDER_REGISTER_EVENT) {
				const request = value as Record<string, unknown>;
				bus.registration = request;
				request.result = { ok: true, registration: { dispose() {} } };
				return;
			}
			for (const handler of [...(handlers.get(event) ?? [])]) handler(value, undefined);
		},
	};
	const session = makeSessionFactory();
	const goal = { id: options.goalId, revision: 0, objective: "o", status: "active", tasks: [], createdAt: new Date().toISOString() };
	const ctx = {
		cwd: options.dir,
		sessionManager: {
			getSessionId: () => options.sessionId,
			getEntries: () => [],
			getLeafId: () => null,
			getBranch: () => [],
			getCwd: () => options.dir,
			getSessionDir: () => options.dir,
			getSessionFile: () => undefined,
		},
		model: { provider: "mock", id: "mock" },
		modelRegistry: { getAvailable: () => [], runtime: { borrowed: true } },
		getSystemPrompt: () => "SYSTEM",
		ui: { setStatus() {}, notify() {} },
		hasUI: false,
	};
	const cancels: Array<Record<string, unknown>> = [];
	let identity: Record<string, unknown> | undefined;
	bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (value) => cancels.push(value as Record<string, unknown>));
	bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
		identity = value as Record<string, unknown>;
		bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
	});
	const pending = runGoalCompletionAuditor({
		ctx: ctx as never,
		events: bus as never,
		goal: goal as never,
		detailedSummary: `Goal: ${options.goalId}`,
		skipPreflight: true,
		auditSidechannelSessionFactory: session.factory,
		timeouts: { startedMs: 5_000, terminalMs: 30_000, cancellationMs: 5_000 },
	} as never);
	const ask = {
		requestId: `ask-${options.goalId}`,
		runId: `run-${options.goalId}`,
		agent: "goal-auditor",
		childIndex: 0,
		reason: "need_decision" as const,
		message: "q",
		deadlineAt: Date.now() + 60_000,
	};
	return { bus, session, pending, ask, cancels, identity: () => identity };
}

async function waitForRegistration(audit: Awaited<ReturnType<typeof startAudit>>) {
	for (let i = 0; i < 100; i += 1) {
		if (audit.bus.registration) return audit.bus.registration;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the responder was never registered");
}

describe("audit lifecycle full chain (same attempt)", () => {
	for (const seam of SEAMS) {
		it(`${seam}: in-flight ask inside the ORIGINAL attempt`, async () => {
			const dir = mkdtempSync(path.join(os.tmpdir(), "goal-audit-chain-"));
			try {
				const handlers = new Map<string, Handler[]>();
				const on = (event: string, handler: Handler) => {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
				};
				const core = createGoalCore({ events: { on, emit() {} }, on, registerTool() {}, registerCommand() {}, sendMessage() {} } as never);
				registerGoalEvents(core);
				core.setAuditSessionId("session-1");
				const a = { id: "g1", revision: 0, objective: "o", status: "active" as const, tasks: [], createdAt: new Date().toISOString() };
				const b = { id: "g2", revision: 0, objective: "p", status: "active" as const, tasks: [], createdAt: new Date().toISOString() };
				const c = { id: "g3", revision: 0, objective: "q", status: "active" as const, tasks: [], createdAt: new Date().toISOString() };
				const ctx = {
					cwd: dir,
					sessionManager: {
						getSessionId: () => "session-1",
						getEntries: () => [],
						getLeafId: () => null,
						getBranch: () => [],
						getCwd: () => dir,
						getSessionDir: () => dir,
						getSessionFile: () => undefined,
					},
					ui: { setStatus() {}, notify() {} },
				};
				core.setGoal(a as never, ctx as never, false);

				const victim = await startAudit({ goalId: "g1", sessionId: "session-1", dir });
				const sibling = await startAudit({ goalId: "g2", sessionId: "session-1", dir });
				const foreign = await startAudit({ goalId: "g1", sessionId: "session-2", dir });
				const victimReg = await waitForRegistration(victim);
				const siblingReg = await waitForRegistration(sibling);
				const foreignReg = await waitForRegistration(foreign);
				const respond = (reg: Record<string, unknown>, ask: unknown) =>
					(reg.respond as (value: unknown) => Promise<Outcome>)(ask);

				const victimPending = respond(victimReg, victim.ask);
				const siblingPending = respond(siblingReg, sibling.ask);
				const foreignPending = respond(foreignReg, foreign.ask);
				await victim.session.promptEntered;
				assert.ok(victim.session.ref.execute, "the ask is running inside the ORIGINAL attempt");

				// real seam — started WITHOUT awaiting, so the slow handler tail cannot let the
				// cancellation timer settle the attempt before the approval is injected.
				const runHandler = (name: string, event: Record<string, unknown> = {}) =>
					(async () => {
						for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
					})();
				let seamDone: Promise<void> = Promise.resolve();
				if (seam === "focus_away_back") {
					core.setGoal(c as never, ctx as never, false);
					core.setGoal(a as never, ctx as never, false);
				} else if (seam === "same_id_removal") {
					core.setGoal({ ...a, revision: 1, status: "archived" } as never, ctx as never, false);
				} else if (seam === "reload") {
					seamDone = (async () => {
						await runHandler("session_tree", { reason: "reload" });
						await runHandler("session_start", { reason: "reload" });
					})();
				} else {
					seamDone = runHandler(seam);
				}
				// Deterministic barrier: the approval is emitted only AFTER the revocation happened
				// (a cancel was emitted) and while the attempt is provably UNSETTLED.
				await waitFor(() => victim.cancels.length === 1, "the revocation cancel");
				let settled = false;
				void victim.pending.then(() => {
					settled = true;
				});
				assert.equal(settled, false, "the attempt is still unsettled when the approval is injected");
				// A LATE legal answer is submitted while this attempt is STILL running (prompt held).
				await victim.session.ref.execute!("late", { kind: "reply", message: "LATE" });
				// A LATE schema-valid approval arrives INSIDE the cancellation window.
				victim.bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					...(victim.identity() as object),
					status: "completed",
					result: { kind: "structured", value: { verdict: "approved", report: "late", findings: [] } },
				});
				await seamDone;

				// precise cancel with the ORIGINAL identity, exactly once
				assert.equal(victim.cancels.length, 1, "exactly one cancel for this attempt");
				assert.equal(victim.cancels[0]!.requestId, victim.identity()!.requestId);
				assert.equal(victim.cancels[0]!.ownerRunId, victim.identity()!.ownerRunId);
				assert.equal(victim.cancels[0]!.nodeId, victim.identity()!.nodeId);

				victim.session.release();
				const victimOutcome = await victimPending;
				assert.equal(victimOutcome.kind, "error", "the late answer is not delivered");
				assert.equal(victim.session.counters.subscribe, 1);
				await waitFor(() => victim.session.counters.unsubscribe === 1, "the listener to be released once");
				assert.equal(victim.session.counters.unsubscribe, 1, "the listener is released exactly once");

				// scope: goal-level seams spare the sibling; session-level ones do not; the other session always answers
				await sibling.session.ref.execute!("sib", { kind: "reply", message: "SIB" });
				sibling.session.release();
				const siblingOutcome = await siblingPending;
				if (GOAL_SCOPED.has(seam)) assert.equal(siblingOutcome.kind, "reply", "sibling goal unaffected");
				else assert.equal(siblingOutcome.kind, "error", "session-wide revocation covers the sibling goal");
				await foreign.session.ref.execute!("fgn", { kind: "reply", message: "FGN" });
				foreign.session.release();
				const foreignOutcome = await foreignPending;
				assert.equal(foreignOutcome.kind, "reply", "the other session is never affected");

				const result = await victim.pending;
				assert.equal(result.approved, false);
				assert.equal(victim.cancels.length, 1, "the terminal emits no second cancel");
				await waitFor(() => victim.session.counters.abort === 1, "the single abort");
				await waitFor(() => victim.session.counters.dispose === 1, "the single dispose");
				assert.equal(victim.session.counters.abort, 1, "the session is aborted exactly once");
				assert.equal(victim.session.counters.dispose, 1, "and disposed exactly once");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
