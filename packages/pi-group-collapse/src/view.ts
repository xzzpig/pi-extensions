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
};

const DISCLOSURE = "▸";
const FAILURE_MARK = "✗";
const WARNING_MARK = "⚠";

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
  const marker =
    summary.errors > 0 || summary.failed > 0
      ? FAILURE_MARK
      : summary.warnings > 0
        ? WARNING_MARK
        : undefined;

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

  let keep = parts.length;
  while (keep > 0) {
    const line = compose(marker, parts.slice(0, keep));
    if (visibleWidth(line) <= options.width) return line;
    keep -= 1;
  }
  // Even the single most significant count does not fit.
  return undefined;
}

function compose(
  marker: string | undefined,
  parts: readonly CountPart[],
): string {
  const head = marker === undefined ? DISCLOSURE : `${DISCLOSURE} ${marker}`;
  return `${head} ${parts.map((part) => part.text).join(" · ")}`;
}

/**
 * Summary cache key inputs: the line depends only on the counts, so the
 * view can reuse a rendered line until the segment's statistics change.
 */
export function summaryCacheKey(summary: SegmentSummary): string {
  return [
    summary.tools,
    summary.thinking,
    summary.messages,
    summary.failed,
    summary.warnings,
    summary.errors,
  ].join("/");
}
