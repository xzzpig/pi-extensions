/**
 * Plan approval gate (design D6/D7; openspec change add-pi-openspec-x, task
 * 7.3).
 *
 * After the plan review returns OKAY the plan is final, but implementation is
 * still not authorized: the user must approve the PLAN explicitly. Approval
 * covers the plan only — it never authorizes implementation by itself; the
 * `/opsx:implement` flow is a separate, explicit step.
 *
 * The gate is fail-closed: `canEnterImplementation` is true only for an
 * `approved` decision recorded against the same change. A missing, pending,
 * revised, or rejected approval keeps implementation locked.
 *
 * The structured question uses the host's blocking selector when a UI exists
 * (pi-ask present or not — the selector is the plugin's own deterministic
 * dialog). Without a UI the plugin degrades to a plain-text request and leaves
 * the decision pending, so the gate stays closed until a structured approval
 * is recorded.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  emitSilentUiSpan,
  publishLifecycle,
  publishNotify,
  type EventEmitterLike,
} from "./lifecycle.ts";

/** Minimal host view for capability probes; the real ExtensionAPI satisfies it. */
export interface ToolNameSource {
  getAllTools(): ReadonlyArray<{ name: string }>;
}

/** How the approval was requested. */
export type ApprovalVia = "pi-ask" | "select" | "text";

/** The user's plan decision. */
export type ApprovalDecision = "approved" | "revise" | "rejected" | "pending";

export interface PlanApproval {
  changeId: string;
  decision: ApprovalDecision;
  /** ISO timestamp. */
  at: string;
  via: ApprovalVia;
}

const APPROVAL_OPTIONS = [
  { value: "approved", label: "Approve the plan" },
  { value: "revise", label: "Request changes" },
  { value: "rejected", label: "Reject the plan" },
] as const;

/** The pi-ask / host tool whose presence marks the structured-ask path. */
export const PI_ASK_TOOL_NAME = "ask_user";

/** True when pi-ask's `ask_user` tool is registered in this process. */
export function detectPiAsk(pi: ToolNameSource): boolean {
  try {
    return pi.getAllTools().some((tool) => tool.name === PI_ASK_TOOL_NAME);
  } catch {
    return false;
  }
}

/**
 * Fail-closed gate: only an `approved` decision for this exact change unlocks
 * implementation. Everything else (missing, pending, revise, rejected, or a
 * different change) keeps it locked.
 *
 * The decision is only ever read from the structured selector answer (or the
 * recorded ledger entry) — free text is never interpreted (README: the plugin
 * does not listen to free-text approval).
 */
export function canEnterImplementation(
  approval: PlanApproval | undefined,
  changeId: string,
): boolean {
  return Boolean(
    approval &&
      approval.changeId === changeId &&
      approval.decision === "approved",
  );
}

function approvalPrompt(changeId: string): string {
  return `Approve the plan for change "${changeId}"? Approval covers the finalized plan only; implementation remains a separate /opsx:implement step.`;
}

/**
 * Request the user's plan approval. Opens the host's blocking selector when a
 * UI exists (recording `via: "pi-ask"` when pi-ask is installed, so observers
 * know the structured path was available); without a UI the decision stays
 * pending and the caller asks in plain text.
 */
export async function requestPlanApproval(
  pi: ToolNameSource,
  ctx: ExtensionContext,
  changeId: string,
  events?: EventEmitterLike,
): Promise<PlanApproval> {
  const at = new Date().toISOString();
  if (events) {
    // Blocking approval: claim the UI span as silent, then announce the wait.
    emitSilentUiSpan(events, "plan approval dialog");
    publishLifecycle(events, {
      type: "approval_wait",
      change: changeId,
      mode: "plan",
    });
    publishNotify(events, {
      eventId: "input-required",
      label: `Approve the plan for ${changeId}`,
    });
  }
  if (!ctx.hasUI) {
    return { changeId, decision: "pending", at, via: "text" };
  }
  const via: ApprovalVia = detectPiAsk(pi) ? "pi-ask" : "select";
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(
      approvalPrompt(changeId),
      APPROVAL_OPTIONS.map((option) => option.label),
    );
  } catch {
    return { changeId, decision: "pending", at, via };
  }
  const option = APPROVAL_OPTIONS.find((entry) => entry.label === choice);
  const decision = option ? option.value : "pending";
  if (events && decision === "approved") {
    publishLifecycle(events, {
      type: "plan_approved",
      change: changeId,
      mode: "plan",
    });
  }
  return { changeId, decision, at, via };
}
