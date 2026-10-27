/**
 * The two-level group view's summary line (change task 3.2).
 *
 * One line per folded group: a disclosure marker, the failure/warning/error
 * marker when any exists (markers outrank counts and are never squeezed
 * out), and the non-zero kind counts — tools, thinking runs, messages —
 * separated by middots. The line never embeds member content: no tool
 * arguments, results, thinking, or message bodies, and no tool names to
 * crowd out the markers. Width is measured in terminal cells (CJK counts
 * double) and the line degrades by dropping the least significant count
 * first; a terminal too narrow for even the minimal identifiable summary
 * keeps the group's original display instead of overflowing.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { SegmentSummary } from "./model.ts";

export type SummaryTextOptions = {
  /** Available terminal columns for the summary line. */
  readonly width: number;
  /**
   * The group's own expanded state. An expanded group's title row points
   * down (▾) because the next click folds it; a folded group's summary
   * points right (▸). Callers must pass the *group* state, never a member
   * component's expansion or an expand-target's toggle direction.
   */
  readonly expanded?: boolean;
};

const DISCLOSURE_FOLDED = "▸";
const DISCLOSURE_EXPANDED = "▾";
const FAILURE_MARK = "✗";
const WARNING_MARK = "⚠";

/**
 * The failure/warning marker a summary warrants, if any. Failures outrank
 * warnings and both outrank every count, so the marker is never squeezed
 * out by a narrow terminal. Exported so the header decoration can give the
 * marker its semantic color without re-deriving the precedence.
 */
export function summaryMarker(
  summary: SegmentSummary,
): typeof FAILURE_MARK | typeof WARNING_MARK | undefined {
  if (summary.errors > 0 || summary.failed > 0) return FAILURE_MARK;
  if (summary.warnings > 0) return WARNING_MARK;
  return undefined;
}

type CountPart = {
  /** Lower significance drops first when the terminal is narrow. */
  readonly significance: number;
  readonly text: string;
};

/**
 * The summary line for a folded group, or undefined when the terminal is
 * too narrow to express even the minimal identifiable summary.
 */
export function summaryLine(
  summary: SegmentSummary,
  options: SummaryTextOptions,
): string | undefined {
  const marker = summaryMarker(summary);

  const parts: CountPart[] = [];
  if (summary.tools > 0) {
    parts.push({ significance: 3, text: `${summary.tools} 次工具调用` });
  }
  if (summary.thinking > 0) {
    parts.push({ significance: 2, text: `${summary.thinking} 段思考` });
  }
  if (summary.messages > 0) {
    parts.push({ significance: 1, text: `${summary.messages} 条消息` });
  }
  if (parts.length === 0) return undefined;

  // Most significant first; narrow terminals drop from the tail.
  parts.sort((a, b) => b.significance - a.significance);

  const disclosure = options.expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_FOLDED;

  let keep = parts.length;
  while (keep > 0) {
    const line = compose(disclosure, marker, parts.slice(0, keep));
    if (visibleWidth(line) <= options.width) return line;
    keep -= 1;
  }
  // Even the single most significant count does not fit.
  return undefined;
}

function compose(
  disclosure: string,
  marker: string | undefined,
  parts: readonly CountPart[],
): string {
  const head = marker === undefined ? disclosure : `${disclosure} ${marker}`;
  return `${head} ${parts.map((part) => part.text).join(" · ")}`;
}

/**
 * Summary cache key inputs: the line depends only on the counts and the
 * group's expanded state, so a cache can reuse a rendered line until the
 * segment's statistics or its disclosure state change.
 */
export function summaryCacheKey(
  summary: SegmentSummary,
  expanded = false,
): string {
  return [
    summary.tools,
    summary.thinking,
    summary.messages,
    summary.failed,
    summary.warnings,
    summary.errors,
    expanded ? "open" : "closed",
  ].join("/");
}
