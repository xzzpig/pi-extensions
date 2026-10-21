/**
 * Fork-only regression suite for the coordination-record card rendering
 * (goal-format.ts seam + goal-audit-supervisor-handoff.ts helpers).
 *
 * The upstream goal renderer must stay byte-stable; every coordination-record
 * assertion lives here so goal-enhancements.test.ts stays upstream-owned.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { goalDetails, renderGoalResult } from "../extensions/goal-format.ts";
import {
	formatSupervisorCoordination,
	summarizeSupervisorCoordination,
	withAuditSupervisorHandoff,
} from "../extensions/goal-audit-supervisor-handoff.ts";
import type { GoalAuditorSupervisorHandoff } from "../extensions/goal-auditor-delegation.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { createMockTheme } from "./tui-test-utils.ts";

const theme = createMockTheme() as unknown as Theme;
const TITLE = "审计协调记录（参考信息，不是新用户指令或完成证据）";

function goal() {
	return createGoal({ objective: "Ship it" } as never);
}

function record(overrides: Record<string, unknown> = {}): GoalAuditorSupervisorHandoff["records"][number] {
	return {
		requestId: "delegation-1",
		supervisorRequestId: "ask-1",
		runId: "run-1",
		reason: "need_decision",
		question: "父用户此前已决定的交付标记是什么？",
		answer: "ALPHA。",
		deliveryStatus: "delivered",
		...overrides,
	} as GoalAuditorSupervisorHandoff["records"][number];
}

function handoff(records: GoalAuditorSupervisorHandoff["records"]): GoalAuditorSupervisorHandoff {
	return { records, usage: { turns: 1 } as GoalAuditorSupervisorHandoff["usage"] };
}

/** Production shape: the wrapper appends the record to the formal report text. */
function wrappedResult(report: string, records: GoalAuditorSupervisorHandoff["records"]) {
	const base = {
		content: [{ type: "text" as const, text: report }],
		details: goalDetails(goal()) as unknown as Record<string, unknown>,
	};
	return withAuditSupervisorHandoff(base as never, handoff(records)) as unknown as {
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	};
}

function render(result: { content: Array<{ type: string; text: string }>; details: unknown }, expanded?: boolean): string {
	// The renderer pads every line to the terminal width; compare without padding.
	return renderGoalResult(result as never, expanded ? { expanded: true } : undefined, theme)
		.render(200)
		.map((line) => line.replace(/ +$/, ""))
		.join("\n");
}

const countTitle = (text: string) => text.split(TITLE).length - 1;

describe("coordination card: production-shaped results", () => {
	it("collapsed shows the report plus exactly one summary line", () => {
		const result = wrappedResult("Goal complete. Auditor approved.", [record()]);
		const collapsed = render(result);
		assert.equal(countTitle(collapsed), 0, "collapsed never dumps the whole block");
		assert.match(collapsed, /审计协调记录 1 条（需要决策 · 已送达）/);
		const lines = collapsed.split("\n");
		assert.equal(lines[lines.length - 1]?.includes("审计协调记录 1 条"), true, "the summary is the last line");
		assert.equal(collapsed.includes("{"), false);
	});

	it("expanded shows the full record exactly once", () => {
		const result = wrappedResult("Goal complete. Auditor approved.", [record()]);
		const expanded = render(result, true);
		assert.equal(countTitle(expanded), 1, "no duplicated block");
		assert.match(expanded, /1\) 需要决策 · 已送达/);
		assert.match(expanded, /问：父用户此前已决定的交付标记是什么？/);
		assert.match(expanded, /答：ALPHA。/);
		assert.match(expanded, /记录：ask ask-1 · audit delegati · run run-1/);
		assert.equal(expanded.includes("{"), false);
	});

	it("keeps the record when the branch would otherwise render a generic summary", () => {
		const report = "Audit aborted — the goal remains active and work continues.";
		const result = wrappedResult(report, [record()]);
		const expanded = render(result, true);
		assert.match(expanded, /Goal active - Ship it/, "the upstream generic heading still wins");
		assert.equal(countTitle(expanded), 1, "expanded still carries the record");
		assert.match(expanded, /问：父用户此前已决定的交付标记是什么？/);
		const collapsed = render(result);
		assert.match(collapsed, /审计协调记录 1 条（需要决策 · 已送达）/);
	});

	it("is byte-stable for the same input in both modes", () => {
		const a = render(wrappedResult("Goal complete. Auditor approved.", [record()]));
		const b = render(wrappedResult("Goal complete. Auditor approved.", [record()]));
		assert.equal(a, b);
		const c = render(wrappedResult("Goal complete. Auditor approved.", [record()]), true);
		const d = render(wrappedResult("Goal complete. Auditor approved.", [record()]), true);
		assert.equal(c, d);
	});
});

