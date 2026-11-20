/**
 * Fork-only orchestration for agent-initiated goal tweaks.
 *
 * Owns admission, draft construction/registration and cleanup so the upstream
 * `goal-drafting.ts` keeps only a small call seam. All state access is injected
 * through a narrow context; the actual review/transaction remains upstream.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalCore } from "./goal-state.ts";
import type { ActiveGoalDraft } from "./goal-drafting.ts";
import type { GoalRecord, GoalTaskList } from "./goal-record.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { nowIso } from "./goal-record.ts";
import { readAuthoritativeGoal } from "./fork-goal-authority.ts";
import {
	parseExplicitTweak,
	validateAgentTweakAdmission,
	validateContinuedTweakAdmission,
	type ExplicitTweak,
} from "./goal-agent-tweak.ts";

export interface AgentTweakPorts {
	/** Fresh, uncached record from the focused goal's active file. */
	authoritativeGoal(): GoalRecord | null;
	activeDraft(): ActiveGoalDraft | undefined;
	/** Pure parameter validation; returns parsed inputs or an error before any side effect. */
	validateParams(): { ok: true; objective: string; taskResult: { ok: true; value?: GoalTaskList }; extracted: { objective: string; verificationContract?: string } } | { ok: false; message: string };
	/** Pure cached-state admission pre-check; still re-checked after authoritative reconcile. */
	precheckAdmission(tweak: ExplicitTweak): string | undefined;
	flushAndReconcile(): string | undefined;
	currentGoal(): GoalCore["state"]["goal"];
	runningGoalId(): string | null;
	stoppedGoalId(): string | null;
	schedulerDenied(): boolean;
}

/** Bind admission policy to the core; the caller supplies draft and validation seams. */
export function createAgentTweakPorts(core: GoalCore, ctx: ExtensionContext,
 activeDraft: AgentTweakPorts["activeDraft"], validateParams: AgentTweakPorts["validateParams"], tweak?: unknown): AgentTweakPorts {
 return {
  authoritativeGoal: () => readAuthoritativeGoal(ctx, core), activeDraft, validateParams,
  precheckAdmission: (tweak) => {
   const result = validateAgentTweakAdmission(tweak, { goal: core.state.goal, runningGoalId: core.runningGoalId,
    stoppedGoalId: core.currentTurnStoppedGoalId(), schedulerDenied: core.scheduler.isDenied() });
   return result.ok ? undefined : result.message;
  },
  flushAndReconcile: () => {
   const error = core.goalService.flushForAudit(ctx, tweak !== undefined || activeDraft()?.agentInitiated === true);
   if (error || core.goalService.isTurnBuffered()) return error ?? "goal changes are still buffered";
   core.reconcileFocusedGoalFromDisk(ctx);
   return undefined;
  },
  currentGoal: () => core.state.goal, runningGoalId: () => core.runningGoalId,
  stoppedGoalId: () => core.currentTurnStoppedGoalId(), schedulerDenied: () => core.scheduler.isDenied(),
 };
}

export type PrepareResult =
	| { kind: "reject"; message: string }
	| { kind: "proceed"; draft: ActiveGoalDraft; explicit?: ExplicitTweak; target?: NonNullable<GoalCore["state"]["goal"]>; registered: boolean;
	    objective: string; taskResult: { ok: true; value?: GoalTaskList }; extracted: { objective: string; verificationContract?: string } };

/**
 * Run authority: reconcile from disk, validate, then build a LOCAL proposal.
 * This function never mutates draft or runtime state. Side effects belong only
 * to the post-decision `commitAgentTweakDecision` path.
 */
