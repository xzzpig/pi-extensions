import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "@xzzpig/pi-subagents/delegation";
import goalExtension from "../extensions/goal.ts";
import { REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX } from "../extensions/goal-auditor-progress.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";

class FakeEvents {
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();

	on(event: string, handler: (value: unknown) => void): () => void {
		const entries = this.handlers.get(event) ?? [];
		entries.push(handler);
		this.handlers.set(event, entries);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((entry) => entry !== handler));
	}

	emit(event: string, value: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
	}
}

function createHarness(cwd: string) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, ToolDefinition>();
	const events = new FakeEvents();
	const messages: unknown[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	const goal = createGoal({ objective: "Ship a complete delegated audit integration.", autoContinue: true, sisyphus: false });
	writeActiveGoalFile({ cwd }, goal);
	mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "agents", "goal-auditor.md"), `---
name: goal-auditor
description: Test completion auditor
tools: read, grep, find, ls, bash, report_auditor_progress
extensions:
inheritProjectContext: false
inheritSkills: false
systemPromptMode: replace
---

Test auditor.
`, "utf8");
	const entries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
	const pi = {
		registerTool: (definition: ToolDefinition) => { tools.set(definition.name, definition); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: unknown) => { messages.push(message); },
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		events,
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		sessionManager: {
			getBranch: () => entries,
			getCwd: () => cwd,
			getSessionId: () => "delegated-completion-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any);
	return { handlers, tools, events, ctx, goal, messages, core: (pi as any)._goalCore };
}

async function start(harness: ReturnType<typeof createHarness>): Promise<void> {
	await harness.handlers.get("session_start")?.({ reason: "start" }, harness.ctx);
	await harness.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, harness.ctx);
}