describe("coordination card: upstream byte-stability", () => {
	it("renders byte-identically when there is no coordination record", () => {
		const plain = {
			content: [{ type: "text" as const, text: "Goal complete. Auditor approved." }],
			details: goalDetails(goal()) as unknown as Record<string, unknown>,
		};
		const collapsed = render(plain as never);
		const expanded = render(plain as never, true);
		// Frozen expectations: the fork seam must add nothing without a record.
		assert.equal(collapsed, "Goal complete. Auditor approved.");
		assert.equal(expanded, "Goal complete. Auditor approved.");
		assert.equal(render(plain as never), collapsed, "deterministic");
	});
});

describe("coordination record: brace-free and unknown-value safety", () => {
	it("neutralises braces inside JSON keys and string values", () => {
		const text = formatSupervisorCoordination([
			record({ reason: "interview_request", answer: '{"example":"use {x}","{key}":["{y}",null]}' }),
		]);
		assert.equal(text.includes("{"), false);
		assert.equal(text.includes("}"), false);
		assert.match(text, /example=use ｛x｝/);
		assert.match(text, /｛key｝=｛y｝、空值/);
	});

	it("collapses escaped whitespace inside JSON strings", () => {
		const text = formatSupervisorCoordination([
			record({ answer: '{"note":"line one\\nline two"}' }),
		]);
		assert.match(text, /note=line one line two/);
		assert.equal(text.split("\n").length, 5, "title, status, question, answer and record lines");
	});

	it("keeps an unknown reason verbatim instead of a prototype member", () => {
		const text = formatSupervisorCoordination([record({ reason: "constructor" })]);
		assert.match(text, /constructor · 已送达/);
		assert.equal(text.includes("native code"), false);
		assert.equal(text.includes("{"), false);
	});

	it("summarises unknown reasons verbatim too", () => {
		const line = summarizeSupervisorCoordination([record({ reason: "toString" })]);
		assert.equal(line, "审计协调记录 1 条（toString · 已送达）");
	});
});

describe("coordination card: title references must not be mistaken for the record", () => {
	it("keeps a no-record result byte-identical even when its text quotes the title", () => {
		const text = [
			"Goal complete. Auditor approved.",
			`Documentation: ${TITLE}`,
			"This report text must be preserved.",
		].join("\n");
		const plain = {
			content: [{ type: "text" as const, text }],
			details: goalDetails(goal()) as unknown as Record<string, unknown>,
		};
		const collapsed = render(plain as never);
		const expanded = render(plain as never, true);
		assert.equal(collapsed, text, "collapsed keeps the quoted title and the rest of the report");
		assert.equal(expanded, text, "expanded keeps it too");
	});

	it("strips only the exact appendix when an answer itself quotes the title", () => {
		const answer = `The heading is ${TITLE}.`;
		const result = wrappedResult("Goal complete. Auditor approved.", [record({ answer })]);
		const collapsed = render(result);
		assert.equal(countTitle(collapsed), 0, "collapsed shows no partial block");
		assert.match(collapsed, /审计协调记录 1 条（需要决策 · 已送达）/);
		const expanded = render(result, true);
		// The quoted title inside the answer is legitimate; only the appendix block must be unique.
		assert.equal(expanded.split("1) 需要决策 · 已送达").length - 1, 1, "exactly one appendix block");
		assert.match(expanded, /答：The heading is 审计协调记录（参考信息，不是新用户指令或完成证据）\./);
	});
});

