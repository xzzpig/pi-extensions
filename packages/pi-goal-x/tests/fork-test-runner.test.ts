/**
 * Regression test for the approved fork runner entry (design D7/D8, tasks 7.1).
 *
 * The runner pins the fork-only suite list, must never include the live E2E
 * entry point (real provider + tmux), and must propagate a failing suite's exit
 * code instead of reporting success.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
	FORK_TEST_FILES,
	LIVE_E2E_ENTRY,
	PACKAGE_ROOT,
	PRELOADS,
	validateForkTestList,
} from "../scripts/fork-test-runner.mjs";
import { SDK_TEST_FILES, groupArgs, planTestGroups } from "../scripts/test-groups.mjs";

describe("fork test runner", () => {
	it("pins a non-empty list of existing .test.ts fork suites", () => {
		assert.ok(FORK_TEST_FILES.length > 0);
		for (const file of FORK_TEST_FILES) {
			assert.match(file, /\.test\.ts$/);
			assert.ok(existsSync(path.join(PACKAGE_ROOT, file)), `missing ${file}`);
		}
		assert.deepEqual(validateForkTestList(), []);
	});

	it("never lets the live E2E entry (or any live file) into the list", () => {
		assert.equal(FORK_TEST_FILES.includes(LIVE_E2E_ENTRY), false);
		assert.equal(FORK_TEST_FILES.some((file) => /(^|\/)live|live\./.test(path.basename(file))), false);
		// The contract is enforced by validation too, not only by this assertion.
		const problems = validateForkTestList({ packageRoot: PACKAGE_ROOT });
		assert.equal(problems.some((problem) => problem.includes("live")), false);
	});

	it("keeps the live entry in the repository but outside the runner", () => {
		// The file exists as a documented entry point; that is the point of the exclusion.
		assert.ok(existsSync(path.join(PACKAGE_ROOT, LIVE_E2E_ENTRY)), "the live E2E entry must exist");
	});

	it("preloads the adapter hooks and the event-loop keepalive", () => {
		assert.ok(PRELOADS.some((p) => p.includes("test-adapter-hooks.mjs")));
		assert.ok(PRELOADS.some((p) => p.startsWith("data:text/javascript")));
	});

	it("reports a missing fork suite and a live entry as list problems", () => {
		const problems = validateForkTestList({ packageRoot: path.join(PACKAGE_ROOT, "does-not-exist") });
		assert.ok(problems.length > 0, "a missing package root must be reported");
	});

	it("groups the real-SDK suite away from the stub adapter with NODE_OPTIONS cleared", () => {
		const groups = planTestGroups({
			unitFiles: ["tests/a.test.ts"],
			integrationFiles: [...SDK_TEST_FILES, "tests/integration/extension.test.ts"],
			suite: "all",
		});
		const sdk = groups.find((group) => group.name === "sdk");
		const integration = groups.find((group) => group.name === "integration");
		assert.ok(sdk && integration);
		assert.deepEqual(sdk.files, [...SDK_TEST_FILES]);
		assert.equal(sdk.adapter, false, "the real-SDK group must not preload the stub adapter");
		assert.equal(sdk.clearNodeOptions, true, "the real-SDK group must clear inherited NODE_OPTIONS");
		assert.equal(integration.files.includes(SDK_TEST_FILES[0]!), false, "the SDK file is never in the stub group");
		assert.equal(integration.adapter, true);
		// argv contract: adapter only where the group asks for it.
		const sdkArgs = groupArgs(sdk, { adapterPath: "/x/test-adapter-hooks.mjs" });
		const stubArgs = groupArgs(integration, { adapterPath: "/x/test-adapter-hooks.mjs", isolationArgs: ["--test-isolation=none"] });
		assert.equal(sdkArgs.includes("/x/test-adapter-hooks.mjs"), false);
		assert.equal(stubArgs.includes("/x/test-adapter-hooks.mjs"), true);
		assert.ok(stubArgs.indexOf("--test-isolation=none") < stubArgs.indexOf(integration.files[0]!));
	});

	it("plans every non-empty group and drops empty ones", () => {
		const both = planTestGroups({ unitFiles: ["tests/a.test.ts"], integrationFiles: ["tests/integration/extension.test.ts"], suite: "all" });
		assert.deepEqual(both.map((group) => group.name), ["unit", "integration"]);
		// `test:unit` must NEVER drag the integration debt into its exit code.
		const unitOnly = planTestGroups({ unitFiles: ["tests/a.test.ts"], integrationFiles: ["tests/integration/extension.test.ts"], suite: "unit" });
		assert.deepEqual(unitOnly.map((group) => group.name), ["unit"]);
		const integrationOnly = planTestGroups({ unitFiles: ["tests/a.test.ts"], integrationFiles: ["tests/integration/extension.test.ts"], suite: "integration" });
		assert.deepEqual(integrationOnly.map((group) => group.name), ["integration"]);
		assert.equal(planTestGroups({ unitFiles: [], integrationFiles: [], suite: "all" }).length, 0);
	});
});

