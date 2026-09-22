import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerSandboxProfileGuard, {
	projectScopedProfileTrustError,
} from "../../src/runs/shared/sandbox-profile-guard.ts";

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

// u-3.3: the selection-side guard (projectScopedProfileTrustError) coexists with
// the new definition side — it still decides whether a project-declared agent may
// select a profile, independent of whether the profile name resolves in the
// project registry. Both kinds (sandbox/permission) and both message styles
// (preflight/executor) must give the same trusted-pass / untrusted-refuse verdict
// that they did before the change.
describe("projectScopedProfileTrustError coexistence", () => {
	const common = {
		agentName: "reviewer",
		profileName: "reviewer-strict",
		projectScoped: true,
		messageStyle: "preflight" as const,
	};

	it("lets a project-scoped sandbox selection pass in a trusted project at the project cwd", () => {
		assert.equal(
			projectScopedProfileTrustError({
				...common,
				kind: "sandbox",
				trustedCwd: "/work/app",
				effectiveCwd: "/work/app",
			}),
			undefined,
		);
	});

	it("refuses a project-scoped sandbox selection when the project is not trusted", () => {
		const error = projectScopedProfileTrustError({
			...common,
			kind: "sandbox",
			trustedCwd: undefined,
			effectiveCwd: "/work/app",
		});
		assert.match(error ?? "", /project is not trusted/);
	});

	it("refuses a project-scoped sandbox selection when the child cwd differs from the trusted project cwd", () => {
		const error = projectScopedProfileTrustError({
			...common,
			kind: "sandbox",
			trustedCwd: "/work/app",
			effectiveCwd: "/other/child",
		});
		assert.match(error ?? "", /does not match trusted project cwd/);
	});

	it("lets a project-scoped permission selection pass in a trusted project at the project cwd", () => {
		assert.equal(
			projectScopedProfileTrustError({
				...common,
				kind: "permission",
				trustedCwd: "/work/app",
				effectiveCwd: "/work/app",
			}),
			undefined,
		);
	});

	it("refuses a project-scoped permission selection when the project is not trusted", () => {
		const error = projectScopedProfileTrustError({
			...common,
			kind: "permission",
			trustedCwd: undefined,
			effectiveCwd: "/work/app",
		});
		assert.match(error ?? "", /project is not trusted/);
	});

	it("uses the executor message style (child cwd) for executor-side refusals", () => {
		const error = projectScopedProfileTrustError({
			...common,
			kind: "permission",
			messageStyle: "executor",
			trustedCwd: "/work/app",
			effectiveCwd: "/other/child",
		});
		assert.match(error ?? "", /child cwd/);
		assert.match(error ?? "", /does not match the trusted project cwd/);
	});

	it("never blocks a selection that is not project-scoped", () => {
		for (const kind of ["sandbox", "permission"] as const) {
			for (const messageStyle of ["preflight", "executor"] as const) {
				assert.equal(
					projectScopedProfileTrustError({
						...common,
						kind,
						messageStyle,
						projectScoped: false,
						trustedCwd: undefined,
						effectiveCwd: "/work/app",
					}),
					undefined,
				);
			}
		}
	});

	it("passes executor-side project-scoped selections in a trusted project at the child cwd", () => {
		for (const kind of ["sandbox", "permission"] as const) {
			assert.equal(
				projectScopedProfileTrustError({
					...common,
					kind,
					messageStyle: "executor",
					trustedCwd: "/work/app",
					effectiveCwd: "/work/app",
				}),
				undefined,
			);
		}
	});

	it("refuses executor-side project-scoped selections when the project is not trusted", () => {
		for (const kind of ["sandbox", "permission"] as const) {
			const error = projectScopedProfileTrustError({
				...common,
				kind,
				messageStyle: "executor",
				trustedCwd: undefined,
				effectiveCwd: "/work/app",
			});
			assert.match(error ?? "", /project is not trusted/);
		}
	});
});
