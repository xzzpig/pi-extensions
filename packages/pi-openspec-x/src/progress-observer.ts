/**
 * Parent-side subagent progress projection (task 9.2; spec: 子 agent 的过程进度
 * MUST 经结构化上报（阶段标签 + 百分比，或等效字段），由主会话投影为看板展示).
 *
 * The reporting tools carry an optional structured `progress` field. A child's
 * tool call runs in the child's own session, so the parent does not see it
 * directly; what the parent does see is every report that reaches ITS session —
 * the main agent's own `report_work` (the tick gate requires it in agent mode)
 * and any report relayed up. This observer folds whatever it observes into one
 * row per agent+phase and appends a `progress` flow entry whose renderer draws
 * the board.
 *
 * Progress is display-only: it never gates anything, and a session with no
 * reports appends nothing.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

import { appendFlowEntry, OPSX_ENTRY_TYPES } from "./flow-entries.ts";
import {
  progressUpdateFrom,
  projectProgress,
  type ProgressUpdate,
} from "./progress-projection.ts";

/** The report tools that can carry a structured progress field. */
const REPORT_TOOL_NAMES = [
  "report_gap_analysis",
  "report_plan_review",
  "report_work",
] as const;

const updatesBySession = new Map<string, ProgressUpdate[]>();

function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId() ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Build the `tool_result` handler that folds report-tool progress into the
 * session's board. Returns a value only when a board entry was appended.
 */
export function createProgressObserverHandler(
  pi: Pick<ExtensionAPI, "appendEntry">,
): ExtensionHandler<ToolResultEvent, ToolResultEventResult> {
  return (event, ctx) => {
    if (
      !(REPORT_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      event.isError
    ) {
      return;
    }
    const update = progressUpdateFrom(event.toolName, event.input);
    if (!update) return;

    const sessionId = sessionKey(ctx);
    const updates = updatesBySession.get(sessionId) ?? [];
    updates.push(update);
    updatesBySession.set(sessionId, updates);

    appendFlowEntry(pi, OPSX_ENTRY_TYPES.progress, {
      rows: projectProgress(updates),
    });
  };
}

export function registerProgressObserver(pi: ExtensionAPI): void {
  pi.on("tool_result", createProgressObserverHandler(pi));
}
