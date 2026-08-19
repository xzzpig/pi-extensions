/**
 * Guided drafting is the normal entry path; the two -direct commands are the
 * explicit immediate-creation escape hatch.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { parseGoalFile } from "../extensions/storage/goal-files.ts";

const CURATED_COMMANDS = [
	"goal", "sisyphus", "goal-direct", "sisyphus-direct", "goal-tweak", "goal-pause", "goal-resume",
	"goal-clear", "goal-list", "goal-status", "goal-subagent-eject", "goal-refresh", "goal-recovery", "goal-focus", "goal-unfocus", "goal-settings", "goal-cancel",
];

const REMOVED_COMMANDS = ["goals", "goals-set", "sisyphus-set", "goal-abort", "goal-audit"];

function createHarness(cwd: string) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const messages: string[] = [];
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: (message: string) => { messages.push(message); },
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [] as unknown[],
			getCwd: () => cwd,
			getSessionId: () => "palette-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
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
	goalExtension(pi as any, {});
	const core = (pi as any)._goalCore;
	return { handlers, commands, ctx, notifications, messages, tools, core, getActiveTools: () => [...activeTools] };
}

function installGoalAuditorPackage(agentDir: string): void {
	const packageRoot = path.resolve(path.dirname(new URL("../package.json", import.meta.url).pathname));
	const target = path.join(agentDir, "npm", "node_modules", "@xzzpig", "pi-goal-x");
	mkdirSync(path.dirname(target), { recursive: true });
	symlinkSync(packageRoot, target, "dir");
}

async function withEjectFixture(
	run: (fixture: { cwd: string; agentDir: string; harness: ReturnType<typeof createHarness> }) => Promise<void>,
): Promise<void> {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-eject-command-"));
	const agentDir = path.join(cwd, "agent-home");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		installGoalAuditorPackage(agentDir);
		await run({ cwd, agentDir, harness: createHarness(cwd) });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("exactly the seventeen curated commands are registered; legacy commands are absent", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-"));
	try {
		const h = createHarness(cwd);
		for (const name of CURATED_COMMANDS) {
			assert.ok(h.commands.has(name), `${name} must be registered`);
		}
		for (const name of REMOVED_COMMANDS) {
			assert.equal(h.commands.has(name), false, `${name} must NOT be registered`);
		}
		assert.equal(h.commands.size, CURATED_COMMANDS.length, "no aliases or extras");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/goal-subagent-eject writes a portable global agent without changing goal state", { concurrency: false }, async () => {
	await withEjectFixture(async ({ cwd, agentDir, harness }) => {
		const goalBefore = harness.core.state.goal;
		await harness.commands.get("goal-subagent-eject")!.handler("global", harness.ctx);
		const targetPath = path.join(agentDir, "agents", "goal-auditor.md");
		assert.equal(existsSync(targetPath), true);
		assert.match(readFileSync(targetPath, "utf8"), /^subagentOnlyExtensions: \/.+goal-auditor-progress\.ts$/m);
		assert.ok(harness.notifications.some((message) => message.includes("Ejected agent 'goal-auditor' from package to user scope")));
		assert.equal(harness.core.state.goal, goalBefore);
		assert.equal(activeGoalFiles(cwd).length, 0);
	});
});

test("/goal-subagent-eject selects trusted project scope interactively and cancellation is a no-op", { concurrency: false }, async () => {
	await withEjectFixture(async ({ cwd, harness }) => {
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		(harness.ctx as any).hasUI = true;
		(harness.ctx as any).isProjectTrusted = () => true;
		const ui = harness.ctx.ui as any;
		ui.select = async (_title: string, options: string[]) => {
			assert.deepEqual(options, ["Global", "Project"]);
			return "Project";
		};
		await harness.commands.get("goal-subagent-eject")!.handler("", harness.ctx);
		assert.equal(existsSync(path.join(cwd, ".pi", "agents", "goal-auditor.md")), true);

		const cancelDir = path.join(cwd, "cancel-project");
		mkdirSync(path.join(cancelDir, ".pi"), { recursive: true });
		(harness.ctx as any).cwd = cancelDir;
		ui.select = async () => undefined;
		await harness.commands.get("goal-subagent-eject")!.handler("", harness.ctx);
		assert.equal(existsSync(path.join(cancelDir, ".pi", "agents", "goal-auditor.md")), false);
	});
});

test("/goal-subagent-eject refuses untrusted project scope without writing", { concurrency: false }, async () => {
	await withEjectFixture(async ({ cwd, harness }) => {
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		(harness.ctx as any).isProjectTrusted = () => false;
		await harness.commands.get("goal-subagent-eject")!.handler("project", harness.ctx);
		assert.ok(harness.notifications.some((message) => message.includes("requires a trusted project")));
		assert.equal(existsSync(path.join(cwd, ".pi", "agents", "goal-auditor.md")), false);
	});
});

function activeGoalFiles(cwd: string): string[] {
	const goalsDirectory = path.join(cwd, ".pi", "goals");
	if (!existsSync(goalsDirectory)) return [];
	return readdirSync(goalsDirectory).filter((name) => name.startsWith("active_goal_"));
}

test("/goal-subagent-eject requires an explicit scope in headless mode without mutating goal state", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-eject-headless-"));
	try {
		const h = createHarness(cwd);
		const goalBefore = h.core.state.goal;
		await h.commands.get("goal-subagent-eject")!.handler("", h.ctx);
		await h.commands.get("goal-subagent-eject")!.handler("workspace", h.ctx);
		assert.equal(h.notifications.filter((message) => message.includes("Usage: /goal-subagent-eject global|project")).length, 2);
		assert.equal(h.core.state.goal, goalBefore);
		assert.equal(existsSync(path.join(cwd, ".pi", "agents", "goal-auditor.md")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/goal <objective> starts guided drafting without creating a goal", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-create-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("Create hello.txt with 'Hello'", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 0, "drafting does not create before confirmation");
		assert.ok(h.messages.some((message) => message.includes("GOAL CONFIRMATION")), "drafting prompt sent to agent");
		assert.deepEqual(h.getActiveTools().filter((name) => name.startsWith("goal_") || name === "propose_goal_draft"), ["goal_question", "goal_questionnaire", "propose_goal_draft"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bare /goal begins a guided draft and asks for an objective", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-status-"));
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("", h.ctx);
		assert.equal(activeGoalFiles(cwd).length, 0, "no goal created");
		assert.ok(h.messages.some((message) => message.includes("ask the user what they want")), "draft prompt requests an objective");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("confirmed draft creates the proposed goal and agent-selected task plan together", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-confirm-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("Ship a small feature", h.ctx);
		const proposal = h.tools.get("propose_goal_draft");
		assert.ok(proposal, "draft proposal tool registered");
		await proposal.execute("draft-1", {
			objective: "Ship a small feature.\nSuccess criteria: tests pass.",
			sisyphus: false,
			tasks: [{ id: "implement", title: "Implement the feature" }, { id: "verify", title: "Run tests" }],
			block_completion: true,
		}, new AbortController().signal, undefined, h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1, "confirmed draft creates one goal");
		const goal = parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
		assert.deepEqual(goal?.taskList?.tasks.map((task) => task.id), ["implement", "verify"]);
		assert.equal(goal?.taskList?.blockCompletion, true);
		assert.ok(h.getActiveTools().includes("update_goal"), "execution profile restored after confirmation");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/goal-direct and /sisyphus-direct create goals immediately", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-sisy-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal-direct")!.handler("Create hello.txt", h.ctx);
		await h.commands.get("sisyphus-direct")!.handler("1) create a.txt 2) create b.txt", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 2, "direct commands create immediately");
		const parsed = files.map((file) => parseGoalFile(path.join(cwd, ".pi", "goals", file)));
		assert.ok(parsed.some((goal) => goal?.sisyphus === true), "sisyphus direct mode");
		assert.ok(parsed.some((goal) => goal?.sisyphus === false), "regular direct mode");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("goal-settings renders sectioned rows with clearer auditor wording", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({
		auditorAgent: "project-auditor",
		auditorProjectResources: true,
	}), "utf8");
	const h = createHarness(cwd);
	try {
		// The settings menu is interactive: give the harness ctx a TUI.
		(h.ctx as { hasUI: boolean }).hasUI = true;
		// Capture the options list passed to ctx.ui.select; answer "Done" on the
		// first call so the menu closes immediately.
		let captured: string[] | null = null;
		const ui = h.ctx.ui as unknown as { select: (title: string, options: string[]) => Promise<string | undefined> };
		ui.select = async (_title: string, options: string[]) => {
			if (captured === null) captured = options;
			return "Done";
		};

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		assert.ok(captured, "settings menu must call ui.select");
		const opts: string[] = captured ?? [];
		assert.ok(opts.includes("─── Goal behavior ───"), "Goal behavior section header");
		assert.ok(opts.includes("─── Task tracking ───"), "Task tracking section header");
		assert.ok(opts.includes("─── Completion auditor ───"), "Completion auditor section header");
		assert.ok(opts.some((l) => l.includes("auditor disabled:")), "clearer auditor wording row");
		assert.ok(opts.some((l) => l.includes("auditor agent: project-auditor")), "configured auditor agent row");
		assert.ok(opts.some((l) => l.includes("auditorProjectResources is deprecated and ignored")), "deprecated resources migration note");
		assert.ok(opts.some((l) => l.includes("provider:")) && opts.some((l) => l.includes("model:")), "provider/model rows");
		assert.equal(opts.filter((l) => l.startsWith("───")).length, 3, "exactly three sections");
		assert.ok(opts.includes("Done"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ── #19: positive-integer rows use a row-driven lower bound ──────────────────
// The stall timeout row defaults to 0 ("no stall timeout") and must accept 0;
// subtaskDepth is a nesting depth and must keep rejecting 0 and non-integers.

test("goal-settings: stall timeout row accepts 0 (row-driven lower bound)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-bound-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const stallRow = options.find((o) => o.includes("stall timeout (minutes)"));
				assert.ok(stallRow, "stall timeout row must be listed");
				return stallRow;
			}
			return "Done";
		};
		ui.input = async (_prompt: string) => "0";

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		const saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.stallTimeoutMinutes, 0, "stallTimeoutMinutes must accept 0");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("goal-settings: subtaskDepth rejects 0 (min 1) and never saves it", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-bound-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const depthRow = options.find((o) => o.includes("subtaskDepth"));
				assert.ok(depthRow, "subtaskDepth row must be listed");
				return depthRow;
			}
			return "Done";
		};
		ui.input = async (_prompt: string) => "0";

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		assert.ok(h.notifications.some((n) => n.includes("subtaskDepth must be an integer >= 1")),
			`expected subtaskDepth bound warning, got notifications: ${h.notifications.join(" | ")}`);
		const settingsPath = path.join(cwd, ".pi", "pi-goal-x-settings.json");
		// A rejected input never persists: the file is either absent or lacks the key.
		if (readFileSyncSafe(settingsPath)) {
			assert.ok(!readFileSyncSafe(settingsPath)!.includes("subtaskDepth"), "subtaskDepth must not be written");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("goal-settings: max objective length row defaults to 0 and accepts a configured limit", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-objective-max-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		let inputValue = "0";
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const row = options.find((o) => o.includes("max objective length"));
				assert.ok(row, "max objective length row must be listed");
				assert.ok(row!.includes(": 0"), "row defaults to 0 = no limit");
				return row;
			}
			return "Done";
		};
		ui.input = async (_prompt: string, defaultValue?: string) => {
			assert.equal(defaultValue, "0", "input defaults to 0");
			return inputValue;
		};

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		let saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.objectiveMaxChars, 0, "0 = no limit persists explicitly");

		// A configured limit persists too.
		inputValue = "6000";
		selectCalls = 0;
		await h.commands.get("goal-settings")!.handler("", h.ctx);
		saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.objectiveMaxChars, 6000, "configured limit persists");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function readFileSyncSafe(p: string): string | null {
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}
