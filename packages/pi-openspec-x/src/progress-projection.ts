/**
 * Subagent progress projection (design D8; openspec change add-pi-openspec-x,
 * task 9.2).
 *
 * The reporting tools carry a phase label and a percentage alongside their
 * structured result. The parent projects those calls into a bounded progress
 * board: repeated updates for the same agent and phase fold into one row
 * (keeping the highest percentage), so a chatty subagent cannot flood the
 * interface. Progress is display-only — it never influences a gate.
 */

export interface ProgressUpdate {
  agent: string;
  /** The phase the subagent is in (e.g. "plan compliance"). */
  phase: string;
  label: string;
  /** 0–100; clamped on projection. */
  percentage: number;
}

export interface ProjectedProgress {
  agent: string;
  phase: string;
  label: string;
  percentage: number;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Fold a progress stream into one row per agent+phase, in first-seen order.
 * A later update for the same agent+phase replaces the row only when its
 * percentage is at least the current one, so a regression cannot make the
 * board go backwards.
 */
export function projectProgress(
  updates: readonly ProgressUpdate[],
): ProjectedProgress[] {
  const rows = new Map<string, ProjectedProgress>();
  const order: string[] = [];
  for (const update of updates) {
    const key = `${update.agent}\u0000${update.phase}`;
    if (!rows.has(key)) order.push(key);
    const existing = rows.get(key);
    const percentage = clampPercentage(update.percentage);
    if (!existing || percentage >= existing.percentage) {
      rows.set(key, {
        agent: update.agent,
        phase: update.phase,
        label: update.label,
        percentage,
      });
    }
  }
  const result: ProjectedProgress[] = [];
  for (const key of order) {
    const row = rows.get(key);
    if (row) result.push(row);
  }
  return result;
}

/** Which opsx agent a reporting tool belongs to. */
const REPORT_AGENT_BY_TOOL: Record<string, string> = {
  report_gap_analysis: "opsx-gap-analysis",
  report_plan_review: "opsx-plan-review",
  report_work: "opsx-worker",
};

/**
 * Read the structured progress out of a report tool's payload. `undefined`
 * when the report carries none, so a report without progress simply leaves the
 * board unchanged. Structural read on purpose: the parent sees the raw tool
 * input, not a typed schema instance.
 */
export function progressUpdateFrom(
  toolName: string,
  input: Record<string, unknown>,
): ProgressUpdate | undefined {
  const agent = REPORT_AGENT_BY_TOOL[toolName];
  if (!agent) return undefined;
  const progress = input.progress;
  if (typeof progress !== "object" || progress === null) return undefined;
  const { phase, percentage, label } = progress as {
    phase?: unknown;
    percentage?: unknown;
    label?: unknown;
  };
  if (typeof phase !== "string" || phase.trim() === "") return undefined;
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    return undefined;
  }
  const text = phase.trim();
  return {
    agent,
    phase: text,
    label:
      typeof label === "string" && label.trim() !== "" ? label.trim() : text,
    percentage,
  };
}

/** Render the projected progress as a compact board. */
export function renderProgressBoard(
  projected: readonly ProjectedProgress[],
): string {
  if (projected.length === 0) return "opsx progress: (no subagent activity)";
  const lines = ["opsx progress:"];
  for (const row of projected) {
    lines.push(
      `  ${row.agent} [${row.phase}] ${row.label} — ${row.percentage}%`,
    );
  }
  return lines.join("\n");
}
