import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { commandPaths, type GoalCommands } from "../goal-controls.ts";
import type { goalAuditFailure } from "../fork-goal-audit-history.ts";
import { truncateToWidth, wrapTextWithAnsi } from "./text-cache.ts";

export type GoalAuditFailure = NonNullable<ReturnType<typeof goalAuditFailure>>;

export type AuditFailureMinimumLayout =
  | "hide-progress"
  | "status-header-with-details"
  | "status-header-without-task-divider"
  | "status-header-bounded-details"
  | "hide-details"
  | "hide-task-header"
  | "status-header";

export const INFERRED_TASK_NOTE =
  "Inferred from the first pending task — no persisted current task.";

/** Keep the task title and inferred-focus explanation on one line when dock space is tight. */
export function inlineInferredTaskTitle(
  prefix: string,
  title: string,
  available: number,
  dim: (text: string) => string,
): string {
  const separator = " — ";
  const room = Math.max(1, available - visibleWidth(prefix));
  const note =
    [
      INFERRED_TASK_NOTE,
      "Inferred from the first pending task",
      "Inferred",
    ].find(
      (candidate) => visibleWidth(title + separator + candidate) <= room,
    ) ?? "Inferred";
  const titleRoom = room - visibleWidth(separator + note);
  if (titleRoom < 1) return prefix + truncateToWidth(title, room, "…");
  return (
    prefix + truncateToWidth(title, titleRoom, "…") + dim(separator + note)
  );
}

/** Reserve the footer before clipping the tail of the current-task block. */
export function fitCurrentTaskDetails(
  lines: string[],
  rows: number,
  columns: number,
  boxLine: (text: string) => string,
): string[] {
  if (lines.length <= rows) return lines;
  if (rows <= 0) return [];
  const visible = lines.slice(0, rows);
  const last = plainAuditReport(visible[rows - 1]!)
    .slice(2, -1)
    .trimEnd();
  visible[rows - 1] = boxLine(truncateToWidth(`${last}…`, columns, "…"));
  return visible;
}

export interface GoalAuditFailureView {
  failure: GoalAuditFailure;
  extraRows: number;
  shareStatusRow?: boolean;
  minimumLayout?: AuditFailureMinimumLayout;
  rowCap?: number;
  commands?: GoalCommands;
}

/** Keep the report's lines, but never render control sequences supplied by it. */
export function plainAuditReport(report: string): string {
  return stripVTControlCharacters(report)
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Cc}/gu, (char) =>
      char === "\n" || char === "\t" ? char : "",
    );
}

export function verboseAuditFailureLines(failure: GoalAuditFailure): string[] {
  const label = failure.historical
    ? "Previous audit (historical)"
    : "Last audit";
  return [
    "",
    `${label} (${failure.at.slice(0, 10)}): ${failure.verdict}`,
    plainAuditReport(failure.report),
  ];
}

export function goalAuditFailureStatusRows(
  status: string,
  view: GoalAuditFailureView | undefined,
  available: number,
  paint: (row: string) => string,
): string[] {
  if (!view?.shareStatusRow)
    return [status, ...goalAuditFailureRows(view, available).map(paint)];
  const separator = " · ";
  const separatorWidth = visibleWidth(separator);
  const minimumReportWidth = view.failure.verdict === "error" ? 10 : 11;
  const statusWidth = Math.min(
    visibleWidth(status),
    available - separatorWidth - minimumReportWidth,
  );
  if (statusWidth < 1) return goalAuditFailureRows(view, available).map(paint);
  const reportWidth = available - statusWidth - separatorWidth;
  const [first, ...continuation] = goalAuditFailureRows(view, reportWidth);
  return [
    `${truncateToWidth(status, statusWidth, "…")}${separator}${paint(first!)}`,
    ...continuation.map(paint),
  ];
}

function goalAuditFailureRows(
  view: GoalAuditFailureView | undefined,
  available: number,
): string[] {
  if (!view) return [];
  const { failure, extraRows, commands } = view;
  const label =
    failure.verdict === "error" ? "Last audit error" : "Last audit rejected";
  const short = failure.verdict === "error" ? "Audit error" : "Rejected";
  // The complete report is available via /goal-status verbose, not the dock.
  const preview = failure.report.slice(0, 4096);
  const report = plainAuditReport(preview).trim() || "No report recorded.";
  const summary = report.replace(/\s+/g, " ");
  const reasonWidth = Math.min(4, visibleWidth(summary));
  const smallest = failure.verdict === "error" ? "Error" : "Reject";
  const heading =
    [label, short].find((name) => name.length + 2 + reasonWidth <= available) ??
    smallest;
  if (!extraRows)
    return [truncateToWidth(`${heading}: ${summary}`, available, "…")];

  const maxRows = 1 + extraRows;
  const expanded = `${heading}: ${report.replace(/\t/g, " ")}`;
  const rows = wrapTextWithAnsi(expanded, available);
  if (rows.length <= maxRows && preview.length === failure.report.length)
    return rows;
  // Preview only: blank separators must not consume the report budget. The
  // verbose command still prints the original line breaks.
  const meaningful = rows.filter((row) => row.trim());
  if (meaningful.length <= maxRows && preview.length === failure.report.length)
    return meaningful;
  const command = commandPaths(commands, "goal-status")[0];
  const hint = command ? `… /${command} verbose` : "";
  const showHint = extraRows >= 3 && hint && visibleWidth(hint) <= available;
  const bodyRows = maxRows - (showHint ? 1 : 0);
  // If many short paragraphs expose no more evidence than compact mode,
  // reflow the preview before allocating a row to the hint.
  const compact = truncateToWidth(
    expanded.replace(/\s+/g, " "),
    available,
    "…",
  );
  const contents = (text: string) => visibleWidth(text.replace(/[\s…]/g, ""));
  const body =
    contents(meaningful.slice(0, bodyRows).join("")) <= contents(compact)
      ? wrapTextWithAnsi(expanded.replace(/\s+/g, " "), available)
      : meaningful;
  if (body.length <= maxRows && preview.length === failure.report.length)
    return body;
  if (showHint) return [...body.slice(0, bodyRows), hint];
  return [
    ...body.slice(0, bodyRows - 1),
    truncateToWidth(`${body[bodyRows - 1] ?? ""}…`, available, "…"),
  ];
}
