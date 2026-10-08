import test from "node:test";
import assert from "node:assert/strict";
import { contextUsageLine, modelBudgetLine } from "../extensions/goal-accounting.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { goalModelPromptParts } from "../extensions/goal-model-view.ts";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";

test("context occupancy never falls back to cumulative usage or invented zero", () => {
	for (const usage of [undefined, { tokens: null, contextWindow: 200000 }, { tokens: NaN, contextWindow: 200000 }, { tokens: 10, contextWindow: 0 }]) assert.equal(contextUsageLine(usage), "Context snapshot: unavailable");
	assert.equal(contextUsageLine({ tokens: 100000, contextWindow: 250000 }), "Context snapshot: 100000/250000 tokens (40%)");
	assert.equal(contextUsageLine({ tokens: 0, contextWindow: 250000 }), "Context snapshot: 0/250000 tokens (0%)");
});

test("changing and removing budget or run limits clears retained current policy without reintroducing context telemetry", () => {
	const goal = createGoal({ objective: "Continue work", autoContinue: true, sisyphus: false });
	goal.tokenBudget = 100;
	goal.usage.tokensUsed = 20;
	const retention = new LiveTailRetention();
	const base = [{ role: "user", content: "start" }];
	retention.apply("s", base, goalModelPromptParts(goal, { maxAutonomousRuns: 10 }));
	delete goal.tokenBudget;
	const parts = goalModelPromptParts(goal, {});
	const out = retention.apply("s", [...base, { role: "assistant", content: "work" }], parts);
	assert.equal(out.transientContents.length, 1, "without budget or run limits only the stable policy tail remains");
	assert.doesNotMatch(out.transientContents.join("\n"), /Limits:|Goal snapshot:|Context snapshot:|tokens=100|runs=10|unavailable/);
	assert.match(modelBudgetLine({ tokenBudget: 1, usage: { tokensUsed: 2 } })!, /spending cap, not context capacity/);
});
