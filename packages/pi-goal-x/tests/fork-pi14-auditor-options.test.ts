import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuditorSessionModelOptions } from "../extensions/goal-auditor.ts";

test("reuses the Pi 1.4 parent ModelRuntime without the removed modelRegistry option", () => {
	const runtime = { id: "parent-runtime" };
	const options = resolveAuditorSessionModelOptions({ modelRegistry: { runtime } } as never);
	assert.equal(options.modelRuntime, runtime);
	assert.equal("modelRegistry" in options, false);
	const missing = resolveAuditorSessionModelOptions({ modelRegistry: undefined } as never);
	assert.equal(missing.modelRuntime, undefined);
});
