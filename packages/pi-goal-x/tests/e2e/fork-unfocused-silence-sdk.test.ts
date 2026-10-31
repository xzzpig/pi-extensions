/**
 * Fork-only real-SDK e2e entry for `silence-unfocused-goal-prompts`: the worker
 * asserts against the actual outbound request bodies assembled by Pi across a
 * fresh session, a restored history with a compaction summary, a real reload,
 * and a focus -> unfocus cycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK: unfocused sessions send no other-goal guidance across restore, reload and unfocus", { timeout: 60000 }, async () => {
	const { NODE_TEST_CONTEXT: _dropped, ...env } = process.env;
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--experimental-strip-types", fileURLToPath(new URL("../unfocused-silence-sdk-worker.mjs", import.meta.url))],
		{ env, timeout: 55000 },
	);
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	// fresh tool loop (2) + fresh second turn (1) + restored history (1) +
	// reload (1) + focused turn (1) + unfocused turn (1): no goal-triggered request.
	assert.equal(result.providerRequests, 7);
	assert.deepEqual(result.phases, { fresh: 3, history: 1, reload: 1, focusCycle: 2 });
	assert.deepEqual(result.reminderOccurrences, { history: 1, reload: 1 });
});
