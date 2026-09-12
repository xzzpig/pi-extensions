/**
 * Escape belongs to the open dialog (foreign `ctx.ui.*` spans).
 *
 * pi core (>= 0.84.4) wraps every blocking extension UI call in the OUTERMOST
 * span and dispatches `ui_prompt_start` / `ui_prompt_end`. pi-tui runs
 * `onTerminalInput` listeners BEFORE the focused component, so without the
 * `core.uiPromptDepth` guard an Escape meant for another extension's dialog
 * (select / confirm / input / editor / custom without `overlay: true`) would
 * abort a running completion audit, or pause the goal and abort the current
 * turn. These tests drive the REAL extension through the REAL events,
 * terminal-input handler, audit flow, and escape dialog.
 *
 * Spec: specs/2026-09-12-escape-foreign-ui-prompt-guard/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../extensions/goal.ts";
import { runGoalCompletionFlow } from "../extensions/goal-completion.ts";
import type { GoalAuditorResult, GoalCompletionAuditorArgs } from "../extensions/goal-auditor.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { createMockTheme, createMockTUI } from "./tui-test-utils.ts";

const FIXTURE_GOAL = readFileSync(new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url), "utf8");
const ESCAPE = "\x1b";

interface Harness {
	handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	notifyCalls: string[];
	ctx: ExtensionContext;
	core: GoalCore;
	terminalInput: (data: string) => unknown;
	/** Dispatches a core ui_prompt event the way the runner does (via handlers). */
	fireStart: () => Promise<void>;
	fireEnd: () => Promise<void>;
	overlayDone: () => void;
	overlayShown: () => boolean;
	auditorStarted: () => boolean;
	resolveAuditor: (result: GoalAuditorResult) => void;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Polls a predicate while the asynchronous completion flow settles. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await flush();
	}
	return predicate();
}

function createHarness(cwd: string): Harness {
	const handlers: Harness["handlers"] = {};
	const notifyCalls: string[] = [];
	let terminalInputHandler: ((data: string) => unknown) | null = null;
	let resolveOverlay: (() => void) | null = null;
	let overlayShown = false;
	let auditorStarted = false;
	let settleAuditor: ((result: GoalAuditorResult) => void) | null = null;

	// A slow auditor the test resolves explicitly; it mirrors the real
	// delegation by settling with the terminal "Auditor aborted." error when
	// Escape aborts the dedicated audit AbortController.
	const runCompletionAuditor = (args: GoalCompletionAuditorArgs): Promise<GoalAuditorResult> =>
		new Promise<GoalAuditorResult>((resolve) => {
			auditorStarted = true;
			settleAuditor = resolve;
			args.signal?.addEventListener("abort", () => {
				resolve({ approved: false, disapproved: true, output: "", error: "Auditor aborted." });
			}, { once: true });
		});

	const tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }> = {};
	const mockPi = {
		registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { tools[def.name] = def; },
		registerCommand: () => {},
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers[event] = handler as Harness["handlers"][string];
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
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
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => false,
		hasPendingMessages: () => true,
		abort: () => {},
		ui: {
			notify: (message: string) => { notifyCalls.push(message); },
			onTerminalInput: (handler: (data: string) => unknown) => {
				terminalInputHandler = handler;
				return () => { terminalInputHandler = null; };
			},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingVisible: () => {},
			custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
				overlayShown = true;
				resolveOverlay = () => resolve({ decision: "confirm" } as never);
				factory(createMockTUI().tui, createMockTheme(), null, resolveOverlay);
			}),
			select: async () => null,
			confirm: async () => true,
			input: async () => undefined,
		},
	} as unknown as ExtensionContext;

	piGoalExtension(mockPi as never, { runCompletionAuditor });
	const core = (mockPi as unknown as { _goalCore: GoalCore })._goalCore;

	return {
		handlers,
		notifyCalls,
		ctx,
		core,
		terminalInput: (data: string) => terminalInputHandler ? terminalInputHandler(data) : undefined,
		fireStart: async () => { await handlers["ui_prompt_start"]?.({}, ctx); },
		fireEnd: async () => { await handlers["ui_prompt_end"]?.({}, ctx); },
		overlayDone: () => resolveOverlay?.(),
		overlayShown: () => overlayShown,
		auditorStarted: () => auditorStarted,
		resolveAuditor: (result: GoalAuditorResult) => settleAuditor?.(result),
	};
}

/**
 * Fixture goal file. The shared fixture ships a task list with a pending subtask
 * and `blockCompletion: true`, which the completion gate rejects; the audit test
 * needs a goal that can actually reach the auditor, so it writes a task-less
 * variant of the same goal.
 */
function fixtureGoalBody(withTasks: boolean): string {
	if (withTasks) return FIXTURE_GOAL;
	return JSON.stringify({
		version: 3,
		id: "golden_fixture_goal",
		objective: "Golden fixture goal objective",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-08-03T09:00:00.000Z",
		updatedAt: "2026-08-03T10:00:00.000Z",
		activePath: ".pi/goals/active_goal_fixture.md",
		verificationContract: "Run npm test (0 failures).",
	}, null, 2) + "\n";
}

function fixtureCwd(opts: { withTasks?: boolean } = {}): { cwd: string; goal: GoalRecord } {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-ui-prompt-escape-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), fixtureGoalBody(opts.withTasks ?? true));
	const parsed = createGoal({ objective: "Golden fixture goal objective", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 3, 9, 0, 0));
	return { cwd, goal: { ...parsed, id: "golden_fixture_goal" } };
}

