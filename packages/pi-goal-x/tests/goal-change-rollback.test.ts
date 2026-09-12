/**
 * Workspace change manifest — `/goal-clear` rollback.
 *
 * Covers the two-step clear interaction, the silent skip conditions, the
 * fail-closed backup, the rollback itself (restore / delete / never reset a
 * HEAD), the result report, and the ordering guarantee that the rollback runs
 * while the baseline still exists.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache, saveGoalSettingsFileConfig } from "../extensions/goal-settings.ts";
import { captureChangeBaseline, changeBaselinePath, readChangeBaseline, writeChangeBaselineIfAbsent } from "../extensions/goal-change-baseline.ts";
import { computeChangeDelta } from "../extensions/goal-change-delta.ts";
import {
	executeRollback,
	formatRollbackReport,
	planRollback,
	rollbackBackupDirName,
	writeRollbackBackup,
} from "../extensions/goal-change-rollback.ts";
import { configureRepo, gitAvailable, makeGitFixture, type GitFixture } from "./git-fixture.ts";

const skip = gitAvailable ? false : "git is not available";

interface HarnessOptions {
	cwd: string;
	sessionEntries: unknown[];
	hasUI?: boolean;
	confirm?: boolean;
	/** Answer for the rollback `select`; a function can record side effects first. */
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	onSelect?: (title: string, options: string[]) => void;
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
		hasUI: options.hasUI ?? false,
	};
	const notifications: string[] = [];
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? false,
		sessionManager: {
			getBranch: () => options.sessionEntries,
			getCwd: () => options.cwd,
			getSessionId: () => "rollback-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async (title: string, choices: string[]) => {
				options.onSelect?.(title, choices);
				return options.select ? await options.select(title, choices) : undefined;
			},
			confirm: async () => options.confirm ?? false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return {
		handlers,
		commands,
		ctx,
		notifications,
		async start() {
			await handlers.get("session_start")?.({ reason: "start" }, ctx);
			await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, ctx);
		},
		async clear() {
			await commands.get("goal-clear")!.handler("", ctx);
		},
	};
}

/** Goal record + focus entry inside the git fixture. */
function seedGoal(fixture: GitFixture, objective = "Baseline rollback") {
	const goal = createGoal(
		{ objective: `=== Goal ===\nObjective: ${objective}`, autoContinue: true, sisyphus: false },
		Date.UTC(2026, 8, 13, 10, 0, 0),
	);
	const written = writeActiveGoalFile({ cwd: fixture.dir }, goal);
	const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(written.id, "created") }];
	return { goal: written, sessionEntries };
}

