/**
 * The enforced "review before tick" gate for agent mode (task 8.2; spec MUST
 * "未审查不得勾选").
 *
 * `worker-dispatch.ts` decides *whether* a tick is allowed; this module is what
 * makes the decision binding. It tracks the main session's dispatch traffic —
 * an `opsx-worker` dispatch, the `report_work` review that must follow it, and
 * the tick — and the `tool_call` handler uses it to block an
 * `update_goal_task` completion that has no review behind it.
 *
 * The gate is agent-only on purpose: direct mode has no dispatch, so there is
 * nothing to reconcile and the completion audit remains the only gate.
 */
import {
  decideTaskTick,
  detectStalledDispatch,
  type DispatchTrace,
  type WorkReportLike,
} from "./worker-dispatch.ts";

/** One observed worker dispatch and what happened to it. */
interface DispatchRecord {
  /** The task the dispatch was for, when it could be read from the payload. */
  taskId: string | undefined;
  changedFiles: number;
  ticked: boolean;
}

/**
 * Explicit failure markers in a recorded verification result.
 *
 * Kept as two expressions because the uppercase markers must stay
 * case-sensitive: a case-insensitive `FAIL` would match the "0 failures" of a
 * clean run, and a false hold is worse than a missed one here (the completion
 * audit is the real verification gate). The accepted cost is that a lowercase
 * marker such as "2 errors" is not detected — only `FAIL`/`FAILED`/`ERROR` in
 * caps, a non-zero exit code, or an explicit "<n> failures" count are.
 */
const UPPERCASE_FAILURE_RE = /(^|\s)(FAIL|FAILED|ERROR|✗)/;
const NUMERIC_FAILURE_RE =
  /\bexit(?:ed)? (?:code )?[1-9]\b|\b[1-9]\d* (?:tests? )?fail/i;

function looksFailed(result: string | undefined): boolean {
  if (result === undefined) return false;
  return UPPERCASE_FAILURE_RE.test(result) || NUMERIC_FAILURE_RE.test(result);
}

/**
 * Per-session dispatch bookkeeping. One tracker per active agent flow.
 */
export class DispatchReviewTracker {
  private readonly records: DispatchRecord[] = [];
  private readonly reports = new Map<string, WorkReportLike>();

  /**
   * Record an `opsx-worker` dispatch. `taskId` is undefined when the payload
   * did not name the task (the `subagent` tool accepts several shapes), which
   * still counts as "a dispatch happened" — the gate must never deadlock on a
   * task-id parsing miss.
   */
  noteDispatch(taskId: string | undefined): void {
    this.records.push({
      taskId,
      changedFiles: 0,
      ticked: false,
    });
  }

  /**
   * Remember the main agent's `report_work` review and attach its changed-file
   * count to the most recent dispatch it can belong to.
   */
  rememberReport(report: WorkReportLike): void {
    this.reports.set(report.taskId, report);
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (record.taskId !== undefined && record.taskId !== report.taskId) {
        continue;
      }
      record.taskId = report.taskId;
      record.changedFiles = report.changedFiles.length;
      break;
    }
  }

  /** Record that a task was ticked. */
  noteTick(taskId: string): void {
    for (const record of this.records) {
      if (record.taskId === taskId) record.ticked = true;
    }
  }

  /** The observed `report_work` for a task, if the main agent submitted one. */
  reportFor(taskId: string): WorkReportLike | undefined {
    return this.reports.get(taskId);
  }

  /**
   * Whether a worker dispatch was observed for the task. A dispatch whose
   * payload never named a task counts for every task: the alternative is
   * blocking a legitimate tick because of an unparsed payload shape.
   */
  dispatched(taskId: string): boolean {
    return this.records.some(
      (record) => record.taskId === taskId || record.taskId === undefined,
    );
  }

  /** The bounded dispatch trace used for stall detection. */
  traces(): DispatchTrace[] {
    return this.records.map((record) => ({
      taskId: record.taskId ?? "<unknown>",
      changedFiles: record.changedFiles,
      ticked: record.ticked,
    }));
  }

  /** Tasks that keep being dispatched without producing or reporting work. */
  stalled(threshold = 2): string[] {
    const result = detectStalledDispatch(this.traces(), threshold);
    return result.stalled ? result.taskIds : [];
  }

  reset(): void {
    this.records.length = 0;
    this.reports.clear();
  }
}

type TickGateDecision =
  | { allow: true; warnings: string[] }
  | { allow: false; reason: string };

