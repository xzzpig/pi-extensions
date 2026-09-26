/**
 * End-to-end proposal rejection rendering (§proposal-adjust follow-up):
 * rejecting a goal draft through the confirmation dialog — with a typed
 * reason, without one, or discarding the draft — must surface the decision
 * and the user's verbatim reason in the transcript tool-result rendering
 * (the pipeline pi actually runs: the tool definition's renderResult),
 * instead of the generic "Goal No goal is set." one-liner.
 *
 * Runs the REAL extension (goalExtension) with a controllable dialog, then
 * renders each result through the registered renderResult exactly as the
 * host does (collapsed by default, expanded on demand).
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

const CONTINUE_ANSWER = "Continue chatting — keep refining";
const CANCEL_ANSWER = "Cancel — discard this draft";
const OBJECTIVE = "Build a tiny app.\nSuccess criteria: it runs.";

function createHarness(cwd: string) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	let dialogResolve: ((result: any) => void) | null = null;
	let hasDialogPending = false;
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: true,
	};
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "draft-rejection-e2e-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => true,
			custom: async () => new Promise((resolve) => { dialogResolve = resolve; hasDialogPending = true; }),
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any);
	return {
		ctx,
		tools,
		commands,
		get core() { return (pi as unknown as { _goalCore: any })._goalCore; },
		dialogResult: (result: unknown) => { hasDialogPending = false; dialogResolve?.(result); },
		hasDialog: () => hasDialogPending,
		callProposal: (params: Record<string, unknown>) => {
			const proposal = tools.get("propose_goal_draft");
			assert.ok(proposal, "propose_goal_draft must be registered during a draft");
			return proposal.execute("prop-1", params, undefined, undefined, ctx) as Promise<any>;
		},
		renderResult: (result: any, expanded: boolean): string => {
			const proposal = tools.get("propose_goal_draft");
			assert.ok(typeof proposal?.renderResult === "function", "propose_goal_draft registers the transcript result renderer");
			return (proposal.renderResult(result, { expanded }, theme) as { render(w: number): string[] }).render(160).join("\n");
		},
		activeGoalCount: (): number => {
			try {
				return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_")).length;
			} catch {
				return 0;
			}
		},
		sessionStart: async () => { await handlers.get("session_start")?.({ reason: "start" }, ctx); },
		beforeAgentStart: async () => { await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, ctx); },
	};
}

test("rejecting the proposal with a typed reason renders the reason in the transcript", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-reject-e2e-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.beforeAgentStart();
		await h.commands.get("goal")!.handler("Build a tiny app", h.ctx);

		const reason = "Split the task list into a setup milestone and a verification milestone.";
		const pending = h.callProposal({ objective: OBJECTIVE, sisyphus: false });
		assert.ok(h.hasDialog(), "confirmation dialog opens");
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: reason, wasCustom: true }], cancelled: false });
		const result = await pending;

		// Continue semantics: no goal is created and drafting stays alive.
		assert.equal(h.activeGoalCount(), 0, "no goal file is created by the rejection");
		assert.ok(h.core.goalDraftActive, "drafting stays active after the rejection");

		const collapsed = h.renderResult(result, false);
		assert.match(collapsed, /Goal draft rejected — reason:/, "collapsed heading names the rejection");
		assert.ok(collapsed.includes(reason), "the typed reason is visible without expanding");

		const expanded = h.renderResult(result, true);
		assert.ok(expanded.includes(reason), "expanded keeps the verbatim reason");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort; failure must not fail the test */ }
	}
});

test("plain continue without a typed reason renders the no-reason heading", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-plain-e2e-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.beforeAgentStart();
		await h.commands.get("goal")!.handler("Build a tiny app", h.ctx);

		const pending = h.callProposal({ objective: OBJECTIVE, sisyphus: false });
		assert.ok(h.hasDialog(), "confirmation dialog opens");
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONTINUE_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;

		assert.ok(h.core.goalDraftActive, "drafting stays active");
		const collapsed = h.renderResult(result, false);
		assert.match(collapsed, /Goal draft rejected — no reason given/);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort; failure must not fail the test */ }
	}
});

test("cancelling the proposal renders the cancelled heading and clears the draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-cancel-e2e-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.beforeAgentStart();
		await h.commands.get("goal")!.handler("Build a tiny app", h.ctx);

		const pending = h.callProposal({ objective: OBJECTIVE, sisyphus: false });
		assert.ok(h.hasDialog(), "confirmation dialog opens");
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CANCEL_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;

		assert.equal(h.activeGoalCount(), 0, "cancel must not create a goal");
		assert.equal(h.core.goalDraftActive, false, "draft cleared on cancel");
		const collapsed = h.renderResult(result, false);
		assert.match(collapsed, /Goal draft cancelled — no goal was created/);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort; failure must not fail the test */ }
	}
});
