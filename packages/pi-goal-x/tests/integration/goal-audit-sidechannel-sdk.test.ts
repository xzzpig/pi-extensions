/**
 * Task 6.1 gate: run the REAL SDK worker (design D8).
 *
 * The worker must not inherit the Goal-X stub preload, so it is spawned as a
 * separate process WITHOUT the adapter/test hooks. `NODE_OPTIONS` is cleared
 * for the child because that variable is how this repository injects the
 * `--import` stub preload into a test run; a child that saw it would be testing
 * mocks instead of the genuine @earendil-works SDK, and the evidence would be
 * worthless.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../goal-audit-sidechannel-sdk-worker.ts", import.meta.url));

test(
	"6.1 the default side-session factory runs against the real SDK with no stub",
	{ timeout: 180_000 },
	async () => {
		// Drop the parent's test context so the child emits observable TAP, and
		// clear NODE_OPTIONS so no stub preload can leak into the real run.
		const { NODE_TEST_CONTEXT: _dropped, NODE_OPTIONS: _preload, ...childEnv } = process.env;
		const { stdout, stderr } = await promisify(execFile)(
			process.execPath,
			["--experimental-strip-types", "--test", worker],
			{ timeout: 170_000, env: childEnv, cwd: path.dirname(worker) },
		);
		const output = `${stdout}\n${stderr}`;
		assert.match(output, /pass 6/, `the real SDK worker must run all six cases:\n${output}`);
		assert.match(output, /fail 0/, `no real SDK case may fail:\n${output}`);
		assert.doesNotMatch(output, /cancelled [1-9]/, `no real SDK case may be cancelled:\n${output}`);
		assert.doesNotMatch(output, /skipped [1-9]/, `no real SDK case may be skipped:\n${output}`);
	},
);