/**
 * Root paths that belong to tooling rather than to a task's output. A window
 * delta picks these up because extensions write into the working directory
 * (pi-lens probe logs), and they are not the dispatch's work. Build-output
 * directories are deliberately NOT listed: `dist/`, `coverage/`,
 * `node_modules/` and `.cache/` are exactly what the agent write allowlist
 * permits, so a task whose output lives there must stay reconcilable.
 */
const RUNTIME_ROOT_PREFIXES = [".pi/", ".pi-lens-probe-home/"];

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Drop tool-runtime noise from an observed window delta. */
function filterTaskDelta(paths: readonly string[]): string[] {
  return paths.filter((entry) => {
    const normalized = normalizePath(entry);
    return !RUNTIME_ROOT_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    );
  });
}

/**
 * Decide whether `update_goal_task status=complete` may proceed for a task.
 *
 * The checks run in this order, and each one is unconditional:
 *
 * 1. a worker dispatch must have been observed;
 * 2. the dispatch must have been reviewed with `report_work`;
 * 3. the recorded verification must have run and passed;
 * 4. the report's files must reconcile with the window delta — a claimed file
 *    nobody changed is a false claim (hold), while a delta file the report
 *    omitted is only a warning, because the delta also carries tool-runtime
 *    noise no report can be expected to declare.
 *
 * Step 3 must not be reachable only through `decideTaskTick`: that function
 * reports file-set mismatches before it looks at verification, so delegating
 * the whole decision to it let a failed or missing verification through
 * whenever the delta happened to contain an extra file.
 */
export function evaluateTickGate(
  tracker: DispatchReviewTracker,
  input: { taskId: string; observedChangedFiles?: string[] },
): TickGateDecision {
  if (!tracker.dispatched(input.taskId)) {
    return {
      allow: false,
      reason: `Task ${input.taskId} has no observed opsx-worker dispatch. Agent mode implements every task through a dispatch: dispatch opsx-worker for it, review the diff, then tick.`,
    };
  }

  const report = tracker.reportFor(input.taskId);
  if (!report) {
    return {
      allow: false,
      reason: `The dispatch for task ${input.taskId} has not been reviewed. Call report_work with taskId "${input.taskId}", the changed files you verified, and the verification command and result, then tick.`,
    };
  }

  const result = report.selfVerification.result;
  // The structured verdict wins: when the report states it explicitly, the
  // free-text scan is never consulted (spec: 门控判断 MUST 依据结构化裁决字段，
  // MUST NOT 依赖解析子 agent 的自由文本). It remains the fallback for reports
  // that carry only a result string.
  const structured = report.verificationPassed;
  const verification = {
    ran:
      structured !== undefined ||
      report.selfVerification.command !== undefined ||
      result !== undefined,
    passed: structured !== undefined ? structured : !looksFailed(result),
    ...(result !== undefined ? { evidence: result } : {}),
  };
  if (!verification.ran) {
    return {
      allow: false,
      reason:
        "The task's verification has not been run; tick only after it passes.",
    };
  }
  if (!verification.passed) {
    return {
      allow: false,
      reason: `The task's verification failed${result ? `: ${result}` : ""}. Fix and re-verify before ticking.`,
    };
  }

  // Reconciliation runs on the noise-filtered delta, so a report is never
  // accused of a phantom claim just because a probe log was filtered out, and
  // a build-output task (dist/, coverage/) is never filtered out of its own
  // evidence.
  const observed = filterTaskDelta(
    input.observedChangedFiles ?? report.changedFiles,
  );
  const decision = decideTaskTick(report, {
    observedChangedFiles: observed,
    verification,
  });
  if (decision.kind === "tick") {
    return { allow: true, warnings: [] };
  }

  // After the verification pre-check the only possible hold is a file-set
  // mismatch. Distinguish the two directions by set membership, never by the
  // wording of the hold reason.
  const observedSet = new Set(observed.map(normalizePath));
  const claimedSet = new Set(report.changedFiles.map(normalizePath));
  const phantom = [...claimedSet].filter((file) => !observedSet.has(file));
  if (phantom.length > 0) {
    return { allow: false, reason: decision.reason };
  }
  const unclaimed = [...observedSet].filter((file) => !claimedSet.has(file));
  if (unclaimed.length > 0) {
    return {
      allow: true,
      warnings: [
        `The window delta contains file(s) the report did not declare: ${unclaimed.join(", ")}. Confirm none of them belongs to this task before ticking.`,
      ],
    };
  }
  return { allow: false, reason: decision.reason };
}
