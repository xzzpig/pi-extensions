/**
 * Fork-only decision handling for agent-initiated goal tweaks.
 *
 * An explicit tweak proposal is PRE-APPROVAL: it must not register a durable
 * draft, clear a user draft, or touch accounting/continuation state. Those
 * side effects belong only to the user's "continue chatting" decision, which
 * turns the one-shot proposal into a resumable draft.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveGoalDraft, GoalDraftSession } from "./goal-drafting.ts";
import type { GoalCore } from "./goal-state.ts";
import type { GoalRecord } from "./goal-record.ts";
import { readAuthoritativeGoal } from "./fork-goal-authority.ts";
import { continuedDraftSession } from "./goal-agent-tweak.ts";
import { StaleTweakError, type TweakReview } from "./goal-tweak-review.ts";

export interface AgentTweakDecisionPorts {
	activeDraft(): ActiveGoalDraft | undefined;
	setActive(active: boolean): void;
	setDraft(draft: ActiveGoalDraft): void;
	persistSession(session: GoalDraftSession): void;
	/** Clear the active draft. The helper calls this only for an owned draft. */
	clearDraft(): void;
}

/** Two drafts are the same logical proposal when their identity markers match. */
export function isSameDraft(a: ActiveGoalDraft | undefined, b: ActiveGoalDraft): boolean {
	return !!a && a.agentInitiated === b.agentInitiated && a.mode === b.mode
		&& a.targetGoalId === b.targetGoalId && a.startedAt === b.startedAt;
}

/**
 * True when the currently active draft may be changed/cleared for this proposal.
 * `registered` distinguishes a first proposal (never written to state) from a
 * continued proposal that was written and may since have been cancelled.
 */
export function canMutateDraft(current: ActiveGoalDraft | undefined, proposal: ActiveGoalDraft, registered: boolean): boolean {
	if (registered) return isSameDraft(current, proposal); // cleared/replaced → false
	return current === undefined; // a first proposal must not overwrite a newer draft
}

/** Error text attached to a post-decision authority rejection. */
export function decisionRejectedText(): string {
	return "The goal or active draft changed while reviewing this proposal; nothing was saved. Review it before proposing again.";
}

/** Apply a failed post-decision result so the saved snapshot records an error outcome. */
export function rejectDecision<T extends { isError?: boolean; content: ReadonlyArray<{ type: "text"; text?: string }> }>(
	result: T,
	review: { recordFailure(error: Error): string } | undefined,
	reason: string,
): T {
	review?.recordFailure(new Error(reason));
	result.isError = true;
	return result;
}

export function commitAgentTweakDecision(args: {
	decision: "confirm" | "continue" | "cancel";
	unavailable: boolean;
	/** Was this proposal already registered as the active draft when review began? */
	registered: boolean;
	proposal: ActiveGoalDraft;
	ports: AgentTweakDecisionPorts;
}): { ok: true } | { ok: false; reason: "replaced" | "cancelled" } {
	const { decision, unavailable, registered, proposal, ports } = args;
	const current = ports.activeDraft();
	if (!canMutateDraft(current, proposal, registered)) {
		return { ok: false, reason: registered && !current ? "cancelled" : "replaced" };
	}
	if (decision === "cancel" || unavailable) {
		if (registered) ports.clearDraft();
		return { ok: true };
	}
	if (decision === "confirm") {
		if (registered) ports.clearDraft();
		return { ok: true };
	}
	if (decision === "continue") {
		// Only now does a one-shot proposal become a resumable model draft.
		const previous = current;
		const draft: ActiveGoalDraft = { ...proposal, startedAt: previous?.startedAt ?? proposal.startedAt };
		ports.setDraft(draft);
		ports.setActive(true);
		ports.persistSession({
			version: 1, mode: draft.mode, seed: draft.originalTopic,
			targetGoalId: draft.targetGoalId, startedAt: draft.startedAt,
			auditorEnabled: draft.auditorEnabled, reason: draft.reason, agentInitiated: true,
		});
	}
	return { ok: true };
}

/** Dispatch post-dialog draft lifecycle without changing manual-draft semantics. */
export function handleDraftDecision(args: { decision: "cancel" | "continue"; unavailable: boolean;
 proposal: ActiveGoalDraft; registered: boolean; auditorEnabled: boolean; ports: AgentTweakDecisionPorts }): boolean {
 const agent = args.proposal.agentInitiated === true;
 if (agent) {
  commitAgentTweakDecision({ ...args, proposal: { ...args.proposal, auditorEnabled: args.auditorEnabled } });
 } else if (args.decision === "cancel") {
  args.ports.clearDraft();
 } else if (!args.unavailable && args.decision === "continue" && args.auditorEnabled !== args.proposal.auditorEnabled) {
  const next = { ...args.proposal, auditorEnabled: args.auditorEnabled };
  args.ports.setDraft(next);
  args.ports.persistSession(continuedDraftSession(next));
 }
 return agent;
}

/** Stop waiting for a host dialog when the tool call is aborted. */
export async function awaitProposalDecision<T>(decision: Promise<T>, signal?: AbortSignal): Promise<T> {
 if (!signal) return decision;
 if (signal.aborted) throw new Error("Goal proposal aborted");
 return new Promise<T>((resolve, reject) => {
  const abort = () => reject(new Error("Goal proposal aborted"));
  signal.addEventListener("abort", abort, { once: true });
  decision.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
 });
}

/** Evaluate draft ownership and authoritative goal/execution gates at decision time. */
export function checkAgentDecision(ctx: ExtensionContext, core: GoalCore, draft: ActiveGoalDraft,
 registered: boolean, current: ActiveGoalDraft | undefined,
 token: ReturnType<GoalCore["focusedOperationToken"]> | undefined, revision: number): {
 fresh: GoalRecord | null; conflict?: "goal" | "draft";
} {
 if (!draft.agentInitiated) return { fresh: null };
 const fresh = readAuthoritativeGoal(ctx, core);
 if (!token || !core.isFocusedOperationCurrent(token) || !fresh || fresh.id !== draft.targetGoalId
  || fresh.revision !== revision || fresh.status !== "active" || core.runningGoalId !== draft.targetGoalId
  || core.scheduler.isDenied() || core.currentTurnStoppedGoalId() !== null) return { fresh, conflict: "goal" };
 if (!canMutateDraft(current, draft, registered)) return { fresh, conflict: "draft" };
 return { fresh };
}

/** Project from the lock-time record only if it remains eligible and reviewed. */
export function projectLockedTweak(args: { goal: GoalRecord; fresh: GoalRecord | null; authoritative: GoalRecord | null;
 agentInitiated: boolean; targetId: string; revision: number; review: TweakReview; auditorEnabled: boolean; now: string; signal?: AbortSignal }) {
 if (args.signal?.aborted) throw new StaleTweakError("The goal proposal was aborted.");
 const basis = args.fresh ?? args.authoritative ?? args.goal;
 if (args.agentInitiated && (!args.fresh || basis.id !== args.targetId || basis.activePath !== args.goal.activePath || basis.status !== "active" || basis.revision !== args.revision))
  throw new StaleTweakError("The reviewed goal changed; propose again.");
 const projected = args.review.mutate(basis, args.auditorEnabled);
 return { candidate: { ...projected.candidate, updatedAt: args.now }, resumed: projected.resumed };
}
