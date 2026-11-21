import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const worker = fileURLToPath(new URL("./fork-goal-resume-message-sdk-worker.ts", import.meta.url));

test("real SDK: resume with a message after interruption", { timeout: 60_000 }, async t => {
	// The package e2e runner preloads the Pi stubs. The worker needs the real SDK.
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_TEST_CONTEXT;
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--experimental-strip-types", "--test", worker],
		{ env, timeout: 55_000 },
	);
	t.diagnostic(stdout.trim());
});
