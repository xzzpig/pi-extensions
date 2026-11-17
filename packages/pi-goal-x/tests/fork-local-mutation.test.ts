import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { goalLocalSettingsPath, invalidateGoalSettingsCache, loadSettingsSnapshot, loadGoalSettingsFileConfig, mutateSettingsLayer } from "../extensions/goal-settings.ts";

test("local mutations write only local and deletion restores inherited value", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-local-mutate-"));
	const global = path.join(cwd, "global.json");
	const project = path.join(cwd, "project.json");
	const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: global, PI_GOAL_SETTINGS_FILE: project };
	try {
		fs.writeFileSync(global, '{"auditor":{"model":"global"}}');
		fs.writeFileSync(project, '{"auditor":{"model":"shared"}}');
		const apply = (op: "set" | "unset") => mutateSettingsLayer({ cwd, env, scope: "local", mutation: op === "set" ? { op, path: ["auditor", "model"], value: "personal" } : { op, path: ["auditor", "model"] } });
		apply("set");
		assert.equal(loadSettingsSnapshot(cwd, env).value.auditor?.model, "personal");
		assert.equal(loadGoalSettingsFileConfig(cwd, env).auditor?.model, "shared");
		assert.equal(fs.readFileSync(project, "utf8"), '{"auditor":{"model":"shared"}}');
		apply("unset");
		assert.equal(loadSettingsSnapshot(cwd, env).value.auditor?.model, "shared");
		fs.writeFileSync(goalLocalSettingsPath(cwd), "broken"); invalidateGoalSettingsCache();
		assert.throws(() => apply("set"), /invalid local settings/);
		assert.equal(fs.readFileSync(goalLocalSettingsPath(cwd), "utf8"), "broken");
	} finally { invalidateGoalSettingsCache(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
