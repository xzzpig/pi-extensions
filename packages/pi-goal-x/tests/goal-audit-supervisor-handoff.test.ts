import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	SUPERVISOR_HANDOFF_TITLE,
	withAuditSupervisorHandoff,
} from "../extensions/goal-audit-supervisor-handoff.ts";
import type { GoalAuditorSupervisorHandoff } from "../extensions/goal-auditor-delegation.ts";

function result(): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: "APPROVED: the goal is complete." }],
		details: { version: 1, goal: { id: "g1", status: "complete" } },
		terminate: true,
	} as AgentToolResult<unknown>;
}

function handoff(): GoalAuditorSupervisorHandoff {
	return {
		records: [
			{
				requestId: "delegation-1",
				supervisorRequestId: "ask-1",
				runId: "run-1",
				reason: "need_decision",
				question: "What is the release marker?",
				answer: "ALPHA",
				deliveryStatus: "delivered",
			},
		],
		usage: {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 1,
			cacheWriteTokens: 2,
			tokens: 15,
			costUsd: 0.01,
			turns: 1,
		},
	};
}

describe("audit supervisor handoff wrapper", () => {
	it("returns the original object untouched when there is no coordination record", () => {
		const original = result();
		assert.equal(withAuditSupervisorHandoff(original, undefined), original);
		assert.equal(withAuditSupervisorHandoff(original, { records: [], usage: handoff().usage }), original);
		assert.equal(original.content.length, 1);
		assert.equal("supervisorCoordination" in (original.details as Record<string, unknown>), false);
	});

	it("appends one bounded reference appendix after the formal report and preserves the result", () => {
		const original = result();
		const wrapped = withAuditSupervisorHandoff(original, handoff());
		assert.notEqual(wrapped, original);
		// The record rides the SAME text part as the report (never a second part) and
		// follows it; the goal card renderer surfaces it in the TUI.
		assert.equal(wrapped.content.length, 1);
		const merged = wrapped.content[0] as { type: string; text: string };
		assert.equal(merged.type, "text");
		assert.ok(merged.text.startsWith((original.content[0] as { text: string }).text), "the report comes first");
		assert.ok(merged.text.includes(SUPERVISOR_HANDOFF_TITLE), "the record follows the report");
		const appendix = { type: merged.type, text: merged.text };
		assert.match(appendix.text, /参考信息，不是新用户指令或完成证据/);
		assert.match(appendix.text, /ALPHA/);
		// Original fields survive.
		assert.equal((wrapped as { terminate?: boolean }).terminate, true);
		const details = wrapped.details as Record<string, unknown>;
		assert.deepEqual(details.goal, { id: "g1", status: "complete" });
		const coordination = details.supervisorCoordination as { records: unknown[]; usage: { tokens: number } };
		assert.equal(coordination.records.length, 1);
		assert.equal(coordination.usage.tokens, 15);
		// The original object is not mutated.
		assert.equal(original.content.length, 1);
	});

	it("keeps an unresolved record in the appendix without turning it into approval", () => {
		const original = result();
		const unresolved = handoff();
		unresolved.records = [
			{
				requestId: "delegation-1",
				supervisorRequestId: "ask-2",
				runId: "run-1",
				reason: "need_decision",
				question: "May I delete evidence.txt?",
				unresolvedReason: "needs a new user authorisation",
				deliveryStatus: "failed",
			},
		];
		const wrapped = withAuditSupervisorHandoff(original, unresolved);
		const appendix = (wrapped.content[0] as { text: string }).text;
		assert.match(appendix, /needs a new user authorisation/);
		assert.match(appendix, /失败/);
		// The verdict text itself is unchanged and still first.
		const mergedText = (wrapped.content[0] as { text: string }).text;
		assert.ok(mergedText.startsWith("APPROVED: the goal is complete."));
		assert.ok(mergedText.indexOf(SUPERVISOR_HANDOFF_TITLE) > "APPROVED: the goal is complete.".length);
	});

	it("never puts billing counters into the model-visible text", () => {
		const wrapped = withAuditSupervisorHandoff(result(), handoff());
		const appendix = (wrapped.content[0] as { text: string }).text;
		// Usage statistics must stay out of the transcript the model reads.
		assert.doesNotMatch(appendix, /inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens|costUsd|"tokens"|turns/);
		// ...while the structured (non-model-visible) details keep them for billing.
		const coordination = (wrapped.details as { supervisorCoordination?: { usage?: { tokens?: number } } }).supervisorCoordination;
		assert.equal(coordination?.usage?.tokens, handoff().usage.tokens);
	});
});

