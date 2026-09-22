/**
 * [fork] Child launch tool-plan extensions: sandbox profiles, permission
 * profiles, and @xzzpig permission-system resolution preference. Moved out of
 * child-tool-plan-permission-system.test.ts so that file stays byte-identical
 * to upstream.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildInProcessChildLaunch, type BuildInProcessChildLaunchInput } from "../../src/runs/shared/child-launch.ts";
import {
	resolvePermissionSystemExtension,
	resolvePiLaunchToolPlan,
} from "../../src/runs/shared/child-tool-plan.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_SUBAGENT_PERMISSION_PROFILE: process.env.PI_SUBAGENT_PERMISSION_PROFILE,
};
const tempRoots: string[] = [];

function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "child-tool-plan-perm-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
	return { root, agentDir, projectDir };
}

afterEach(() => {
	for (const key of Object.keys(originalEnv)) {
		const value = originalEnv[key as keyof typeof originalEnv];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of tempRoots) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
	tempRoots.length = 0;
});

function childLaunch(overrides: Partial<BuildInProcessChildLaunchInput> = {}): BuildInProcessChildLaunchInput {
	return {
		host: "parent",
		cwd: process.cwd(),
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		childAgentName: "worker",
		childIndex: 0,
		...overrides,
	};
}

describe("resolvePermissionSystemExtension", () => {
	it("prefers the @xzzpig installation when both package variants are available", () => {
		const { agentDir } = createFixture();
		const forkDir = path.join(agentDir, "npm", "node_modules", "@xzzpig", "pi-permission-system");
		const upstreamDir = path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
		for (const [dir, name] of [
			[forkDir, "@xzzpig/pi-permission-system"],
			[upstreamDir, "@gotgenes/pi-permission-system"],
		]) {
			fs.mkdirSync(path.join(dir, "src"), { recursive: true });
			fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, pi: { extensions: ["./src/index.ts"] } }));
			fs.writeFileSync(path.join(dir, "src", "index.ts"), "export default () => {};");
		}
		assert.equal(resolvePermissionSystemExtension(), path.join(forkDir, "src", "index.ts"));
	});
});

describe("resolvePiLaunchToolPlan with sandbox profiles", () => {
	function installSandboxExtension(agentDir: string): string {
		const extDir = path.join(agentDir, "extensions", "pi-sandbox");
		const entryPath = path.join(extDir, "src", "index.ts");
		fs.mkdirSync(path.dirname(entryPath), { recursive: true });
		fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({
			name: "@xzzpig/pi-sandbox",
			pi: { extensions: ["./src/index.ts"] },
		}));
		fs.writeFileSync(entryPath, "export default () => {};", "utf-8");
		return entryPath;
	}

	it("injects pi-sandbox and passes only the profile name for an explicit extension allowlist", () => {
		const { agentDir, projectDir } = createFixture();
		const sandboxEntry = installSandboxExtension(agentDir);
		const { session } = buildInProcessChildLaunch(childLaunch({
			host: "runner",
			extensions: [sandboxEntry],
			cwd: projectDir,
			sandbox: "reviewer-strict",
			projectTrusted: true,
			trustedProjectCwd: projectDir,
		}));

		assert.equal(session.ambientExtensions, false);
		assert.deepEqual(session.extensionPaths.filter((entry) => entry === sandboxEntry), [sandboxEntry]);
		assert.ok(session.extensionPaths.some((entry) => entry.endsWith("sandbox-profile-guard.ts")));
		const env = session.processEnv ?? {};
		assert.equal(env.PI_SUBAGENT_SANDBOX_PROFILE, "reviewer-strict");
		assert.equal(env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED, "1");
		assert.match(env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH ?? "", /sandbox-profile-acks\/[0-9a-f-]{36}\.json$/);
		assert.match(env.PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN ?? "", /^[0-9a-f-]{36}$/);
		assert.equal(Object.keys(env).some((key) => key.includes("SANDBOX_CONFIG")), false);
	});

	it("does not extend trusted project configuration to a child with a different cwd", () => {
		const { agentDir, projectDir } = createFixture();
		const sandboxEntry = installSandboxExtension(agentDir);
		const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-profile-child-"));
		tempRoots.push(childCwd);
		const { session } = buildInProcessChildLaunch(childLaunch({
			host: "runner",
			extensions: [sandboxEntry],
			cwd: childCwd,
			sandbox: "reviewer-strict",
			projectTrusted: true,
			trustedProjectCwd: projectDir,
		}));

		assert.equal(session.processEnv?.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED, "0");
	});

	it("extends trusted project configuration to a child inside the trusted project tree (subdirectory inheritance)", () => {
		const { agentDir, projectDir } = createFixture();
		const sandboxEntry = installSandboxExtension(agentDir);
		const childCwd = path.join(projectDir, "packages", "svc");
		fs.mkdirSync(childCwd, { recursive: true });
		const { session } = buildInProcessChildLaunch(childLaunch({
			host: "runner",
			extensions: [sandboxEntry],
			cwd: childCwd,
			sandbox: "reviewer-strict",
			projectTrusted: true,
			trustedProjectCwd: projectDir,
		}));

		// Platform trust is ancestor-inheriting (findNearestTrustEntry walks up
		// from the child cwd): a child launched inside the trusted project tree —
		// a subdirectory included — is trusted the same as a child at the project
		// root. This must match what the child's own ctx.isProjectTrusted()
		// returns for that cwd, which is the channel the permission side uses, so
		// both definition sides conclude the same project state.
		assert.equal(session.processEnv?.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED, "1");
	});

	it("fails closed when a profile needs pi-sandbox but no package is installed", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		assert.throws(
			() => resolvePiLaunchToolPlan({ sandbox: "reviewer-strict" }),
			/pi-sandbox is not installed/,
		);
	});

	it("fails closed when the installed pi-sandbox manifest is malformed", () => {
		const { agentDir } = createFixture();
		const extDir = path.join(agentDir, "extensions", "pi-sandbox");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(path.join(extDir, "package.json"), "{ malformed", "utf-8");
		assert.throws(
			() => resolvePiLaunchToolPlan({ sandbox: "reviewer-strict" }),
			/Cannot read sandbox package manifest/,
		);
	});

	it("fails closed when the sandbox manifest names a different package", () => {
		const { agentDir } = createFixture();
		const extDir = path.join(agentDir, "extensions", "pi-sandbox");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({
			name: "unrelated-extension",
			pi: { extensions: ["./index.ts"] },
		}), "utf-8");
		fs.writeFileSync(path.join(extDir, "index.ts"), "export default () => {};", "utf-8");

		assert.throws(
			() => resolvePiLaunchToolPlan({ sandbox: "reviewer-strict" }),
			/must declare name '@xzzpig\/pi-sandbox' or 'pi-sandbox'/,
		);
	});

	it("fails closed when the sandbox manifest entry escapes its package directory", () => {
		const { agentDir } = createFixture();
		const extDir = path.join(agentDir, "extensions", "pi-sandbox");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "escaped.ts"), "export default () => {};", "utf-8");
		fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({
			name: "@xzzpig/pi-sandbox",
			pi: { extensions: ["../escaped.ts"] },
		}), "utf-8");

		assert.throws(
			() => resolvePiLaunchToolPlan({ sandbox: "reviewer-strict" }),
			/must remain inside/,
		);
	});

	it("fails closed when a sandbox entry symlink resolves outside its package directory", { skip: process.platform === "win32" ? "symlink permission varies on Windows" : undefined }, () => {
		const { agentDir } = createFixture();
		const extDir = path.join(agentDir, "extensions", "pi-sandbox");
		const escapedEntry = path.join(agentDir, "extensions", "escaped-symlink-target.ts");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(escapedEntry, "export default () => {};", "utf-8");
		fs.symlinkSync(escapedEntry, path.join(extDir, "entry.ts"));
		fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({
			name: "@xzzpig/pi-sandbox",
			pi: { extensions: ["./entry.ts"] },
		}), "utf-8");

		assert.throws(
			() => resolvePiLaunchToolPlan({ sandbox: "reviewer-strict" }),
			/resolves outside/,
		);
	});

	it("fails closed when an extension ceiling denies a requested profile", () => {
		createFixture();
		assert.throws(
			() => resolvePiLaunchToolPlan({
				sandbox: "reviewer-strict",
				capabilityCeiling: {
					version: 1,
					denyExtensions: true,
					sources: ["test"],
				},
			}),
			/requires the pi-sandbox child extension, but this launch denies child extensions/,
		);
	});
});

describe("resolvePiLaunchToolPlan with permission profiles", () => {
	function installPermissionSystemExtension(agentDir: string): string {
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		const entryPath = path.join(extDir, "src", "index.ts");
		fs.mkdirSync(path.dirname(entryPath), { recursive: true });
		fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({
			name: "@xzzpig/pi-permission-system",
			pi: { extensions: ["./src/index.ts"] },
		}));
		fs.writeFileSync(entryPath, "export default () => {};", "utf-8");
		return entryPath;
	}

	it("injects pi-permission-system and passes only the profile name for an explicit extension allowlist", () => {
		const { agentDir, projectDir } = createFixture();
		const permEntry = installPermissionSystemExtension(agentDir);
		const { session } = buildInProcessChildLaunch(childLaunch({
			host: "runner",
			extensions: [permEntry],
			cwd: projectDir,
			permissionProfile: "reviewer-strict",
			projectTrusted: true,
			trustedProjectCwd: projectDir,
		}));

		assert.equal(session.ambientExtensions, false);
		assert.deepEqual(session.extensionPaths.filter((entry) => entry === permEntry), [permEntry]);
		const env = session.processEnv ?? {};
		assert.equal(env.PI_SUBAGENT_PERMISSION_PROFILE, "reviewer-strict");
		// Only the validated name crosses the boundary — never the rules.
		assert.equal(Object.keys(env).some((key) => key.includes("PERMISSION_RULES") || key.includes("PERMISSION_CONFIG")), false);
		assert.ok(session.transientProcessEnv?.includes("PI_SUBAGENT_PERMISSION_PROFILE"));
	});

	it("pins an unset permission profile so a child cannot inherit the host session's role", () => {
		const { projectDir } = createFixture();
		const previous = process.env.PI_SUBAGENT_PERMISSION_PROFILE;
		// The host session selected a role profile; the child declares none.
		process.env.PI_SUBAGENT_PERMISSION_PROFILE = "session-role";
		try {
			const { session } = buildInProcessChildLaunch(
				childLaunch({ host: "runner", cwd: projectDir }),
			);
			const env = session.processEnv ?? {};
			assert.equal(
				Object.prototype.hasOwnProperty.call(env, "PI_SUBAGENT_PERMISSION_PROFILE"),
				true,
				"the key must be pinned even when the child declares no profile",
			);
			assert.equal(env.PI_SUBAGENT_PERMISSION_PROFILE, undefined);
			assert.equal(
				env.PI_SUBAGENT_PERMISSION_PROFILE_PINNED,
				"1",
				"the launcher marker is what tells pi-permission-system the selection is pinned",
			);
			assert.ok(
				session.transientProcessEnv?.includes("PI_SUBAGENT_PERMISSION_PROFILE"),
				"the host value must be restored after the child session is created",
			);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_PERMISSION_PROFILE;
			else process.env.PI_SUBAGENT_PERMISSION_PROFILE = previous;
		}
	});

	it("fails closed when a permission profile needs pi-permission-system but no package is installed", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		assert.throws(
			() => resolvePiLaunchToolPlan({ permissionProfile: "reviewer-strict" }),
			/pi-permission-system is not installed/,
		);
	});

	it("fails closed when the launch denies child extensions", () => {
		const { agentDir } = createFixture();
		installPermissionSystemExtension(agentDir);
		assert.throws(
			() => resolvePiLaunchToolPlan({
				permissionProfile: "reviewer-strict",
				capabilityCeiling: { version: 1, denyExtensions: true },
			}),
			/denies child extensions/,
		);
	});

	it("rejects invalid permission-profile names at the tool plan", () => {
		const { agentDir } = createFixture();
		installPermissionSystemExtension(agentDir);
		assert.throws(
			() => resolvePiLaunchToolPlan({ permissionProfile: "../escape" }),
			/letters, digits, underscores, or hyphens/,
		);
	});
});
