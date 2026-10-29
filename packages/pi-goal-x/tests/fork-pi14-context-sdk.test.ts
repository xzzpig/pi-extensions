import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("context capture resolves the goal-x SDK rather than the hoisted workspace SDK", () => {
	const script = `
		import { readFileSync } from "node:fs";
		import { join } from "node:path";
		import { codingAgentRoot, createCodingTools, createReadOnlyTools, buildSystemPrompt, streamResponses }
			from "./experiments/context/fork-sdk-paths.mjs";
		console.log(JSON.stringify({
			version: JSON.parse(readFileSync(join(codingAgentRoot, "package.json"), "utf8")).version,
			functions: [createCodingTools, createReadOnlyTools, buildSystemPrompt, streamResponses].map(value => typeof value),
		}));
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "" },
	});
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.equal(output.version, "1.4.0");
	assert.deepEqual(output.functions, ["function", "function", "function", "function"]);
});
