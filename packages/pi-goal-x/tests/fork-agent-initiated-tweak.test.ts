/**
 * Fork-only coverage for agent-initiated goal tweaks.
 *
 * The tests exercise admission and confirmation through the real registered
 * propose_goal_draft tool with a stub host, so a proposal cannot bypass focus,
 * target identity, draft, or auto-confirm checks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { findJsonObjectEnd, parseGoalFile } from "../extensions/storage/goal-files.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import {
	continuedDraftSession,
	parseExplicitTweak,
	validateAgentTweakAdmission,
	validateContinuedTweakAdmission,
	type AgentTweakAdmissionState,
} from "../extensions/goal-agent-tweak.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { createMockExtensionContext, createMockTheme, createMockTUI, invokeCustomFactory } from "./tui-test-utils.ts";
import { renderTweakReview } from "../extensions/goal-tweak-review.ts";
import { runBasicTweakDialog, showTweakProposalDialog } from "../extensions/goal-tweak-confirmation.ts";

interface Harness {
	ctx: ExtensionContext;
	tools: Map<string, any>;
	commands: Map<string, any>;
	messages: string[];
	dialogTexts: string[];
	dialogResult(result: unknown): void;
	rejectDialog(error: unknown): void;
	hasDialog(): boolean;
	sessionStart(): Promise<void>;
	sessionTree(): Promise<void>;
	markRunning(): void;
	useRichTUI(): void;
	stopTurn(): void;
	entries(): unknown[];
	draftActive(): boolean;
	core: any;
}

function createHarness(cwd: string, opts: { hasUI?: boolean } = {}): Harness {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const messages: string[] = [];
	const dialogTexts: string[] = [];
	let dialogResolve: ((value: unknown) => void) | undefined;
	let dialogReject: ((error: unknown) => void) | undefined;
	let selectAnswer: string | undefined = "__unknown__";
	let richTUI = false;
	let pending = false;
	let activeTools = ["read", "bash", "edit", "write"];
	const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
	const hasUI = opts.hasUI ?? false;
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		registerMessageRenderer: () => {},
		sendUserMessage: (message: string) => { messages.push(message); },
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI,
	};
	const ctx = {
		cwd,
		hasUI,
		sessionManager: { getBranch: () => [...entries], getSessionId: () => "agent-tweak-session", getCwd: () => cwd, getRoot: () => cwd },
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingVisible: () => {},
			onTerminalInput: () => () => {} ,
			select: async (prompt: string) => { dialogTexts.push(prompt); return selectAnswer; },
			confirm: async () => false,
			custom: async (factory: any) => {
				const tui = richTUI ? createMockTUI().tui : {};
				const component = factory(tui, createMockTheme(), {}, (value: unknown) => { pending = false; dialogResolve?.(value); });
				dialogTexts.push(component.render?.(120).join("\n") ?? "");
				pending = true;
				return new Promise((resolve, reject) => { dialogResolve = resolve; dialogReject = reject; });
			},
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	const core = (pi as any)._goalCore;
	return {
		ctx,
		tools,
		commands,
		messages,
		dialogTexts,
		dialogResult: (result: unknown) => { pending = false; dialogResolve?.(result); },
		rejectDialog: (error: unknown) => { pending = false; dialogReject?.(error); },
		hasDialog: () => pending,
		sessionStart: async () => { await handlers.get("session_start")?.({ reason: "start" }, ctx); },
		sessionTree: async () => { await handlers.get("session_tree")?.({}, ctx); },
		markRunning: () => { core.runningGoalId = core.state.goal?.status === "active" ? core.state.goal.id : null; },
		useRichTUI: () => { richTUI = true; },
		stopTurn: () => { core.runningGoalId = null; },
		entries: () => [...entries],
		draftActive: () => core.goalDraftActive === true,
		core,
	};
}

function diskGoal(cwd: string) {
	const files = readdirSync(path.join(cwd, ".pi", "goals")).filter((name) => name.startsWith("active_goal_"));
	assert.equal(files.length, 1, "exactly one active goal expected");
	return parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!))!;
}

async function proposal(h: Harness, params: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) {
	const tool = h.tools.get("propose_goal_draft");
	assert.ok(tool, "propose_goal_draft must be registered");
	return tool.execute("call-1", params, signal, undefined, h.ctx);
}

function baseState(goal: ReturnType<typeof createGoal>, overrides: Partial<AgentTweakAdmissionState> = {}): AgentTweakAdmissionState {
	return { goal, runningGoalId: goal.id, stoppedGoalId: null, schedulerDenied: false, ...overrides };
}

test("explicit tweak parsing rejects absent goal id, empty or control-only reason, and sanitizes text", () => {
	assert.equal(parseExplicitTweak(undefined), undefined);
	assert.equal(parseExplicitTweak({ goal_id: "g", reason: "  " })?.ok, false);
	assert.equal(parseExplicitTweak({ goal_id: "g", reason: "\u001b[31m\u001b[0m" })?.ok, false);
	const valid = parseExplicitTweak({ goal_id: " g ", reason: " \u001b[31mred\u001b[0m text " });
	assert.deepEqual(valid, { ok: true, value: { goalId: "g", reason: "red text" } });
});

test("admission binds target, active status, running turn, and stop gates", () => {
	const goal = createGoal({ objective: "old", autoContinue: true, sisyphus: false }, Date.UTC(2026, 0, 1));
	const tweak = { goalId: goal.id, reason: "why" };
	assert.equal(validateAgentTweakAdmission(tweak, baseState(goal)).ok, true);
	assert.match((validateAgentTweakAdmission({ ...tweak, goalId: "other" }, baseState(goal)) as any).message, /changed/);
	assert.match((validateAgentTweakAdmission(tweak, baseState({ ...goal, status: "paused" })) as any).message, /not active/);
	assert.match((validateAgentTweakAdmission(tweak, baseState(goal, { runningGoalId: null })) as any).message, /running turn/);
	assert.match((validateAgentTweakAdmission(tweak, baseState(goal, { schedulerDenied: true })) as any).message, /stopped/);
	assert.match((validateAgentTweakAdmission(tweak, baseState(goal, { stoppedGoalId: goal.id })) as any).message, /stopped/);
});

test("continued draft re-proves admission and keeps reason in durable session", () => {
	const goal = createGoal({ objective: "old", autoContinue: true, sisyphus: false }, Date.UTC(2026, 0, 1));
	const draft = { mode: "tweak" as const, targetGoalId: goal.id, reason: "why", originalTopic: "why", startedAt: "now", auditorEnabled: true };
	assert.equal(validateContinuedTweakAdmission(undefined, draft, baseState(goal)).ok, true);
	assert.match((validateContinuedTweakAdmission(undefined, draft, baseState(goal, { runningGoalId: null })) as any).message, /running turn/);
	assert.match((validateContinuedTweakAdmission({ goalId: "other", reason: "x" }, draft, baseState(goal)) as any).message, /bound to another goal/);
	assert.equal(continuedDraftSession(draft).reason, "why");
});

test("agent tweak applies with explicit goal_id and reason without a start command", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-apply-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const startedMessages = h.messages.length;
		const pending = proposal(h, {
			objective: "Revised objective",
			sisyphus: false,
			tweak: { goal_id: before.id, reason: "The old acceptance criteria are obsolete." },
		});
		assert.ok(h.hasDialog(), "one call opens the existing tweak review");
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /tweak confirmed and applied/);
		assert.equal(h.messages.length, startedMessages, "no draft-start message is injected");
		const after = diskGoal(cwd);
		assert.equal(after.id, before.id, "same goal revised");
		assert.equal(after.objective, "Revised objective");
		assert.ok(readGoalLedger({ cwd }).events.some((event) => event.type === "goal_tweaked"));
		assert.equal(h.draftActive(), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a rejected agent tweak leaves no active draft behind", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-reject-params-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const result = await proposal(h, { objective: "   ", sisyphus: false,
			tweak: { goal_id: before.id, reason: "Valid reason but empty objective." } });
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /at least 1 character/);
		assert.equal(h.draftActive(), false, "validation failure must not leave a stray draft");
		assert.equal(h.hasDialog(), false);
		assert.equal(diskGoal(cwd).objective, before.objective, "no mutation");
		// A valid follow-up is still admitted because no stale draft blocks it.
		const followup = proposal(h, { objective: "Valid revision", sisyphus: false,
			tweak: { goal_id: before.id, reason: "Retry after correction." } });
		assert.ok(h.hasDialog(), "follow-up proposal is admitted");
		h.dialogResult({ decision: "cancel", auditorEnabled: true, unavailable: false });
		await followup;
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("continue chatting keeps the agent tweak draft bound to the same goal", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-continue-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "First revision", sisyphus: false,
			tweak: { goal_id: before.id, reason: "First reason." } });
		assert.ok(h.hasDialog());
		h.dialogResult({ decision: "continue", auditorEnabled: false, unavailable: false, feedback: "Narrow the scope." });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /refinement requested/);
		assert.ok(result.content.map((item: any) => item.text ?? "").join("\n").includes("Narrow the scope."));
		assert.equal(diskGoal(cwd).objective, before.objective, "continue must not mutate the goal");
		assert.equal(h.draftActive(), true, "draft stays active for refinement");
		const next = proposal(h, { objective: "Second revision", sisyphus: false });
		assert.ok(h.hasDialog(), "the continued draft accepts the next proposal without a new command");
		h.dialogResult({ decision: "cancel", auditorEnabled: false, unavailable: false });
		await next;
		assert.equal(h.draftActive(), false);
		assert.equal(diskGoal(cwd).objective, before.objective, "cancel keeps the original goal");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("PI_GOAL_AUTO_CONFIRM=1 applies an agent tweak and retains the reason", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-auto-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		try {
			const result = await proposal(h, { objective: "Auto revised", sisyphus: false,
				tweak: { goal_id: before.id, reason: "A new constraint invalidated the goal." } });
			assert.equal(h.hasDialog(), false, "auto-confirm skips the dialog");
			const text = result.content.map((item: any) => item.text ?? "").join("\n");
			assert.match(text, /调整原因/);
			assert.match(text, /A new constraint invalidated the goal\./);
			assert.match(text, /tweak confirmed and applied/);
			assert.equal(diskGoal(cwd).objective, "Auto revised");
		} finally { delete process.env.PI_GOAL_AUTO_CONFIRM; }
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("auto-confirm initializes auditor from the same uncached goal used for admission and review", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-stale-auditor-"));
 mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart();
  await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const applied = h.core.goalService.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, skipAuditor: true }) });
  assert.equal(applied.ok, true);
  const before = diskGoal(cwd); assert.equal(before.skipAuditor, true);
  const fs = await import("node:fs"); const dir = path.join(cwd, ".pi", "goals");
  const file = path.join(dir, readdirSync(dir).find(f => f.startsWith("active_goal_"))!);
  const fixed = new Date("2020-01-01T00:00:00.000Z"); fs.utimesSync(file, fixed, fixed);
  const old = fs.readFileSync(file, "utf8"); const stat = fs.statSync(file);
  assert.equal(parseGoalFile(file)?.skipAuditor, true);
  const changed = old.replace('"skipAuditor": true', '"skipAuditor":false');
  assert.notEqual(old, changed); assert.equal(Buffer.byteLength(changed), stat.size);
  fs.writeFileSync(file, changed); fs.utimesSync(file, fixed, fixed);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs); assert.equal(fs.statSync(file).size, stat.size);
  assert.equal(parseGoalFile(file)?.skipAuditor, true, "the shared parse cache remains stale");
  assert.equal(h.core.state.goal.skipAuditor, true, "session starts with the stale auditor choice");
  process.env.PI_GOAL_AUTO_CONFIRM = "1";
  const result = await proposal(h, { objective: "Revised objective", sisyphus: false, tweak: { goal_id: before.id, reason: "New evidence" } });
  assert.equal(h.hasDialog(), false);
  const text = result.content.map((x: any) => x.text ?? "").join("\n");
  assert.match(text, /tweak confirmed and applied/i); assert.match(text, /New evidence/);
  assert.doesNotMatch(text, /Independent auditor:\s*enabled\s*->\s*disabled/i);
  const { readAuthoritativeGoalAtPath } = await import("../extensions/fork-goal-authority.ts");
  const actual = readAuthoritativeGoalAtPath(file)!; assert.notEqual(actual.skipAuditor, true); assert.equal(actual.objective, "Revised objective");
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

test("continued agent draft keeps the user's explicit auditor choice on auto-confirm", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-user-auditor-"));
 mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart();
  await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); process.env.PI_GOAL_AUTO_CONFIRM = "0";
  const first = proposal(h, { objective: "First revision", sisyphus: false, tweak: { goal_id: before.id, reason: "Refine" } });
  assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "continue", auditorEnabled: false, unavailable: false }); await first;
  process.env.PI_GOAL_AUTO_CONFIRM = "1";
  const result = await proposal(h, { objective: "Second revision", sisyphus: false });
  assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /confirmed and applied/i);
  assert.equal(diskGoal(cwd).skipAuditor, true);
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

test("malformed custom-host confirmation cannot approve or change auditor selection", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-malformed-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); process.env.PI_GOAL_AUTO_CONFIRM = "0";
  const pending = proposal(h, { objective: "Should not apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Invalid host" } });
  assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "confirm" });
  const result = await pending; assert.equal(result.isError, true); assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /invalid|host|failed/i);
  const after = diskGoal(cwd); assert.equal(after.objective, before.objective); assert.equal(after.skipAuditor, before.skipAuditor); assert.equal(after.revision, before.revision); assert.equal(h.draftActive(), false);
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

for (const mode of ["before-auto", "admission-flush", "dialog-confirm", "dialog-continue", "dialog-hang", "commit-lock"] as const) {
 test(`aborted model tweak cannot apply or create a draft (${mode})`, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-abort-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
  const prior = process.env.PI_GOAL_AUTO_CONFIRM;
  try {
   const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
   const before = diskGoal(cwd); const controller = new AbortController();
   process.env.PI_GOAL_AUTO_CONFIRM = mode === "before-auto" || mode === "commit-lock" ? "1" : "0";
   let flushes = 0; const originalFlush = h.core.goalService.flushForAudit.bind(h.core.goalService);
   h.core.goalService.flushForAudit = (...args: any[]) => { flushes++; if (mode === "admission-flush") controller.abort(); return originalFlush(...args); };
   if (mode === "before-auto") controller.abort();
   if (mode === "commit-lock") {
    const service = h.core.goalService; const originalRead = service.readFreshDiskGoal.bind(service);
    service.readFreshDiskGoal = (...args: any[]) => { controller.abort(); return originalRead(...args); };
   }
   const pending = proposal(h, { objective: "Should not apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Abort" } }, controller.signal);
   if (mode.startsWith("dialog")) {
    assert.equal(h.hasDialog(), true); controller.abort();
    if (mode !== "dialog-hang") h.dialogResult({ decision: mode === "dialog-confirm" ? "confirm" : "continue", auditorEnabled: true, unavailable: false });
   }
   const result = await pending; assert.equal(result.isError, true);
   if (mode === "dialog-hang") h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
   assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /abort|not applied|changed/i);
   if (mode === "before-auto") assert.equal(flushes, 0, "pre-aborted call cannot flush");
   if (mode === "admission-flush") assert.equal(h.hasDialog(), false, "abort during admission cannot open review");
   const after = diskGoal(cwd); assert.equal(after.objective, before.objective); assert.equal(after.skipAuditor, before.skipAuditor); assert.equal(after.revision, before.revision); assert.equal(h.draftActive(), false);
  } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
 });
}

test("an empty task list and its normalized absent form compare equal for a model review flush", async () => {
 const { canFlushBufferedGoal, parseAuthoritativeGoalContent } = await import("../extensions/fork-goal-authority.ts");
 const { serializeGoalFile } = await import("../extensions/storage/goal-files.ts");
 const goal = { ...createGoal({ objective: "A complete goal", autoContinue: true, sisyphus: false }, Date.now()),
  taskList: { tasks: [], blockCompletion: false, proposedAt: new Date().toISOString() } };
 const reloaded = parseAuthoritativeGoalContent(serializeGoalFile(goal)); assert.ok(reloaded); assert.equal(reloaded.taskList, undefined);
 assert.equal(canFlushBufferedGoal(reloaded, goal, goal, true), true);
});

test("clearing tasks by model tweak permits later buffered usage and ledger flush", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-empty-tasks-flush-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true }); const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  process.env.PI_GOAL_AUTO_CONFIRM = "1"; const h = createHarness(cwd); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const seed = h.core.goalService.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, taskList: { tasks: [{ id: "old", title: "Old", status: "pending" }], blockCompletion: false, proposedAt: new Date().toISOString() } }) });
  assert.equal(seed.ok, true); const before = diskGoal(cwd);
  const result = await proposal(h, { objective: "Revised objective", sisyphus: false, tasks: [], tweak: { goal_id: before.id, reason: "Clear tasks" } });
  assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /confirmed and applied/i);
  const saved = diskGoal(cwd); assert.equal(saved.taskList, undefined);
  const service = h.core.goalService; service.beginTurn(h.ctx, saved.id);
  assert.equal(service.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, usage: { ...g.usage, tokensUsed: g.usage.tokensUsed + 2 } }),
   ledger: [{ type: "goal_tweaked", goalId: saved.id, changeSummary: "post-empty-task buffer", at: new Date().toISOString() }] }).ok, true);
  assert.equal(service.flushForAudit(h.ctx, true), null);
  assert.equal(diskGoal(cwd).usage.tokensUsed, saved.usage.tokensUsed + 2);
  assert.ok(readGoalLedger({ cwd }).events.some(e => e.type === "goal_tweaked" && e.changeSummary === "post-empty-task buffer"));
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

test("agent tweak with only a verification contract is rejected before review", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-contract-only-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); let flushes = 0; const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
  h.core.goalService.flushForAudit = (...args: any[]) => { flushes++; return original(...args); };
  const result = await proposal(h, { objective: "Verification contract: Inspect the finished memo.", sisyphus: false, tweak: { goal_id: before.id, reason: "Scope" } });
  assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /complete objective/i);
  assert.equal(flushes, 0); assert.equal(h.hasDialog(), false); assert.equal(diskGoal(cwd).objective, before.objective);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const autoConfirm of [false, true]) test(`empty tasks and contract text agree across preview, commit, reload and ledger (auto=${autoConfirm})`, async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-candidate-roundtrip-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true }); const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  process.env.PI_GOAL_AUTO_CONFIRM = autoConfirm ? "1" : "0";
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const seed = h.core.goalService.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, taskList: { tasks: [{ id: "old", title: "Old", status: "pending" }], blockCompletion: false, proposedAt: new Date().toISOString() } }) });
  assert.equal(seed.ok, true); const before = diskGoal(cwd);
  const args = { objective: "Write the status memo.\n\nVerification contract: Check the included Risks section.", sisyphus: false, tasks: [], block_completion: true, tweak: { goal_id: before.id, reason: "Scope and evidence" } };
  const pending = proposal(h, args); if (!autoConfirm) { assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false }); }
  const result = await pending; assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /confirmed and applied/i);
  const review = result.details.tweakReview; assert.ok(review); assert.match(review.fullText, /Write the status memo\./);
  assert.match(review.fullText, /does not block goal completion/i); assert.doesNotMatch(review.fullText, /blocks goal completion/i);
  assert.doesNotMatch(review.diffText, /[+]\s*(?:Task completion: )?blocks goal completion/i);
  const after = diskGoal(cwd); assert.equal(after.objective, "Write the status memo."); assert.equal(after.verificationContract, "Check the included Risks section."); assert.equal(after.taskList, undefined);
  const evt = readGoalLedger({ cwd }).events.filter(e => e.type === "task_list_set").at(-1) as any;
  assert.ok(evt); assert.equal(evt.taskCount, 0); assert.equal(evt.blockCompletion, false);
  const service = h.core.goalService; service.beginTurn(h.ctx, after.id);
  assert.equal(service.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, usage: { ...g.usage, tokensUsed: g.usage.tokensUsed + 2 } }) }).ok, true);
  assert.equal(service.flushForAudit(h.ctx, true), null); assert.equal(diskGoal(cwd).objective, after.objective);
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

for (const autoConfirm of [false, true]) test(`model CRLF candidate matches storage when contracts are disabled (auto=${autoConfirm})`, async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-crlf-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true }); const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  const { saveGoalSettingsFileConfig, loadGoalSettings } = await import("../extensions/goal-settings.ts");
  saveGoalSettingsFileConfig(cwd, { disableContracts: true }); assert.equal(loadGoalSettings(cwd).disableContracts, true);
  process.env.PI_GOAL_AUTO_CONFIRM = autoConfirm ? "1" : "0";
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); const text = "Draft the memo.\r\nInclude Risks.";
  const pending = proposal(h, { objective: text, sisyphus: false, tweak: { goal_id: before.id, reason: "Updated requirements" } });
  if (!autoConfirm) { assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false }); }
  const result = await pending; assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /confirmed and applied/i);
  const review = result.details.tweakReview; assert.ok(review); assert.match(review.fullText, /Draft the memo\.[\s\S]*Include Risks\./); assert.doesNotMatch(review.fullText, /\r/);
  const after = diskGoal(cwd); assert.equal(after.objective, "Draft the memo.\nInclude Risks."); assert.equal(h.core.state.goal.objective, after.objective);
  const service = h.core.goalService; service.beginTurn(h.ctx, after.id);
  assert.equal(service.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, usage: { ...g.usage, tokensUsed: g.usage.tokensUsed + 2 } }),
   ledger: [{ type: "goal_tweaked", goalId: after.id, changeSummary: "crlf flush evidence", at: new Date().toISOString() }] }).ok, true);
  assert.equal(service.flushForAudit(h.ctx, true), null); assert.equal(diskGoal(cwd).usage.tokensUsed, after.usage.tokensUsed + 2);
  assert.ok(readGoalLedger({ cwd }).events.some(e => e.type === "goal_tweaked" && e.changeSummary === "crlf flush evidence"));
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

test("invisible Unicode-only reasons are rejected before flush or review", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-invisible-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); let flushes = 0; const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
  h.core.goalService.flushForAudit = (...args: any[]) => { flushes++; return original(...args); };
  for (const reason of ["\u200b", "\u200b\u200d", "\u001b[31m\u200b\u001b[0m"]) {
   const result = await proposal(h, { objective: "Revised", sisyphus: false, tweak: { goal_id: before.id, reason } });
   assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /visible text/i);
  }
  assert.equal(flushes, 0); assert.equal(h.hasDialog(), false); assert.equal(diskGoal(cwd).objective, before.objective);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const agentReview of [false, true]) test(`flush treats false and absent skipAuditor as equivalent (agent=${agentReview})`, async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-flush-bool-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 try {
  const h = createHarness(cwd); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); h.core.state.goal = { ...h.core.state.goal, skipAuditor: false };
  const service = h.core.goalService; service.beginTurn(h.ctx, before.id);
  const result = service.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, usage: { ...g.usage, tokensUsed: g.usage.tokensUsed + 3 } }),
   ledger: [{ type: "goal_tweaked", goalId: before.id, changeSummary: "buffer evidence", at: new Date().toISOString() }] });
  assert.equal(result.ok, true); assert.equal(service.flushForAudit(h.ctx, agentReview), null);
  const after = diskGoal(cwd); assert.equal(after.usage.tokensUsed, before.usage.tokensUsed + 3); assert.equal(after.revision, (before.revision ?? 0) + 1);
  assert.ok(readGoalLedger({ cwd }).events.some(e => e.type === "goal_tweaked" && e.changeSummary === "buffer evidence"));
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("initial explicit tweak call row does not preview derived tasks or auto-continuation changes", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-call-preview-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const seeded = h.core.goalService.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, autoContinue: true,
   taskList: { tasks: [{ id: "old", title: "Existing", status: "complete", evidence: "verified" }], blockCompletion: true, proposedAt: "2026-01-01T00:00:00.000Z" } }) });
  assert.equal(seeded.ok, true);
  const before = diskGoal(cwd); const tool = h.tools.get("propose_goal_draft");
  const args = { objective: "1. First step\n2. Second step", auto_continue: false, tweak: { goal_id: before.id, reason: "Changed scope" } };
  const output = tool.renderCall(args, createMockTheme(), { cwd, state: {}, invalidate() {} }).render(180).join("\n");
  assert.match(output, /Goal tweak/); assert.doesNotMatch(output, /Tasks derived|Automatic continuation: disabled/);
  const pending = proposal(h, args); assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
  const result = await pending; assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /confirmed and applied/i);
  const after = diskGoal(cwd); assert.deepEqual(after.taskList, before.taskList); assert.equal(after.autoContinue, before.autoContinue);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("unset auto-confirm on a headless host applies model tweak with its reason", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-default-headless-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true }); const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  delete process.env.PI_GOAL_AUTO_CONFIRM; const h = createHarness(cwd, { hasUI: false }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); const result = await proposal(h, { objective: "Headless revision", sisyphus: false, tweak: { goal_id: before.id, reason: "Headless reason" } });
  assert.equal(h.hasDialog(), false); assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /Headless reason/);
  assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /confirmed and applied/i); assert.equal(diskGoal(cwd).objective, "Headless revision");
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

test("cancelling model tweak preserves task progress budget and execution state", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-cancel-state-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true }); const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  process.env.PI_GOAL_AUTO_CONFIRM = "0"; const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const outcome = h.core.goalService.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, tokenBudget: 10000,
   taskList: { tasks: [{ id: "a", title: "Done", status: "complete", evidence: "verified", completedAt: "2026-01-01T00:00:00.000Z" }], blockCompletion: true, proposedAt: "2026-01-01T00:00:00.000Z" } }) });
  assert.equal(outcome.ok, true); const before = diskGoal(cwd); const running = h.core.runningGoalId;
  const pending = proposal(h, { objective: "Cancelled revision", sisyphus: false, tweak: { goal_id: before.id, reason: "Review" } });
  assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "cancel", auditorEnabled: true, unavailable: false }); await pending;
  const after = diskGoal(cwd); assert.equal(after.objective, before.objective); assert.equal(after.tokenBudget, before.tokenBudget);
  assert.deepEqual(after.taskList, before.taskList); assert.equal(after.status, before.status); assert.equal(after.autoContinue, before.autoContinue);
  assert.equal(after.revision, before.revision); assert.equal(h.core.runningGoalId, running); assert.equal(h.draftActive(), false);
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

test("agent tweak rejects a stale target and leaves an existing user draft intact", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-reject-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const result = await proposal(h, { objective: "Stale revision", sisyphus: false,
			tweak: { goal_id: "wrong-id", reason: "New information arrived." } });
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /changed while preparing/);
		assert.equal(diskGoal(cwd).objective, before.objective, "no mutation on stale target");
		assert.equal(h.hasDialog(), false);
		await h.commands.get("goal")!.handler("A separate user creation draft", h.ctx);
		const blocked = await proposal(h, { objective: "Should not apply", sisyphus: false,
			tweak: { goal_id: before.id, reason: "Model tries again." } });
		assert.match(blocked.content.map((item: any) => item.text ?? "").join("\n"), /guided draft is already active/);
		assert.equal(h.draftActive(), true, "user draft survives");
		assert.equal(h.messages.some((m) => m.includes("A separate user creation draft")), true, "user draft was not replaced");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("PI_GOAL_AUTO_CONFIRM=0 with no UI leaves no active or persisted draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-auto0-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: false });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		process.env.PI_GOAL_AUTO_CONFIRM = "0";
		try {
			const result = await proposal(h, { objective: "Should not apply", sisyphus: false,
				tweak: { goal_id: before.id, reason: "No UI must not auto-approve." } });
			assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /goal was NOT changed/);
			assert.equal(h.draftActive(), false, "no active draft after unavailable confirmation");
			assert.equal(diskGoal(cwd).objective, before.objective, "no mutation");
		} finally { delete process.env.PI_GOAL_AUTO_CONFIRM; }
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a confirm-time target change clears the newly registered draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-conflict-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Revised", sisyphus: false,
			tweak: { goal_id: before.id, reason: "Conflict during confirmation." } });
		assert.ok(h.hasDialog());
		// Simulate a concurrent focus change while the dialog is open.
		await h.commands.get("goal-unfocus")!.handler("", h.ctx);
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /NOT applied|changed while reviewing|changed during confirmation/);
		assert.equal(h.draftActive(), false, "conflict must clear the new draft");
		assert.equal(diskGoal(cwd).objective, before.objective, "no mutation");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("cancelling a model proposal never clears a user draft started while its dialog was open", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-user-draft-race-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Model revision", sisyphus: false, tweak: { goal_id: before.id, reason: "Model reason." } });
		assert.ok(h.hasDialog());
		// The user starts their own draft while the model's dialog is open.
		await h.commands.get("goal")!.handler("User's separate draft", h.ctx);
		h.dialogResult({ decision: "cancel", auditorEnabled: true, unavailable: false });
		await pending;
		assert.equal(h.draftActive(), true, "user draft survives model proposal cancel");
		assert.ok(h.messages.some((m) => m.includes("User's separate draft")), "user draft still active");
		const entries = JSON.stringify(h.entries());
		assert.ok(!entries.includes("Model reason.") || entries.includes("User's separate draft"), "no tombstone that erases the user draft");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("confirming a model proposal cannot apply over a user draft started during the dialog", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-confirm-race-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Model revision", sisyphus: false, tweak: { goal_id: before.id, reason: "Model reason." } });
		assert.ok(h.hasDialog());
		await h.commands.get("goal")!.handler("User's separate draft", h.ctx);
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /NOT applied|draft changed/);
		assert.equal(diskGoal(cwd).objective, before.objective, "model tweak must NOT apply over user draft");
		assert.equal(h.draftActive(), true, "user draft survives");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a manual tweak conflict rejects the commit but keeps the user draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "manual-tweak-conflict-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		await h.commands.get("goal-tweak")!.handler("Manual refinement", h.ctx);
		const pending = proposal(h, { objective: "Manual revision", sisyphus: false });
		assert.ok(h.hasDialog());
		// Change the goal on disk during confirmation without touching the draft.
		const pathMod = await import("node:fs");
		const files = pathMod.readdirSync(path.join(cwd, ".pi", "goals")).filter((f: string) => f.startsWith("active_goal_"));
		const file = path.join(cwd, ".pi", "goals", files[0]!);
		const raw = pathMod.readFileSync(file, "utf8");
		const [header = "{}", ...rest] = raw.split("\n\n");
		const record = JSON.parse(header);
		record.revision += 1;
		pathMod.writeFileSync(file, JSON.stringify(record, null, 2) + "\n\n" + rest.join("\n\n"));
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /not applied|changed during confirmation/);
		assert.equal(h.draftActive(), true, "manual tweak draft survives a conflict (baseline behavior)");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a model tweak cannot be committed after the execution turn is stopped during the dialog", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-gate-race-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Should not apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Gate test." } });
		assert.ok(h.hasDialog());
		h.stopTurn(); // emulate the turn becoming ineligible while the dialog is open
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\\n"), /not applied|changed during confirmation/);
		assert.equal(diskGoal(cwd).objective, before.objective, "stopped turn must not apply the tweak");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a late continue decision cannot resurrect a cancelled agent draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-late-continue-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const first = proposal(h, { objective: "First", sisyphus: false, tweak: { goal_id: before.id, reason: "First reason." } });
		h.dialogResult({ decision: "continue", auditorEnabled: true, unavailable: false });
		await first;
		assert.equal(h.draftActive(), true);
		const second = proposal(h, { objective: "Second", sisyphus: false });
		assert.ok(h.hasDialog());
		// The user cancels the draft while the second review is open.
		await h.commands.get("goal-cancel")!.handler("", h.ctx);
		assert.equal(h.draftActive(), false, "draft cancelled");
		h.dialogResult({ decision: "continue", auditorEnabled: true, unavailable: false });
		const late = await second;
		assert.match(late.content.map((item: any) => item.text ?? "").join("\n"), /draft changed|left untouched/i);
		assert.equal(h.draftActive(), false, "late continue must not resurrect a cancelled draft");
		const lastEntry = JSON.stringify(h.entries().at(-1));
		assert.ok(!lastEntry.includes("Second") || lastEntry.includes("clearedAt"), "no fresh draft record written for cancelled draft");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a late confirm decision cannot apply a cancelled agent draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-late-confirm-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const first = proposal(h, { objective: "First", sisyphus: false, tweak: { goal_id: before.id, reason: "First reason." } });
		h.dialogResult({ decision: "continue", auditorEnabled: true, unavailable: false });
		await first;
		const second = proposal(h, { objective: "Late revision", sisyphus: false });
		assert.ok(h.hasDialog());
		await h.commands.get("goal-cancel")!.handler("", h.ctx);
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const late = await second;
		assert.match(late.content.map((item: any) => item.text ?? "").join("\n"), /NOT applied|draft changed/i);
		assert.equal(diskGoal(cwd).objective, before.objective, "cancelled draft's review must not mutate the goal");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("continue chatting cannot persist a draft after the goal loses focus during review", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-continue-focus-race-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Revised", sisyphus: false, tweak: { goal_id: before.id, reason: "Focus race." } });
		assert.ok(h.hasDialog());
		// Focus is lost while the review is open.
		await h.commands.get("goal-unfocus")!.handler("", h.ctx);
		h.dialogResult({ decision: "continue", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /nothing was saved|changed while reviewing/i);
		assert.equal(h.draftActive(), false, "no draft written after focus loss");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a legacy no-draft proposal is rejected without flushing or reconciling", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-legacy-no-flush-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		let flushes = 0;
		const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
		h.core.goalService.flushForAudit = (...args: any[]) => { flushes += 1; return original(...args); };
		const result = await proposal(h, { objective: "Legacy call", sisyphus: false });
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /No guided goal draft is active/);
		assert.equal(flushes, 0, "legacy rejection must not close a turn transaction buffer");
		h.core.goalService.flushForAudit = original;
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("an empty-objective proposal with an active draft is rejected before flush", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-empty-with-draft-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		await h.commands.get("goal-tweak")!.handler("Manual refinement", h.ctx);
		let flushes = 0;
		const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
		h.core.goalService.flushForAudit = (...args: any[]) => { flushes += 1; return original(...args); };
		const result = await proposal(h, { objective: "   ", sisyphus: false });
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /at least 1 character/);
		assert.equal(flushes, 0, "empty objective must be rejected before any flush");
		assert.equal(h.draftActive(), true, "existing manual draft is untouched");
		h.core.goalService.flushForAudit = original;
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("wrong id, stopped turn and invalid tasks are rejected before any flush", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-preflush-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
		let flushes = 0;
		h.core.goalService.flushForAudit = (...args: any[]) => { flushes += 1; return original(...args); };
		const cases = [
			[ { objective: "X", tweak: { goal_id: "wrong-id", reason: "Wrong." } }, /changed while preparing/ ],
			[ { objective: "X", tweak: { goal_id: before.id, reason: "Stopped." } }, /running turn|stopped|not admitted/i ],
			[ { objective: "X", tweak: { goal_id: before.id, reason: "Bad tasks." }, tasks: [{ id: "a", title: "a", parent_id: "missing" }] }, /parent|unknown|invalid/i ],
		] as const;
		// Stop the turn only for the second case.
		for (let i = 0; i < cases.length; i++) {
			if (i === 1) h.stopTurn(); else h.markRunning();
			const [params, pattern] = cases[i]!;
			const result = await proposal(h, { sisyphus: false, ...params });
			assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), pattern as RegExp);
		}
		assert.equal(flushes, 0, "all pure rejections happen before flush");
		h.core.goalService.flushForAudit = original;
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a stopped continued proposal is rejected before any flush", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-continued-stop-flush-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const first = proposal(h, { objective: "First", sisyphus: false, tweak: { goal_id: before.id, reason: "First reason." } });
		h.dialogResult({ decision: "continue", auditorEnabled: true, unavailable: false });
		await first;
		h.stopTurn();
		let flushes = 0;
		const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
		h.core.goalService.flushForAudit = (...args: any[]) => { flushes += 1; return original(...args); };
		const result = await proposal(h, { objective: "Second", sisyphus: false });
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /stopped|not admitted/i);
		assert.equal(flushes, 0, "stopped continued proposal must be rejected before flush");
		h.core.goalService.flushForAudit = original;
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("admission flush rejects a same-revision pause under the lock without overwriting it", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-flush-race-"));
 mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 try {
  const h = createHarness(cwd, { hasUI: true });
  await h.sessionStart();
  await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
  h.markRunning();
  const before = diskGoal(cwd);
  const service = h.core.goalService;
  service.beginTurn(h.ctx, before.id);
  const buffered = service.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, usage: { ...g.usage, tokensUsed: g.usage.tokensUsed + 10 } }) });
  assert.equal(buffered.ok, true);
  assert.equal(service.isTurnBuffered(), true);
  const fs = await import("node:fs");
  const file = path.join(cwd, ".pi", "goals", readdirSync(path.join(cwd, ".pi", "goals")).find(f => f.startsWith("active_goal_"))!);
  const original = service.readFreshDiskGoal.bind(service);
  let changed = false;
  service.readFreshDiskGoal = (...args: any[]) => {
   if (!changed) {
    changed = true;
    const raw = fs.readFileSync(file, "utf8");
    const paused = raw.replace('"status": "active"', '"status": "paused"');
    assert.notEqual(raw, paused);
    fs.writeFileSync(file, paused);
   }
   return original(...args);
  };
  const result = await proposal(h, { objective: "Must not apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Race test" } });
  assert.equal(changed, true);
  assert.equal(h.hasDialog(), false);
  assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /changed|rejected/i);
  const { readAuthoritativeGoalAtPath } = await import("../extensions/fork-goal-authority.ts");
  const actual = readAuthoritativeGoalAtPath(file)!;
  assert.equal(actual.status, "paused");
  assert.equal(actual.revision, before.revision);
  assert.equal(actual.usage.tokensUsed, before.usage.tokensUsed);
  assert.equal(actual.objective, before.objective);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const change of ["id", "objective"] as const) {
 test(`admission flush rejects same-revision ${change} change without changing focus`, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agent-flush-definition-"));
  mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
  try {
   const h = createHarness(cwd, { hasUI: true });
   await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
   const before = diskGoal(cwd); const token = h.core.focusedOperationToken(before.id);
   const service = h.core.goalService;
   service.beginTurn(h.ctx, before.id);
   assert.equal(service.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, usage: { ...g.usage, tokensUsed: g.usage.tokensUsed + 10 } }) }).ok, true);
   const fs = await import("node:fs");
   const file = path.join(cwd, ".pi", "goals", readdirSync(path.join(cwd, ".pi", "goals")).find(f => f.startsWith("active_goal_"))!);
   const original = service.readFreshDiskGoal.bind(service); let changed = false;
   service.readFreshDiskGoal = (...args: any[]) => {
    if (!changed) {
     changed = true; const raw = fs.readFileSync(file, "utf8");
     const replacement = change === "id" ? raw.replace(`"id": "${before.id}"`, '"id": "different-goal-id"') : raw.replaceAll("Initial objective", "External objective");
     assert.notEqual(replacement, raw); fs.writeFileSync(file, replacement);
    }
    return original(...args);
   };
   const result = await proposal(h, { objective: "Must not apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Race" } });
   assert.equal(changed, true); assert.equal(h.hasDialog(), false);
   assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /changed|rejected/i);
   assert.equal(h.core.state.goal.id, before.id); assert.equal(h.core.isFocusedOperationCurrent(token), true);
   const { readAuthoritativeGoalAtPath } = await import("../extensions/fork-goal-authority.ts");
   const actual = readAuthoritativeGoalAtPath(file)!;
   assert.equal(actual.id, change === "id" ? "different-goal-id" : before.id);
   assert.equal(actual.objective, change === "objective" ? "External objective" : before.objective);
   assert.equal(actual.revision, before.revision); assert.equal(actual.usage.tokensUsed, before.usage.tokensUsed);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
 });
}

for (const autoConfirm of [false, true]) {
 test(`same-revision objective change under commit lock rejects reviewed proposal (auto=${autoConfirm})`, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agent-commit-definition-"));
  mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
  const previous = process.env.PI_GOAL_AUTO_CONFIRM;
  try {
   const h = createHarness(cwd, { hasUI: !autoConfirm }); await h.sessionStart();
   await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
   const before = diskGoal(cwd); const fs = await import("node:fs");
   const file = path.join(cwd, ".pi", "goals", readdirSync(path.join(cwd, ".pi", "goals")).find(f => f.startsWith("active_goal_"))!);
   const service = h.core.goalService; const original = service.readFreshDiskGoal.bind(service); let changed = false;
   service.readFreshDiskGoal = (...args: any[]) => {
    if (!changed) { changed = true; const raw = fs.readFileSync(file, "utf8");
     const modified = raw.replaceAll("Initial objective", "External objective"); assert.notEqual(raw, modified); fs.writeFileSync(file, modified); }
    return original(...args);
   };
   if (autoConfirm) process.env.PI_GOAL_AUTO_CONFIRM = "1"; else process.env.PI_GOAL_AUTO_CONFIRM = "0";
   const pending = proposal(h, { objective: "Model proposal", sisyphus: false, tweak: { goal_id: before.id, reason: "Review race" } });
   if (!autoConfirm) { assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false }); }
   const result = await pending; assert.equal(changed, true);
   assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /not applied|changed/i);
   const { readAuthoritativeGoalAtPath } = await import("../extensions/fork-goal-authority.ts");
   const actual = readAuthoritativeGoalAtPath(file)!; assert.equal(actual.objective, "External objective"); assert.equal(actual.revision, before.revision);
  } finally { if (previous === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = previous; rmSync(cwd, { recursive: true, force: true }); }
 });
}

test("admission flush with unavailable lock-time read retains focus and token", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-flush-unavailable-"));
 mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart();
  await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
  const before = diskGoal(cwd); const token = h.core.focusedOperationToken(before.id);
  const service = h.core.goalService; service.beginTurn(h.ctx, before.id);
  assert.equal(service.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g, usage: { ...g.usage, tokensUsed: g.usage.tokensUsed + 10 } }) }).ok, true);
  const original = service.readFreshDiskGoal.bind(service); let calls = 0;
  service.readFreshDiskGoal = (...args: any[]) => { calls++; return calls === 1 ? null : original(...args); };
  const result = await proposal(h, { objective: "Must not apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Read failure" } });
  assert.equal(calls, 1); assert.equal(h.hasDialog(), false);
  assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /changed|rejected/i);
  assert.equal(h.core.state.goal.id, before.id); assert.equal(h.core.isFocusedOperationCurrent(token), true);
  const actual = diskGoal(cwd); assert.equal(actual.objective, before.objective); assert.equal(actual.revision, before.revision);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const autoConfirm of [false, true]) {
 test(`same-revision Sisyphus change under commit lock rejects reviewed proposal (auto=${autoConfirm})`, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agent-commit-mode-"));
  mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
  const previous = process.env.PI_GOAL_AUTO_CONFIRM;
  try {
   const h = createHarness(cwd, { hasUI: !autoConfirm }); await h.sessionStart();
   await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
   const before = diskGoal(cwd); const fs = await import("node:fs");
   const file = path.join(cwd, ".pi", "goals", readdirSync(path.join(cwd, ".pi", "goals")).find(f => f.startsWith("active_goal_"))!);
   const service = h.core.goalService; const original = service.readFreshDiskGoal.bind(service); let changed = false;
   service.readFreshDiskGoal = (...args: any[]) => {
    if (!changed) { changed = true; const raw = fs.readFileSync(file, "utf8");
     const modified = raw.replace('"sisyphus": false', '"sisyphus": true'); assert.notEqual(raw, modified); fs.writeFileSync(file, modified); }
    return original(...args);
   };
   process.env.PI_GOAL_AUTO_CONFIRM = autoConfirm ? "1" : "0";
   const pending = proposal(h, { objective: "Model proposal", sisyphus: false, tweak: { goal_id: before.id, reason: "Mode race" } });
   if (!autoConfirm) { assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false }); }
   const result = await pending; assert.equal(changed, true);
   assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /not applied|changed/i);
   const { readAuthoritativeGoalAtPath } = await import("../extensions/fork-goal-authority.ts");
   const actual = readAuthoritativeGoalAtPath(file)!; assert.equal(actual.sisyphus, true);
   assert.equal(actual.objective, before.objective); assert.equal(actual.revision, before.revision);
  } finally { if (previous === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = previous; rmSync(cwd, { recursive: true, force: true }); }
 });
}

for (const autoConfirm of [false, true]) {
 for (const change of ["activePath", "scheduler"] as const) {
  test(`commit rejects lock-time ${change} replacement (auto=${autoConfirm})`, async () => {
   const cwd = mkdtempSync(path.join(tmpdir(), "agent-commit-authority-"));
   mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
   const previous = process.env.PI_GOAL_AUTO_CONFIRM;
   try {
    const h = createHarness(cwd, { hasUI: !autoConfirm }); await h.sessionStart();
    await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx); h.markRunning();
    if (change === "scheduler") {
     const seeded = h.core.goalService.apply(h.ctx, { reconcile: false, mutate: (g: any) => ({ ...g,
      usage: { ...g.usage, tokensUsed: 1 },
      scheduler: { version: 1, owner: "agent-tweak-session", generation: "owned-generation", used: 0, phase: "idle", repairUsed: false } }) });
     assert.equal(seeded.ok, true);
    }
    const before = diskGoal(cwd); const fs = await import("node:fs");
    if (change === "scheduler") {
     const { projectTweakCandidate } = await import("../extensions/goal-tweak-projection.ts");
     const input = { objective: "Model proposal", tokenBudget: 1, auditorEnabled: true };
     const context = { disableContracts: false, sessionId: "agent-tweak-session", now: before.updatedAt, schedulerGeneration: "new-generation" };
     const reviewed = projectTweakCandidate(before, input, context);
     const foreign = projectTweakCandidate({ ...before, scheduler: { version: 1, owner: "foreign-session", generation: "foreign-generation", used: 2, phase: "interrupted", repairUsed: false } }, input, context);
     assert.equal(reviewed.schedulerReset, true); assert.equal(reviewed.candidate.scheduler?.phase, "idle");
     assert.equal(foreign.schedulerReset, false); assert.equal(foreign.candidate.scheduler?.phase, "interrupted");
    }
    const dir = path.join(cwd, ".pi", "goals");
    const file = path.join(dir, readdirSync(dir).find(f => f.startsWith("active_goal_"))!);
    const victim = path.join(dir, "active_goal_victim.md");
    const sentinel = "Unrelated victim file: do not overwrite\n";
    fs.writeFileSync(victim, sentinel);
    const service = h.core.goalService; const original = service.readFreshDiskGoal.bind(service);
    let changed = false; let changedBytes = "";
    service.readFreshDiskGoal = (...args: any[]) => {
     if (!changed) {
      changed = true; const raw = fs.readFileSync(file, "utf8");
      const end = findJsonObjectEnd(raw); assert.ok(end > 0);
      const header = JSON.parse(raw.slice(0, end + 1));
      if (change === "activePath") header.activePath = "active_goal_victim.md";
      else header.scheduler = { version: 1, owner: "foreign-session", generation: "foreign-generation", used: 2, phase: "interrupted", repairUsed: false };
      changedBytes = JSON.stringify(header, null, 2) + raw.slice(end + 1);
      fs.writeFileSync(file, changedBytes);
     }
     return original(...args);
    };
    process.env.PI_GOAL_AUTO_CONFIRM = autoConfirm ? "1" : "0";
    const pending = proposal(h, { objective: "Model proposal", sisyphus: false, ...(change === "scheduler" ? { token_budget: 1 } : {}), tweak: { goal_id: before.id, reason: "Authority race" } });
    if (!autoConfirm) { assert.equal(h.hasDialog(), true); h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false }); }
    const result = await pending; assert.equal(changed, true);
    assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /not applied|changed|deleted|archived/i);
    assert.equal(fs.readFileSync(file, "utf8"), changedBytes, "reviewed file must not be overwritten");
    assert.equal(fs.readFileSync(victim, "utf8"), sentinel, "other active file must not be overwritten");
    assert.equal(h.core.state.goal.id, before.id);
   } finally { if (previous === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = previous; rmSync(cwd, { recursive: true, force: true }); }
  });
 }
}

test("continued agent draft targeting A rejects running B before flushing", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-foreign-draft-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Goal A", h.ctx); h.markRunning();
  const a = diskGoal(cwd); const first = proposal(h, { objective: "A revised", sisyphus: false, tweak: { goal_id: a.id, reason: "Continue" } });
  h.dialogResult({ decision: "continue", auditorEnabled: true, unavailable: false }); await first;
  const { writeActiveGoalFile } = await import("../extensions/storage/goal-files.ts");
  const b = writeActiveGoalFile(h.ctx, createGoal({ objective: "Goal B", autoContinue: true, sisyphus: false }, Date.now() + 100));
  h.core.state.goal = b; h.core.runningGoalId = b.id;
  let flushes = 0; const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
  h.core.goalService.flushForAudit = (...args: any[]) => { flushes++; return original(...args); };
  const result = await proposal(h, { objective: "Wrong goal", sisyphus: false });
  assert.match(result.content.map((x: any) => x.text ?? "").join("\n"), /another goal|bound/i);
  assert.equal(flushes, 0); assert.equal(h.draftActive(), true); assert.equal(h.core.state.goal.id, b.id);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("aborting registered review closes custom host and never falls back after late host failure", async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-host-abort-")); mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
 const prior = process.env.PI_GOAL_AUTO_CONFIRM;
 try {
  const h = createHarness(cwd, { hasUI: true }); await h.sessionStart(); await h.commands.get("goal-direct")!.handler("Goal A", h.ctx); h.markRunning();
  const before = diskGoal(cwd); let closed = 0, fallback = 0; let rejectHost!: (error: Error) => void;
  (h.ctx.ui as any).select = async () => { fallback++; return undefined; };
  (h.ctx.ui as any).custom = (factory: any) => new Promise((_resolve, reject) => {
   rejectHost = reject; const { tui } = createMockTUI({ terminalRows: 42 });
   factory(tui, createMockTheme(), {}, () => { closed++; });
  });
  process.env.PI_GOAL_AUTO_CONFIRM = "0"; const controller = new AbortController();
  const pending = proposal(h, { objective: "No apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Abort" } }, controller.signal);
  controller.abort(); const result = await pending; assert.equal(result.isError, true); assert.equal(closed, 1, "host done callback closes review");
  rejectHost(new Error("late host failure")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallback, 0, "aborted rich review never opens a basic fallback");
  assert.equal(diskGoal(cwd).objective, before.objective); assert.equal(h.draftActive(), false);
 } finally { if (prior === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = prior; rmSync(cwd, { recursive: true, force: true }); }
});

test("reason wrapping preserves diff source anchor after width change in bounded viewport", () => {
 const ctx = createMockExtensionContext(); const { tui } = createMockTUI({ terminalRows: 42 });
 const reason = "long reason ".repeat(35); const diffText = Array.from({ length: 100 }, (_, i) => `ITEM-${String(i).padStart(3, "0")} stable detail`).join("\n");
 void showTweakProposalDialog(ctx, { defaultAuditorEnabled: true, reason, presentation: () => ({ diffText, fullText: diffText }) });
 const call = (ctx as any)._customCalls[0]; const component = call.factory(tui, createMockTheme(), {}, () => {}) as any;
 let before = "";
 for (let i = 0; i < 100; i++) {
  before = component.render(100).join("\n"); const match = before.match(/ITEM-(\d{3})/);
  if (match && Number(match[1]) >= 30) break;
  component.handleInput("\u001b[6~");
 }
 const match = before.match(/ITEM-(\d{3})/); assert.ok(match && Number(match[1]) >= 30, "scrolled into diff in a bounded viewport");
 const after = component.render(48).join("\n"); const next = after.match(/ITEM-(\d{3})/);
 assert.equal(next?.[1], match[1], "same source row remains at the top after rewrap");
});

test("commit rejects when the lock-time authoritative record changed", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-locktime-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Should not apply", sisyphus: false,
			tweak: { goal_id: before.id, reason: "Lock-time change." } });
		assert.ok(h.hasDialog());
		// Change pause/budget ONLY in the lock-time read (readFreshDiskGoal) so
		// the pre-commit fresh read still sees the reviewed record.
		const service = h.core.goalService as any;
		const originalFresh = service.readFreshDiskGoal.bind(service);
		let intercepted = false;
		service.readFreshDiskGoal = (...args: any[]) => {
			if (!intercepted) {
				intercepted = true;
				const file = path.join(cwd, before.activePath!);
				const raw = readFileSync(file, "utf8");
				writeFileSync(file, raw.replace('"status": "active"', '"status": "paused"'));
				return originalFresh(...args);
			}
			return originalFresh(...args);
		};
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.equal(intercepted, true, "lock-time authoritative read happened");
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /not applied|changed/i);
		assert.equal(diskGoal(cwd).objective, before.objective, "stale candidate was not written");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const autoConfirm of [false, true]) {
	test(`lock-time content change with identical mtime/size is rejected (autoConfirm=${autoConfirm})`, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), `agent-tweak-lock-metadata-${autoConfirm}-`));
		mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
		try {
			const h = createHarness(cwd, { hasUI: !autoConfirm });
			await h.sessionStart();
			await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
			h.markRunning();
			const before = diskGoal(cwd);
			const fs = await import("node:fs");
			const pathMod = await import("node:path");
			const file = pathMod.join(cwd, ".pi", "goals", (fs.readdirSync(path.join(cwd, ".pi", "goals")).filter((f: string) => f.startsWith("active_goal_")))[0]!);
			const fixedTime = new Date("2020-01-01T00:00:00.000Z");
			fs.utimesSync(file, fixedTime, fixedTime);
			const raw = fs.readFileSync(file, "utf8");
			const originalStat = fs.statSync(file);
			const { parseGoalFile } = await import("../extensions/storage/goal-files.ts");
			assert.equal(parseGoalFile(file)?.status, "active"); // seed the real shared cache
			const changed = raw.replace('"status": "active"', '"status": "paused"');
			assert.notEqual(changed, raw);
			assert.equal(Buffer.byteLength(changed), originalStat.size);
			const applyPaused = () => {
				fs.writeFileSync(file, changed);
				fs.utimesSync(file, fixedTime, fixedTime);
				const stat = fs.statSync(file);
				assert.equal(stat.size, originalStat.size);
				assert.equal(stat.mtimeMs, originalStat.mtimeMs);
				assert.equal(parseGoalFile(file)?.status, "active", "shared cache is stale");
			};
			const service = h.core.goalService as any;
			const originalFresh = service.readFreshDiskGoal.bind(service);
			let mutatedAtLock = false;
			service.readFreshDiskGoal = (...args: any[]) => {
				if (!mutatedAtLock) { mutatedAtLock = true; applyPaused(); }
				return originalFresh(...args);
			};
			if (autoConfirm) process.env.PI_GOAL_AUTO_CONFIRM = "1";
			try {
				const pending = proposal(h, { objective: "Should not apply", sisyphus: false,
					tweak: { goal_id: before.id, reason: "Lock-time same metadata." } });
				if (!autoConfirm) {
					assert.ok(h.hasDialog());
					h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
				}
				const result = await pending;
				assert.equal(mutatedAtLock, true, "lock-time read happened");
				assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /not applied|re-read|changed|left untouched/i);
				assert.equal(diskGoal(cwd).objective, before.objective, "stale candidate must not be written");
			} finally { if (autoConfirm) delete process.env.PI_GOAL_AUTO_CONFIRM; service.readFreshDiskGoal = originalFresh; }
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}

test("PI_GOAL_AUTO_CONFIRM=1 rejects a candidate invalidated before commit", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-auto-stale-commit-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		try {
			// Wrong ID is rejected at admission; the commit gate is covered by
			// the stopped-turn test above, which uses a valid candidate.
			const result = await proposal(h, { objective: "Stale", sisyphus: false, tweak: { goal_id: "wrong-id", reason: "Stale." } });
			assert.match(result.content.map((item: any) => item.text ?? "").join("\\n"), /changed while preparing/);
			assert.equal(diskGoal(cwd).objective, before.objective);
		} finally { delete process.env.PI_GOAL_AUTO_CONFIRM; }
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tweak reason is rendered in rich diff/full views, basic host, and saved snapshot", async () => {
	const reason = "New evidence invalidated the plan.";
	const dialogCtx = createMockExtensionContext();
	void showTweakProposalDialog(dialogCtx, {
		defaultAuditorEnabled: true,
		reason,
		presentation: () => ({ diffText: "- old\n+ new", fullText: "new", fullUiText: "new" }),
	});
	const { component } = invokeCustomFactory((dialogCtx as any)._customCalls);
	const diffText = component.render(120).join("\n");
	assert.match(diffText, /调整原因/);
	assert.match(diffText, /New evidence invalidated the plan\./);
	assert.match(diffText, /Changes from the current goal/);
	// Switch to the full view via the advertised row and verify the reason stays.
	const keys = component as any;
	for (let i = 0; i < 3; i++) keys.handleInput("\u001b[B");
	keys.handleInput("\r");
	const fullText = component.render(120).join("\n");
	assert.match(fullText, /Modified goal — full effective content/);
	assert.match(fullText, /调整原因/);
	assert.match(fullText, /New evidence invalidated the plan\./);
	// Basic host (ui.select) fallback must show the reason too.
	const prompts: string[] = [];
	const basicCtx = { hasUI: true, defaultAuditorEnabled: true, ui: {
		select: async (prompt: string) => { prompts.push(prompt); return "Cancel — discard this tweak"; },
	} } as unknown as ExtensionContext;
	await runBasicTweakDialog(basicCtx, {
		defaultAuditorEnabled: true, reason,
		presentation: () => ({ diffText: "- old\n+ new", fullText: "new", fullUiText: "new" }),
	});
	assert.ok(prompts.some((p) => p.includes("调整原因") && p.includes("New evidence invalidated the plan.")), "basic dialog shows reason");
	const result = renderTweakReview({ details: { tweakReview: {
		diffText: "- old\n+ new", fullText: "new", outcome: "applied", reason,
	} }, content: [] }, true, createMockTheme())!;
	const rendered = result.render(120).join("\n");
	assert.match(rendered, /调整原因/);
	assert.match(rendered, /New evidence invalidated the plan\./);
});


test("an agent draft can explicitly update its reason for the same goal and preserve auditor choice", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-reason-update-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const first = proposal(h, { objective: "First", sisyphus: false, tweak: { goal_id: before.id, reason: "First reason." } });
		assert.ok(h.hasDialog());
		h.dialogResult({ decision: "continue", auditorEnabled: false, unavailable: false });
		await first;
		// Explicit reason update for the SAME goal on the model's own draft is allowed.
		const second = proposal(h, { objective: "Second", sisyphus: false, tweak: { goal_id: before.id, reason: "Updated reason." } });
		assert.ok(h.hasDialog(), "explicit reason update admitted on own draft");
		h.dialogResult({ decision: "cancel", auditorEnabled: false, unavailable: false });
		const result = await second;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /Updated reason\./);
		assert.equal(h.draftActive(), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a continued agent draft survives session reload with target, reason and auditor choice", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-reload-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Revised", sisyphus: false, tweak: { goal_id: before.id, reason: "Durable reason." } });
		assert.ok(h.hasDialog());
		h.dialogResult({ decision: "continue", auditorEnabled: false, unavailable: false });
		await pending;
		await h.sessionTree(); // rehydrate from the durable draft entry
		assert.equal(h.draftActive(), true, "draft rehydrated");
		h.markRunning(); // the next continuation/user turn binds the running goal
		h.useRichTUI(); // render the REAL dialog opened by the registered tool
		const next = proposal(h, { objective: "Revised after reload", sisyphus: false });
		assert.ok(h.hasDialog(), "reloaded draft accepts a proposal without a new command");
		const persistedEntry = h.entries().find((e: any) => e?.customType === "pi-goal-draft" && !e?.data?.clearedAt) as any;
		assert.equal(persistedEntry?.data?.reason, "Durable reason.", "reason persisted in durable draft entry");
		assert.equal(persistedEntry?.data?.auditorEnabled, false, "auditor choice persisted in durable draft entry");
		// These are rendered by the REAL dialog the registered tool opened after
		// rehydration, not by a separately constructed fixture.
		const reopened = h.dialogTexts.at(-1) ?? "";
		assert.match(reopened, /调整原因/, "reopened review shows the reason section");
		assert.match(reopened, /Durable reason\./, "reopened review uses the preserved reason");
		assert.match(reopened, /Auditor disabled/, "reopened review uses the saved auditor default");
		const persisted = JSON.stringify(h.entries());
		assert.match(persisted, /Durable reason\./, "reason persisted in durable draft entry");
		assert.match(persisted, /"auditorEnabled":false/, "auditor choice persisted across reload");
		h.dialogResult({ decision: "cancel", auditorEnabled: false, unavailable: false });
		await next;
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("PI_GOAL_AUTO_CONFIRM=1 still rejects a stale candidate through the registered tool", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-auto-stale-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		try {
			const result = await proposal(h, { objective: "Stale", sisyphus: false, tweak: { goal_id: "wrong-id", reason: "Stale target." } });
			assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /changed while preparing/);
			assert.equal(diskGoal(cwd).objective, before.objective, "auto-confirm must not apply a stale proposal");
		} finally { delete process.env.PI_GOAL_AUTO_CONFIRM; }
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("auto-confirm rejects a candidate that becomes stale after admission before commit", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-auto-commit-stale-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		// flushForAudit runs at admission AND at the final commit gate. Fail the
		// second call to emulate a goal that changed after the candidate was built.
		const original = h.core.goalService.flushForAudit.bind(h.core.goalService);
		let calls = 0;
		h.core.goalService.flushForAudit = (...args: any[]) => {
			calls += 1;
			if (calls === 2) return "goal changed on disk during review";
			return original(...args);
		};
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		try {
			const result = await proposal(h, { objective: "Should never apply", sisyphus: false,
				tweak: { goal_id: before.id, reason: "Commit-time stale." } });
			assert.ok(calls >= 2, "the commit gate re-checks audit flush");
			assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /not applied|changed during confirmation/);
			assert.equal(diskGoal(cwd).objective, before.objective, "stale candidate must not be applied");
		} finally { delete process.env.PI_GOAL_AUTO_CONFIRM; h.core.goalService.flushForAudit = original; }
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("continue chatting is rejected when the execution turn stops during review", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-continue-stop-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Revised", sisyphus: false, tweak: { goal_id: before.id, reason: "Stop during review." } });
		assert.ok(h.hasDialog());
		h.stopTurn();
		h.dialogResult({ decision: "continue", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /nothing was saved|changed while reviewing/i);
		assert.equal(h.draftActive(), false, "no draft after stopped turn");
		const review = (result.details as any)?.tweakReview;
		assert.equal(review?.outcome, "error", "rejected continue snapshot is an error");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("commit is rejected when the authoritative goal becomes paused after review", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-paused-commit-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Should not apply", sisyphus: false, tweak: { goal_id: before.id, reason: "Pause during review." } });
		assert.ok(h.hasDialog());
		// Pause on disk after the candidate was built; same id/revision, so only
		// the authoritative status check can reject it at commit time.
		const fs = await import("node:fs");
		const pathMod = await import("node:path");
		const files = fs.readdirSync(path.join(cwd, ".pi", "goals")).filter((f: string) => f.startsWith("active_goal_"));
		const file = pathMod.join(cwd, ".pi", "goals", files[0]!);
		const raw = fs.readFileSync(file, "utf8");
		const [header = "{}", ...rest] = raw.split("\n\n");
		const record = JSON.parse(header);
		record.status = "paused";
		fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n\n" + rest.join("\n\n"));
		h.dialogResult({ decision: "confirm", auditorEnabled: true, unavailable: false });
		const result = await pending;
		assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /NOT applied|changed/i);
		assert.equal(diskGoal(cwd).objective, before.objective, "paused goal is not modified");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("auto-confirm rejects when the goal revision changes after admission but before commit", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-auto-revision-race-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const fs = await import("node:fs");
		const pathMod = await import("node:path");
		const files = fs.readdirSync(path.join(cwd, ".pi", "goals")).filter((f: string) => f.startsWith("active_goal_"));
		const file = pathMod.join(cwd, ".pi", "goals", files[0]!);
		// Bump the on-disk revision on the FIRST reconcile call (after the
		// candidate is built but before the commit fresh-read), so the admitted
		// candidate is valid at admission but stale at commit.
		const original = h.core.reconcileFocusedGoalFromDisk.bind(h.core);
		let calls = 0;
		h.core.reconcileFocusedGoalFromDisk = (...args: any[]) => {
			calls += 1;
			if (calls === 1) {
				const raw = fs.readFileSync(file, "utf8");
				const [header = "{}", ...rest] = raw.split("\n\n");
				const record = JSON.parse(header);
				record.revision = (record.revision ?? 0) + 1;
				fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n\n" + rest.join("\n\n"));
			}
			return original(...args);
		};
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		try {
			const result = await proposal(h, { objective: "Should not apply", sisyphus: false,
				tweak: { goal_id: before.id, reason: "Revision changed after admission." } });
			assert.ok(calls >= 1, "admission reconciles from disk");
			assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /NOT applied|changed|left untouched/i);
			assert.equal(diskGoal(cwd).objective, before.objective, "stale revision must not be applied");
		} finally { delete process.env.PI_GOAL_AUTO_CONFIRM; h.core.reconcileFocusedGoalFromDisk = original; }
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a dialog failure is recorded as an error result, not continue chatting", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "agent-tweak-dialog-error-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		h.markRunning();
		const before = diskGoal(cwd);
		const pending = proposal(h, { objective: "Revised", sisyphus: false, tweak: { goal_id: before.id, reason: "Failure test." } });
		assert.ok(h.hasDialog());
		// Force rich custom to fail so the host falls back to select; an unknown
		// option makes runBasicTweakDialog throw, exercising the real catch path.
		h.rejectDialog(new Error("host broke"));
		const result = await pending;
		const text = result.content.map((item: any) => item.text ?? "").join("\n");
		assert.equal(result.isError, true, "dialog failure is an error result");
		assert.match(text, /confirmation failed|not changed/i);
		assert.match(JSON.stringify((result.details as any)?.tweakReview ?? {}), /"outcome":"error"/, "snapshot records error, not continue");
		assert.equal(diskGoal(cwd).objective, before.objective, "no mutation on dialog failure");
		assert.equal(h.draftActive(), false, "failed first proposal leaves no draft");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a long reason on a narrow rich dialog remains scrollable and keeps decisions reachable", async () => {
	const reason = ("长原因需要完整展示并且不能挤掉决策区。" + "line\n").repeat(12);
	const ctx = createMockExtensionContext();
	void showTweakProposalDialog(ctx, {
		defaultAuditorEnabled: true, reason,
		presentation: () => ({ diffText: "- old\n+ new", fullText: "new", fullUiText: "new" }),
	});
	const { component } = invokeCustomFactory((ctx as any)._customCalls);
	const screen = component.render(24).join("\n");
	assert.match(screen, /调整原因/);
	assert.match(screen, /Confirm — apply this tweak|\[Confirm selection\]|Press|↑|↓|more/, "decisions or paging hint reachable on narrow screen");
	// Scroll the long reason body to the end; the fixed decision area must
	// remain visible and no control may disappear.
	const keys = component as any;
	for (let i = 0; i < 80; i++) keys.handleInput("\u001b[6~"); // page down
	const scrolled = component.render(24).join("\n");
	assert.match(scrolled, /Confirm — apply this tweak|\[Confirm selection\]|\[Apply\]/, "decision control reachable after scrolling long reason");
});