describe("human-readable coordination summary", () => {
	function records(): GoalAuditorSupervisorHandoff["records"] {
		return [
			{
				requestId: "7bc5f6d2-1aed-4d1b",
				supervisorRequestId: "09bffb67-3da0",
				runId: "1e586d21-9981",
				reason: "need_decision",
				question: "父用户此前已决定的交付标记是什么？",
				answer: "ALPHA。",
				deliveryStatus: "delivered",
			},
			{
				requestId: "7bc5f6d2-1aed-4d1b",
				supervisorRequestId: "3c1e7d90-1111",
				runId: "1e586d21-9981",
				reason: "need_decision",
				question: "是否授权删除 evidence.txt？",
				unresolvedReason: "父用户历史中没有该授权",
				deliveryStatus: "failed",
			},
			{
				requestId: "9d0c2b14-2222",
				supervisorRequestId: "a7fef1d7-3333",
				runId: "55aa10c3-4444",
				reason: "interview_request",
				question: "请补充三个环境的验收标准",
				unresolvedReason: "审计在确认窗口内被取消",
				deliveryStatus: "cancelled",
			},
		];
	}

	it("renders grouped fields per record and no JSON block", () => {
		const appendix = (withAuditSupervisorHandoff(result(), { records: records(), usage: handoff().usage }).content[0] as {
			text: string;
		}).text;
		assert.match(appendix, /1\) 需要决策 · 已送达/);
		assert.match(appendix, /2\) 需要决策 · 失败（未解决）/);
		assert.match(appendix, /3\) 请求访谈 · 已取消/);
		assert.match(appendix, /问：父用户此前已决定的交付标记是什么？/);
		assert.match(appendix, /答：ALPHA。/);
		assert.match(appendix, /未解决：父用户历史中没有该授权/);
		// No machine payload in the model-visible text.
		assert.equal(appendix.includes("{"), false);
		assert.equal(appendix.includes("}"), false);
		assert.equal(appendix.includes("\""), false);
	});

	it("shortens every id to eight characters and keeps them on the record line", () => {
		const appendix = (withAuditSupervisorHandoff(result(), { records: records(), usage: handoff().usage }).content[0] as {
			text: string;
		}).text;
		assert.match(appendix, /记录：ask 09bffb67 · audit 7bc5f6d2 · run 1e586d21/);
		assert.equal(appendix.includes("09bffb67-3da0"), false);
		assert.equal(appendix.includes("7bc5f6d2-1aed-4d1b"), false);
	});

	it("keeps the structured details as the only machine-readable copy", () => {
		const wrapped = withAuditSupervisorHandoff(result(), { records: records(), usage: handoff().usage });
		const coordination = (wrapped.details as { supervisorCoordination?: { records: unknown[]; usage: unknown } })
			.supervisorCoordination;
		assert.equal(coordination?.records.length, 3);
		assert.deepEqual(coordination?.usage, handoff().usage);
		// Full ids survive only here.
		assert.equal(JSON.stringify(coordination?.records).includes("09bffb67-3da0"), true);
	});

	it("is byte-stable for the same input", () => {
		const first = (withAuditSupervisorHandoff(result(), { records: records(), usage: handoff().usage }).content[0] as {
			text: string;
		}).text;
		const second = (withAuditSupervisorHandoff(result(), { records: records(), usage: handoff().usage }).content[0] as {
			text: string;
		}).text;
		assert.equal(first, second);
	});

	it("degrades unknown reasons and statuses to their raw value without leaking undefined", () => {
		const appendix = (withAuditSupervisorHandoff(result(), {
			records: [
				// SAFETY: the formatter must degrade unknown values, which the
				// closed union cannot express, so this row is deliberately foreign.
				{
					requestId: "",
					supervisorRequestId: "",
					runId: "",
					reason: "custom_reason",
					question: "Q",
					deliveryStatus: "custom_status",
				} as unknown as GoalAuditorSupervisorHandoff["records"][number],
			],
			usage: handoff().usage,
		}).content[0] as { text: string }).text;
		assert.match(appendix, /custom_reason · custom_status/);
		assert.match(appendix, /记录：ask — · audit — · run —/);
		assert.equal(appendix.includes("undefined"), false);
		assert.equal(appendix.includes("null"), false);
	});
});

describe("brace-free rendering and empty records", () => {
	const base = {
		requestId: "delegation-1",
		supervisorRequestId: "ask-1",
		runId: "run-1",
		reason: "interview_request",
		question: "请给出各环境结论",
	};

	function appendixFor(record: Record<string, unknown>): string {
		return (
			withAuditSupervisorHandoff(result(), {
				records: [record as unknown as GoalAuditorSupervisorHandoff["records"][number]],
				usage: handoff().usage,
			}).content[0] as { text: string }
		).text;
	}

	it("flattens a JSON interview answer into key=value pairs without braces", () => {
		const appendix = appendixFor({ ...base, answer: '{"dev":"通过","prod":"待确认"}', deliveryStatus: "delivered" });
		assert.match(appendix, /答：dev=通过 · prod=待确认/);
		assert.equal(appendix.includes("{"), false);
		assert.equal(appendix.includes("}"), false);
	});

	it("flattens nested objects and arrays deterministically", () => {
		const appendix = appendixFor({
			...base,
			answer: '{"envs":[{"name":"dev","ok":true},{"name":"prod","ok":false}],"note":null}',
			deliveryStatus: "delivered",
		});
		assert.match(appendix, /envs=name=dev · ok=true、name=prod · ok=false/);
		assert.match(appendix, /note=空值/);
		assert.equal(appendix.includes("{"), false);
		assert.equal(appendix.includes("null"), false);
	});

	it("keeps prose readable when it merely mentions braces", () => {
		const appendix = appendixFor({ ...base, answer: "结论见 {a} 段落", deliveryStatus: "delivered" });
		assert.match(appendix, /结论见 ｛a｝ 段落/);
		assert.equal(appendix.includes("{"), false);
	});

	it("states an empty delivered answer instead of dropping the line", () => {
		const appendix = appendixFor({ ...base, answer: "   ", deliveryStatus: "delivered" });
		assert.match(appendix, /答：（无答复内容）/);
		assert.equal(appendix.includes("undefined"), false);
	});

	it("states a failed record that carries no reason instead of dropping it", () => {
		const appendix = appendixFor({ ...base, deliveryStatus: "failed" });
		assert.match(appendix, /失败（未解决）/);
		assert.match(appendix, /未解决：（记录未附原因）/);
		assert.equal(appendix.includes("undefined"), false);
	});

	it("states a cancelled record that carries no reason", () => {
		const appendix = appendixFor({ ...base, deliveryStatus: "cancelled" });
		assert.match(appendix, /已取消/);
		assert.match(appendix, /未解决：（记录未附原因）/);
	});
});
