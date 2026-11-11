import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TweakReview, withTweakReview, renderTweakReview, renderTweakCall } from "../extensions/goal-tweak-review.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import { createMockTheme } from "./tui-test-utils.ts";

function fixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "tweak-review-"));
	const ctx = { cwd, sessionManager: { getSessionId: () => "test" } } as unknown as ExtensionContext;
	const goal: GoalRecord = { id: "reviewed", objective: "old", status: "active", autoContinue: false,
		sisyphus: false, revision: 4, createdAt: "2026-11-04", updatedAt: "2026-11-04",
		usage: { tokensUsed: 0, activeSeconds: 0 }, verificationContract: "retained test contract",
		taskList: { tasks: [{ id: "keep", title: "done task", status: "complete", evidence: "checked" }], blockCompletion: true, proposedAt: "2026-11-04" } };
	return { ctx, goal, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("review candidate matches accepted mutation, keeps task evidence and omitted contract", async () => {
	const f = fixture();
	try {
		await withTweakReview(async () => {
			const review = new TweakReview(f.ctx, f.goal, "new", undefined, undefined, true);
			review.record({ decision: "confirm", auditorEnabled: false, unavailable: false });
			const projected = review.mutate(f.goal, false);
			assert.equal(projected.candidate.objective, "new");
			assert.equal(projected.candidate.verificationContract, "retained test contract");
			assert.equal(projected.candidate.taskList?.tasks[0]?.evidence, "checked");
			assert.equal(projected.candidate.skipAuditor, true);
			assert.match(review.presentation(false).fullText, /\[complete\] keep: done task/);
			return { content: [{ type: "text", text: "applied" }], terminate: true };
		});
	} finally { f.close(); }
});

test("saved record stays fixed after the live goal changes and exposes full content only on expansion", async () => {
	const f = fixture();
	try {
		const result = await withTweakReview(async () => {
			const review = new TweakReview(f.ctx, f.goal, "new", undefined, null, true);
			review.record({ decision: "confirm", auditorEnabled: true, unavailable: false });
			return { content: [{ type: "text", text: "applied" }], terminate: true, details: { retainedMachineField: 1 } };
		});
		f.goal.objective = "later unrelated change";
		const theme = createMockTheme();
		const expanded = renderTweakReview(result, true, theme)!.render(160).join("\n");
		const collapsed = renderTweakReview(result, false, theme)!.render(160).join("\n");
		assert.match(expanded, /- old/); assert.match(expanded, /\+ new/);
		assert.match(expanded, /retained test contract/); assert.doesNotMatch(expanded, /later unrelated change/);
		assert.doesNotMatch(collapsed, /retained test contract/);
		assert.equal(result.details.retainedMachineField, 1);
	} finally { f.close(); }
});

test("continue and cancel keep diff and feedback without claiming goal creation", async () => {
	const f = fixture();
	try {
		for (const decision of ["continue", "cancel"] as const) {
			const result = await withTweakReview(async () => {
				const review = new TweakReview(f.ctx, f.goal, "new", undefined, undefined, true);
				review.record({ decision, auditorEnabled: true, unavailable: false, feedback: "keep my feedback" });
				return { content: [{ type: "text", text: decision === "cancel" ? "Draft cancelled; no goal was created. Run /goal." : "keep my feedback" }] };
			});
			const rendered = renderTweakReview(result, true, createMockTheme())!.render(160).join("\n");
			assert.match(rendered, /- old/); assert.doesNotMatch(rendered, /no goal was created/);
			if (decision === "continue") assert.match(rendered, /keep my feedback/);
		}
	} finally { f.close(); }
});

test("changed revision or changed effective budget admission rejects the candidate", async () => {
	const f = fixture();
	try {
		const result = await withTweakReview(async () => {
			const review = new TweakReview(f.ctx, f.goal, "new", undefined, 10, true);
			review.record({ decision: "confirm", auditorEnabled: true, unavailable: false });
			review.mutate({ ...f.goal, revision: 5 }, true);
			return { content: [{ type: "text", text: "unexpected commit" }] };
		});
		assert.match(result.content.map(item => item.text).join("\n"), /not applied/);
		const review = new TweakReview(f.ctx, f.goal, "new", undefined, 10, true);
		assert.throws(() => review.mutate({ ...f.goal, usage: { tokensUsed: 20, activeSeconds: 0 } }, true), /changed/);
	} finally { f.close(); }
});

test("execution errors retain the review and are explicitly reported without claiming success", async () => {
	const f = fixture();
	try {
		const failure = await withTweakReview<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>(async () => {
			new TweakReview(f.ctx, f.goal, "new", undefined, undefined, true);
			throw new Error("write failed");
		});
		assert.equal(failure.isError, true);
		assert.match(failure.content.map(item => item.text).join("\n"), /application is not confirmed/);
		assert.match(renderTweakReview(failure, false, createMockTheme())!.render(160).join("\n"), /error/);
		assert.equal(renderTweakReview({ details: {} }, true, createMockTheme()), undefined);
	} finally { f.close(); }
});


test("call classification survives clearing the draft and replay via shared renderer state", async () => {
	const f = fixture();
	try {
		const theme = createMockTheme();
		let invalidations = 0;
		const context = { state: {}, invalidate: () => { invalidations++; } };
		assert.equal(renderTweakCall(false, theme, context), undefined);
		const preview = renderTweakCall(true, theme, context, { target: f.goal, args: { objective: "new" }, auditorEnabled: true })!.render(160).join("\n");
		assert.match(preview, /pending authoritative/);
		assert.match(preview, /- old/);
		assert.match(preview, /\+ new/);
		assert.ok(renderTweakCall(false, theme, context));
		const result = await withTweakReview(async () => {
			const review = new TweakReview(f.ctx, f.goal, "new", undefined, undefined, true);
			review.record({ decision: "cancel", auditorEnabled: true, unavailable: false });
			return { content: [{ type: "text", text: "cancelled" }] };
		});
		renderTweakReview(result, false, theme, context);
		renderTweakReview(result, false, theme, context);
		assert.equal(invalidations, 1, "the saved result requests one call-row refresh, not a render loop");
		assert.match(renderTweakCall(false, theme, context)!.render(160).join("\n"), /review snapshot below/);
		const creation = { state: {}, invalidate: () => {} };
		renderTweakReview({ details: { existingCreationResult: true } }, false, theme, creation);
		assert.equal(renderTweakCall(true, theme, creation), undefined, "another active tweak must not reclassify a saved creation row");
		const replay = { state: {}, invalidate: () => {} };
		renderTweakReview(result, false, theme, replay);
		assert.match(renderTweakCall(false, theme, replay)!.render(160).join("\n"), /review snapshot below/);
	} finally { f.close(); }
});
