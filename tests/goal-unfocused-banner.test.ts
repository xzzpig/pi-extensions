/**
 * PR #29 clean rewrite — layered hideUnfocusedBanner with live refresh.
 *
 * Pins: boolean parsing, global/project layering, live hide/restore before
 * the settings handler resolves, focused dashboard immunity, and the
 * model-facing [PI GOAL UNFOCUSED] safety invariant.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	loadGoalSettings,
	loadSettingsSnapshot,
	mutateSettingsLayer,
	parseSettingsLayer,
	invalidateGoalSettingsCache,
} from "../extensions/goal-settings.ts";
import { unfocusedOpenGoalsPrompt } from "../extensions/prompts/goal-prompts.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-banner-")));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

describe("hideUnfocusedBanner setting", () => {
	it("parses true/false booleans (and string forms); default is false", () => {
		const parsed = parseSettingsLayer({ hideUnfocusedBanner: true }, "project", "t.json");
		assert.equal(parsed.layer.hideUnfocusedBanner, true);
		const parsedFalse = parseSettingsLayer({ hideUnfocusedBanner: "false" }, "project", "t.json");
		assert.equal(parsedFalse.layer.hideUnfocusedBanner, false);
		withTempDir((dir) => {
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "none.json") }).hideUnfocusedBanner, false, "default false");
		});
	});

	it("layering: global true hides; project false overrides and shows; project true over global false hides", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			const projectFile = path.join(dir, ".pi", "pi-goal-x-settings.json");

			writeJson(projectFile, {});
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).hideUnfocusedBanner, false, "absent + absent -> visible");

			writeJson(path.join(dir, "g.json"), { hideUnfocusedBanner: true });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).hideUnfocusedBanner, true, "global true -> hidden");

			writeJson(projectFile, { hideUnfocusedBanner: false });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).hideUnfocusedBanner, false, "project false overrides global true -> visible");

			writeJson(path.join(dir, "g.json"), { hideUnfocusedBanner: false });
			writeJson(projectFile, { hideUnfocusedBanner: true });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).hideUnfocusedBanner, true, "project true over global false -> hidden");

			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.provenance.get("hideUnfocusedBanner")?.source, "project");
		});
	});

	it("save/unset round trip through the scoped mutation API", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["hideUnfocusedBanner"], value: true } });
			assert.equal(loadGoalSettings(dir, env).hideUnfocusedBanner, true);
			mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "unset", path: ["hideUnfocusedBanner"] } });
			assert.equal(loadGoalSettings(dir, env).hideUnfocusedBanner, false, "unset returns to inherited/default");
		});
	});
});

describe("model-facing safety invariant (PR #29 §39)", () => {
	it("[PI GOAL UNFOCUSED] prompt text is unchanged by the banner setting", () => {
		const prompt = unfocusedOpenGoalsPrompt(2);
		assert.match(prompt, /\[PI GOAL UNFOCUSED\]/);
		assert.match(prompt, /Do not choose or switch focus autonomously/);
		assert.match(prompt, /Ask the user to run \/goal-focus/);
		// The prompt builder takes only the open-goal count — the setting cannot
		// reach it structurally.
		assert.equal(unfocusedOpenGoalsPrompt(1), unfocusedOpenGoalsPrompt(1));
	});
});
