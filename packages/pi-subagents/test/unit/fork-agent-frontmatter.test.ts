/**
 * [fork] Agent frontmatter extensions: sandbox profiles, permission profiles,
 * and injectToContext. Moved out of agent-frontmatter.test.ts so that file
 * stays byte-identical to upstream.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, type AgentConfig } from "../../src/agents/agents.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";

const tempDirs: string[] = [];

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent sandbox profile frontmatter", () => {
	it("parses and serializes a scalar sandbox profile selector", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-sandbox-profile-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, ".pi", "agents", "reviewer.md");
		writeAgent(filePath, `---
name: reviewer
description: Review safely
sandbox: reviewer-strict
---

Review the change.
`);

		const agent = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "reviewer");
		assert.equal(agent?.sandbox, "reviewer-strict");
		assert.match(serializeAgent(agent!), /^sandbox: reviewer-strict$/m);
	});

	it("rejects empty, traversal, object, and external-runner sandbox declarations", () => {
		const cases = [
			"sandbox:",
			"sandbox: false",
			"sandbox: ../escape",
			"sandbox:\n  network:\n    allowedDomains: [example.com]",
			"runner:\n  type: external-cli\n  command: node\nsandbox: reviewer-strict",
		];
		for (const [index, declaration] of cases.entries()) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagents-agent-sandbox-invalid-${index}-`));
			tempDirs.push(dir);
			writeAgent(path.join(dir, ".pi", "agents", "worker.md"), `---\nname: worker\ndescription: Worker\n${declaration}\n---\nWork.`);
			const discovered = discoverAgents(dir, "project");
			assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "worker")?.error ?? "", /sandbox|unsupported Pi-only fields/);
		}
	});
});

describe("agent permission-profile frontmatter", () => {
	it("parses and serializes a scalar permission-profile selector", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-permission-profile-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, ".pi", "agents", "reviewer.md");
		writeAgent(filePath, `---
name: reviewer
description: Review safely
permission-profile: reviewer-strict
---

Review the change.
`);

		const agent = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "reviewer");
		assert.equal(agent?.permissionProfile, "reviewer-strict");
		assert.match(serializeAgent(agent!), /^permission-profile: reviewer-strict$/m);
	});

	it("coexists with the permission frontmatter block and round-trips both", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-permission-profile-coexist-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, ".pi", "agents", "reviewer.md");
		writeAgent(filePath, `---
name: reviewer
description: Review safely
permission-profile: reviewer-strict
permission:
  write: deny
  edit: deny
---

Review the change.
`);

		const agent = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "reviewer");
		assert.equal(agent?.permissionProfile, "reviewer-strict");
		assert.ok(agent?.permissions);
		const serialized = serializeAgent(agent!);
		assert.match(serialized, /^permission-profile: reviewer-strict$/m);
		assert.match(serialized, /^permissions:/m);
		assert.match(serialized, /^  write: deny$/m);
	});

	it("rejects empty, traversal, object, false, and external-runner permission-profile declarations", () => {
		const cases = [
			"permission-profile:",
			"permission-profile: false",
			"permission-profile: ../escape",
			"permission-profile:\n  permission:\n    read: allow",
			"runner:\n  type: external-cli\n  command: node\npermission-profile: reviewer-strict",
		];
		for (const [index, declaration] of cases.entries()) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagents-agent-permission-profile-invalid-${index}-`));
			tempDirs.push(dir);
			writeAgent(path.join(dir, ".pi", "agents", "worker.md"), `---
name: worker
description: Worker
${declaration}
---
Work.`);
			const discovered = discoverAgents(dir, "project");
			assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "worker")?.error ?? "", /permission-profile|unsupported Pi-only fields/);
		}
	});
});

describe("agent frontmatter injectToContext", () => {
	it("serializes injectToContext into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "scout",
			description: "Scout",
			systemPrompt: "Recon",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/scout.md",
			injectToContext: true,
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /injectToContext: true/);
	});

	it("omits injectToContext when unset or false", () => {
		const unset: AgentConfig = {
			name: "scout",
			description: "Scout",
			systemPrompt: "Recon",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/scout.md",
		};
		const disabled: AgentConfig = { ...unset, injectToContext: false };

		assert.doesNotMatch(serializeAgent(unset), /injectToContext/);
		assert.doesNotMatch(serializeAgent(disabled), /injectToContext/);
	});

	it("parses injectToContext from discovered agent frontmatter and keeps it out of extraFields", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-inject-to-context-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
description: Scout
injectToContext: true
---

Recon
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const scout = result.agents.find((agent) => agent.name === "scout");
		assert.equal(scout?.injectToContext, true);
		assert.equal(scout?.extraFields?.injectToContext, undefined);
	});

	it("defaults injectToContext to false when frontmatter omits it or uses a non-true value", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-inject-defaults-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "plain.md"), `---
name: plain
description: Plain
---

Body
`, "utf-8");
		fs.writeFileSync(path.join(agentsDir, "truthy.md"), `---
name: truthy
description: Truthy
injectToContext: yes
---

Body
`, "utf-8");

		const result = discoverAgents(dir, "project");
		assert.equal(result.agents.find((agent) => agent.name === "plain")?.injectToContext ?? false, false);
		assert.equal(result.agents.find((agent) => agent.name === "truthy")?.injectToContext ?? false, false);
	});

	it("preserves injectToContext through a serialize and rediscover round trip", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-inject-roundtrip-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
description: Scout
injectToContext: true
---

Recon
`, "utf-8");

		const discovered = discoverAgents(dir, "project").agents.find((agent) => agent.name === "scout");
		assert.ok(discovered);
		const serialized = serializeAgent({ ...discovered, source: "project", filePath: path.join(agentsDir, "scout.md") });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), serialized, "utf-8");

		const rediscovered = discoverAgents(dir, "project").agents.find((agent) => agent.name === "scout");
		assert.equal(rediscovered?.injectToContext, true);
	});
});
