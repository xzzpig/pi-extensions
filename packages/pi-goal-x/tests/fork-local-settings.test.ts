import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { effectiveSettingsReport, goalLocalSettingsPath, invalidateGoalSettingsCache, loadSettingsSnapshot, readSettingsLayer } from "../extensions/goal-settings.ts";

function fixture(): { cwd: string; env: { PI_GOAL_GLOBAL_SETTINGS_FILE: string; PI_GOAL_SETTINGS_FILE: string }; write: (file: string, data: unknown) => void; close: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-local-"));
	const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(cwd, "global.json"), PI_GOAL_SETTINGS_FILE: path.join(cwd, "shared.json") };
	return { cwd, env, write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); invalidateGoalSettingsCache(); }, close() { invalidateGoalSettingsCache(); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

test("three settings layers combine per leaf and preserve provenance", () => {
	const f = fixture();
	try {
		f.write(f.env.PI_GOAL_GLOBAL_SETTINGS_FILE, { disableTasks: true, auditor: { model: "global", provider: "provider", checklistExtra: ["global"] }, oracle: { enabled: true }, networkRecovery: { maxAttempts: 7 } });
		f.write(f.env.PI_GOAL_SETTINGS_FILE, { auditor: { model: "project", checklistExtra: ["shared"] }, commands: { "goal-settings": ["goal-settings", "settings"] }, pauseOrder: "together" });
		f.write(goalLocalSettingsPath(f.cwd), { disableTasks: false, auditor: { model: "local", checklistExtra: [] }, networkRecovery: { maxAttempts: 0 }, oracle: { provider: "oracle" } });
		const snap = loadSettingsSnapshot(f.cwd, f.env);
		assert.equal(snap.value.disableTasks, false);
		assert.equal(snap.value.auditor?.provider, "provider");
		assert.equal(snap.value.auditor?.model, "local");
		assert.deepEqual(snap.value.auditor?.checklistExtra, []);
		assert.equal(snap.value.oracle?.enabled, true);
		assert.equal(snap.value.oracle?.provider, "oracle");
		assert.equal(snap.value.networkRecovery?.maxAttempts, 0);
		assert.equal(snap.provenance.get("auditor.model")?.source, "local");
		assert.equal(snap.provenance.get("auditor.provider")?.source, "global");
		assert.equal(snap.provenance.get("commands.goal-settings")?.source, "project");
		assert.equal(loadSettingsSnapshot(f.cwd, { ...f.env, PI_GOAL_DISABLE_TASKS: "true" }).provenance.get("disableTasks")?.source, "environment");
		assert.ok(effectiveSettingsReport(f.cwd, f.env).some(line => line.includes(goalLocalSettingsPath(f.cwd))));
		fs.unlinkSync(goalLocalSettingsPath(f.cwd)); invalidateGoalSettingsCache();
		assert.equal(loadSettingsSnapshot(f.cwd, f.env).value.auditor?.model, "project");
	} finally { f.close(); }
});

test("local diagnostics retain valid siblings and cache scope identity", () => {
	const f = fixture();
	try {
		f.write(f.env.PI_GOAL_GLOBAL_SETTINGS_FILE, { auditor: { model: "fallback" } });
		f.write(goalLocalSettingsPath(f.cwd), { auditor: { model: 42, provider: "local-provider" } });
		const snap = loadSettingsSnapshot(f.cwd, f.env);
		assert.equal(snap.value.auditor?.model, "fallback");
		assert.equal(snap.value.auditor?.provider, "local-provider");
		assert.equal(snap.local.status, "invalid");
		assert.equal(snap.diagnostics[0]?.scope, "local");
		assert.equal(readSettingsLayer(goalLocalSettingsPath(f.cwd), "project").scope, "project");
	} finally { f.close(); }
});
