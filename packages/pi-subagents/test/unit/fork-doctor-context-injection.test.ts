/**
 * [fork] Doctor report extension: context-injection diagnostics. Moved out of
 * doctor.test.ts so that file stays byte-identical to upstream.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildDoctorReport } from "../../src/extension/doctor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeAgent(name: string, source: AgentConfig["source"]): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "Prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source,
		filePath: `/tmp/${name}.md`,
	};
}

describe("buildDoctorReport", () => {
	it("reports context injection advertisement and unknown names", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-context-injection-"));
		try {
			const flagged = makeAgent("flagged-a", "project");
			flagged.injectToContext = true;
			const state = makeState(root);
			state.contextInjectionBlock = "<available_subagents>...</available_subagents>";

			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state,
				spawnBudget: { used: 0, configuredLimit: null, granted: 0, limit: null, remaining: null, grantRemaining: null, grantHistory: [] },
				activeAsyncCapacity: { used: 0, limit: 0 },
				deps: {
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({
						builtin: [],
						user: [makeAgent("listed-user", "user")],
						project: [flagged],
						injectAgents: ["listed-user", "ghost"],
						chains: [],
						userDir: path.join(root, "home", ".agents"),
						projectDir: path.join(root, ".pi", "agents"),
						userChainDir: path.join(root, "home", ".pi", "agent", "chains"),
						projectChainDir: path.join(root, ".pi", "chains"),
						userSettingsPath: path.join(root, "home", ".pi", "agent", "settings.json"),
						projectSettingsPath: path.join(root, ".pi", "settings.json"),
					}),
					discoverAvailableSkills: () => [],
					diagnoseIntercomBridge: () => ({
						active: false,
						mode: "always",
						wantsIntercom: false,
						supervisorChannelAvailable: true,
						extensionDir: "native:pi-subagents-supervisor-channel",
					}),
				},
			});

			assert.match(report, /- context injection: 2 advertised \(flagged-a, listed-user\); session snapshot present/);
			assert.match(report, /- context injection unknown names \(ignored\): ghost/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
