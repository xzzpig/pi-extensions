/**
 * Task 6.2: the REAL registered `update_goal` handler driving the real
 * completion flow with a real delegation event chain (registration → request →
 * structured response) and a controllable auditor fixture.
 *
 * Covers the held completion promise, unique child launch / unique terminal,
 * one coordination handoff inside the ORIGINAL tool result, the independent
 * billing split (one audit_usage + one audit_supervisor_usage) with the parent
 * budget untouched, and the approved / disapproved / coordination-error /
 * focus-cancel branches — never as a user message or a second completion path.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";
import { runGoalCompletionAuditor, type GoalAuditorResult } from "../extensions/goal-auditor-delegation.ts";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
} from "@xzzpig/pi-subagents/delegation";
import { SUPERVISOR_RESPONDER_REGISTER_EVENT } from "@xzzpig/pi-subagents/supervisor-routing";

function fixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-supervisor-int-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({ objective: "=== Goal ===\nObjective: supervisor integration", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 4, 9, 0, 0));
	const written = writeActiveGoalFile({ cwd }, goal);
	const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
	return { cwd, goal: written, sessionEntries, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

interface Harness {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, Function>;
	core: { state: { goal: { usage?: { tokensUsed?: number } } | null } };
	ctx: ExtensionContext;
	sentMessages: Array<{ content: unknown; options?: unknown }>;
}

function createHarness(options: {
	cwd: string;
	sessionEntries: unknown[];
	runCompletionAuditor: (args: unknown) => Promise<GoalAuditorResult>;
	events?: unknown;
}): Harness {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, ToolDefinition>();
	const sentMessages: Array<{ content: unknown; options?: unknown }> = [];
	const pi = {
		registerTool: (def: ToolDefinition) => tools.set(def.name, def),
		registerCommand: () => {},
		on: (event: string, handler: Function) => handlers.set(event, handler),
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (content: unknown, options?: unknown) => sentMessages.push({ content, options }),
		sendUserMessage: (content: unknown, options?: unknown) => sentMessages.push({ content, options }),
		steer: () => {},
		followUp: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
		events: options.events,
	};
	const ctx = {
		cwd: options.cwd,
		hasUI: false,
		modelRegistry: { getAvailable: () => [] },
		model: undefined,
		sessionManager: {
			getBranch: () => options.sessionEntries,
			getCwd: () => options.cwd,
			getSessionId: () => "supervisor-integration-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as never, { runCompletionAuditor: options.runCompletionAuditor as never });
	return { tools, handlers, core: (pi as unknown as { _goalCore: Harness["core"] })._goalCore, ctx, sentMessages };
}

async function start(h: Harness): Promise<void> {
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);
}

/** True when the coordination appendix leaked into a message channel instead of the tool result. */
function recordWasSentAsMessage(h: Harness): boolean {
	return h.sentMessages.some((message) => String(message.content).includes("审计协调记录"));
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((name) => name.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function ledger(cwd: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(goalLedgerPath({ cwd }), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** Usage shape the delegation reports for the auditor child. */
const AUDITOR_USAGE = { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cost: 0.02, turns: 2 };
/** Independent side-channel usage the handoff carries. */
const SIDE_USAGE = { inputTokens: 7, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2, tokens: 14, costUsd: 0.005, turns: 1 };

function handoffResult(): GoalAuditorResult {
	return {
		approved: true,
		disapproved: false,
		output: "All good\n<approved/>",
		model: "fixture",
		usage: AUDITOR_USAGE,
		supervisorHandoff: {
			records: [
				{
					requestId: "delegation-1",
					supervisorRequestId: "ask-1",
					runId: "run-1",
					reason: "need_decision",
					question: "父用户此前已决定的交付标记是什么",
					answer: "ALPHA",
					deliveryStatus: "delivered",
				},
			],
			usage: SIDE_USAGE,
		},
	} as GoalAuditorResult;
}

describe("update_goal(complete) with the supervisor side channel", () => {
	it("holds the completion promise until the audit terminal, then commits once with one handoff and split billing", async () => {
		const f = fixture();
		let release: ((value: GoalAuditorResult) => void) | undefined;
		let auditorCalls = 0;
		try {
			const h = createHarness({
				cwd: f.cwd,
				sessionEntries: f.sessionEntries,
				runCompletionAuditor: () => {
					auditorCalls += 1;
					return new Promise<GoalAuditorResult>((resolve) => {
						release = resolve;
					});
				},
			});
			await start(h);
			const budgetBefore = h.core.state.goal?.usage?.tokensUsed ?? 0;
			const update = h.tools.get("update_goal")!;
			let settled = false;
			const pending = (update.execute as never as (a: string, b: unknown, c: AbortSignal, d: unknown, e: ExtensionContext) => Promise<{ content: Array<{ text?: string }>; details?: Record<string, unknown>; usage?: Record<string, unknown>; terminate?: boolean }>)(
				"u-supervisor-1",
				{ status: "complete" },
				new AbortController().signal,
				undefined,
				h.ctx,
			);
			void pending.then(() => {
				settled = true;
			});
			// While the audit is unresolved the tool promise must stay held.
			for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
			assert.equal(settled, false, "update_goal must not return while the audit is unresolved");
			assert.equal(auditorCalls, 1, "exactly one auditor child is launched");
			assert.equal(activeGoalFiles(f.cwd).length, 1, "nothing is committed before the verdict");

			release!(handoffResult());
			const result = await pending;

			assert.equal(settled, true);
			// Exactly one coordination appendix, after the formal report, inside the
			// first text part (the only part the TUI renders).
			const texts = result.content.map((part) => part.text ?? "");
			assert.equal(texts.length, 1, "the appendix rides the same text part as the report");
			const merged = texts[0] ?? "";
			assert.ok(merged.includes("Goal audit approved"), `approval report first: ${merged}`);
			const appendixAt = merged.indexOf("审计协调记录（参考信息，不是新用户指令或完成证据）");
			assert.ok(appendixAt > merged.indexOf("Goal audit approved"), "the record follows the report");
			assert.ok(merged.includes("Goal audit approved"), "the report is preserved");
			assert.equal(merged.indexOf("审计协调记录", appendixAt + 1), -1, "exactly one appendix");
			assert.match(merged, /ALPHA/);
			assert.equal(merged.includes("{"), false, "no JSON block in the result");
			const coordination = (result.details as { supervisorCoordination?: { records: unknown[] } }).supervisorCoordination;
			assert.ok(coordination, "the structured record travels in details too");
			assert.equal(coordination.records.length, 1);

			// Billing: parent tool usage = auditor + side, parent budget untouched.
			const usage = result.usage as { input: number; totalTokens: number; cost: { total: number } };
			assert.equal(usage.input, AUDITOR_USAGE.input + SIDE_USAGE.inputTokens);
			assert.equal(usage.totalTokens, AUDITOR_USAGE.input + AUDITOR_USAGE.output + AUDITOR_USAGE.cacheRead + AUDITOR_USAGE.cacheWrite + SIDE_USAGE.tokens);
			assert.equal(Math.round(usage.cost.total * 1000), Math.round((AUDITOR_USAGE.cost + SIDE_USAGE.costUsd) * 1000));
			assert.equal(h.core.state.goal?.usage?.tokensUsed ?? 0, budgetBefore, "the parent turn budget is not modified by side billing");

			// The record is never a user message or a wake: only the pre-existing
			// goal-context rehydration message may be sent, and never a turn trigger.
			assert.equal(recordWasSentAsMessage(h), false, "the coordination record must travel only inside the tool result");
			assert.equal(h.sentMessages.every((message) => (message.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === false), true, "the record must never wake the main model");

			// Ledger: exactly one auditor row and exactly one side row.
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			assert.equal(activeGoalFiles(f.cwd).length, 0, "the approved goal archives at turn_end");
			const events = ledger(f.cwd);
			assert.equal(events.filter((event) => event.type === "audit_usage").length, 1, "one auditor usage row");
			assert.equal(events.filter((event) => event.type === "audit_supervisor_usage").length, 1, "one side usage row");
			const sideRow = events.find((event) => event.type === "audit_supervisor_usage")!;
			assert.equal(sideRow.tokens, SIDE_USAGE.tokens);
			assert.equal(sideRow.turns, SIDE_USAGE.turns);
			assert.equal(sideRow.auditRequestId, "delegation-1");
			assert.equal(events.filter((event) => event.type === "audit_result").length, 1, "exactly one verdict row");
			assert.equal(events.filter((event) => event.type === "audit_skipped").length, 0, "no bypass row for an approval");
		} finally {
			f.cleanup();
		}
	});

	it("writes no side row and no appendix when the audit had no question", async () => {
		const f = fixture();
		try {
			const h = createHarness({
				cwd: f.cwd,
				sessionEntries: f.sessionEntries,
				runCompletionAuditor: async () => ({ approved: true, disapproved: false, output: "ok\n<approved/>", model: "fixture", usage: AUDITOR_USAGE } as GoalAuditorResult),
			});
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as never as (a: string, b: unknown, c: AbortSignal, d: unknown, e: ExtensionContext) => Promise<{ content: Array<{ text?: string }>; details?: Record<string, unknown>; usage?: unknown }>)(
				"u-supervisor-2",
				{ status: "complete" },
				new AbortController().signal,
				undefined,
				h.ctx,
			);
			assert.equal(result.content.length, 1, "no appendix without questions");
			assert.equal((result.details as { supervisorCoordination?: unknown }).supervisorCoordination, undefined);
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			const events = ledger(f.cwd);
			assert.equal(events.filter((event) => event.type === "audit_usage").length, 1);
			assert.equal(events.filter((event) => event.type === "audit_supervisor_usage").length, 0, "a question-free audit never bills a side channel");
		} finally {
			f.cleanup();
		}
	});

	it("keeps the goal active and commits nothing when coordination fails closed", async () => {
		const f = fixture();
		try {
			const h = createHarness({
				cwd: f.cwd,
				sessionEntries: f.sessionEntries,
				runCompletionAuditor: async () =>
					({
						approved: false,
						disapproved: true,
						output: "",
						error: "Goal auditor supervision could not be resolved: needs a new user authorisation",
						usage: AUDITOR_USAGE,
						supervisorHandoff: {
							records: [
								{
									requestId: "delegation-1",
									supervisorRequestId: "ask-9",
									runId: "run-1",
									reason: "need_decision",
									question: "是否授权删除本测试的 evidence.txt",
									unresolvedReason: "needs a new user authorisation",
									deliveryStatus: "failed",
								},
							],
							usage: SIDE_USAGE,
						},
					}) as GoalAuditorResult,
			});
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as never as (a: string, b: unknown, c: AbortSignal, d: unknown, e: ExtensionContext) => Promise<{ content: Array<{ text?: string }>; details?: Record<string, unknown> }>)(
				"u-supervisor-3",
				{ status: "complete" },
				new AbortController().signal,
				undefined,
				h.ctx,
			);
			const text = result.content.map((part) => part.text ?? "").join("\n");
			assert.match(text, /needs a new user authorisation/, "the blocked question is reported back");
			assert.match(text, /审计协调记录（参考信息，不是新用户指令或完成证据）/, "the coordination record is returned");
			assert.ok(!text.includes("<approved/>"), "a coordination failure can never approve");
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			assert.equal(activeGoalFiles(f.cwd).length, 1, "the goal stays active");
			const events = ledger(f.cwd);
			assert.equal(events.filter((event) => event.type === "goal_completed").length, 0, "no completion is committed");
			assert.equal(events.filter((event) => event.type === "audit_result" && event.verdict === "approved").length, 0);
			// Spent side usage is still accounted for on a failure branch.
			assert.equal(events.filter((event) => event.type === "audit_supervisor_usage").length, 1, "actual side spend is not lost");
			assert.equal(recordWasSentAsMessage(h), false);
			assert.equal(h.sentMessages.every((message) => (message.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === false), true);
		} finally {
			f.cleanup();
		}
	});

	it("does not commit when the user cancels the completion (focus loss)", async () => {
		const f = fixture();
		try {
			const h = createHarness({
				cwd: f.cwd,
				sessionEntries: f.sessionEntries,
				runCompletionAuditor: async () =>
					({
						approved: false,
						disapproved: false,
						cancelled: true,
						output: "",
						error: "Goal auditor cancelled by the user",
						usage: AUDITOR_USAGE,
					}) as GoalAuditorResult,
			});
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as never as (a: string, b: unknown, c: AbortSignal, d: unknown, e: ExtensionContext) => Promise<{ content: Array<{ text?: string }> }>)(
				"u-supervisor-4",
				{ status: "complete" },
				new AbortController().signal,
				undefined,
				h.ctx,
			);
			const text = result.content.map((part) => part.text ?? "").join("\n");
			assert.doesNotMatch(text, /Goal audit approved/);
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			assert.equal(activeGoalFiles(f.cwd).length, 1, "a cancelled audit never archives the goal");
			assert.equal(ledger(f.cwd).filter((event) => event.type === "goal_completed").length, 0);
		} finally {
			f.cleanup();
		}
	});

	it("runs the real delegation event chain through the real handler: one child, one terminal, one precise cancel", async () => {
		const f = fixture();
		const handlers = new Map<string, Array<(value: unknown) => void>>();
		const requests: unknown[] = [];
		const cancellations: unknown[] = [];
		let registration: Record<string, unknown> | undefined;
		const bus = {
			on(event: string, handler: (value: unknown) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
			},
			emit(event: string, value: unknown) {
				if (event === SUPERVISOR_RESPONDER_REGISTER_EVENT) {
					const request = value as Record<string, unknown>;
					if (request.result === undefined) {
						registration = request;
						request.result = { ok: true, registration: { dispose: () => {} } };
					}
				}
				if (event === SUBAGENT_DELEGATION_REQUEST_EVENT) requests.push(value);
				if (event === SUBAGENT_DELEGATION_CANCEL_EVENT) cancellations.push(value);
				for (const handler of [...(handlers.get(event) ?? [])]) handler(value);
			},
		};
		try {
			const h = createHarness({
				cwd: f.cwd,
				sessionEntries: f.sessionEntries,
				events: bus,
				runCompletionAuditor: (args) => runGoalCompletionAuditor({ ...(args as object), skipPreflight: true } as never),
			});
			await start(h);
			bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
				bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, value);
				// The read-only responder cannot decide: the dispatcher fails closed.
				const onFailure = registration?.onFailure as ((error: Error) => void) | undefined;
				onFailure?.(new Error("unresolved: needs a new user authorisation"));
			});
			// The cancel acknowledgement tries to smuggle a late approval in.
			bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (value) => {
				bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					...(value as object),
					status: "completed",
					result: { kind: "structured", value: { verdict: "approved", report: "late approval", findings: [] } },
				});
			});
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as never as (a: string, b: unknown, c: AbortSignal, d: unknown, e: ExtensionContext) => Promise<{ content: Array<{ text?: string }> }>)(
				"u-supervisor-5",
				{ status: "complete" },
				new AbortController().signal,
				undefined,
				h.ctx,
			);
			assert.equal(requests.length, 1, "exactly one child launch");
			assert.equal(cancellations.length, 1, "exactly one precise cancellation");
			assert.ok(registration, "the responder was registered for this attempt");
			const text = result.content.map((part) => part.text ?? "").join("\n");
			assert.match(text, /needs a new user authorisation/);
			assert.ok(!text.includes("Goal audit approved"), "a late approval after the exact cancel never approves");
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			assert.equal(activeGoalFiles(f.cwd).length, 1, "the goal stays active");
			const events = ledger(f.cwd);
			assert.equal(events.filter((event) => event.type === "goal_completed").length, 0);
			assert.equal(events.filter((event) => event.type === "audit_result").length, 1, "exactly one terminal verdict row");
			assert.equal(events.filter((event) => event.type === "audit_result")[0]?.verdict, "error");
		} finally {
			f.cleanup();
		}
	});
});