function sessionEntriesFor(goal: GoalRecord): unknown[] {
	const stateEntry: GoalStateEntry = {
		version: 3,
		goal: {
			...goal,
			activePath: ".pi/goals/active_goal_fixture.md",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: undefined,
			verificationContract: undefined,
		},
	};
	return [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];
}

async function startSession(h: Harness, goal: GoalRecord): Promise<void> {
	const ss = h.handlers["session_start"];
	assert.ok(ss, "session_start handler must be registered");
	await ss({ reason: "start" }, {
		...h.ctx,
		sessionManager: { ...h.ctx.sessionManager, getBranch: () => sessionEntriesFor(goal) },
	} as unknown as ExtensionContext);
}

function pauseCount(h: Harness): number {
	return h.notifyCalls.filter((m) => m === "Goal paused.").length;
}

test("Escape is yielded to a foreign ui_prompt span, then pauses the goal again after it closes", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	await startSession(h, goal);

	await h.fireStart();
	assert.equal(h.core.uiPromptDepth, 1, "ui_prompt_start opens one span");

	// pi-tui runs input listeners first: the handler must yield, not consume.
	const yielded = h.terminalInput(ESCAPE);
	assert.equal(yielded, undefined, "Escape must pass through to the foreign dialog");
	assert.equal(pauseCount(h), 0, "the goal must not pause while a foreign dialog owns Escape");

	await h.fireEnd();
	assert.equal(h.core.uiPromptDepth, 0, "ui_prompt_end closes the span");

	const afterClose = h.terminalInput(ESCAPE);
	assert.equal(afterClose, undefined, "Escape on a live goal passes back to pi (stops the turn)");
	assert.equal(pauseCount(h), 1, "Escape after the dialog closes pauses the goal again");
});

test("Escape during an audit does not abort it while a foreign dialog is open; it does after it closes", async () => {
	const { cwd, goal } = fixtureCwd({ withTasks: false });
	const h = createHarness(cwd);
	await startSession(h, goal);

	let flowResult: unknown = null;
	const flow = runGoalCompletionFlow(h.core, h.ctx, "fixture claim").then((result) => {
		flowResult = result;
		return result;
	});
	assert.ok(
		await waitFor(() => h.auditorStarted()),
		`the completion flow must have started the audit (result: ${JSON.stringify(flowResult)})`,
	);
	assert.ok(h.core.auditProgress, "auditProgress marks a running audit");
	assert.ok(h.core.auditAbortController, "the audit owns an AbortController");

	// Foreign dialog open: Escape closes the dialog, the audit keeps running.
	await h.fireStart();
	const duringDialog = h.terminalInput(ESCAPE);
	assert.equal(duringDialog, undefined, "Escape is yielded while the dialog is open");
	assert.equal(h.core.auditAborted, false, "the audit must not be marked aborted");
	assert.ok(h.core.auditProgress, "the audit keeps its progress state");
	assert.equal(h.core.auditAbortController?.signal.aborted, false, "the audit controller must not abort");

	// Dialog closed: Escape now belongs to the goal and aborts the audit.
	await h.fireEnd();
	const afterClose = h.terminalInput(ESCAPE);
	assert.deepEqual(afterClose, { consume: true }, "Escape is consumed so pi does not also abort the tool run");
	assert.equal(h.core.auditAborted, true, "the audit is marked aborted");
	assert.equal(h.core.auditAbortController, null, "the audit controller is cleared");

	// The aborted audit reaches the Escape dialog; close it so the flow settles.
	assert.ok(await waitFor(() => h.overlayShown()), "the escape dialog opens after an aborted audit");
	h.overlayDone();
	await flow;
});

test("stray ui_prompt_end events never underflow the depth and re-enable Escape", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	await startSession(h, goal);

	// Two unmatched ends before a real span: without clamping the counter would
	// sit at -2 and the following start would resolve to -1, leaving Escape
	// unblocked while a real dialog is open.
	await h.fireEnd();
	await h.fireEnd();
	assert.equal(h.core.uiPromptDepth, 0, "an unmatched end never drives the depth negative");

	await h.fireStart();
	assert.equal(h.core.uiPromptDepth, 1, "a real span after stray ends is counted exactly once");
	h.terminalInput(ESCAPE);
	assert.equal(pauseCount(h), 0, "Escape stays blocked while the real dialog is open");

	await h.fireEnd();
	h.terminalInput(ESCAPE);
	assert.equal(pauseCount(h), 1, "Escape works again once the real span closes");
});

test("session_start clears a leaked ui_prompt span so Escape is never permanently trapped", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	await startSession(h, goal);

	// A span that never closed (host bug, or a dialog torn down by the session).
	await h.fireStart();
	assert.equal(h.core.uiPromptDepth, 1, "the leaked span is tracked");
	h.terminalInput(ESCAPE);
	assert.equal(pauseCount(h), 0, "the leak blocks Escape in the current session");

	await startSession(h, goal);
	assert.equal(h.core.uiPromptDepth, 0, "the new session resets the span depth");

	const afterReset = h.terminalInput(ESCAPE);
	assert.equal(afterReset, undefined, "Escape behaves normally again");
	assert.equal(pauseCount(h), 1, "the goal pauses again in the new session");
});

test("regression: with no dialog open Escape pauses the live goal and stops the turn", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	await startSession(h, goal);

	assert.equal(h.core.uiPromptDepth, 0, "no span is open");
	const result = h.terminalInput(ESCAPE);
	assert.equal(result, undefined, "Escape must pass back to pi so the current turn stops");
	assert.equal(pauseCount(h), 1, "the live goal pauses as before");
});
