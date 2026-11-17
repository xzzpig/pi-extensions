import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { goalLocalSettingsPath, invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import { clearGoalAuditorOverride, loadGoalSettingsWithAuditorOverride, setGoalAuditorOverride } from "../extensions/goal-auditor-override.ts";
import { resolveAuditorDelegationOverrides, resolveAuditorTerminalTimeoutMs } from "../extensions/goal-auditor-delegation.ts";
import { buildGoalAuditorPrompt } from "../extensions/goal-auditor.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { DEFAULT_AUDITOR_DEFINITION, mergeAuditorDefinition } from "../extensions/goal-auditor-registration.ts";

test("auditor request composes local model, shared checklist, global settings and per-goal override", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-local-audit-"));
	const global = path.join(cwd, "global.json"), project = path.join(cwd, "project.json"), local = goalLocalSettingsPath(cwd);
	const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: global, PI_GOAL_SETTINGS_FILE: project };
	const goal = createGoal({ objective: "Verify example", autoContinue: true, sisyphus: false });
	try {
		fs.mkdirSync(path.dirname(local), { recursive: true });
		fs.writeFileSync(global, JSON.stringify({ auditor: { timeoutMs: 123456, thinkingLevel: "high" } }));
		fs.writeFileSync(project, JSON.stringify({ auditor: { checklistExtra: ["shared-evidence-check"] } }));
		fs.writeFileSync(local, JSON.stringify({ auditor: { provider: "provider", model: "model", systemPromptExtra: "definition-one" } }));
		invalidateGoalSettingsCache();
		let settings = loadGoalSettingsWithAuditorOverride(cwd, goal.id, env);
		assert.equal(resolveAuditorDelegationOverrides(settings).model, "provider/model");
		assert.equal(resolveAuditorTerminalTimeoutMs(settings), 123456);
		assert.match(buildGoalAuditorPrompt({ goal, detailedSummary: "done", settings }), /shared-evidence-check/);
		const registered = mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, settings.auditor);
		fs.writeFileSync(local, JSON.stringify({ auditor: { provider: "provider", model: "new-model", systemPromptExtra: "definition-two" } }));
		invalidateGoalSettingsCache();
		const updated = loadGoalSettingsWithAuditorOverride(cwd, goal.id, env);
		assert.equal(resolveAuditorDelegationOverrides(updated).model, "provider/new-model");
		assert.match(registered.systemPrompt ?? "", /definition-one/);
		assert.doesNotMatch(registered.systemPrompt ?? "", /definition-two/);
		assert.match(mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, updated.auditor).systemPrompt ?? "", /definition-two/);
		setGoalAuditorOverride(goal.id, { model: "override" });
		settings = loadGoalSettingsWithAuditorOverride(cwd, goal.id, env);
		assert.equal(resolveAuditorDelegationOverrides(settings).model, "provider/override");
		assert.match(buildGoalAuditorPrompt({ goal, detailedSummary: "done", settings }), /shared-evidence-check/);
	} finally { clearGoalAuditorOverride(goal.id); invalidateGoalSettingsCache(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
