/**
 * Fork-only admission rules for an agent-initiated goal tweak.
 *
 * The upstream draft flow requires a user command to create a draft. A running
 * goal's model may instead submit one explicit `propose_goal_draft` call that
 * names the target goal and explains why a revision is needed. This module
 * keeps that decision pure and testable; the caller owns all state access and
 * the existing review/transaction path.
 */
import { Type } from "typebox";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { GoalRecord } from "./goal-record.ts";

export const TWEAK_PARAM_SCHEMA = Type.Object({
	goal_id: Type.String({ description: "ID of the currently focused active goal to revise. Read it from get_goal or the injected goal context." }),
	reason: Type.String({ description: "Why this revision is proposed. Shown to the user above the diff; not written into the goal." }),
}, { additionalProperties: false });

export interface ExplicitTweak {
	goalId: string;
	reason: string;
}

export type TweakParseResult =
	| undefined
	| { ok: true; value: ExplicitTweak }
	| { ok: false; message: string };

/** Strip terminal control sequences from untrusted proposal text. Shared with the dialog and result renderer. */
/* eslint-disable no-control-regex -- escaping terminal control sequences is this sanitizer's purpose */
export function sanitizeTweakReason(text: string): string {
	return text
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[()][0-9A-Za-z]/g, "")
		.replace(/\u001b[@-_]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
/* eslint-enable no-control-regex */

/** Return undefined when absent; otherwise validate and sanitize the explicit tweak fields. */
export function parseExplicitTweak(raw: unknown): TweakParseResult {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, message: "tweak must be an object with goal_id and reason." };
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.goal_id !== "string" || !value.goal_id.trim()) {
		return { ok: false, message: "tweak.goal_id must be the non-empty ID of the focused active goal." };
	}
	if (typeof value.reason !== "string") {
		return { ok: false, message: "tweak.reason must be a non-empty explanation shown to the user." };
	}
	const reason = sanitizeTweakReason(value.reason).trim();
	if (!reason || !reason.split("\n").some(line => visibleWidth(line.trim()) > 0)) {
		return { ok: false, message: "tweak.reason must contain visible text after terminal control sequences are removed." };
	}
	return { ok: true, value: { goalId: value.goal_id.trim(), reason } };
}

export interface AgentTweakAdmissionState {
	goal: GoalRecord | null;
	runningGoalId: string | null;
	stoppedGoalId: string | null;
	schedulerDenied: boolean;
}

/** Pure admission check against the authoritative, disk-reconciled goal; no mutation, no UI. */
export function validateAgentTweakAdmission(tweak: ExplicitTweak, state: AgentTweakAdmissionState): { ok: true } | { ok: false; message: string } {
	if (!state.goal) {
		return { ok: false, message: "No focused goal is set; an agent-initiated tweak requires an active focused goal." };
	}
	if (state.goal.id !== tweak.goalId) {
		return { ok: false, message: `The focused goal changed while preparing the tweak (expected ${tweak.goalId}, found ${state.goal.id}); review and propose again.` };
	}
	if (state.goal.status !== "active") {
		return { ok: false, message: `The focused goal is ${state.goal.status}, not active; an agent-initiated tweak is not admitted.` };
	}
	// Bind the proposal to the execution turn that is actually running this goal.
	if (state.runningGoalId !== state.goal.id) {
		return { ok: false, message: "An agent-initiated tweak must be proposed during the focused goal's running turn; no active goal execution is bound to this turn." };
	}
	if (state.schedulerDenied || state.stoppedGoalId !== null) {
		return { ok: false, message: "Goal execution is stopped in this turn; an agent-initiated tweak is not admitted." };
	}
	return { ok: true };
}

/** Shape the durable session entry for a continued draft, preserving its reason. */
export function continuedDraftSession(draft: {
	mode: "goal" | "sisyphus" | "tweak";
	originalTopic: string;
	targetGoalId?: string;
	startedAt: string;
	auditorEnabled: boolean;
	reason?: string;
	agentInitiated?: boolean;
}) {
	return {
		version: 1 as const, mode: draft.mode, seed: draft.originalTopic,
		targetGoalId: draft.targetGoalId, startedAt: draft.startedAt,
		auditorEnabled: draft.auditorEnabled, ...(draft.reason ? { reason: draft.reason } : {}), ...(draft.agentInitiated ? { agentInitiated: true } : {}),
	};
}

/** Re-validate a continued draft whose proposer omitted `tweak` on a later call. */
export function validateContinuedTweakAdmission(
	tweak: ExplicitTweak | undefined,
	draft: { mode: string; targetGoalId?: string; reason?: string },
	state: AgentTweakAdmissionState,
): { ok: true; reason?: string } | { ok: false; message: string } {
	if (draft.mode !== "tweak") return { ok: true };
	const effective = tweak ?? (draft.targetGoalId && draft.reason
		? { goalId: draft.targetGoalId, reason: draft.reason }
		: undefined);
	if (!effective) return { ok: false, message: "This tweak draft has no recorded target/reason; start /goal-tweak again." };
	if (tweak && draft.targetGoalId && tweak.goalId !== draft.targetGoalId) {
		return { ok: false, message: "An active tweak draft is bound to another goal; confirm or cancel it before proposing a different revision." };
	}
	if (tweak && tweak.goalId !== effective.goalId) {
		return { ok: false, message: "The revised tweak no longer matches the draft target." };
	}
	const admission = validateAgentTweakAdmission(effective, state);
	if (!admission.ok) return admission;
	return { ok: true, reason: effective.reason };
}
