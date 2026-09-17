/**
 * Provider-context normalization of checkpoint markers.
 *
 * The request context must stay append-only across requests so the provider
 * prompt cache keeps hitting: compactGoalCheckpointContext rewrites every
 * checkpoint marker in place to a tiny bounded trigger, preserving each
 * marker's original position instead of deleting it. Deleting mid-history
 * markers shifted every later message and invalidated the cache after the
 * first continuation; in-place rewrite keeps the token sequence prefix-stable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_AUDIT_ENTRY, GOAL_EVENT_ENTRY, GOAL_STATE_EVENT_ENTRY } from "../extensions/goal-format.ts";
import { compactGoalCheckpointContext } from "../extensions/goal-events.ts";
import { checkpointTriggerPrompt } from "../extensions/prompts/goal-prompts.ts";

function checkpointMarker(goalId: string, seq: number): Record<string, unknown> {
	return {
		role: "custom",
		customType: GOAL_EVENT_ENTRY,
		content: `[GOAL CHECKPOINT goalId=${goalId}]\nlegacy full prompt body`,
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

test("context normalize: null when no checkpoint markers exist", () => {
	const messages = [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		stateSnapshot("g1", 1),
		auditEvent("g1"),
	];
	assert.equal(compactGoalCheckpointContext(messages, null), null);
});

test("context normalize: rewrites every marker in place, keeps message count and order", () => {
	const messages = [
		{ role: "user", content: "start the goal" },
		{ role: "assistant", content: [{ type: "text", text: "working" }] },
		checkpointMarker("g1", 1),
		stateSnapshot("g1", 2),
		{ role: "assistant", content: [{ type: "text", text: "progress" }] },
		checkpointMarker("g1", 2),
		auditEvent("g1"),
	];
	const normalized = compactGoalCheckpointContext(messages, null)!;
	assert.equal(normalized.length, messages.length, "message count must be preserved");
	const customTypes = normalized.map((m) => (m as { customType?: string }).customType ?? null);
	assert.deepEqual(customTypes, [null, null, GOAL_EVENT_ENTRY, GOAL_STATE_EVENT_ENTRY, null, GOAL_EVENT_ENTRY, GOAL_AUDIT_ENTRY]);
	// Markers are rewritten to the bounded trigger content, not dropped.
	const marker = normalized[2] as { content: string };
	assert.equal(marker.content, checkpointTriggerPrompt("g1"));
	const lastText = (normalized[1] as { content: Array<{ text: string }> }).content[0]!.text;
	assert.equal(lastText, "working");
});

test("context normalize: legacy v1 markers with full prompt content are rewritten in place", () => {
	const legacy = {
		role: "custom",
		customType: GOAL_EVENT_ENTRY,
		content: "[GOAL CHECKPOINT goalId=g1]\nsome long legacy prompt body",
		display: false,
		details: { kind: "checkpoint", goalId: "g1", objective: "some long legacy prompt body" },
	};
	const normalized = compactGoalCheckpointContext([legacy, { role: "user", content: "go" }], null)!;
	assert.equal(normalized.length, 2, "message count preserved");
	assert.equal((normalized[0] as { content: string }).content, checkpointTriggerPrompt("g1"));
});

test("context normalize: prefix-stable across a growing session (prompt-cache contract)", () => {
	const user = { role: "user", content: "start" };
	const markerOne = checkpointMarker("g1", 1);
	const snapshotOne = stateSnapshot("g1", 1);
	const work = { role: "assistant", content: [{ type: "text", text: "work" }] };
	const toolResult = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "data" }] };
	const markerTwo = checkpointMarker("g1", 2);
	const snapshotTwo = stateSnapshot("g1", 2);

	const normalizedOne = compactGoalCheckpointContext([user, markerOne, snapshotOne, work], null)!;
	const normalizedTwo = compactGoalCheckpointContext([user, markerOne, snapshotOne, work, toolResult, markerTwo, snapshotTwo], null)!;

	// The turn-one request context must be an exact prefix of the turn-two
	// request context, or the provider prompt cache diverges mid-history.
	const rewrittenMarkerOne = { ...markerOne, content: checkpointTriggerPrompt("g1"), details: { version: 2, kind: "checkpoint", goalId: "g1" } };
	assert.deepEqual(normalizedOne, [user, rewrittenMarkerOne, snapshotOne, work]);
	for (let i = 0; i < normalizedOne.length; i += 1) {
		assert.deepEqual(normalizedTwo[i], normalizedOne[i], `position ${i} shifted between requests`);
	}
});