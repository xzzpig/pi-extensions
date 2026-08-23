import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("subagents.injectAgents settings", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-inject-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-inject-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("rejects a non-array injectAgents with an accurate error", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: { injectAgents: "worker" },
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("injectAgents")
				&& error.message.includes("expected an array of non-empty agent names"),
		);
	});

	it("rejects empty-string entries in injectAgents with an accurate error", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: { injectAgents: ["worker", "  "] },
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("injectAgents")
				&& error.message.includes("expected an array of non-empty agent names"),
		);
	});

	it("exposes trimmed user injectAgents through runtime discovery", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { injectAgents: ["worker", " reviewer "] },
		});

		const result = discoverAgents(tempProject, "both");
		assert.deepEqual(result.injectAgents, ["worker", "reviewer"]);
	});

	it("lets project injectAgents replace user injectAgents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { injectAgents: ["worker"] },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { injectAgents: ["scout"] },
		});

		const result = discoverAgents(tempProject, "both");
		assert.deepEqual(result.injectAgents, ["scout"]);
	});

	it("keeps user injectAgents when project settings define no injectAgents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { injectAgents: ["worker"] },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: false },
		});

		const result = discoverAgents(tempProject, "both");
		assert.deepEqual(result.injectAgents, ["worker"]);
	});
});
