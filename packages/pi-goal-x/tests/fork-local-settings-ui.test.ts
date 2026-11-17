import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import goalExtension from "../extensions/goal.ts";
import { invalidateGoalSettingsCache, loadSettingsSnapshot } from "../extensions/goal-settings.ts";

test("settings menu defaults to project, identifies local masking, and edits only selected layer", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-local-ui-"));
	const project = path.join(cwd, ".pi", "pi-goal-x-settings.json");
	const local = path.join(cwd, ".pi", "pi-goal-x-settings.local.json");
	const global = path.join(cwd, "global.json");
	const prior = { project: process.env.PI_GOAL_SETTINGS_FILE, global: process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, disableTasks: process.env.PI_GOAL_DISABLE_TASKS };
	delete process.env.PI_GOAL_DISABLE_TASKS;
	fs.mkdirSync(path.dirname(project));
	fs.writeFileSync(project, JSON.stringify({ disableTasks: false }));
	fs.writeFileSync(local, JSON.stringify({ disableTasks: true }));
	fs.writeFileSync(global, JSON.stringify({ disableTasks: false }));
	process.env.PI_GOAL_SETTINGS_FILE = project; process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = global;
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = {
		on() {}, registerCommand(name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, def); },
		registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
	};
	const menus: string[][] = [];
	let step = 0;
	const select = async (_prompt: string, options: string[]) => {
		menus.push(options);
		switch (step++) {
			case 0: return options.find(v => v.trimStart().startsWith("disableTasks:"));
			case 1: return "Set project override to true";
			case 2: return options.find(v => v.startsWith("Scope:"));
			case 3: return options.find(v => v.trimStart().startsWith("disableTasks:"));
			case 4: return "Use inherited value";
			default: return "Done";
		}
	};
	const ctx = {
		cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
		getSystemPrompt: () => "", sessionManager: { getBranch: () => [], getSessionId: () => "local-ui", getCwd: () => cwd },
		modelRegistry: { getAvailable: () => [] }, ui: { select, notify() {}, setStatus() {}, setWidget() {}, setWorkingVisible() {}, onTerminalInput: () => () => {} },
	};
	try {
		goalExtension(pi as never);
		await commands.get("goal-settings")!.handler("", ctx);
		assert.match(menus[0]![0]!, /Editing: project/);
		assert.ok(menus[0]!.some(row => row.includes("disableTasks: true") && row.includes("source: local") && row.includes("project: false") && row.includes("overridden by local")));
		assert.equal(JSON.parse(fs.readFileSync(project, "utf8")).disableTasks, true);
		assert.equal(JSON.parse(fs.readFileSync(local, "utf8")).disableTasks, undefined);
		assert.equal(JSON.parse(fs.readFileSync(global, "utf8")).disableTasks, false);
		assert.equal(loadSettingsSnapshot(cwd).provenance.get("disableTasks")?.source, "project");
		fs.unlinkSync(local); fs.writeFileSync(global, "{}"); invalidateGoalSettingsCache();
		const absentMenus: string[][] = [];
		ctx.ui.select = async (_prompt: string, options: string[]) => {
			absentMenus.push(options);
			return absentMenus.length <= 2 ? options.find(v => v.startsWith("Scope:")) : "Done";
		};
		await commands.get("goal-settings")!.handler("", ctx);
		assert.ok(absentMenus[0]!.some(row => row.includes("disableTasks: true") && row.includes("source: project") && row.includes("project: true")));
		assert.ok(absentMenus[2]!.some(row => row.includes("disableTasks: true") && row.includes("source: project") && row.includes("global: unset") && row.includes("overridden by project")));
		assert.equal(fs.existsSync(local), false);
		process.env.PI_GOAL_DISABLE_TASKS = "false";
		const environmentMenus: string[][] = [];
		ctx.ui.select = async (_prompt: string, options: string[]) => { environmentMenus.push(options); return "Done"; };
		await commands.get("goal-settings")!.handler("", ctx);
		assert.ok(environmentMenus[0]!.some(row => row.includes("disableTasks: false") && row.includes("source: environment PI_GOAL_DISABLE_TASKS") && row.includes("project: true") && row.includes("read-only")));
		delete process.env.PI_GOAL_DISABLE_TASKS;
		fs.writeFileSync(project, JSON.stringify({ oracle: { provider: "shared-provider", model: "shared-model" } }));
		fs.writeFileSync(local, JSON.stringify({ oracle: { provider: "personal-provider" } }));
		invalidateGoalSettingsCache();
		const oracleMenus: string[][] = [];
		ctx.ui.select = async (_prompt: string, options: string[]) => {
			oracleMenus.push(options);
			return oracleMenus.length <= 2 ? options.find(v => v.startsWith("Scope:")) : "Done";
		};
		await commands.get("goal-settings")!.handler("", ctx);
		assert.ok(oracleMenus[0]!.includes("  oracle provider: personal-provider (source: local; project: shared-provider; overridden by local)"));
		assert.ok(oracleMenus[0]!.includes("  oracle model: shared-model (source: project; project: shared-model)"));
		assert.ok(oracleMenus[1]!.includes("  oracle provider: personal-provider (source: local; local: personal-provider)"));
		assert.ok(oracleMenus[1]!.includes("  oracle model: shared-model (source: project; local: unset)"));
		assert.ok(oracleMenus[2]!.includes("  oracle provider: personal-provider (source: local; global: unset; overridden by local)"));
		assert.ok(oracleMenus[2]!.includes("  oracle model: shared-model (source: project; global: unset; overridden by project)"));
		fs.writeFileSync(global, JSON.stringify({ oracle: { provider: "global-provider", model: "global-model" } }));
		fs.writeFileSync(project, JSON.stringify({ oracle: { provider: "shared-provider" } }));
		fs.writeFileSync(local, JSON.stringify({ oracle: { model: "personal-model" } }));
		invalidateGoalSettingsCache();
		const splitMenus: string[][] = [];
		ctx.ui.select = async (_prompt: string, options: string[]) => { splitMenus.push(options); return "Done"; };
		await commands.get("goal-settings")!.handler("", ctx);
		assert.ok(splitMenus[0]!.includes("  oracle provider: shared-provider (source: project; project: shared-provider)"));
		assert.ok(splitMenus[0]!.includes("  oracle model: personal-model (source: local; project: unset; overridden by local)"));
	} finally {
		const core = (pi as any)._goalCore; core.scheduler.shutdown(); core.runtime.clearContinuationState();
		for (const [key, value] of [["PI_GOAL_SETTINGS_FILE", prior.project], ["PI_GOAL_GLOBAL_SETTINGS_FILE", prior.global], ["PI_GOAL_DISABLE_TASKS", prior.disableTasks]] as const) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		invalidateGoalSettingsCache(); fs.rmSync(cwd, { recursive: true, force: true });
	}
});
