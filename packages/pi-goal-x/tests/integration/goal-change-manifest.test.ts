/**
 * Integration: the change manifest end to end through the real extension —
 * turn_start baseline capture, audit injection of the real window, and the
 * `/goal-clear` rollback chain.
 *
 * Runs on a real git fixture and the real registered handlers/tools/commands
 * (mock pi, injected auditor), so it exercises the wiring the unit suites stub.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { listBaselineGoalIds } from "../../extensions/goal-change-baseline.ts";
import { gitAvailable, makeGitFixture, type GitFixture } from "../git-fixture.ts";

const skip = gitAvailable ? false : "git is not available";

interface HarnessOptions {
	cwd: string;
	sessionEntries: unknown[];
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	runCompletionAuditor?: (...args: any[]) => Promise<any>;
}

function createHarness(options: HarnessOptions) {
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
		hasUI: true,
	};
	const notifications: string[] = [];
	const ctx = {
		cwd: options.cwd,
		hasUI: true,
		sessionManager: {
			getBranch: () => options.sessionEntries,
			getCwd: () => options.cwd,
			getSessionId: () => "manifest-integration",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async (title: string, choices: string[]) =>
				options.select ? await options.select(title, choices) : undefined,
			confirm: async () => true,
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
		async start() {
			await handlers.get("session_start")?.({ reason: "start" }, ctx);
			await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, ctx);
		},
	};
}

function seedGoal(fixture: GitFixture) {
	const goal = createGoal(
		{ objective: "=== Goal ===\nObjective: Manifest integration", autoContinue: true, sisyphus: false },
		Date.UTC(2026, 8, 13, 12, 0, 0),
	);
	const written = writeActiveGoalFile({ cwd: fixture.dir }, goal);
	return {
		goal: written,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(written.id, "created") }],
	};
}

describe("change manifest integration", () => {
	it("captures the baseline on the first execution turn, once", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const { goal, sessionEntries } = seedGoal(fixture);
			const h = createHarness({ cwd: fixture.dir, sessionEntries });
			await h.start();

			assert.deepEqual(listBaselineGoalIds({ cwd: fixture.dir }), [], "no baseline before the first turn");
			await h.handlers.get("turn_start")?.({}, h.ctx);
			assert.deepEqual(listBaselineGoalIds({ cwd: fixture.dir }), [goal.id], "the first execution turn captures it");

			const captured = readFileSync(
				path.join(fixture.dir, ".pi", "goals", `${goal.id}.baseline.json`),
				"utf8",
			);
			await h.handlers.get("turn_start")?.({}, h.ctx);
			assert.equal(
				readFileSync(path.join(fixture.dir, ".pi", "goals", `${goal.id}.baseline.json`), "utf8"),
				captured,
				"later turns never overwrite the window origin",
			);
		} finally {
			fixture.remove();
		}
	});

	it("injects the real window into the completion audit", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("tracked.txt", "one\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "seed"]);
			const { sessionEntries } = seedGoal(fixture);
			let auditArgs: any = null;
			const h = createHarness({
				cwd: fixture.dir,
				sessionEntries,
				runCompletionAuditor: async (args: any) => {
					auditArgs = args;
					return { approved: true, disapproved: false, output: "ok" };
				},
			});
			await h.start();
			await h.handlers.get("turn_start")?.({}, h.ctx);

			// The window: one modified, one created file.
			fixture.write("tracked.txt", "one\ntwo\n");
			fixture.write("fresh.txt", "new\n");

			const update = h.tools.get("update_goal")!;
			await (update.execute as any)("i1", { status: "complete" }, undefined, undefined, h.ctx);

			assert.ok(auditArgs, "the auditor ran");
			const manifest: string = auditArgs.changeManifest;
			assert.ok(manifest, "the audit received a manifest");
			assert.match(manifest, /git -C .* diff [0-9a-f]+/, "it carries an expandable command");
			assert.match(manifest, /M\s+tracked\.txt \(\+1\/-0\)/, "it reports the modified file");
			assert.match(manifest, /\?\?\s+fresh\.txt/, "it reports the created file");
			assert.doesNotMatch(manifest, /change_manifest/, "body only: the prompt wrapper adds the tags");
			// The extension's own bookkeeping never shows up as workspace work.
			assert.doesNotMatch(manifest, /\.pi\/goals/);
		} finally {
			fixture.remove();
		}
	});

	it("rolls the workspace back to the baseline when the user asks on clear", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("tracked.txt", "one\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "seed"]);
			const { sessionEntries } = seedGoal(fixture);
			let asked = 0;
			const h = createHarness({
				cwd: fixture.dir,
				sessionEntries,
				select: async (_title, options) => {
					asked += 1;
					return options[1]; // the explicit "Yes — roll back" entry
				},
			});
			await h.start();
			await h.handlers.get("turn_start")?.({}, h.ctx);

			fixture.write("tracked.txt", "one\ntwo\n");
			writeFileSync(path.join(fixture.dir, "fresh.txt"), "new\n", "utf8");

			await h.commands.get("goal-clear")!.handler("", h.ctx);

			assert.equal(asked, 1, "the rollback question was asked");
			assert.equal(fixture.read("tracked.txt"), "one\n", "the modified file is back at baseline content");
			assert.equal(existsSync(path.join(fixture.dir, "fresh.txt")), false, "the created file is gone");
			assert.equal(
				readdirSync(path.join(fixture.dir, ".pi", "goals", "archived")).some((name) => name.startsWith("rollback_")),
				true,
				"the discarded changes are backed up",
			);
			assert.deepEqual(listBaselineGoalIds({ cwd: fixture.dir }), [], "the baseline is cleaned up");
			assert.ok(h.notifications.some((line) => line.includes("Rolled back")), "the result is reported");
		} finally {
			fixture.remove();
		}
	});
});
