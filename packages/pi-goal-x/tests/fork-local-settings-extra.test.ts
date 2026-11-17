import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { goalLocalSettingsPath, invalidateGoalSettingsCache, loadSettingsSnapshot } from "../extensions/goal-settings.ts";

test("aliases, nested bindings and copy safety remain layer-aware", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-local-matrix-"));
	const global = path.join(cwd, "global.json");
	const project = path.join(cwd, "project.json");
	const local = goalLocalSettingsPath(cwd);
	const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: global, PI_GOAL_SETTINGS_FILE: project };
	try {
		fs.mkdirSync(path.dirname(local), { recursive: true });
		fs.writeFileSync(global, JSON.stringify({ provider: "global-provider", model: "global-model", auditor: { checklistExtra: ["one"] } }));
		fs.writeFileSync(project, JSON.stringify({ model: "project-model", keybindings: { dashboard: { toggleExpand: "ctrl+a" } } }));
		fs.writeFileSync(local, JSON.stringify({ model: "legacy-local", auditor: { model: "nested-local" }, keybindings: { dashboard: { scrollDown: "ctrl+b" } }, commands: { "goal-pause": [] }, pauseOrder: "goal-first", subtaskDepth: 2 }));
		invalidateGoalSettingsCache();
		const a = loadSettingsSnapshot(cwd, env);
		assert.equal(a.value.auditor?.model, "nested-local");
		assert.equal(a.provenance.get("auditor.model")?.source, "local");
		assert.equal(a.value.auditor?.provider, "global-provider");
		assert.equal(a.provenance.get("keybindings.dashboard.toggleExpand")?.source, "project");
		assert.equal(a.provenance.get("keybindings.dashboard.scrollDown")?.source, "local");
		assert.deepEqual(a.value.commands?.["goal-pause"], []);
		assert.equal(a.provenance.get("commands.goal-pause")?.source, "local");
		assert.equal(a.value.pauseOrder, "goal-first");
		assert.equal(a.value.subtaskDepth, 2);
		a.value.auditor?.checklistExtra?.push("mutation");
		if (a.local.layer.auditor) a.local.layer.auditor.model = "tampered";
		assert.deepEqual(loadSettingsSnapshot(cwd, env).value.auditor?.checklistExtra, ["one"]);
		assert.equal(loadSettingsSnapshot(cwd, env).local.layer.auditor?.model, "nested-local");
	} finally { invalidateGoalSettingsCache(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