async function seedBaseline(fixture: GitFixture, goalId: string): Promise<void> {
	const baseline = await captureChangeBaseline({ cwd: fixture.dir }, goalId, { depth: 0, reason: "turn_start" });
	assert.ok(baseline);
	assert.equal(writeChangeBaselineIfAbsent({ cwd: fixture.dir }, baseline), true);
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((name) => name.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function rollbackDirs(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals", "archived")).filter((name) => name.startsWith("rollback_"));
	} catch {
		return [];
	}
}

function cleanup(cwd: string): void {
	try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("rollback restores the window, backs it up, and still clears the goal", { skip }, async () => {
	const fixture = makeGitFixture();
	try {
		fixture.write("mod.txt", "a\n");
		fixture.write("gone.txt", "gone\n");
		fixture.write("dirty.txt", "base\n");
		fixture.git(["add", "-A"]);
		fixture.git(["commit", "-q", "-m", "seed"]);
		// Dirty BEFORE the baseline: the rollback must return to this content,
		// not to HEAD.
		fixture.write("dirty.txt", "base\npre-existing\n");

		const { goal, sessionEntries } = seedGoal(fixture);
		await seedBaseline(fixture, goal.id);
		const baselinePath = changeBaselinePath({ cwd: fixture.dir }, goal.id);

		// Window work: modify, delete, create, and further modify already-dirty.
		fixture.write("mod.txt", "a\nb\n");
		rmSync(path.join(fixture.dir, "gone.txt"));
		fixture.write("new.txt", "new\n");
		fixture.write("dirty.txt", "base\npre-existing\nwindow\n");
		const stashListBefore = fixture.git(["stash", "list"]);

		let sawBaselineDuringQuestion = false;
		let sawArchivedGoalDuringQuestion = false;
		let question = "";
		const h = createHarness({
			cwd: fixture.dir,
			sessionEntries,
			hasUI: true,
			confirm: true,
			onSelect: (title) => {
				question = title;
				sawBaselineDuringQuestion = existsSync(baselinePath);
				sawArchivedGoalDuringQuestion = activeGoalFiles(fixture.dir).length === 0;
			},
			select: async (_title, choices) => choices[1],
		});
		await h.start();
		await h.clear();

		// 7.1 — the question is a second, explicit step before archival.
		assert.equal(question, "Roll back this goal's workspace changes?");
		assert.equal(sawBaselineDuringQuestion, true, "the rollback runs while the baseline still exists");
		assert.equal(sawArchivedGoalDuringQuestion, false, "the rollback is offered before archival");

		// 7.5 — the worktree is back at the baseline.
		assert.equal(fixture.read("mod.txt"), "a\n");
		assert.equal(fixture.read("gone.txt"), "gone\n");
		assert.equal(fixture.read("dirty.txt"), "base\npre-existing\n", "returns to baseline content, not HEAD content");
		assert.equal(existsSync(path.join(fixture.dir, "new.txt")), false, "window-created files are deleted");

		// 7.3 — backup is self-contained, replayable, and stash-neutral.
		assert.equal(fixture.git(["stash", "list"]), stashListBefore, "the user's stash list is untouched");
		const dirs = rollbackDirs(fixture.dir);
		assert.equal(dirs.length, 1, "exactly one backup directory");
		const backupRoot = path.join(fixture.dir, ".pi", "goals", "archived", dirs[0]!);
		const patchName = readdirSync(backupRoot).find((name) => name.endsWith(".patch"));
		assert.ok(patchName, "a per-repo patch is written");
		const manifest = JSON.parse(readFileSync(path.join(backupRoot, "manifest.json"), "utf8"));
		assert.equal(manifest.goalId, goal.id);
		assert.deepEqual(manifest.repos[0].copiedFiles, ["new.txt"], "window-created file content is preserved");
		assert.doesNotThrow(
			() => fixture.git(["apply", "--check", path.join(backupRoot, patchName!)]),
			"the backup patch replays cleanly against the rolled-back worktree",
		);

		// Clearing still happened.
		assert.equal(activeGoalFiles(fixture.dir).length, 0);
		assert.equal(existsSync(baselinePath), false, "the baseline is cleaned up after the flow");
		assert.ok(h.notifications.some((line) => line.includes("Rolled back")), "the result report is surfaced");
	} finally {
		cleanup(fixture.dir);
	}
});

test("answering no is the default and leaves the workspace untouched", { skip }, async () => {
	const fixture = makeGitFixture();
	try {
		fixture.write("mod.txt", "a\n");
		fixture.git(["add", "-A"]);
		fixture.git(["commit", "-q", "-m", "seed"]);
		const { goal, sessionEntries } = seedGoal(fixture);
		await seedBaseline(fixture, goal.id);
		fixture.write("mod.txt", "a\nb\n");

		let choices: string[] = [];
		let title = "";
		const h = createHarness({
			cwd: fixture.dir,
			sessionEntries,
			hasUI: true,
			confirm: true,
			onSelect: (_t, options) => { title = _t; choices = options; },
			select: async (_title, options) => options[0], // the default entry
		});
		await h.start();
		await h.clear();

		assert.equal(choices[0]?.includes("default"), true, "the no-rollback option is labelled as the default");
		assert.match(choices[1] ?? "", /restore 1 file\(s\) and delete 0 new file\(s\)/, "the question previews the plan");
		assert.equal(title, "Roll back this goal's workspace changes?");
		assert.equal(fixture.read("mod.txt"), "a\nb\n", "declining changes no file");
		assert.deepEqual(rollbackDirs(fixture.dir), [], "declining writes no backup");
		assert.equal(activeGoalFiles(fixture.dir).length, 0, "the goal is still cleared");
	} finally {
		cleanup(fixture.dir);
	}
});

test("no baseline, an empty window, or collection off never asks", { skip }, async () => {
	// No baseline at all.
	const noBaseline = makeGitFixture();
	try {
		noBaseline.write("mod.txt", "a\n");
		noBaseline.git(["add", "-A"]);
		noBaseline.git(["commit", "-q", "-m", "seed"]);
		const { sessionEntries } = seedGoal(noBaseline);
		let asked = 0;
		const h = createHarness({
			cwd: noBaseline.dir,
			sessionEntries,
			hasUI: true,
			confirm: true,
			onSelect: () => { asked += 1; },
		});
		await h.start();
		await h.clear();
		assert.equal(asked, 0, "without a baseline there is no rollback question");
		assert.equal(activeGoalFiles(noBaseline.dir).length, 0);
	} finally {
		cleanup(noBaseline.dir);
	}

	// Baseline present, but nothing changed in the window.
	const emptyWindow = makeGitFixture();
	try {
		emptyWindow.write("mod.txt", "a\n");
		emptyWindow.git(["add", "-A"]);
		emptyWindow.git(["commit", "-q", "-m", "seed"]);
		const { goal, sessionEntries } = seedGoal(emptyWindow);
		await seedBaseline(emptyWindow, goal.id);
		let asked = 0;
		const h = createHarness({
			cwd: emptyWindow.dir,
			sessionEntries,
			hasUI: true,
			confirm: true,
			onSelect: () => { asked += 1; },
		});
		await h.start();
		await h.clear();
		assert.equal(asked, 0, "an empty window is not worth a question");
	} finally {
		cleanup(emptyWindow.dir);
	}

	// Collection turned off after the baseline was captured.
	const collectionOff = makeGitFixture();
	try {
		collectionOff.write("mod.txt", "a\n");
		collectionOff.git(["add", "-A"]);
		collectionOff.git(["commit", "-q", "-m", "seed"]);
		const { goal, sessionEntries } = seedGoal(collectionOff);
		await seedBaseline(collectionOff, goal.id);
		collectionOff.write("mod.txt", "a\nb\n");
		saveGoalSettingsFileConfig(collectionOff.dir, { changeManifest: "off" });
		invalidateGoalSettingsCache();
		let asked = 0;
		const h = createHarness({
			cwd: collectionOff.dir,
			sessionEntries,
			hasUI: true,
			confirm: true,
			onSelect: () => { asked += 1; },
		});
		await h.start();
		await h.clear();
		assert.equal(asked, 0, "collection off means no rollback offer");
	} finally {
		cleanup(collectionOff.dir);
	}
});

test("a refused backup means no rollback at all (fail-closed)", { skip }, async () => {
	const fixture = makeGitFixture();
	try {
		fixture.write("mod.txt", "a\n");
		fixture.git(["add", "-A"]);
		fixture.git(["commit", "-q", "-m", "seed"]);
		const { goal } = seedGoal(fixture);
		await seedBaseline(fixture, goal.id);
		fixture.write("mod.txt", "a\nb\n");

		const baseline = readChangeBaseline({ cwd: fixture.dir }, goal.id);
		assert.ok(baseline);
		const plan = planRollback(await computeChangeDelta(baseline));
		assert.equal(plan.restoreCount, 1, "the plan has one restore action");

		// A cap of one byte refuses the backup before anything is touched.
		const refused = await writeRollbackBackup({ cwd: fixture.dir }, plan, { maxBytes: 1 });
		assert.equal(refused.ok, false, "an oversized backup is refused");
		assert.match(refused.reason ?? "", /cap/);
		assert.equal(fixture.read("mod.txt"), "a\nb\n", "the worktree is untouched after a refused backup");
	} finally {
		cleanup(fixture.dir);
	}
});

test("rollback reports per-path failures without aborting the rest", { skip }, async () => {
	const fixture = makeGitFixture();
	try {
		fixture.write("mod.txt", "a\n");
		fixture.git(["add", "-A"]);
		fixture.git(["commit", "-q", "-m", "seed"]);
		const { goal } = seedGoal(fixture);
		await seedBaseline(fixture, goal.id);
		fixture.write("mod.txt", "a\nb\n");

		const baseline = readChangeBaseline({ cwd: fixture.dir }, goal.id);
		assert.ok(baseline);
		const plan = planRollback(await computeChangeDelta(baseline));
		// Inject one path that escapes the repository root: it must fail and be
		// reported while the legitimate restore still succeeds.
		plan.repos[0]!.actions.push({ kind: "restore", path: "../outside.txt" });

		const results = await executeRollback(plan);
		assert.equal(results[0]?.restored, 1, "the valid path is still restored");
		assert.deepEqual(
			results[0]?.failures.map((failure) => failure.path),
			["../outside.txt"],
		);
		const report = formatRollbackReport(plan, results, "/tmp/backup");
		assert.match(report, /could not be rolled back/);
		assert.match(report, /\.\.\/outside\.txt — path escapes the repository root/);
		assert.match(report, /Backup \(can be replayed with git apply\): \/tmp\/backup/);
		assert.equal(fixture.read("mod.txt"), "a\n", "the window change is rolled back");
	} finally {
		cleanup(fixture.dir);
	}
});

test("a submodule's files are restored while its HEAD is never reset", { skip }, async () => {
	const submodule = makeGitFixture();
	const superproject = makeGitFixture();
	try {
		// Seed the submodule content BEFORE adding it, so the clone has the file.
		submodule.write("lib.txt", "one\n");
		submodule.git(["add", "-A"]);
		submodule.git(["commit", "-q", "-m", "lib"]);
		superproject.git(["-c", "protocol.file.allow=always", "submodule", "add", submodule.dir, "sub"]);
		superproject.git(["commit", "-q", "-m", "add submodule"]);
		const subDir = path.join(superproject.dir, "sub");
		assert.equal(readFileSync(path.join(subDir, "lib.txt"), "utf8"), "one\n", "the clone carries the file");

		const { goal } = seedGoal(superproject);
		await seedBaseline(superproject, goal.id);
		const subHeadBefore = superproject.git(["rev-parse", "HEAD"], subDir).trim();

		// Window work INSIDE the submodule working tree: a dirty tracked file plus a
		// commit that moves the submodule HEAD.
		configureRepo(superproject, subDir); // the clone has no identity of its own
		writeFileSync(path.join(subDir, "lib.txt"), "one\ntwo\n", "utf8");
		writeFileSync(path.join(subDir, "committed.txt"), "committed\n", "utf8");
		superproject.git(["add", "committed.txt"], subDir);
		superproject.git(["commit", "-q", "-m", "inside window"], subDir);

		const baseline = readChangeBaseline({ cwd: superproject.dir }, goal.id);
		assert.ok(baseline);
		const plan = planRollback(await computeChangeDelta(baseline));
		const backup = await writeRollbackBackup({ cwd: superproject.dir }, plan);
		assert.equal(backup.ok, true, "the backup is written before any mutation");
		const results = await executeRollback(plan);

		assert.equal(readFileSync(path.join(subDir, "lib.txt"), "utf8"), "one\n", "the modified submodule file returns to baseline content");
		assert.equal(existsSync(path.join(subDir, "committed.txt")), false, "the window-created file is removed");
		assert.notEqual(superproject.git(["rev-parse", "HEAD"], subDir).trim(), subHeadBefore, "the in-window commit itself is kept");
		const movedHeads = results.flatMap((result) => result.headMoved);
		assert.equal(movedHeads.length, 1, "the moved HEAD is reported as not reset");
		assert.match(movedHeads[0]?.reason ?? "", /never rewritten/);
		assert.match(formatRollbackReport(plan, results, backup.dir), /were not reset/);
	} finally {
		superproject.remove();
		submodule.remove();
	}
});

test("backup directory names mirror the archive naming convention", () => {
	const name = rollbackBackupDirName("goal-abc", new Date(Date.UTC(2026, 8, 13, 4, 5, 6, 70)));
	assert.match(name, /^rollback_\d{16}_goal-abc$/, `unexpected backup name: ${name}`);
	assert.match(rollbackBackupDirName("weird/id with spaces"), /^rollback_\d{16}_weird_id_with_spaces$/);
});

test("a rollback is never offered without a UI", { skip }, async () => {
	const fixture = makeGitFixture();
	try {
		fixture.write("mod.txt", "a\n");
		fixture.git(["add", "-A"]);
		fixture.git(["commit", "-q", "-m", "seed"]);
		const { goal, sessionEntries } = seedGoal(fixture);
		await seedBaseline(fixture, goal.id);
		fixture.write("mod.txt", "a\nb\n");
		let asked = 0;
		const h = createHarness({
			cwd: fixture.dir,
			sessionEntries,
			hasUI: false,
			confirm: true,
			onSelect: () => { asked += 1; },
		});
		await h.start();
		await h.clear();
		assert.equal(asked, 0, "headless clearing asks nothing");
		assert.equal(fixture.read("mod.txt"), "a\nb\n", "and changes nothing");
	} finally {
		cleanup(fixture.dir);
	}
});
