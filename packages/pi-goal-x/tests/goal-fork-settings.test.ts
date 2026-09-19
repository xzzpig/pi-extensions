import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	loadGoalSettings,
	loadSettingsSnapshot,
	invalidateGoalSettingsCache,
	parseGoalSettings,
	parseSettingsLayer,
	loadGoalSettingsFileConfig,
	saveGoalSettingsFileConfig,
	effectiveSettingsReport,
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
			assert.equal(snap.value.auditor?.changeManifest, "auto");
			assert.equal(snap.value.auditor?.changeManifestDepth, 1);
			assert.equal(snap.provenance.get("auditor.changeManifest")?.source, "default");
			assert.equal(snap.provenance.get("auditor.changeManifestDepth")?.source, "default");
		});
	});

	it("changeManifest / changeManifestDepth: global applies, project overrides, invalid values fall back", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { changeManifest: "off", changeManifestDepth: 3 });
			invalidateGoalSettingsCache();
			let snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.auditor?.changeManifest, "off", "global-only value applies");
			assert.equal(snap.value.auditor?.changeManifestDepth, 3, "global-only depth applies");
			assert.equal(snap.provenance.get("auditor.changeManifest")?.source, "global");

			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { changeManifest: "auto", changeManifestDepth: 0 });
			invalidateGoalSettingsCache();
			snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.auditor?.changeManifest, "auto", "project overrides global enum");
			assert.equal(snap.value.auditor?.changeManifestDepth, 0, "explicit project zero overrides global positive (0 = no downward scan)");
			assert.equal(snap.provenance.get("auditor.changeManifestDepth")?.source, "project");

			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { changeManifest: "sometimes", changeManifestDepth: -2 });
			invalidateGoalSettingsCache();
			snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.auditor?.changeManifest, "off", "invalid enum value falls back to the lower layer");
			assert.equal(snap.value.auditor?.changeManifestDepth, 3, "invalid depth falls back to the lower layer");
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
			assert.equal(loadGoalSettings(dir, env).auditor?.timeoutMs, 3_600_000);
		});
	});

	it("auditorTimeoutMs: project layer overrides global layer", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { auditorTimeoutMs: 3_600_000 });
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { auditorTimeoutMs: 7_200_000 });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).auditor?.timeoutMs, 7_200_000, "project value wins inside the project");
		});
	});

	it("auditorTimeoutMs: unset resolves to the phantom default and default provenance", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.auditor?.timeoutMs, undefined, "auditor applies its built-in 30-minute default");
			assert.equal(snap.provenance.get("auditor.timeoutMs")?.source, "default");
		});
	});

	it("auditorTimeoutMs: out-of-range values produce diagnostics and fall back", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { auditorTimeoutMs: 2_147_483_648 });
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.auditor?.timeoutMs, undefined, "invalid value is dropped, default cap applies");
			assert.ok(snap.diagnostics.some((d) => d.code === "invalid_value" && d.scope === "global" && d.settingPath === "auditorTimeoutMs"));
		});
	});
});

describe("fork settings: auditor profile selectors (sandbox / permissionProfile)", () => {
	it("parse: valid profile names are accepted as definition-tier leaves", () => {
		assert.deepEqual(
			parseGoalSettings({ auditor: { sandbox: "reviewer-strict", permissionProfile: "reviewer" } }),
			{ auditor: { sandbox: "reviewer-strict", permissionProfile: "reviewer" } },
		);
		assert.deepEqual(parseGoalSettings({ auditor: { sandbox: "sand-1", permissionProfile: "p_2" } }), {
			auditor: { sandbox: "sand-1", permissionProfile: "p_2" },
		});
	});

	it("parse: invalid profile names produce invalid_value diagnostics and do not land", () => {
		const { layer, diagnostics } = parseSettingsLayer(
			{ auditor: { sandbox: "false", permissionProfile: "a/b", agent: "custom" } },
			"project",
			"(inline)",
		);
		assert.equal(layer.auditor?.sandbox, undefined, "literal false is rejected and not persisted");
		assert.equal(layer.auditor?.permissionProfile, undefined, "path-like names are rejected and not persisted");
		assert.equal(layer.auditor?.agent, "custom", "valid sibling leaves survive the diagnostic");
		assert.ok(
			diagnostics.some((d) => d.code === "invalid_value" && d.settingPath === "auditor.sandbox" && d.message.includes("false")),
			"sandbox literal-false diagnostic names the leaf",
		);
		assert.ok(
			diagnostics.some((d) => d.code === "invalid_value" && d.settingPath === "auditor.permissionProfile"),
			"permissionProfile path-like name diagnostic names the leaf",
		);
	});

	it("parse: whitespace, over-long, and non-identifier profile names are rejected", () => {
		const long = "x".repeat(129);
		const ok = "x".repeat(128);
		for (const bad of ["", "  ", " padded ", "false", "a/b", "a b", "\u4e2d\u6587", long]) {
			const result = parseGoalSettings({ auditor: { sandbox: bad, permissionProfile: bad } });
			assert.equal(result.auditor, undefined, `rejects ${JSON.stringify(bad)}`);
		}
		assert.deepEqual(parseGoalSettings({ auditor: { sandbox: ok } }).auditor?.sandbox, ok, "128-char identifier is the accepted ceiling");
	});

	it("persistence: profile selectors round-trip and clear", () => {
		withTempDir((dir) => {
			saveGoalSettingsFileConfig(dir, { auditor: { sandbox: "reviewer-strict", permissionProfile: "reviewer" } });
			const loaded = loadGoalSettingsFileConfig(dir);
			assert.equal(loaded.auditor?.sandbox, "reviewer-strict", "sandbox selector persists");
			assert.equal(loaded.auditor?.permissionProfile, "reviewer", "permission profile selector persists");
			saveGoalSettingsFileConfig(dir, { auditor: { checklist: ["only x"] } });
			assert.equal(loadGoalSettingsFileConfig(dir).auditor?.sandbox, undefined, "cleared when omitted");
			assert.equal(loadGoalSettingsFileConfig(dir).auditor?.permissionProfile, undefined, "cleared when omitted");
		});
	});

	it("report: profile selector rows show unset or the selected name with provenance", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "no-global.json") };
			invalidateGoalSettingsCache();
			let lines = effectiveSettingsReport(dir, env);
			assert.ok(lines.some((l) => l.startsWith("  auditor sandbox profile (next session): (unset)")), "sandbox row present and unset");
			assert.ok(lines.some((l) => l.startsWith("  auditor permission profile (next session): (unset)")), "permission profile row present and unset");
			saveGoalSettingsFileConfig(dir, { auditor: { sandbox: "reviewer-strict", permissionProfile: "reviewer" } });
			invalidateGoalSettingsCache();
			lines = effectiveSettingsReport(dir, env);
			const sandboxRow = lines.find((l) => l.startsWith("  auditor sandbox profile (next session)"));
			const permissionRow = lines.find((l) => l.startsWith("  auditor permission profile (next session)"));
			assert.ok(sandboxRow?.includes("reviewer-strict (project)"), `sandbox row shows project override: ${sandboxRow}`);
			assert.ok(permissionRow?.includes("reviewer (project)"), `permission row shows project override: ${permissionRow}`);
		});
	});
});
