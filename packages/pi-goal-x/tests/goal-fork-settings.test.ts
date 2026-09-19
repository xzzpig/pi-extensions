import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	loadGoalSettings,
	loadSettingsSnapshot,
	invalidateGoalSettingsCache,
} from "../extensions/goal-settings.ts";

// [fork] change-manifest / auditor settings coverage, split out of the
// upstream goal-layered-settings.test.ts so the fork-owned cases live in a
// fork-only file with zero subtree conflict surface.

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-fork-settings-")));
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

describe("fork settings: changeManifest / auditorTimeoutMs", () => {
	it("changeManifest / changeManifestDepth: defaults are auto and 1 with default provenance", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "no-global.json") };
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.changeManifest, "auto");
			assert.equal(snap.value.changeManifestDepth, 1);
			assert.equal(snap.provenance.get("changeManifest")?.source, "default");
			assert.equal(snap.provenance.get("changeManifestDepth")?.source, "default");
		});
	});

	it("changeManifest / changeManifestDepth: global applies, project overrides, invalid values fall back", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { changeManifest: "off", changeManifestDepth: 3 });
			invalidateGoalSettingsCache();
			let snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.changeManifest, "off", "global-only value applies");
			assert.equal(snap.value.changeManifestDepth, 3, "global-only depth applies");
			assert.equal(snap.provenance.get("changeManifest")?.source, "global");

			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { changeManifest: "auto", changeManifestDepth: 0 });
			invalidateGoalSettingsCache();
			snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.changeManifest, "auto", "project overrides global enum");
			assert.equal(snap.value.changeManifestDepth, 0, "explicit project zero overrides global positive (0 = no downward scan)");
			assert.equal(snap.provenance.get("changeManifestDepth")?.source, "project");

			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { changeManifest: "sometimes", changeManifestDepth: -2 });
			invalidateGoalSettingsCache();
			snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.changeManifest, "off", "invalid enum value falls back to the lower layer");
			assert.equal(snap.value.changeManifestDepth, 3, "invalid depth falls back to the lower layer");
			assert.ok(
				snap.project.diagnostics.some((d) => d.settingPath === "changeManifest" && d.code === "invalid_value"),
				"invalid enum value is diagnosed",
			);
			assert.ok(
				snap.project.diagnostics.some((d) => d.settingPath === "changeManifestDepth" && d.code === "invalid_value"),
				"invalid depth is diagnosed",
			);
		});
	});

	it("auditorTimeoutMs: global-only setting applies when project absent", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { auditorTimeoutMs: 3_600_000 });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).auditorTimeoutMs, 3_600_000);
		});
	});

	it("auditorTimeoutMs: project layer overrides global layer", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { auditorTimeoutMs: 3_600_000 });
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { auditorTimeoutMs: 7_200_000 });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).auditorTimeoutMs, 7_200_000, "project value wins inside the project");
		});
	});

	it("auditorTimeoutMs: unset resolves to the phantom default and default provenance", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.auditorTimeoutMs, undefined, "auditor applies its built-in 30-minute default");
			assert.equal(snap.provenance.get("auditorTimeoutMs")?.source, "default");
		});
	});

	it("auditorTimeoutMs: out-of-range values produce diagnostics and fall back", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { auditorTimeoutMs: 2_147_483_648 });
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.auditorTimeoutMs, undefined, "invalid value is dropped, default cap applies");
			assert.ok(snap.diagnostics.some((d) => d.code === "invalid_value" && d.scope === "global" && d.settingPath === "auditorTimeoutMs"));
		});
	});
});
