/**
 * Structured audit dashboard model (plan §15).
 *
 * Derivation from the actual checklist and reported pending/running/passed/
 * failed states, plus the approval/rejection result
 * card model. No TUI imports; the renderer and /goal-status share this model.
 */

import type { AuditorProgress } from "../goal-auditor.ts";
import { deriveDynamicAuditorDashboardModel } from "./fork-auditor-dashboard-model.ts";
import { formatDashboardDuration } from "./goal-dashboard-model.ts";

export type AuditCheckState = "pending" | "running" | "passed" | "failed";

export type AuditCheckId = string;

export interface AuditCheck {
	id: AuditCheckId;
	label: string;
	state: AuditCheckState;
	detail?: string;
	sequence?: number;
}

export type AuditVerdict = "approved" | "disapproved" | "error";

export interface AuditorDashboardModel {
	auditorLabel: string;
	elapsedMs: number;
	percentage?: number;
	checks: AuditCheck[];
	progressDiagnostic?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput: string[];
	/** Result verdict when the audit finished (drives the result card). */
	verdict?: AuditVerdict | null;
	/** Whether the audit session is still running (false when phase === done). */
	active: boolean;
}

export interface AuditResultCard {
	verdict: AuditVerdict;
	label: string;
	lines: string[];
}

export interface DeriveAuditorDashboardOptions {
	auditorLabel?: string;
	/** Result verdict when known (set after the audit session finishes). */
	verdict?: AuditVerdict | null;
}

/**
 * Derive the structured audit dashboard from the raw progress stream (§15.2).
 *
 * Checks retain the last reported item states. Percentage estimates and the
 * final verdict never infer or overwrite those states.
 */
export function deriveAuditorDashboardModel(
	progress: AuditorProgress,
	options: DeriveAuditorDashboardOptions = {},
): AuditorDashboardModel {
	return deriveDynamicAuditorDashboardModel(progress, options);
}

/** Human duration label for the audit header (reused formatter). */
export function formatAuditElapsed(elapsedMs: number): string {
	return formatDashboardDuration(Math.floor(elapsedMs / 1000));
}

/**
 * Build the result card (§15.4). Approval shows the fixed acceptance lines;
 * rejection extracts concise findings from the auditor report (bullet-style or
 * the leading non-marker lines, capped at three); errors state the failure.
 */
export function deriveAuditResultCard(verdict: AuditVerdict, report: string): AuditResultCard {
	if (verdict === "approved") {
		return {
			verdict,
			label: "APPROVED",
			lines: [oneLine(report) || "Auditor approved the goal."],
		};
	}
	if (verdict === "error") {
		return {
			verdict,
			label: "ERROR",
			lines: [report.trim() ? oneLine(report) : "The auditor could not finish the review."],
		};
	}
	const findings = extractFindings(report);
	return {
		verdict,
		label: "CHANGES REQUIRED",
		lines: findings.length > 0 ? findings : [oneLine(report) || "The auditor requested changes — review the report."],
	};
}

function extractFindings(report: string): string[] {
	const lines = report.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const findings: string[] = [];
	for (const line of lines) {
		if (/^<(approved|disapproved)\s*\/>/.test(line)) continue;
		const cleaned = line.replace(/^[-*•✗✓]\s*/, "").replace(/^(\d+[.)])\s*/, "").trim();
		if (!cleaned) continue;
		// Skip section headers ("Audit report:", "Findings:") and generic
		// "Auditor: ..." attribution lines — they are not findings.
		if (/^auditor\s*:/i.test(cleaned)) continue;
		if (/^[a-z][a-z ]{0,24}:$/i.test(cleaned)) continue;
		if (cleaned.length > 200) findings.push(`${cleaned.slice(0, 197)}...`);
		else findings.push(cleaned);
		if (findings.length >= 3) break;
	}
	return findings;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
