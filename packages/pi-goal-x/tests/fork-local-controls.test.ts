import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getKeybindings } from "@earendil-works/pi-tui";
import { GoalControlsDialog } from "../extensions/widgets/goal-controls-dialog.ts";
import { goalLocalSettingsPath, invalidateGoalSettingsCache, loadSettingsSnapshot, mutateSettingsLayer } from "../extensions/goal-settings.ts";
import { createMockTheme, createMockTUI } from "./tui-test-utils.ts";

const ENTER = "\r", TAB = "\t", DOWN = "\x1b[B", CTRL_S = "\x13", ESC = "\x1b", F6 = "\x1b[17~";
function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-local-controls-"));
	const old = { project: process.env.PI_GOAL_SETTINGS_FILE, global: process.env.PI_GOAL_GLOBAL_SETTINGS_FILE };
	process.env.PI_GOAL_SETTINGS_FILE = path.join(cwd, "project.json");
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, "global.json");
	const ctx = { cwd, hasUI: true, isIdle: () => true, ui: { setWorkingVisible() {} } };
	const core = { loadedCommands: {}, pi: { getCommands: () => [] }, updateUI() {}, interruption: { isHeld: () => false } };
	const { tui } = createMockTUI({ terminalRows: 32 });
	const dialog = new GoalControlsDialog(core as never, ctx as never, tui, createMockTheme(), getKeybindings() as never, () => {});
	const press = (...keys: string[]) => keys.forEach(key => dialog.handleInput(key));
	const mutate = (scope: "global" | "project" | "local", key: string[], value: unknown) => mutateSettingsLayer({ scope, cwd, mutation: { op: "set", path: key, value } });
	return { cwd, dialog, press, mutate, text: () => dialog.render(110).join("\n"), close() {
		dialog.dispose();
		for (const [key, value] of [["PI_GOAL_SETTINGS_FILE", old.project], ["PI_GOAL_GLOBAL_SETTINGS_FILE", old.global]] as const) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		invalidateGoalSettingsCache(); fs.rmSync(cwd, { recursive: true, force: true });
	} };
}

test("controls edit local commands, keys and pause order without changing project", () => {
	const f = fixture();
	try {
		f.press(CTRL_S); assert.match(f.text(), /Local \(local\)/);
		f.press("Revise", ENTER, ENTER, "\x15", "work edit", ENTER);
		assert.deepEqual(loadSettingsSnapshot(f.cwd).local.layer.commands?.["goal-tweak"], ["work edit"]);
		f.press(TAB, "Pause /", ENTER, ENTER, F6, ENTER);
		assert.deepEqual(loadSettingsSnapshot(f.cwd).local.layer.keybindings?.pause, ["f6"]);
		f.press(TAB, ENTER, DOWN, ENTER);
		assert.equal(loadSettingsSnapshot(f.cwd).local.layer.pauseOrder, "goal-first");
		assert.equal(fs.existsSync(path.join(f.cwd, "project.json")), false);
		assert.ok(fs.existsSync(goalLocalSettingsPath(f.cwd)));
	} finally { f.close(); }
});

test("local controls show source and restore project inheritance", () => {
	const f = fixture();
	try {
		f.mutate("project", ["keybindings", "pause"], "f8");
		f.mutate("local", ["keybindings", "pause"], "f7");
		f.press(CTRL_S, TAB, "Pause /");
		assert.match(f.text(), /Source: Local/);
		f.press(ENTER, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
		assert.equal(loadSettingsSnapshot(f.cwd).value.keybindings?.pause, "f8");
		assert.equal(loadSettingsSnapshot(f.cwd).provenance.get("keybindings.pause")?.source, "project");
		assert.match(f.text(), /Source: This project/);
	} finally { f.close(); }
});

test("controls reject a newly conflicting lower-layer edit even if local masks it", () => {
	const f = fixture();
	try {
		f.mutate("local", ["keybindings", "pause"], "f7");
		f.mutate("global", ["keybindings", "toggleAuditor"], "f6");
		f.press(TAB, "Pause /", ENTER, ENTER, F6, ENTER);
		assert.match(f.text(), /also assigned/);
		assert.equal(loadSettingsSnapshot(f.cwd).project.layer.keybindings?.pause, undefined);
		assert.equal(loadSettingsSnapshot(f.cwd).value.keybindings?.pause, "f7");
		f.press(ESC);
	} finally { f.close(); }
});
