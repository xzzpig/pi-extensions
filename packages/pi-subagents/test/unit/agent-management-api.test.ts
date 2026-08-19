import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import {
	AGENT_MANAGEMENT_API_VERSION,
	ejectAgentDefinition,
} from "../../src/api/agent-management.ts";
import { discoverAgentsAll } from "../../src/agents/agents.ts";

let tempDir = "";
let projectDir = "";
let agentDir = "";
let packageDir = "";
let oldAgentDir: string | undefined;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function installPackagedAuditor(options: { missingResource?: boolean; missingSkill?: boolean } = {}): string {
	packageDir = path.join(agentDir, "npm", "node_modules", "test-goal-auditor");
	const extensionPath = path.join(packageDir, "extensions", "progress.ts");
	writeFile(path.join(packageDir, "package.json"), JSON.stringify({
		name: "test-goal-auditor",
		pi: { subagents: { agents: ["./agents"] } },
	}, null, 2));
	if (!options.missingResource) writeFile(extensionPath, "export default function extension() {}\n");
	writeFile(path.join(packageDir, "agents", "goal-auditor.md"), `---
name: goal-auditor
description: Packaged completion auditor
tools: read, ../tools/check.ts
subagentOnlyExtensions: ../extensions/progress.ts
skillPath: ../skills
${options.missingSkill ? "skills: missing-ejected-skill\n" : ""}---

Audit the goal.
`);
	writeFile(path.join(packageDir, "tools", "check.ts"), "export default function extension() {}\n");
	writeFile(path.join(packageDir, "skills", "audit", "SKILL.md"), "---\ndescription: Audit skill\n---\n\nAudit.\n");
	return extensionPath;
}

describe("public agent-management ejection API", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-api-"));
		projectDir = path.join(tempDir, "project");
		agentDir = path.join(tempDir, "agent-home");
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("exports a versioned API, copies portable package-relative resources, and keeps the ejected agent preflightable", async () => {
		assert.equal(AGENT_MANAGEMENT_API_VERSION, 1);
		const extensionPath = installPackagedAuditor();

		const ejected = ejectAgentDefinition({
			cwd: projectDir,
			agent: "goal-auditor",
			scope: "user",
		});

		assert.equal(ejected.ok, true);
		if (!ejected.ok) return;
		const targetPath = path.join(agentDir, "agents", "goal-auditor.md");
		assert.equal(ejected.targetPath, targetPath);
		assert.deepEqual(ejected.verification.resourcePaths, [
			path.join(packageDir, "extensions", "progress.ts"),
			path.join(packageDir, "skills"),
			path.join(packageDir, "tools", "check.ts"),
		].sort((a, b) => a.localeCompare(b)));
		assert.equal(fs.existsSync(targetPath), true);
		const content = fs.readFileSync(targetPath, "utf-8");
		assert.match(content, new RegExp(`subagentOnlyExtensions: ${extensionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(content, /skillPath: .+\/skills/);
		assert.match(content, /tools: read, .+\/tools\/check\.ts/);

		const copied = discoverAgentsAll(projectDir).user.find((agent) => agent.name === "goal-auditor");
		assert.ok(copied);
		assert.equal(copied.filePath, targetPath);
		assert.deepEqual(copied.subagentOnlyExtensions, [extensionPath]);
		assert.equal(ejected.verification.launchPreflighted, true);

		const preflight = await resolveSubagentLaunchContract({
			agent: "goal-auditor",
			cwd: projectDir,
			context: "fresh",
			availableModels: [],
			outputSchema: { type: "object", properties: {}, additionalProperties: false },
		});
		assert.equal(preflight.ok, true);
		if (!preflight.ok) return;
		assert.equal(preflight.contract.agent.source, "user");
		assert.equal(preflight.contract.agent.filePath, targetPath);
		assert.ok(preflight.contract.tools.extensionArgs.includes(extensionPath));
	});

	it("fails closed for project scope without affirmative trust", () => {
		installPackagedAuditor();
		const result = ejectAgentDefinition({
			cwd: projectDir,
			agent: "goal-auditor",
			scope: "project",
			projectTrusted: false,
		});

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "untrusted_project");
		assert.equal(fs.existsSync(path.join(projectDir, ".pi", "agents", "goal-auditor.md")), false);
	});

	it("does not create a target when a required package-relative resource is missing", () => {
		installPackagedAuditor({ missingResource: true });
		const result = ejectAgentDefinition({ cwd: projectDir, agent: "goal-auditor", scope: "user" });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "resource_missing");
		assert.equal(fs.existsSync(path.join(agentDir, "agents", "goal-auditor.md")), false);
	});

	it("removes the new file when the rediscovered agent fails launch preflight", () => {
		installPackagedAuditor({ missingSkill: true });
		const result = ejectAgentDefinition({ cwd: projectDir, agent: "goal-auditor", scope: "user" });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "preflight_failed");
		assert.match(result.message, /Missing skills: missing-ejected-skill/);
		assert.equal(fs.existsSync(path.join(agentDir, "agents", "goal-auditor.md")), false);
	});

	it("never overwrites an existing ejected definition", () => {
		installPackagedAuditor();
		const first = ejectAgentDefinition({ cwd: projectDir, agent: "goal-auditor", scope: "user" });
		assert.equal(first.ok, true);
		const targetPath = path.join(agentDir, "agents", "goal-auditor.md");
		const original = fs.readFileSync(targetPath, "utf-8");
		fs.writeFileSync(targetPath, `${original}\nCustom change.\n`, "utf-8");
		const changed = fs.readFileSync(targetPath, "utf-8");

		const second = ejectAgentDefinition({ cwd: projectDir, agent: "goal-auditor", scope: "user" });
		assert.equal(second.ok, false);
		if (second.ok) return;
		assert.equal(second.code, "existing_custom");
		assert.equal(fs.readFileSync(targetPath, "utf-8"), changed);
	});
});
