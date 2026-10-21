import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	MAX_AUDIT_CONTEXT_BYTES,
	captureCompletedAuditContext,
} from "../extensions/goal-audit-context-snapshot.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		total: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** SAFETY: the SDK consumes plain session-entry objects at runtime; tests build them by hand. */
function asSessionEntry(value: Record<string, unknown>): SessionEntry {
	// SAFETY: tests build plain session-entry objects and every call site supplies
	// a complete entry; the SDK only reads the documented fields at runtime.
	return value as unknown as SessionEntry;
}

/** Build a linear session-entry chain, the shape the SDK builder walks. */
function chain() {
	let parentId: string | null = null;
	let index = 0;
	const entries: SessionEntry[] = [];
	const push = (message: Record<string, unknown>): void => {
		index += 1;
		const id = `e${index}`;
		entries.push(asSessionEntry({
			type: "message",
			id,
			parentId,
			timestamp: NOW,
			message,
		}));
		parentId = id;
	};
	return {
		entries,
		push,
		leafId: () => parentId,
		lastId: () => parentId,
		user: (text: string) => push({ role: "user", content: text, timestamp: index + 1 }),
		system: (text: string, extra: Record<string, unknown> = {}) =>
			push({ role: "system", content: text, timestamp: index + 1, ...extra }),
		assistant: (calls: string[], extra: Record<string, unknown> = {}) =>
			push({
				role: "assistant",
				content: calls.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: "evidence.txt" } })),
				api: "test",
				provider: "test",
				model: "test-model",
				usage: usage(),
				stopReason: "toolUse",
				timestamp: index + 1,
				...extra,
			}),
		assistantText: (text: string) =>
			push({
				role: "assistant",
				content: [{ type: "text", text }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage: usage(),
				stopReason: "stop",
				timestamp: index + 1,
			}),
		result: (toolCallId: string, isError = false) =>
			push({
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: isError ? "failed" : "ok" }],
				isError,
				timestamp: index + 1,
			}),
		compaction: (summary: string, firstKeptEntryId: string): void => {
			index += 1;
			const id = `e${index}`;
			entries.push(asSessionEntry({
				type: "compaction",
				id,
				parentId,
				timestamp: NOW,
				summary,
				firstKeptEntryId,
				tokensBefore: 1000,
			}));
			parentId = id;
		},
	};
}

function capture(session: ReturnType<typeof chain>, goalPayload: unknown = { goal: "g1" }, systemPrompt = "SYS") {
	return captureCompletedAuditContext({
		entries: session.entries,
		leafId: session.leafId(),
		systemPrompt,
		goalPayload,
	});
}

