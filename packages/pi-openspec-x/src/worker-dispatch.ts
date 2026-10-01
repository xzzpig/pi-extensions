/**
 * Worker dispatch contract and post-dispatch review gate (design D10; openspec
 * change add-pi-openspec-x, task 8.2).
 *
 * Agent mode implements every task through a full-write `opsx-worker`
 * dispatch. Two deterministic pieces make that safe:
 *
 * 1. the six-section dispatch contract (Task, Expected output, Tools, Must do,
 *    Must not do, Context) — plan files stay read-only for the worker, and
 *    ticking tasks.md stays with the main agent;
 * 2. the tick gate: a task may be ticked only after the worker's
 *    `report_work` is reconciled, file by file, with the diff the dispatch
 *    actually produced, and the stated verification actually ran and passed.
 *    An unreviewed or unverified dispatch leaves the task unticked, and a
 *    report that claims files nobody changed (or omits files that changed) is
 *    a finding, not a completion.
 *
 * The gate returns a decision; the caller performs the tasks.md write and the
 * goal-task sync (task 6.3). Nothing here writes files.
 */

/**
 * Structural view of the opsx-worker `report_work` payload (the schema lives
 * in report-tools.ts; only the fields the gate reconciles are named here).
 */
export interface WorkReportLike {
  taskId: string;
  changedFiles: string[];
  claims: string;
  selfVerification: { command?: string; result?: string };
  /** Structured verdict; the gate trusts it over the result text. */
  verificationPassed?: boolean;
}

/**
 * The standard prohibitions every worker dispatch carries. The single source
 * the agent objective's prose reuses: plan files stay read-only for the
 * worker, ticking tasks.md stays with the main agent, and drive-by changes
 * are out.
 */
export const STANDARD_WORKER_MUST_NOT_DO = [
  "Do not modify anything under openspec/ (tasks.md, proposal.md, specs/, design.md); plan files are read-only for you.",
  "Do not tick tasks.md or any checkbox; the main agent ticks after reviewing your diff.",
  "Do not touch files outside the task scope or make drive-by changes.",
];

/** The review facts the main agent gathered after a dispatch. */
export interface DispatchReview {
  /** Repository-relative files the dispatch actually changed (window delta). */
  observedChangedFiles: string[];
  /** Whether the stated verification ran, and whether it passed. */
  verification: { ran: boolean; passed: boolean; evidence?: string };
}

export type TaskTickDecision =
  | { kind: "tick"; taskId: string; evidence: string }
  | { kind: "hold"; taskId: string; reason: string };

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Decide whether a task may be ticked. Holds (never ticks) when:
 * - no report was submitted;
 * - the report claims files the diff does not contain (phantom work);
 * - the diff contains files the report omitted (unclaimed work);
 * - the verification did not run or did not pass.
 */
export function decideTaskTick(
  report: WorkReportLike | undefined,
  review: DispatchReview,
): TaskTickDecision {
  const taskId = report?.taskId ?? "<unknown>";
  if (!report) {
    return {
      kind: "hold",
      taskId,
      reason:
        "No report_work was submitted; review the dispatch output before ticking.",
    };
  }

  const claimed = new Set(report.changedFiles.map(normalize));
  const observed = new Set(review.observedChangedFiles.map(normalize));
  const phantom = [...claimed].filter((file) => !observed.has(file));
  const unclaimed = [...observed].filter((file) => !claimed.has(file));
  if (phantom.length > 0) {
    return {
      kind: "hold",
      taskId,
      reason: `The report claims file(s) the dispatch did not change: ${phantom.join(", ")}. Reconcile before ticking.`,
    };
  }
  if (unclaimed.length > 0) {
    return {
      kind: "hold",
      taskId,
      reason: `The dispatch changed file(s) the report omitted: ${unclaimed.join(", ")}. Review and correct the report before ticking.`,
    };
  }

  if (!review.verification.ran) {
    return {
      kind: "hold",
      taskId,
      reason:
        "The task's verification has not been run; tick only after it passes.",
    };
  }
  if (!review.verification.passed) {
    return {
      kind: "hold",
      taskId,
      reason: `The task's verification failed${review.verification.evidence ? `: ${review.verification.evidence}` : ""}. Fix and re-verify before ticking.`,
    };
  }

  return {
    kind: "tick",
    taskId,
    evidence:
      review.verification.evidence ??
      report.selfVerification.result ??
      "verification passed",
  };
}

/**
 * A bounded dispatch trace used to detect a spinning goal: a dispatch that
 * changed nothing and reported nothing is a stall, not progress.
 */
export interface DispatchTrace {
  taskId: string;
  changedFiles: number;
  ticked: boolean;
}

export function detectStalledDispatch(
  traces: readonly DispatchTrace[],
  threshold = 2,
): { stalled: boolean; taskIds: string[] } {
  const counts = new Map<string, number>();
  for (const trace of traces) {
    if (trace.ticked || trace.changedFiles > 0) continue;
    counts.set(trace.taskId, (counts.get(trace.taskId) ?? 0) + 1);
  }
  const taskIds = [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([taskId]) => taskId);
  return { stalled: taskIds.length > 0, taskIds };
}
