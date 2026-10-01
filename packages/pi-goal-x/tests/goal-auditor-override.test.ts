// [fork] Tests for the per-goal completion-auditor override registry (S1 seam,
// ./extensions/goal-auditor-override.ts). Pins the S1 contract:
//   - no override → the exact global settings (same reference), so the plain
//     /goal completion path stays byte-identical;
//   - an override merges goal-level auditor leaves over the global resolution
//     (goal wins per leaf, untouched leaves keep the global value);
//   - a corrupt override (out-of-band garbage or invalid leaves) falls back to
//     the global settings instead of blocking or altering a completion;
//   - setGoalAuditorOverride validates atomically and rejects definition-tier
//     leaves (agent-definition customization belongs to the S2 resolver).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	clearGoalAuditorOverride,
	getGoalAuditorOverride,
	loadGoalSettingsWithAuditorOverride,
	mergeGoalAuditorOverride,
	setGoalAuditorOverride,
	type GoalAuditorOverride,
} from "../extensions/goal-auditor-override.ts";
import { invalidateGoalSettingsCache, loadGoalSettings } from "../extensions/goal-settings.ts";

const OVERRIDE_REGISTRY_KEY = Symbol.for("@xzzpig/pi-goal-x/auditor-overrides");

function plantOverride(goalId: string, value: unknown): void {
	const registry = (globalThis as typeof globalThis & Record<symbol, Map<string, unknown> | undefined>)[OVERRIDE_REGISTRY_KEY];
	assert.ok(registry instanceof Map, "the override registry must exist once the module is loaded");
	registry!.set(goalId, value);
}

function globalOnlyEnv(dir: string): NodeJS.ProcessEnv {
	return { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "no-global.json") };
}

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-auditor-override-")));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

afterEach(() => {
	(globalThis as typeof globalThis & Record<symbol, Map<string, unknown> | undefined>)[OVERRIDE_REGISTRY_KEY]?.clear();
	invalidateGoalSettingsCache();
});

test("S1: no override merges to the exact global settings object (plain /goal path unchanged)", () => {
	withTempDir((dir) => {
		const env = globalOnlyEnv(dir);
		const settings = loadGoalSettings(dir, env);
		assert.equal(mergeGoalAuditorOverride(settings, "goal-a"), settings, "the same object reference is returned");
		assert.deepEqual(loadGoalSettingsWithAuditorOverride(dir, "goal-a", env), settings, "the seam load equals the plain load");
		assert.equal(loadGoalSettingsWithAuditorOverride(dir, "goal-a", env).auditor?.agent, "goal-auditor");
	});
});

test("S1: goal-level leaves win over global; untouched leaves keep the global resolution", () => {
	withTempDir((dir) => {
		const globalSettingsPath = path.join(dir, "global.json");
		fs.writeFileSync(globalSettingsPath, JSON.stringify({
			auditor: {
				checklistExtra: ["Global extra item"],
				reportFormat: "Two paragraphs.",
			},
		}), "utf8");
		const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: globalSettingsPath };
		invalidateGoalSettingsCache();
		const settings = loadGoalSettings(dir, env);
		assert.equal(settings.auditor?.checklistExtra?.[0], "Global extra item");

		setGoalAuditorOverride("goal-overridden", {
			agent: "opsx-reviewer",
			checklistExtra: ["Plan-conformance check", "Scope-fidelity check"],
		});
		const merged = mergeGoalAuditorOverride(settings, "goal-overridden");
		assert.equal(merged.auditor?.agent, "opsx-reviewer", "the goal-level agent wins");
		assert.deepEqual(merged.auditor?.checklistExtra, ["Plan-conformance check", "Scope-fidelity check"], "the goal-level checklist wins");
		assert.equal(merged.auditor?.reportFormat, "Two paragraphs.", "untouched prompt leaves keep the global value");
		assert.equal(merged.auditor?.disabled, false, "resolved defaults survive the merge");
		assert.equal(merged.auditor?.changeManifest, "auto", "resolved defaults survive the merge");
		assert.equal(merged.subtaskDepth, settings.subtaskDepth, "non-auditor settings pass through");
		assert.notEqual(merged, settings, "the merged value is a copy, not a mutation of the global settings");
		assert.equal(settings.auditor?.agent, "goal-auditor", "the input settings object is never mutated");

		const other = mergeGoalAuditorOverride(settings, "goal-untouched");
		assert.equal(other, settings, "a different goal id without an override keeps the exact global object");
	});
});

