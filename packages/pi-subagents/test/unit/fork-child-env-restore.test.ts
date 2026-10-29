import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

const profileKey = "PI_SUBAGENT_TEST_FORK_PROFILE";
const retainedKey = "PI_SUBAGENT_TEST_FORK_RETAINED";
const launch: ChildSessionLaunch = {
	cwd: process.cwd(),
	storage: { kind: "memory" },
	extensionPaths: [],
	ambientExtensions: false,
	hooks: [],
	noSkills: true,
	noContextFiles: true,
	runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
};

function stubPi(onReload: () => void, onBind: () => void): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() { onReload(); } },
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: () => ({}),
		createAgentSession: async () => ({ session: {
			bindExtensions: async () => onBind(), dispose() {}, extensionRunner: { hasHandlers: () => false },
			subscribe: () => () => {}, prompt: async () => {}, abort: async () => {},
			steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "s",
		} }),
	} as unknown as PiCodingAgentModule;
}

describe("fork transient child profile environment", () => {
	it("retains the profile through session_start and restores only transient runner keys", async () => {
		const seen: Array<string | undefined> = [];
		process.env[profileKey] = "parent";
		process.env[retainedKey] = "previous";
		try {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi(() => seen.push(process.env[profileKey]), () => seen.push(process.env[profileKey])) });
			await factory.create({ ...launch, processEnv: { [profileKey]: "child", [retainedKey]: "runner" }, transientProcessEnv: [profileKey] });
			assert.deepEqual(seen, ["child", "child"]);
			assert.equal(process.env[profileKey], "parent");
			assert.equal(process.env[retainedKey], "runner");
			await factory.dispose();
		} finally {
			delete process.env[profileKey];
			delete process.env[retainedKey];
		}
	});

	it("restores transient profile keys even if extension loading fails", async () => {
		process.env[profileKey] = "parent";
		try {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi(() => { throw new Error("load failed"); }, () => {}) });
			await assert.rejects(factory.create({ ...launch, processEnv: { [profileKey]: "child" }, transientProcessEnv: [profileKey] }), /load failed/);
			assert.equal(process.env[profileKey], "parent");
		} finally {
			delete process.env[profileKey];
		}
	});
});
