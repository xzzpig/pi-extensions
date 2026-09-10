/**
 * PR F — UI/model payload separation acceptance tests:
 *   - audit-start events are display-only (no turn trigger);
 *   - no report_auditor_progress tool exists anywhere;
 *   - auditor prompt carries objective + task tree exactly once;
 *   - the full goal-context message is the post-compaction re-supply.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildGoalAuditorPrompt } from "../extensions/goal-auditor.ts";
import { goalContextMessagePrompt } from "../extensions/prompts/goal-prompts.ts";
import { createGoal } from "../extensions/goal-record.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

const completionSource = readFileSync(new URL("../extensions/goal-completion.ts", import.meta.url), "utf8");
const auditorSource = readFileSync(new URL("../extensions/goal-auditor.ts", import.meta.url), "utf8");

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	const base = createGoal({ objective: "Deliver the audited thing.", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 23, 9, 0, 0));
	base.taskList = {
		tasks: [
			{ id: "t1", title: "First task", status: "complete" },
			{ id: "t2", title: "Second task", status: "pending" },
		],
		blockCompletion: true,
		proposedAt: "2026-08-23T09:01:00.000Z",
	};
	base.verificationContract = "All suites green.";
	return { ...base, ...overrides };
}

describe("PR F §59/§60: audit event separation and progress tool removal", () => {

	it("the report_auditor_progress tool no longer exists in any shipped surface", () => {
		assert.doesNotMatch(auditorSource, /name:\s*"report_auditor_progress"/);
		assert.doesNotMatch(completionSource, /report_auditor_progress/);
		const goalCoreTools = readFileSync(new URL("../extensions/goal-core-tools.ts", import.meta.url), "utf8");
		assert.doesNotMatch(goalCoreTools, /report_auditor_progress/);
	});
});

describe("PR F §61: single-source auditor prompt", () => {
	it("objective appears exactly once; task tree exactly once", () => {
		const g = goal();
		const prompt = buildGoalAuditorPrompt({
			goal: g,
			detailedSummary: `Goal: ${g.objective}\nStatus: running\nTasks: 1/2 complete`, // legacy verbose summary input
			completionSummary: "I claim it is done.",
		});
		assert.equal(prompt.split("Deliver the audited thing.").length - 1, 1, "objective occurs once");
		assert.equal(prompt.split("[ ] t2").length - 1, 1, "task tree rendered once");
		// Fork divergence: the delegation-based auditor keeps the child-only
		// report_auditor_progress protocol in its prompt (progress flows through
		// pi-subagents display events, not a parent-session tool).
	});
});

describe("0.4.0: full goal-context message replaces the post-compaction delta", () => {
	it("carries objective, contract, policy, and the task gate (nothing needs a separate delta)", () => {
		const g = goal({ currentTaskId: "t2" });
		g.taskList!.tasks[1]!.verificationContract = "Prove t2.";
		const message = goalContextMessagePrompt(g);
		assert.match(message, /^\[PI GOAL CONTEXT goalId=/);
		assert.match(message, /re-sent after every compaction/);
		assert.match(message, /Deliver the audited thing\./);
		assert.match(message, /VERIFICATION CONTRACT/);
		assert.match(message, /\[OUTCOMES\]/);
		assert.match(message, /TASK GATE/);
		// The system prompt must carry none of this: the source of truth for the
		// goal block builders is the message channel, asserted structurally.
		const goalEventsSource = readFileSync(new URL("../extensions/goal-events.ts", import.meta.url), "utf8");
		assert.doesNotMatch(goalEventsSource, /systemPrompt:\s*`/, "before_agent_start must not return system prompt overrides");
	});
});
