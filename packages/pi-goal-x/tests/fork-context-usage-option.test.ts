import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../extensions/goal-record.ts";
import { goalModelPromptParts } from "../extensions/goal-model-view.ts";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";
import { contextSwitchCounters } from "../extensions/fork-context-retention.ts";

function activeGoal() {
	const goal = createGoal({ objective: "Continue work", autoContinue: true, sisyphus: false });
	goal.usage = { activeSeconds: 90, tokensUsed: 5000 };
	return goal;
}

test("context usage is opt-in without restoring other unbudgeted telemetry", () => {
	const goal = activeGoal();
	const usage = { tokens: 200, contextWindow: 1000 };
	const baseline = goalModelPromptParts(goal);
	const omitted = goalModelPromptParts(goal, {}, usage);
	const disabled = goalModelPromptParts(goal, { showContextUsage: false }, usage);
	const enabled = goalModelPromptParts(goal, { showContextUsage: true }, usage);

	assert.deepEqual(omitted, baseline);
	assert.deepEqual(disabled, baseline);
	assert.equal(enabled.state, baseline.state, "display settings must not change the stable policy");
	assert.equal(enabled.counters, "Context snapshot: 200/1000 tokens (20%)");
	assert.doesNotMatch(`${enabled.state}\n${enabled.counters}`, /Goal snapshot:|1m30s|5000 tokens/);
});

test("an enabled snapshot preserves actual lifetime budget and unavailable semantics", () => {
	const goal = activeGoal();
	goal.tokenBudget = 10_000;
	const enabled = goalModelPromptParts(goal, { showContextUsage: true }, { tokens: 0, contextWindow: 1000 });
	assert.match(enabled.counters ?? "", /Lifetime token budget:.*5000\/10000 used, 5000 remaining/);
	assert.match(enabled.counters ?? "", /Context snapshot: 0\/1000 tokens \(0%\)/);
	assert.doesNotMatch(`${enabled.state}\n${enabled.counters}`, /Goal snapshot:|1m30s/);
	assert.match(goalModelPromptParts(goal, { showContextUsage: true }).counters ?? "", /Context snapshot: unavailable/);
	assert.doesNotMatch(goalModelPromptParts(goal, { showContextUsage: false }).counters ?? "", /Context snapshot/);
});

test("turning the optional context snapshot off keeps the existing request prefix", () => {
	const goal = activeGoal();
	const retention = new LiveTailRetention();
	const base = [{ role: "user", content: "start" }];
	const disabled = goalModelPromptParts(goal);
	const first = retention.apply("s", base, disabled);
	assert.equal(first.messages.length, 2, "the default does not create an empty counter");
	assert.equal(contextSwitchCounters(disabled.state, disabled.counters, false, retention.contents("s")), undefined);

	base.push({ role: "assistant", content: "work" });
	const enabled = goalModelPromptParts(goal, { showContextUsage: true }, { tokens: 200, contextWindow: 1000 });
	const second = retention.apply("s", base, enabled);
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);

	base.push({ role: "assistant", content: "more work" });
	const counters = contextSwitchCounters(disabled.state, disabled.counters, false, retention.contents("s"));
	const third = retention.apply("s", base, { ...disabled, counters });
	assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages);
	assert.equal(third.messages.at(-1)?.content, "Context usage display is off.");
	assert.deepEqual(retention.apply("s", base, { ...disabled, counters: contextSwitchCounters(disabled.state, disabled.counters, false, retention.contents("s")) }).messages, third.messages);
});

test("context toggle handling does not preserve removed real constraints or old policies", () => {
	assert.equal(contextSwitchCounters("state", undefined, false, ["state", "Lifetime token budget: 1/2\nContext snapshot: 1/2 tokens (50%)"]), undefined);
	assert.equal(contextSwitchCounters("new state", undefined, false, ["old state", "Context snapshot: unavailable"]), undefined);
	assert.equal(contextSwitchCounters("state", "Autonomous runs: 1/2", false, ["state", "Context snapshot: unavailable"]), "Autonomous runs: 1/2");
});