function ledgerEvents(cwd: string): Array<{ type?: string; verdict?: string; report?: string }> {
	try {
		return readFileSync(goalLedgerPath({ cwd }), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function activeGoalFiles(cwd: string): string[] {
	const dir = path.join(cwd, ".pi", "goals");
	return readdirSync(dir).filter((name) => name.startsWith("active_goal_"));
}

test("D-01/D-07/I-05/I-07: approved structured delegation commits through the existing completion transaction", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-delegated-completion-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const harness = createHarness(cwd);
		let request: Record<string, unknown> | undefined;
		harness.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			request = value as Record<string, unknown>;
			const identity = value as { requestId: string; ownerRunId: string; nodeId: string };
			harness.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity);
			harness.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
				...identity,
				currentTool: "report_auditor_progress",
				currentToolArgs: "label=Making final decision...",
				recentOutputLines: [
					`${REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX}${JSON.stringify({ label: "Making final decision...", percentage: 80 })}`,
				],
			});
			harness.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
				...identity,
				status: "completed",
				runId: "goal-audit-child",
				model: "fixture/auditor",
				result: {
					kind: "structured",
					value: {
						verdict: "approved",
						report: "Verified every completion requirement.",
						findings: [],
					},
				},
			});
		});
		await start(harness);
		const updateGoal = harness.tools.get("update_goal")!;
		const result = await (updateGoal.execute as any)("complete-1", { status: "complete", completion_summary: "Please trust this summary." }, new AbortController().signal, undefined, harness.ctx);

		assert.equal(request?.context, "fresh");
		assert.equal(request?.agent, "goal-auditor");
		assert.equal((request?.result as { kind?: string }).kind, "structured");
		assert.match(String(request?.task), /UNTRUSTED/);
		assert.equal(harness.core.state.goal?.status, "complete");
		assert.equal(result.terminate, true);
		assert.match(result.content[0]?.text ?? "", /Verified every completion requirement/);
		const events = ledgerEvents(cwd);
		assert.deepEqual(events.map((entry) => entry.type).slice(0, 3), ["completion_requested", "audit_started", "audit_result"]);
		assert.equal(events.find((entry) => entry.type === "audit_result")?.verdict, "approved");
		assert.equal(activeGoalFiles(cwd).length, 1, "deferred archival keeps the completed goal active until turn_end");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("D-10/I-09: delegated Escape cancel can continue working without a skip ledger event", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-delegated-cancel-continue-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const harness = createHarness(cwd);
		(harness.ctx as any).hasUI = true;
		(harness.ctx.ui as any).custom = async () => "continue_working";
		let started: (() => void) | undefined;
		const startedPromise = new Promise<void>((resolve) => { started = resolve; });
		let requestIdentity: { requestId: string; ownerRunId: string; nodeId: string } | undefined;
		harness.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			requestIdentity = value as typeof requestIdentity;
			harness.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, requestIdentity);
			started?.();
		});
		harness.events.on("prompt-template:subagent:cancel", (value) => {
			const cancel = value as { requestId: string; ownerRunId: string; nodeId: string };
			assert.equal(cancel.requestId, requestIdentity?.requestId);
			assert.equal(cancel.ownerRunId, requestIdentity?.ownerRunId);
			assert.equal(cancel.nodeId, requestIdentity?.nodeId);
			harness.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { ...cancel, status: "cancelled" });
		});
		await start(harness);
		const updateGoal = harness.tools.get("update_goal")!;
		const pending = (updateGoal.execute as any)("complete-cancel-continue", { status: "complete" }, new AbortController().signal, undefined, harness.ctx);
		await startedPromise;
		harness.core.abortAudit(harness.ctx);
		const result = await pending;

		assert.equal(harness.core.state.goal?.status, "active");
		assert.match(result.content[0]?.text ?? "", /goal remains active/);
		const events = ledgerEvents(cwd);
		assert.deepEqual(events.map((entry) => entry.type), ["completion_requested", "audit_started"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("D-10/I-09: delegated Escape cancel can bypass only after explicit user choice", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-delegated-cancel-bypass-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const harness = createHarness(cwd);
		(harness.ctx as any).hasUI = true;
		(harness.ctx.ui as any).custom = async () => "complete_without_audit";
		let started: (() => void) | undefined;
		const startedPromise = new Promise<void>((resolve) => { started = resolve; });
		harness.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			const identity = value as { requestId: string; ownerRunId: string; nodeId: string };
			harness.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity);
			started?.();
		});
		harness.events.on("prompt-template:subagent:cancel", (value) => {
			harness.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { ...(value as object), status: "cancelled" });
		});
		await start(harness);
		const updateGoal = harness.tools.get("update_goal")!;
		const pending = (updateGoal.execute as any)("complete-cancel-bypass", { status: "complete" }, new AbortController().signal, undefined, harness.ctx);
		await startedPromise;
		harness.core.abortAudit(harness.ctx);
		const result = await pending;

		assert.equal(harness.core.state.goal?.status, "complete");
		assert.equal(result.terminate, undefined, "Escape bypass leaves the executor turn available for its final summary");
		assert.ok(ledgerEvents(cwd).some((entry) => entry.type === "audit_skipped"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("D-07/I-06/I-10: disapproved structured delegation keeps the goal active without a retry", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-delegated-reject-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const harness = createHarness(cwd);
		let requests = 0;
		harness.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
			requests++;
			const identity = value as { requestId: string; ownerRunId: string; nodeId: string };
			harness.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
				...identity,
				status: "completed",
				result: {
					kind: "structured",
					value: {
						verdict: "disapproved",
						report: "Evidence is incomplete.",
						findings: ["Missing integration test output."],
					},
				},
			});
		});
		await start(harness);
		const updateGoal = harness.tools.get("update_goal")!;
		const result = await (updateGoal.execute as any)("complete-2", { status: "complete" }, new AbortController().signal, undefined, harness.ctx);

		assert.equal(requests, 1);
		assert.equal(harness.core.state.goal?.status, "active");
		assert.equal(result.terminate, undefined);
		assert.match(result.content[0]?.text ?? "", /Missing integration test output/);
		const audit = ledgerEvents(cwd).find((entry) => entry.type === "audit_result");
		assert.equal(audit?.verdict, "disapproved");
		assert.match(audit?.report ?? "", /Evidence is incomplete/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
