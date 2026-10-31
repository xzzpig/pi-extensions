import assert from "node:assert/strict";
import * as fs from "node:fs";
import { it } from "node:test";
import { GOAL_AUTO_CONTINUE_GATE_EVENT, GOAL_AUTO_CONTINUE_GATE_VERSION } from "../../src/goal-auto-continue-gate.ts";

const read = (relativeUrl: string) => fs.readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
const goalProtocolSource = read("../../../pi-goal-x/extensions/goal-auto-continue-gate.ts");
const goalDocs = read("../../../pi-goal-x/docs/auto-continuation-gate.md");
const subagentsDocs = read("../../docs/goal-auto-continuation-gate.md");
const subagentsPackage = JSON.parse(read("../../package.json")) as Record<string, unknown>;

const dependencies = (manifest: Record<string, unknown>) => [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
].flatMap((section) => Object.keys((manifest[section] as Record<string, unknown> | undefined) ?? {}));

it("keeps the gate contract aligned without adding a reverse package dependency", () => {
	assert.equal(GOAL_AUTO_CONTINUE_GATE_EVENT, "pi-goal:before-auto-continue:v1");
	assert.equal(GOAL_AUTO_CONTINUE_GATE_VERSION, 1);
	assert.match(goalProtocolSource, /export const GOAL_AUTO_CONTINUE_GATE_EVENT = "pi-goal:before-auto-continue:v1"/);
	assert.match(goalProtocolSource, /export const GOAL_AUTO_CONTINUE_GATE_VERSION = 1 as const/);
	assert.match(goalProtocolSource, /events\.emit\(GOAL_AUTO_CONTINUE_GATE_EVENT, request\)/);
	assert.match(goalProtocolSource, /defer: \(_input: GoalAutoContinueDeferral\)[\s\S]*?if \(dispatching\) deferred = true/);

	assert.match(goalDocs, /pi-goal:before-auto-continue:v1/);
	assert.match(subagentsDocs, /pi-goal:before-auto-continue:v1/);
	assert.match(goalDocs, /子代理结果或监督请求仍可照常送达并启动父模型/);
	assert.match(goalDocs, /用户输入和原生子代理\/监督唤醒不受阻/);
	assert.match(subagentsDocs, /不拦截子代理结果、监督请求、用户输入或其他原生唤醒/);
	assert.match(subagentsDocs, /不新增 started\/completed 计数器、等待\/重试机制、用户设置、命令或持久化 schema/);

	assert.doesNotMatch(goalProtocolSource, /pi-subagents/, "the goal protocol module remains package-independent");
	assert.equal(dependencies(subagentsPackage).some((name) => /pi-goal-x/.test(name)), false, "pi-subagents must not add a reverse dependency on goal-x");
});
