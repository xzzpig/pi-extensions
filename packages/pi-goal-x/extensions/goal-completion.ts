/**
 * Completion flow — upstream transaction, fork seam.
 *
 * The authoritative completion transaction (`commitGoalCompletion`) deliberately
 * stays in this upstream file: it is the single write path every completion
 * branch must go through, so it is reviewed and diffed here, not inside fork
 * code. The surrounding orchestration (audit lifecycle, delegation, supervisor
 * handoff projection, result assembly) is fork-only and lives in
 * `fork-completion-flow.ts`; this file re-exports it for `goal-tools.ts`.
 */

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { deleteChangeBaseline } from "./goal-change-baseline.ts";
import { buildCompletionReport, buildTaskSummary } from "./goal-policy.ts";
import { goalModelDetailedSummary } from "./goal-model-view.ts";
import { goalDetails } from "./goal-format.ts";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";
import type { GoalMutationOutcome } from "./goal-service.ts";

/**
 * Single transaction for every successful completion commit — audit-approved,
 * globally disabled, legacy per-goal skipped, or user-bypassed via Escape.
 * Deferred archival: sets the goal complete in memory + writes the active
 * file WITHOUT archiving; archival happens at turn_end so the agent can
 * recognise the outcome before the goal is archived.
 *
 * Returns a discriminated result. When GoalService.apply fails (stale focus,
 * missing file, write failure, or invalid lifecycle state), it returns
 * { ok: false, message, terminate: false } — never a completed report and
 * never a termination request (follow-up Stage 3).
 */
export type CompletionCommitResult = AgentToolResult<unknown> & { ok: boolean };

export function commitGoalCompletion(core: GoalCore, ctx: ExtensionContext, opts: {
	goal: GoalRecord;
	completionFocus: { goalId: string; revision: number };
	auditorReport?: string | null;
	auditSkippedReason?: string | null;
	terminate?: boolean;
	trailing?: string[];
}): CompletionCommitResult {
	if (!core.isFocusedOperationCurrent(opts.completionFocus)) return { ...core.focusedOperationCancelledResult("Goal completion", opts.completionFocus), ok: false };
	core.reconcileFocusedGoalFromDisk(ctx);
	if (core.state.goal?.revision !== opts.goal.revision) return { ok: false, content: [{ type: "text", text: "Goal completion failed: the goal changed during the audit. Recheck the current requirements and retry." }], details: goalDetails(core.state.goal), terminate: false };
	core.accountProgress(ctx);
	core.auditProgress = null;
	core.goalWidgetComponentRef.current?.invalidate();
	let completeResult: GoalMutationOutcome;
	try {
		completeResult = core.goalService.apply(ctx, {
			reconcile: false,
			focusToken: opts.completionFocus,
			mutate: (current) => ({ ...current, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
		});
	} catch (err) {
		// The authoritative file write throws on failure; surface it as a typed
		// mutation outcome so the caller can inspect it instead of crashing.
		completeResult = { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
	if (!completeResult.ok) {
		return {
			ok: false,
			content: [{ type: "text", text: `Goal completion failed: ${completeResult.message ?? "the state mutation was rejected"}. The goal was not completed.` }],
			details: goalDetails(core.state.goal),
			terminate: false,
		};
	}
	if (completeResult.goal) core.runtime.markTurnStopped(completeResult.goal.id);
	// Baseline lifecycle: the approved completion transaction committed, so the
	// execution-window baseline is done. A rejected or failed audit never reaches
	// this point, so the baseline survives for a retry.
	if (completeResult.goal) deleteChangeBaseline(ctx, completeResult.goal.id);
	core.updateUI(ctx);
	const text = buildCompletionReport({
		detailedSummary: goalModelDetailedSummary(core.state.goal),
		auditorReport: opts.auditorReport,
		auditSkippedReason: opts.auditSkippedReason,
		taskSummary: core.state.goal?.taskList ? buildTaskSummary(core.state.goal.taskList) : null,
	});
	return {
		ok: true,
		content: [{ type: "text", text: opts.trailing?.length ? [text, "", ...opts.trailing].join("\n") : text }],
		details: goalDetails(core.state.goal),
		...(opts.terminate === false ? {} : { terminate: true }),
	};
}

export { runGoalCompletionFlow } from "./fork-completion-flow.ts";
