/**
 * [fork] Preflight contract extensions: sandbox-profile provenance and
 * project-trust checks. Moved out of preflight.test.ts so that file stays
 * byte-identical to upstream.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";

let tempDir = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAgentDir: string | undefined;

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function installSandboxExtension(agentDir: string): string {
	const extensionRoot = path.join(agentDir, "extensions", "pi-sandbox");
	const entryPath = path.join(extensionRoot, "index.ts");
	fs.mkdirSync(extensionRoot, { recursive: true });
	fs.writeFileSync(path.join(extensionRoot, "package.json"), JSON.stringify({
		name: "@xzzpig/pi-sandbox",
		pi: { extensions: ["./index.ts"] },
	}));
	fs.writeFileSync(entryPath, "export default () => {};", "utf-8");
	return entryPath;
}

describe("public launch contract preflight", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-"));
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const home = path.join(tempDir, "home");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("binds a sandbox profile and force-injected extension into preflight provenance", async () => {
		const cwd = path.join(tempDir, "sandbox-profile-repo");
		fs.mkdirSync(cwd, { recursive: true });
		const sandboxEntry = installSandboxExtension(process.env.PI_CODING_AGENT_DIR!);
		writeAgent(path.join(cwd, ".pi", "agents", "reviewer.md"), `---
name: reviewer
description: Sandboxed reviewer
sandbox: reviewer-strict
extensions: ./other-extension.ts
---
Review carefully.
`);

		const result = await resolveSubagentLaunchContract({
			agent: "reviewer",
			cwd,
			task: "Review the change",
			projectTrusted: true,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.contract.sandbox, "reviewer-strict");
		assert.ok(result.contract.tools.runtimeExtensions.includes(sandboxEntry));
		assert.ok(result.contract.tools.runtimeExtensions.some((entry) => entry.endsWith("sandbox-profile-guard.ts")));
		assert.ok(result.contract.tools.extensionArgs.includes(sandboxEntry));
		assert.equal(result.contract.tools.disableAmbientExtensions, true);
	});

	it("fails preflight for an untrusted project-scoped sandbox selector", async () => {
		const cwd = path.join(tempDir, "sandbox-untrusted-repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "reviewer.md"), `---
name: reviewer
description: Sandboxed reviewer
sandbox: reviewer-strict
---
Review carefully.
`);

		const result = await resolveSubagentLaunchContract({ agent: "reviewer", cwd, task: "Review" });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "untrusted_project");
			assert.match(result.message, /project is not trusted/);
		}
	});

	it("rejects a project-scoped profile when preflight cwd differs from trusted project cwd", async () => {
		const cwd = path.join(tempDir, "sandbox-cross-cwd-repo");
		const trustedCwd = path.join(tempDir, "trusted-root");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(trustedCwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "reviewer.md"), `---\nname: reviewer\ndescription: Sandboxed reviewer\nsandbox: reviewer-strict\n---\nReview carefully.\n`);

		const result = await resolveSubagentLaunchContract({
			agent: "reviewer",
			cwd,
			projectTrusted: true,
			trustedProjectCwd: trustedCwd,
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "untrusted_project");
			assert.match(result.message, /does not match trusted project cwd/);
		}
	});
});
