/**
 * Parent-side subagent progress projection (task 9.2; spec: 子 agent 的过程进度
 * MUST 经结构化上报（阶段标签 + 百分比，或等效字段），由主会话投影为看板展示).
 *
 * The reporting tools carry an optional structured `progress` field. A child's
 * tool call runs in the child's own session, so the parent never sees the call
 * itself — and since the report tools are no longer registered in the main
 * session at all (design D1), the parent cannot observe them as tool results
 * either. Progress therefore arrives from the ingestion layer, which is the one
 * component that holds an accepted child report (design D3).
 *
 * This module only folds those accepted updates into one row per agent+phase
 * and appends a `progress` flow entry whose renderer draws the board.
 *
 * Progress is display-only: it never gates anything, it never completes a task,
 * and a session with no reports appends nothing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendFlowEntry, OPSX_ENTRY_TYPES } from "./flow-entries.ts";
import {
  progressUpdateFrom,
  projectProgress,
  type ProjectedProgress,
} from "./progress-projection.ts";

/**
 * The projected board per session.
 *
 * Only the folded rows are retained — one per agent+phase — so a chatty
 * subagent cannot grow the parent's memory without bound (design D4).
 */
const boardsBySession = new Map<string, ProjectedProgress[]>();

/** Reset the per-session progress board. Test-only. */
export function resetProgressObserverForTests(): void {
  boardsBySession.clear();
}

/** The current board for a session. Test-observable. */
export function progressBoardFor(sessionId: string): ProjectedProgress[] {
  return boardsBySession.get(sessionId) ?? [];
}

/**
 * Record the structured progress carried by an accepted child report.
 *
 * Returns whether a board entry was appended. A report without progress leaves
 * the board untouched, and a repeated update folds into the existing row rather
 * than appending a second entry, so duplicates never reach the interface.
 *
 * The caller is the ingestion layer, which only ever passes a report that
 * already reached a successful terminal state with a matching attempt nonce —
 * so a failed run or a stale nonce is never projected.
 */
export function recordChildReportProgress(
  pi: Pick<ExtensionAPI, "appendEntry">,
  sessionId: string,
  input: { toolName: string; report: Record<string, unknown> },
): boolean {
  const update = progressUpdateFrom(input.toolName, input.report);
  if (!update) return false;

  const current = boardsBySession.get(sessionId) ?? [];
  const next = projectProgress([...current, update]);
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  boardsBySession.set(sessionId, next);
  if (!changed) return false;

  appendFlowEntry(pi, OPSX_ENTRY_TYPES.progress, { rows: next });
  return true;
}
