// Fork harness: preserve the lightweight shim for mock-only suites while testing
// upstream's real-SDK contracts against the plugin's Pi 1.2 minimum.
import * as fs from "node:fs";
import * as path from "node:path";
import "./isolated-temp-root.mjs";

// Project discovery considers USERPROFILE a home boundary even on Unix. Keep
// fixtures from inheriting host ancestor .agents/.pi directories outside their
// allocated test root, without changing the isolated HOME used for user files.
process.env.USERPROFILE = process.env.PI_SUBAGENTS_TEMP_ROOT;
fs.mkdirSync(process.env.HOME, { recursive: true });

// These mocked child-session tests do not exercise Git. Avoid scanning the
// caller's potentially huge, unmerged worktree for every foreground attempt.
if (path.basename(process.argv[1] ?? "") === "run-child-session.test.ts") {
	const isolatedCwd = path.join(process.env.PI_SUBAGENTS_TEMP_ROOT, "child-session-cwd");
	fs.mkdirSync(isolatedCwd, { recursive: true });
	process.env.GIT_CEILING_DIRECTORIES = process.env.PI_SUBAGENTS_TEMP_ROOT;
	process.chdir(isolatedCwd);
}

const realSdkSuites = new Set([
	"child-commands.test.ts",
	"child-prompt-sections.test.ts",
	"child-session-commands.test.ts",
	"child-session-append-system.test.ts",
	"command-action.test.ts",
	"declaration-pinning.test.ts",
	"fork-tool-declarations.test.ts",
	"fork-context.test.ts",
	"in-process-child.test.ts",
	"notify.test.ts",
	"parent-wake.test.ts",
	"required-child-extensions.test.ts",
	"session-liveness-delivery.test.ts",
	"subagent-messages.test.ts",
	"subagent-prompt-runtime.test.ts",
]);
if (realSdkSuites.has(path.basename(process.argv[1] ?? ""))) {
	await import("./fork-real-sdk.mjs");
}
