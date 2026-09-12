/**
 * Workspace change manifest — baseline lifecycle.
 *
 * The baseline must disappear exactly when a goal reaches a terminal state
 * (approved completion, archive, clear) and must survive a rejected or failed
 * audit so a retry measures the same window. Orphaned baselines (no goal record)
 * are swept by the existing recovery path, with a backup copy first.
 */

import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import {
	changeBaselinePath,
	listBaselineGoalIds,
	writeChangeBaselineIfAbsent,
	type ChangeBaseline,
} from "../extensions/goal-change-baseline.ts";
import { runRecoveryReport, runRecoveryRepair } from "../extensions/goal-recovery.ts";

function createHarness(options: {
	cwd: string;
	sessionEntries: unknown[];
	hasUI?: boolean;
	confirmAnswer?: boolean;
	runCompletionAuditor?: (...args: any[]) => Promise<any>;
}) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: options.hasUI ?? false,
	};
	const notifications: string[] = [];
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? false,
		sessionManager: {
			getBranch: () => options.sessionEntries,
			getCwd: () => options.cwd,
			getSessionId: () => "baseline-lifecycle-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => options.confirmAnswer ?? false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, { runCompletionAuditor: options.runCompletionAuditor });
	return {
		handlers,
		commands,
		tools,
		ctx,
		notifications,
		get core() { return (pi as unknown as { _goalCore: any })._goalCore; },
	};
}

function makeFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-baseline-lifecycle-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal(
		{ objective: "=== Goal ===\nObjective: Baseline lifecycle", autoContinue: true, sisyphus: false },
		Date.UTC(2026, 8, 13, 9, 0, 0),
	);
	const written = writeActiveGoalFile({ cwd }, goal);
	const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
	return {
		cwd,
		goal: written,
		sessionEntries,
		cleanup: () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ } },
	};
}

function seedBaseline(cwd: string, goalId: string): void {
	const baseline: ChangeBaseline = {
		version: 1,
		goalId,
		capturedAt: "2026-09-13T01:00:00.000Z",
		reason: "turn_start",
		truncated: false,
		diagnostics: [],
		repos: [],
	};
	assert.equal(writeChangeBaselineIfAbsent({ cwd }, baseline), true, "the sidecar is seeded");
}

function hasBaseline(cwd: string, goalId: string): boolean {
	return existsSync(changeBaselinePath({ cwd }, goalId));
}

async function start(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, h.ctx);
}

const approved = { approved: true, disapproved: false, output: "ok" };
const disapproved = { approved: false, disapproved: true, output: "nope", error: undefined };

test("approved completion deletes the baseline", async () => {
	const f = makeFixture();
	try {
		seedBaseline(f.cwd, f.goal.id);
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () => approved });
		await start(h);
		const update = h.tools.get("update_goal")!;
		await (update.execute as any)("u1", { status: "complete" }, undefined, undefined, h.ctx);
		assert.equal(hasBaseline(f.cwd, f.goal.id), false, "a committed completion removes the window baseline");
		assert.deepEqual(listBaselineGoalIds({ cwd: f.cwd }), []);
	} finally {
		f.cleanup();
	}
});

test("rejected completion keeps the baseline for a retry", async () => {
	const f = makeFixture();
	try {
		seedBaseline(f.cwd, f.goal.id);
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () => disapproved });
		await start(h);
		const update = h.tools.get("update_goal")!;
		await (update.execute as any)("u2", { status: "complete" }, undefined, undefined, h.ctx);
		assert.equal(hasBaseline(f.cwd, f.goal.id), true, "a rejected audit must not lose the window origin");
		assert.deepEqual(listBaselineGoalIds({ cwd: f.cwd }), [f.goal.id]);
	} finally {
		f.cleanup();
	}
});

test("clearing a goal deletes the baseline after archival", async () => {
	const f = makeFixture();
	try {
		seedBaseline(f.cwd, f.goal.id);
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true, confirmAnswer: true });
		await start(h);
		const clear = h.commands.get("goal-clear")!;
		await clear.handler("", h.ctx);
		assert.equal(hasBaseline(f.cwd, f.goal.id), false, "clearing is terminal for the baseline");
		assert.deepEqual(listBaselineGoalIds({ cwd: f.cwd }), []);
	} finally {
		f.cleanup();
	}
});

test("pausing a goal keeps the baseline", async () => {
	const f = makeFixture();
	try {
		seedBaseline(f.cwd, f.goal.id);
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const pause = h.commands.get("goal-pause")!;
		await pause.handler("", h.ctx);
		assert.equal(hasBaseline(f.cwd, f.goal.id), true, "a paused goal can resume inside the same window");
	} finally {
		f.cleanup();
	}
});

test("recovery reports orphaned baselines and repair removes them with a backup", async () => {
	const f = makeFixture();
	try {
		seedBaseline(f.cwd, f.goal.id); // live goal: not orphaned
		seedBaseline(f.cwd, "ghost-goal"); // no goal record at all

		const report = runRecoveryReport({ cwd: f.cwd });
		assert.deepEqual(report.orphanedBaselines, ["ghost-goal"]);
		assert.equal(report.healthy, false, "stale baseline state is reported as an issue");

		const applied = await runRecoveryRepair({ cwd: f.cwd }, report, async () => true);
		assert.equal(applied.confirmed, true);
		assert.ok(applied.applied.some((line) => line.includes("ghost-goal")), "the orphan removal is reported");
		assert.equal(hasBaseline(f.cwd, "ghost-goal"), false);
		assert.equal(hasBaseline(f.cwd, f.goal.id), true, "a live goal's baseline is never touched");
		assert.ok(applied.backupDir, "repair writes a backup directory");
		assert.deepEqual(readdirSync(applied.backupDir!), ["baseline-ghost-goal.json"], "the removed baseline is recoverable");
		assert.deepEqual(runRecoveryReport({ cwd: f.cwd }).orphanedBaselines, []);
	} finally {
		f.cleanup();
	}
});

test("recovery repair declines cleanly and never touches baselines on refusal", async () => {
	const f = makeFixture();
	try {
		seedBaseline(f.cwd, "ghost-goal");
		const report = runRecoveryReport({ cwd: f.cwd });
		const applied = await runRecoveryRepair({ cwd: f.cwd }, report, async () => false);
		assert.equal(applied.confirmed, false);
		assert.deepEqual(applied.applied, []);
		assert.equal(hasBaseline(f.cwd, "ghost-goal"), true, "nothing is removed without confirmation");
	} finally {
		f.cleanup();
	}
});