test("S1: a corrupt override falls back to the global settings", () => {
	withTempDir((dir) => {
		const env = globalOnlyEnv(dir);
		const settings = loadGoalSettings(dir, env);

		plantOverride("goal-corrupt-all", "not-an-object");
		assert.equal(mergeGoalAuditorOverride(settings, "goal-corrupt-all"), settings, "a non-object entry is ignored wholesale");

		plantOverride("goal-corrupt-leaves", {
			agent: 42,
			checklistExtra: "not-a-list",
			disabled: "yes",
			strictness: "harsh",
			timeoutMs: -1,
			thinkingLevel: "extreme",
		});
		assert.equal(mergeGoalAuditorOverride(settings, "goal-corrupt-leaves"), settings, "an entry with only invalid leaves is ignored wholesale");

		plantOverride("goal-half-corrupt", { agent: "opsx-reviewer", checklistExtra: 123 });
		const merged = mergeGoalAuditorOverride(settings, "goal-half-corrupt");
		assert.equal(merged.auditor?.agent, "opsx-reviewer", "the valid leaf still applies");
		assert.equal(merged.auditor?.checklistExtra, undefined, "the invalid leaf falls back to the global value");

		plantOverride("goal-unknown-leaf", { totallyUnknown: true });
		assert.equal(mergeGoalAuditorOverride(settings, "goal-unknown-leaf"), settings, "an entry with only unknown leaves is ignored wholesale");
	});
});

test("S1: setGoalAuditorOverride validates atomically and rejects definition-tier leaves", () => {
	withTempDir(() => {
		assert.throws(() => setGoalAuditorOverride("goal-x", { agent: 42 } as unknown as GoalAuditorOverride), /invalid goal auditor override leaf 'agent'/);
		assert.throws(() => setGoalAuditorOverride("goal-x", {} as GoalAuditorOverride), /must set at least one auditor leaf/);
		assert.throws(() => setGoalAuditorOverride("goal-x", [] as unknown as GoalAuditorOverride), /must be an object/);
		assert.throws(() => setGoalAuditorOverride("  ", { agent: "opsx-reviewer" }), /goalId/);
		assert.throws(
			() => setGoalAuditorOverride("goal-x", { systemPromptExtra: "definition tier" } as unknown as GoalAuditorOverride),
			/registerAuditorAgentResolver/,
			"definition-tier leaves are rejected: agent definition customization belongs to the S2 resolver",
		);
		assert.throws(
			() => setGoalAuditorOverride("goal-x", { tools: ["read"] } as unknown as GoalAuditorOverride),
			/registerAuditorAgentResolver/,
		);
		assert.equal(getGoalAuditorOverride("goal-x"), undefined, "failed writes leave the registry untouched (atomic)");

		setGoalAuditorOverride("goal-x", { agent: "opsx-reviewer", checklistExtra: ["C1"] });
		const stored = getGoalAuditorOverride("goal-x");
		assert.deepEqual(stored, { agent: "opsx-reviewer", checklistExtra: ["C1"] });
		stored!.checklistExtra!.push("mutated");
		assert.deepEqual(getGoalAuditorOverride("goal-x")?.checklistExtra, ["C1"], "the stored override is a defensive copy");

		setGoalAuditorOverride("goal-x", { agent: "second-reviewer" });
		assert.deepEqual(getGoalAuditorOverride("goal-x"), { agent: "second-reviewer" }, "re-registering for the same goal replaces (latter wins)");

		clearGoalAuditorOverride("goal-x");
		assert.equal(getGoalAuditorOverride("goal-x"), undefined, "clearing an absent override is a no-op");
	});
});

test("S1: the completion seam still reads the override through goal-completion.ts", () => {
	const seamSource = fs.readFileSync(fileURLToPath(new URL("../extensions/goal-completion.ts", import.meta.url)), "utf8");
	assert.equal(
		(seamSource.match(/loadGoalSettingsWithAuditorOverride\(ctx\.cwd, auditTarget\.id\)/g) ?? []).length,
		1,
		"the completion settings read point goes through the S1 merge exactly once",
	);
	assert.match(seamSource, /from "\.\/goal-auditor-override\.ts"/, "the fork merge module is imported by the completion flow");
});
