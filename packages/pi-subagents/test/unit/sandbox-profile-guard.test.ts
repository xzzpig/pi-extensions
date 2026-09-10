import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerSandboxProfileGuard from "../../src/runs/shared/sandbox-profile-guard.ts";

const originalProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
const originalAckPath = process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH;
const originalAckToken = process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN;
const originalExitCode = process.exitCode;
const roots: string[] = [];

afterEach(() => {
	if (originalProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
	else process.env.PI_SUBAGENT_SANDBOX_PROFILE = originalProfile;
	if (originalAckPath === undefined) delete process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH;
	else process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH = originalAckPath;
	if (originalAckToken === undefined) delete process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN;
	else process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN = originalAckToken;
	process.exitCode = originalExitCode;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createMockPi() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	return {
		pi: {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(event, handler);
			},
		},
		handlers,
	};
}

function headlessContext(): ExtensionContext {
	return {
		hasUI: false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
}

test("profile launch guard blocks the first model turn until pi-sandbox acknowledges startup", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-sandbox-guard-"));
	roots.push(root);
	const acknowledgementPath = path.join(root, "sandbox-profile-startup.json");
	const token = "sandbox-startup-token";
	process.env.PI_SUBAGENT_SANDBOX_PROFILE = "reviewer-strict";
	process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH = acknowledgementPath;
	process.env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN = token;

	const { pi, handlers } = createMockPi();
	registerSandboxProfileGuard(pi as never);
	const input = handlers.get("input");
	assert.ok(input);

	assert.deepEqual(input!({ text: "Task: review" }, headlessContext()), { action: "handled" });
	assert.equal(process.exitCode, 1);

	process.exitCode = 0;
	fs.writeFileSync(acknowledgementPath, JSON.stringify({
		version: 1,
		profile: "reviewer-strict",
		token,
	}), "utf-8");
	assert.equal(input!({ text: "Task: review" }, headlessContext()), undefined);
	assert.equal(process.exitCode, 0);
});
