/**
 * Provider-context filtering of checkpoint markers.
 *
 * The request context must stay append-only across requests so the provider
 * prompt cache keeps hitting: filterGoalCheckpointContext is a pure per-message
 * decision (drop every pi-goal-event checkpoint marker), never a positional
 * rewrite like the previous drop-all-but-last compaction.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_AUDIT_ENTRY, GOAL_EVENT_ENTRY, GOAL_STATE_EVENT_ENTRY } from "../extensions/goal-format.ts";
import { filterGoalCheckpointContext } from "../extensions/goal-events.ts";
import { checkpointTriggerPrompt } from "../extensions/prompts/goal-prompts.ts";

function checkpointMarker(goalId: string, seq: number): Record<string, unknown> {
	return {
		role: "custom",
		customType: GOAL_EVENT_ENTRY,
		content: checkpointTriggerPrompt(goalId),
		display: false,
		details: { version: 2, kind: "checkpoint", goalId, checkpointSeq: seq, timestamp: Date.now() },
	};
}

function stateSnapshot(goalId: string, seq: number): Record<string, unknown> {
	return {
		role: "custom",
		customType: GOAL_STATE_EVENT_ENTRY,
		content: `[PI GOAL STATE goalId=${goalId}]`,
		display: false,
		details: { version: 3, kind: "state", goalId, checkpointSeq: seq, timestamp: Date.now() },
	};
}

function auditEvent(goalId: string): Record<string, unknown> {
	return {
		role: "custom",
		customType: GOAL_AUDIT_ENTRY,
		content: "Goal audit started.",
		display: false,
		details: { phase: "started", goalId },
	};
}

test("context filter: null when no checkpoint markers exist", () => {
	const messages = [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		stateSnapshot("g1", 1),
		auditEvent("g1"),
	];
	assert.equal(filterGoalCheckpointContext(messages), null);
});

test("context filter: drops every checkpoint marker, keeps everything else", () => {
	const messages = [
		{ role: "user", content: "start the goal" },
		{ role: "assistant", content: [{ type: "text", text: "working" }] },
		checkpointMarker("g1", 1),
		stateSnapshot("g1", 2),
		{ role: "assistant", content: [{ type: "text", text: "progress" }] },
		checkpointMarker("g1", 2),
		auditEvent("g1"),
	];
	const filtered = filterGoalCheckpointContext(messages)!;
	assert.equal(filtered.length, messages.length - 2);
	const customTypes = filtered.map((m) => (m as { customType?: string }).customType ?? null);
	assert.ok(!customTypes.includes(GOAL_EVENT_ENTRY), "no checkpoint marker may survive");
	assert.deepEqual(customTypes, [null, null, GOAL_STATE_EVENT_ENTRY, null, GOAL_AUDIT_ENTRY]);
	const lastText = (filtered[1] as { content: Array<{ text: string }> }).content[0]!.text;
	assert.equal(lastText, "working");
});

test("context filter: legacy v1 markers with full prompt content are dropped too", () => {
	const legacy = {
		role: "custom",
		customType: GOAL_EVENT_ENTRY,
		content: "[GOAL CHECKPOINT goalId=g1]\nsome long legacy prompt body",
		display: false,
		details: { kind: "checkpoint", goalId: "g1", objective: "some long legacy prompt body" },
	};
	const filtered = filterGoalCheckpointContext([legacy, { role: "user", content: "go" }])!;
	assert.equal(filtered.length, 1);
});

test("context filter: prefix-stable across a growing session (prompt-cache contract)", () => {
	const user = { role: "user", content: "start" };
	const markerOne = checkpointMarker("g1", 1);
	const snapshotOne = stateSnapshot("g1", 1);
	const work = { role: "assistant", content: [{ type: "text", text: "work" }] };
	const toolResult = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "data" }] };
	const markerTwo = checkpointMarker("g1", 2);
	const snapshotTwo = stateSnapshot("g1", 2);

	const filteredOne = filterGoalCheckpointContext([user, markerOne, snapshotOne, work])!;
	const filteredTwo = filterGoalCheckpointContext([user, markerOne, snapshotOne, work, toolResult, markerTwo, snapshotTwo])!;

	// The turn-one request context must be an exact prefix of the turn-two
	// request context, or the provider prompt cache diverges mid-history.
	assert.deepEqual(filteredOne, [user, snapshotOne, work]);
	assert.deepEqual(filteredTwo, [user, snapshotOne, work, toolResult, snapshotTwo]);
	for (let i = 0; i < filteredOne.length; i += 1) {
		assert.equal(filteredTwo[i], filteredOne[i], `position ${i} shifted between requests`);
	}
});
