/**
 * End-to-end regression coverage for /goal-tweak status persistence
 * (specs/2026-08-08-tweak-status-persistence, R1 / success criterion 3):
 * a completed task's status/evidence/completedAt must survive a task-list
 * tweak through the full draft → confirm → apply → disk → reload flow; a
 * tweak without a task list retains the current list unchanged; nested
 * subtask completion survives; currentTaskId survives only while its task
 * stays pending.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { parseGoalFile } from "../extensions/storage/goal-files.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { countTasks } from "../extensions/goal-task-tools.ts";

interface Harness {
	ctx: ExtensionContext;
	commands: Map<string, any>;
	tools: Map<string, any>;
	dialogResult(result: unknown): void;
	hasDialog: () => boolean;
	sessionStart(): Promise<void>;
}

function createHarness(cwd: string): Harness {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
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
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: true,
	};
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "tweak-status-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => new Promise((resolve) => { dialogResolve = resolve; hasDialogPending = true; }),
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return {
		ctx,
		commands,
		tools,
		dialogResult: (result: unknown) => { hasDialogPending = false; dialogResolve?.(result); },
		hasDialog: () => hasDialogPending,
		sessionStart: async () => { await handlers.get("session_start")?.({ reason: "start" }, ctx); },
	};
}

const CONFIRM_ANSWER = "Confirm — create this goal now";

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function diskGoal(cwd: string) {
	const files = activeGoalFiles(cwd);
	assert.equal(files.length, 1, "exactly one active goal expected");
	return parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!))!;
}

function proposalParams(objective: string, extra: Record<string, unknown> = {}) {
	return { objective, sisyphus: false, ...extra };
}

async function runProposal(h: Harness, params: Record<string, unknown>): Promise<any> {
	const proposal = h.tools.get("propose_goal_draft");
	assert.ok(proposal, "propose_goal_draft must be registered during a draft");
	return proposal.execute("draft-1", params, new AbortController().signal, undefined, h.ctx);
}

async function confirmDialog(h: Harness, pending: Promise<any>): Promise<void> {
	assert.ok(h.hasDialog(), "confirmation dialog must open");
	h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
	await pending;
}

async function callTaskTool(h: Harness, name: string, params: Record<string, unknown>): Promise<any> {
	const tool = h.tools.get(name);
	assert.ok(tool, `${name} must be registered`);
	return (tool.execute as any)(`call-${name}`, params, new AbortController().signal, undefined, h.ctx);
}

async function createGoalWithTasks(h: Harness, objective: string, tasks: Array<Record<string, unknown>>): Promise<void> {
	await h.commands.get("goal")!.handler(objective, h.ctx);
	await confirmDialog(h, runProposal(h, proposalParams(objective + "\nSuccess criteria: tests pass.", { tasks })));
	const goal = diskGoal(h.ctx.cwd);
	assert.ok(goal.taskList && countTasks(goal.taskList.tasks) === tasks.length, "goal created with the proposed task tree");
}

function newTmpDir(name: string): string {
	const cwd = mkdtempSync(path.join(tmpdir(), name));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	return cwd;
}

// ── R1: status/evidence/timestamps survive a task-list tweak (disk round-trip) ─

test("e2e: completed task status, evidence, and completedAt survive a task-list tweak through disk reload", async () => {
	const cwd = newTmpDir("tweak-status-complete-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "a", title: "Task A" },
			{ id: "b", title: "Task B" },
		]);

		// Complete task a via the real flow (with evidence), then start b.
		const complete = await callTaskTool(h, "update_goal_task", { task_id: "a", status: "complete", evidence: "verified-e2e" });
		assert.ok(JSON.stringify(complete.content).includes("a"), "complete result mentions the task");
		await callTaskTool(h, "update_goal_task", { task_id: "b", status: "start" });
		assert.equal(diskGoal(cwd).currentTaskId, "b", "currentTaskId set before the tweak");

		// Tweak: same ids + a new task c. The merge must keep a complete.
		await h.commands.get("goal-tweak")!.handler("Revise the plan", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Revised objective", {
			tasks: [
				{ id: "a", title: "Task A (retitled)" },
				{ id: "b", title: "Task B" },
				{ id: "c", title: "Task C" },
			],
		})));

		// Reload the persisted goal from disk.
		const goal = diskGoal(cwd);
		assert.ok(goal.objective.includes("Revised objective"), "objective updated by the tweak");
		const a = goal.taskList!.tasks.find((t) => t.id === "a")!;
		assert.equal(a.status, "complete", "completed status survives the tweak");
		assert.equal(a.evidence, "verified-e2e", "evidence survives the tweak");
		assert.ok(a.completedAt, "completedAt timestamp survives the tweak");
		assert.equal(a.title, "Task A (retitled)", "structural title comes from the incoming proposal");
		assert.equal(goal.taskList!.tasks.find((t) => t.id === "c")!.status, "pending", "new id starts pending");
		assert.equal(goal.taskList!.tasks.find((t) => t.id === "b")!.status, "pending", "pending task stays pending");
		assert.equal(goal.currentTaskId, "b", "currentTaskId survives while its task is still pending");
		assert.ok(readGoalLedger({ cwd }).events.some((e) => e.type === "task_list_set"), "task_list_set ledger event on the tweak");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("e2e: a tweak without a task list retains the current list unchanged (statuses included)", async () => {
	const cwd = newTmpDir("tweak-status-retain-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "a", title: "Task A" },
			{ id: "b", title: "Task B" },
		]);
		await callTaskTool(h, "update_goal_task", { task_id: "a", status: "complete", evidence: "kept" });
		await callTaskTool(h, "update_goal_task", { task_id: "b", status: "skipped", reason: "user direction" });

		// Tweak WITHOUT tasks in the proposal: the current list must be retained unchanged.
		await h.commands.get("goal-tweak")!.handler("Tighten the wording", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Tightened objective wording")));

		const goal = diskGoal(cwd);
		assert.ok(goal.objective.includes("Tightened"), "objective updated");
		const a = goal.taskList!.tasks.find((t) => t.id === "a")!;
		const b = goal.taskList!.tasks.find((t) => t.id === "b")!;
		assert.equal(a.status, "complete", "completed status retained without a task proposal");
		assert.equal(a.evidence, "kept", "evidence retained");
		assert.ok(a.completedAt, "completedAt retained");
		assert.equal(b.status, "skipped", "skipped status retained");
		assert.equal(b.skipReason, "user direction", "skip reason retained");
		assert.ok(b.skippedAt, "skippedAt retained");
		assert.equal(goal.taskList!.tasks.length, 2, "no tasks added or removed");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("e2e: subtask completion status survives a task-list tweak", async () => {
	const cwd = newTmpDir("tweak-status-subtask-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "p", title: "Parent" },
			{ id: "p1", title: "Child one", parent_id: "p" },
		]);
		await callTaskTool(h, "update_goal_task", { task_id: "p1", status: "complete", evidence: "child-done" });

		// Tweak proposing the same parent/subtask structure.
		await h.commands.get("goal-tweak")!.handler("Revise", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Revised objective", {
			tasks: [
				{ id: "p", title: "Parent" },
				{ id: "p1", title: "Child one (renamed)", parent_id: "p" },
			],
		})));

		const goal = diskGoal(cwd);
		const p1 = goal.taskList!.tasks.find((t) => t.id === "p")!.subtasks!.find((t) => t.id === "p1")!;
		assert.equal(p1.status, "complete", "subtask completion survives the tweak");
		assert.equal(p1.evidence, "child-done", "subtask evidence survives");
		assert.ok(p1.completedAt, "subtask completedAt survives");
		assert.equal(p1.title, "Child one (renamed)", "structural subtask title comes from the proposal");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("e2e: currentTaskId survives while its task stays pending and clears when removed", async () => {
	const cwd = newTmpDir("tweak-status-focus-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "x", title: "Task X" },
			{ id: "y", title: "Task Y" },
		]);
		await callTaskTool(h, "update_goal_task", { task_id: "x", status: "start" });
		assert.equal(diskGoal(cwd).currentTaskId, "x");

		// Tweak keeping x: focus survives.
		await h.commands.get("goal-tweak")!.handler("Keep the plan", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Kept objective", {
			tasks: [
				{ id: "x", title: "Task X" },
				{ id: "y", title: "Task Y" },
			],
		})));
		assert.equal(diskGoal(cwd).currentTaskId, "x", "currentTaskId survives when its task stays pending");

		// Tweak removing x: focus clears.
		await h.commands.get("goal-tweak")!.handler("Drop task X", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Dropped objective", {
			tasks: [
				{ id: "y", title: "Task Y" },
			],
		})));
		const goal = diskGoal(cwd);
		assert.equal(goal.currentTaskId, undefined, "currentTaskId clears when its task is removed by the tweak");
		assert.equal(goal.taskList!.tasks.find((t) => t.id === "x"), undefined, "removed task dropped");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
