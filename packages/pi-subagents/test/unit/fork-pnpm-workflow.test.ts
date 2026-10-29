import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const setupAction = "./packages/pi-subagents/.github/actions/fork-setup";
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

it("uses the frozen pnpm workspace for package CI and the standalone gate", () => {
	assert.equal(fs.existsSync(path.join(root, "package-lock.json")), false);
	const action = parse(read(".github/actions/fork-setup/action.yml"));
	const commands = action.runs.steps.map((step: { run?: string }) => step.run).filter(Boolean);
	assert.ok(commands.includes("pnpm install --frozen-lockfile --ignore-scripts"));
	assert.ok(commands.includes("pnpm --filter @xzzpig/pi-components run build"));
	for (const file of [".github/workflows/test.yml", ".github/workflows/release.yml"]) {
		const content = read(file);
		const workflow = parse(content);
		assert.equal(workflow.defaults.run["working-directory"], "packages/pi-subagents");
		assert.doesNotMatch(content, /npm ci\b/u);
		for (const job of Object.values(workflow.jobs) as Array<{ steps: Array<{ uses?: string }> }>) {
			assert.equal(job.steps.filter((step) => step.uses === setupAction).length, 1);
		}
	}
	const tests = parse(read(".github/workflows/test.yml"));
	for (const jobName of ["runner-loader-capability", "clean-install"]) {
		const steps = tests.jobs[jobName].steps as Array<{ uses?: string; with?: { "node-version"?: string | number } }>;
		const install = steps.findIndex((step) => step.uses === setupAction);
		assert.equal(String(steps[install - 1]?.with?.["node-version"]), "24");
		assert.ok(steps[install + 1]?.with?.["node-version"], "the runtime matrix switches Node after pnpm installation");
	}
	const matrix = read("test/smoke/standalone-matrix.mjs");
	assert.match(matrix, /\.\.\/\.\.\/pnpm-lock\.yaml/u);
	assert.doesNotMatch(matrix, /"package-lock\.json"/u);
});
