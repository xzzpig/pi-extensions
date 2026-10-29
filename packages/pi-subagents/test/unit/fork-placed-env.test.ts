import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasUnsupportedPlacedProcessEnv } from "../../src/runs/shared/fork-placed-env.ts";

describe("fork process-environment checks for remote placement", () => {
	it("accepts the local unset-profile pin without sending it to a remote child", () => {
		assert.equal(hasUnsupportedPlacedProcessEnv({
			PI_SUBAGENT_PERMISSION_PROFILE: undefined,
			PI_SUBAGENT_PERMISSION_PROFILE_PINNED: "1",
			PI_SUBAGENT_EXTENSION_BINDINGS: undefined,
			MCP_DIRECT_TOOLS: "__none__",
		}), false);
	});

	it("still rejects selected profiles, extension bindings, and arbitrary local values", () => {
		for (const env of [
			{ PI_SUBAGENT_PERMISSION_PROFILE_PINNED: "1", PI_SUBAGENT_PERMISSION_PROFILE: "restricted" },
			{ PI_SUBAGENT_PERMISSION_PROFILE_PINNED: "2" },
			{ PI_SUBAGENT_EXTENSION_BINDINGS: '{"policy/1":true}' },
			{ LOCAL_SECRET: "secret" },
		]) assert.equal(hasUnsupportedPlacedProcessEnv(env), true);
	});
});
