import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgentsWithRuntime, registerAgent } from "../../src/api/agents.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { clearRuntimeAgentsForPi } from "../../src/agents/runtime-agent-registry.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

let tempHome = "";
let tempProject = "";
let pi: ExtensionAPI;

function makePi(): ExtensionAPI {
	return {
		on() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
}

describe("public agent discovery API", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-discovery-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-discovery-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		pi = makePi();
	});

	afterEach(() => {
		clearRuntimeAgentsForPi(pi);
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("matches plain discovery when nothing is registered at runtime", () => {
		const expected = discoverAgents(tempProject, "both");
		const actual = discoverAgentsWithRuntime(pi, tempProject, "both");
		assert.deepEqual(
			actual.agents.map((agent) => [agent.name, agent.source]),
			expected.agents.map((agent) => [agent.name, agent.source]),
		);
	});

	it("includes runtime-registered agents alongside file-discovered agents", () => {
		registerAgent({
			pi,
			name: "runtime-role",
			definition: {
				description: "Runtime role",
				systemPrompt: "Act as the runtime role.",
				aliases: ["role"],
			},
		});

		const result = discoverAgentsWithRuntime(pi, tempProject, "both");
		const registered = result.agents.find((agent) => agent.name === "runtime-role");
		assert.equal(registered?.source, "runtime");
		assert.deepEqual(registered?.aliases, ["role"]);
		assert.equal(registered?.systemPrompt, "Act as the runtime role.");
		assert.ok(
			result.agents.some((agent) => agent.source === "builtin"),
			"file-discovered agents must remain in the merged result",
		);
	});

	it("honours registration cleanup for subsequent discovery calls", () => {
		registerAgent({
			pi,
			name: "runtime-transient",
			definition: { description: "Transient", systemPrompt: "Transient." },
		});
		assert.ok(discoverAgentsWithRuntime(pi, tempProject, "both").agents.some((agent) => agent.name === "runtime-transient"));

		clearRuntimeAgentsForPi(pi);

		assert.ok(!discoverAgentsWithRuntime(pi, tempProject, "both").agents.some((agent) => agent.name === "runtime-transient"));
	});
});
