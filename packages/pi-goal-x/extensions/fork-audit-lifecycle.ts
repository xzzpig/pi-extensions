import { nowIso } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalCore, ActiveGoalAudit } from "./goal-state.ts";
import type { GoalStorageContext } from "./storage/goal-root.ts";

/** Bind terminal audit settlement to the original session storage and attempt. */
export function createAuditLifecycle(core: GoalCore, storage: GoalStorageContext, goalId: string, auditId: string, onCancel?: () => void): {
	run: ActiveGoalAudit;
	settle(event: GoalLedgerEvent): boolean;
} {
	const run: ActiveGoalAudit = {
		controller: new AbortController(),
		phase: "running",
		cancel(reason) {
			if (run.phase === "settling" || run.phase === "settled") return;
			run.controller.abort();
			try {
				onCancel?.();
			} finally {
				settle({ type: "audit_result", auditId, goalId, verdict: "error", report: reason, at: nowIso() });
			}
		},
	};
	function settle(event: GoalLedgerEvent): boolean {
		if (run.phase === "settling" || run.phase === "settled") return false;
		run.phase = "settling";
		try {
			return core.goalService.appendEvents(storage, [event], { immediate: true });
		} catch {
			return false;
		} finally {
			run.phase = "settled";
			if (core.activeAudit === run) {
				core.activeAudit = null;
				core.stopAuditAnimation();
				core.auditProgress = null;
				core.goalWidgetComponentRef.current?.invalidate();
			}
		}
	}
	return { run, settle };
}