export function prepareAgentTweak(params: { tweak?: unknown }, ports: AgentTweakPorts, ctx: ExtensionContext): PrepareResult {
	const parsed = parseExplicitTweak(params.tweak);
	if (parsed && !parsed.ok) return { kind: "reject", message: parsed.message };
	// All pure admission decisions happen BEFORE flush/reconcile. A rejected
	// call never closes a turn transaction buffer or forces an early write.
	const existing = ports.activeDraft();
	if (!parsed?.ok && !existing) {
		return { kind: "reject", message: "No guided goal draft is active. Start /goal, /sisyphus, /goal-tweak, or pass an explicit tweak proposal." };
	}
	if (parsed?.ok && existing
		&& !(existing.agentInitiated === true && existing.mode === "tweak" && existing.targetGoalId === parsed.value.goalId)) {
		return { kind: "reject", message: "A guided draft is already active. Confirm or cancel it before proposing another tweak; the active draft was not changed." };
	}
	const validated = ports.validateParams();
	if (!validated.ok) return { kind: "reject", message: validated.message };
	// Pure authoritative/turn gates BEFORE flush. A rejected call must never
	// close a turn transaction buffer or force an early write.
	const freshBeforeFlush = ports.authoritativeGoal();
	if (parsed?.ok) {
		const precheck = ports.precheckAdmission(parsed.value);
		if (precheck) return { kind: "reject", message: precheck };
		if (!freshBeforeFlush) return { kind: "reject", message: "The focused goal file is unavailable; an agent-initiated tweak is not admitted." };
		if (freshBeforeFlush.id !== parsed.value.goalId) return { kind: "reject", message: `The focused goal changed while preparing the tweak (expected ${parsed.value.goalId}, found ${freshBeforeFlush.id}); review and propose again.` };
		if (freshBeforeFlush.status !== "active") return { kind: "reject", message: `The focused goal is ${freshBeforeFlush.status}, not active; an agent-initiated tweak is not admitted.` };
	} else if (existing?.mode === "tweak" && existing.reason) {
		// A continued agent proposal inherits the same pre-flush gates.
		if (!freshBeforeFlush) return { kind: "reject", message: "The focused goal file is unavailable; the tweak cannot continue." };
		if (existing.agentInitiated && freshBeforeFlush.id !== existing.targetGoalId) return { kind: "reject", message: "The draft is bound to another goal; no changes were flushed." };
		if (freshBeforeFlush.status !== "active") return { kind: "reject", message: `The focused goal is ${freshBeforeFlush.status}, not active; the tweak cannot continue.` };
		if (ports.stoppedGoalId() !== null || ports.schedulerDenied() || ports.runningGoalId() !== freshBeforeFlush.id) {
			return { kind: "reject", message: "Goal execution is stopped in this turn; the tweak cannot continue." };
		}
	}
	const flushError = ports.flushAndReconcile();
	if (flushError) return { kind: "reject", message: "Proposal not saved: " + flushError };
	const state = {
		goal: ports.currentGoal(),
		runningGoalId: ports.runningGoalId(),
		stoppedGoalId: ports.stoppedGoalId(),
		schedulerDenied: ports.schedulerDenied(),
	};
	// Capture one post-flush authority snapshot for admission, the initial
	// auditor choice and the exact review baseline. Never substitute cached
	// fields for agent drafts when that record is unavailable.
	const fresh = ports.authoritativeGoal();
	const isAgent = parsed?.ok === true || existing?.agentInitiated === true;
	if (isAgent && !fresh) return { kind: "reject", message: "The focused goal file is unavailable; an agent-initiated tweak is not admitted." };
	const authorityState = { ...state, goal: isAgent ? fresh : state.goal };
	if (parsed?.ok) {
		const admission = !fresh
			? ({ ok: false as const, message: "The focused goal file is unavailable; an agent-initiated tweak is not admitted." })
			: fresh.id !== parsed.value.goalId
				? ({ ok: false as const, message: `The focused goal changed while preparing the tweak (expected ${parsed.value.goalId}, found ${fresh.id}); review and propose again.` })
				: fresh.status !== "active"
					? ({ ok: false as const, message: `The focused goal is ${fresh.status}, not active; an agent-initiated tweak is not admitted.` })
					: validateAgentTweakAdmission(parsed.value, authorityState);
		if (!admission.ok) return { kind: "reject", message: admission.message };
	}
	let draft = existing;
	if (parsed?.ok && fresh) {
		const auditorEnabled = !(fresh.skipAuditor ?? (loadGoalSettings(ctx.cwd).auditor?.disabled === true));
		draft = {
			mode: "tweak", originalTopic: parsed.value.reason, targetGoalId: fresh.id,
			startedAt: existing?.startedAt ?? nowIso(),
			auditorEnabled: existing?.auditorEnabled ?? auditorEnabled, reason: parsed.value.reason, agentInitiated: true,
		};
	}
	if (!draft) return { kind: "reject", message: "No guided goal draft is active. Start /goal, /sisyphus, /goal-tweak, or pass an explicit tweak proposal." };
	if (draft.mode === "tweak" && draft.reason && authorityState.goal) {
		const continued = validateContinuedTweakAdmission(parsed?.ok ? parsed.value : undefined, draft, authorityState);
		if (!continued.ok) return { kind: "reject", message: continued.message };
	}
	// The review baseline is the authoritative record, never the cache-merged one.
	const freshTarget = isAgent ? fresh : state.goal;
	return { kind: "proceed", draft, registered: existing !== undefined, objective: validated.objective, taskResult: validated.taskResult, extracted: validated.extracted,
		...(parsed?.ok ? { explicit: parsed.value } : {}), ...(freshTarget ? { target: freshTarget } : {}) };
}
