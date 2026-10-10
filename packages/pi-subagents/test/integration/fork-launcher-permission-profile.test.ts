import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { executeAsyncChain, installAsyncExecutionHooks, makeAsyncExecutor, mockPi, readAsyncPayload, tempDir, waitForMockPiCall } from "../support/async-execution-fixture.ts";

describe("fork permission profile on launcher-routed native children", () => {
	installAsyncExecutionHooks();

	for (const mode of ["single", "chain", "parallel"] as const) {
		it(`preserves profile selection and forced permission extension for ${mode}`, { timeout: 30_000 }, async () => {
			const previous = process.env.PI_CODING_AGENT_DIR;
			const agentDir = path.join(tempDir, "agent-home");
			const extensionDir = path.join(agentDir, "extensions", "pi-permission-system");
			const extension = path.join(extensionDir, "index.ts");
			fs.mkdirSync(extensionDir, { recursive: true });
			fs.writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({ name: "@xzzpig/pi-permission-system", pi: { extensions: ["./index.ts"] } }));
			fs.writeFileSync(extension, "export default () => {};\n");
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const wrapper = path.join(tempDir, "wrapper.sh");
			const marker = path.join(tempDir, "wrapped");
			fs.writeFileSync(wrapper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexec "$@"\n`, { mode: 0o755 });
			try {
				const agent = makeAgent("profiled", { launcher: "wrap", permissionProfile: "reviewer-strict", extensions: [], tools: ["read"] });
				const executor = makeAsyncExecutor([agent], { runnerLaunchers: { wrap: [wrapper] } });
				mockPi.onCall({ output: "Reviewed." });
				const leaf = { agent: "profiled", task: "Review the fixture." };
				const result = mode === "single"
					? await executor.executePublic("launcher-profile-single", leaf, new AbortController().signal, undefined, makeMinimalCtx(tempDir))
					: await executeAsyncChain(`launcher-profile-${mode}-${Date.now()}`, {
						chain: mode === "chain" ? [leaf] : [{ parallel: [leaf] }], agents: [agent],
						ctx: { pi: { events: createEventBus() }, cwd: tempDir, currentSessionId: "test", runnerLaunchers: { wrap: [wrapper] } },
						artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
						shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2,
					});
				assert.notEqual(result.isError, true, result.content[0]?.text);
				assert.ok(result.details?.asyncId, "the launcher uses a background runner");
				await waitForMockPiCall(mockPi, 0);
				const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-") && name.endsWith(".json"));
				assert.ok(callFile);
				const call = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf8"));
				assert.equal(call.launch.processEnv.PI_SUBAGENT_PERMISSION_PROFILE, "reviewer-strict");
				assert.equal(call.launch.processEnv.PI_SUBAGENT_PERMISSION_PROFILE_PINNED, "1");
				assert.equal(call.launch.ambientExtensions, false);
				assert.ok(call.launch.extensionPaths.includes(extension), "explicit empty extensions cannot drop the selected permission profile");
				assert.equal(fs.existsSync(marker), true);
				assert.equal((await readAsyncPayload(result.details.asyncId)).success, true);
			} finally {
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previous;
			}
		});
	}
});