describe("completed audit context snapshot", () => {
	it("accepts an empty branch", () => {
		const session = chain();
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		assert.deepEqual(captured.context.messages, []);
		assert.equal(captured.context.droppedMessages, 0);
	});

	it("keeps a fully paired failed tool group as legitimate evidence", () => {
		const session = chain();
		session.user("inspect");
		session.assistant(["call-1"]);
		session.result("call-1", true);
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		assert.deepEqual(captured.context.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
	});

	it("drops an assistant tool call that never got a result", () => {
		const session = chain();
		session.user("inspect");
		session.assistant(["call-1"]);
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		assert.deepEqual(captured.context.messages.map((message) => message.role), ["user"]);
	});

	it("drops a whole multi-call group when only some results returned", () => {
		const session = chain();
		session.user("inspect");
		session.assistant(["call-1", "call-2"]);
		session.result("call-1");
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		// No partial result from the unfinished group is copied.
		assert.deepEqual(captured.context.messages.map((message) => message.role), ["user"]);
	});

	it("drops a deferred assistant that has not converged", () => {
		const session = chain();
		session.user("inspect");
		session.assistantText("thinking");
		session.assistant([], { stopReason: "deferred", deferred: { id: "handle-1" } });
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		assert.deepEqual(captured.context.messages.map((message) => message.role), ["user", "assistant"]);
	});

	it("rejects an orphan toolResult instead of synthesizing a call", () => {
		const session = chain();
		session.user("inspect");
		session.result("call-orphan");
		const captured = capture(session);
		assert.equal(captured.ok, false);
		if (captured.ok) return;
		assert.equal(captured.code, "context_error");
		assert.match(captured.message, /Orphan toolResult/);
	});

	it("rejects a duplicate toolResult", () => {
		const session = chain();
		session.user("inspect");
		session.assistant(["call-1", "call-2"]);
		session.result("call-1");
		session.result("call-1");
		const captured = capture(session);
		assert.equal(captured.ok, false);
		if (captured.ok) return;
		assert.equal(captured.code, "context_error");
		assert.match(captured.message, /Duplicate toolResult/);
	});

	it("accepts a completed group whose parallel results return in any order", () => {
		const session = chain();
		session.user("inspect");
		session.assistant(["call-1", "call-2"]);
		// A real provider may answer the second call first.
		session.result("call-2");
		session.result("call-1");
		const captured = capture(session);
		assert.equal(captured.ok, true, "intra-group permutation is legal");
		if (!captured.ok) return;
		assert.equal(captured.context.messages.filter((message) => message.role === "toolResult").length, 2);
	});

	it("still rejects a group with a missing result (incomplete group is dropped, never completed)", () => {
		const session = chain();
		session.user("inspect");
		session.assistant(["call-1", "call-2"]);
		session.result("call-2");
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		// The unfinished group (one result of two, plus the following turn) is not part of the prefix.
		assert.equal(captured.context.messages.some((message) => message.role === "toolResult"), false);
	});

	it("strips system capability declarations before judging group completeness", () => {
		const session = chain();
		session.user("inspect");
		// A system message carrying toolsAdded sits inside a real tool group.
		session.system("capability update", { toolsAdded: [{ name: "bash", description: "x", parameters: {} }] });
		session.assistant(["call-1"]);
		session.result("call-1");
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		assert.deepEqual(captured.context.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
		assert.equal(
			captured.context.messages.some((message) => (message as { role?: string }).role === "system"),
			false,
		);
	});

	it("applies the SDK compaction boundary", () => {
		const session = chain();
		session.user("first");
		session.assistantText("first answer");
		session.user("second");
		// Keep only from the second user turn onwards; everything before becomes
		// the SDK's compaction summary message.
		const firstKept = session.lastId()!;
		session.compaction("summary of the earlier turns", firstKept);
		session.assistantText("second answer");
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		const text = JSON.stringify(captured.context.messages);
		assert.match(text, /summary of the earlier turns/);
		assert.doesNotMatch(text, /"first answer"/);
		assert.match(text, /"second answer"/);
	});

	it("returns a deep clone that later parent changes cannot mutate", () => {
		const session = chain();
		session.user("inspect");
		const captured = capture(session);
		assert.equal(captured.ok, true);
		if (!captured.ok) return;
		const first = captured.context.messages[0] as { content?: unknown };
		first.content = "MUTATED";
		assert.equal(JSON.stringify(session.entries).includes("MUTATED"), false);
	});

	it("allows exactly 256 KiB and rejects one byte over", () => {
		const session = chain();
		session.user("inspect");
		const probe = capture(session, { pad: "" });
		assert.equal(probe.ok, true);
		if (!probe.ok) return;
		const padding = MAX_AUDIT_CONTEXT_BYTES - probe.context.bytes;
		assert.ok(padding > 0, "probe must leave room for padding");
		const exact = capture(session, { pad: "x".repeat(padding) });
		assert.equal(exact.ok, true);
		if (!exact.ok) return;
		assert.equal(exact.context.bytes, MAX_AUDIT_CONTEXT_BYTES);
		const over = capture(session, { pad: "x".repeat(padding + 1) });
		assert.equal(over.ok, false);
		if (over.ok) return;
		assert.equal(over.code, "capacity_exceeded");
	});
});
