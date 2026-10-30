/**
 * Group header decoration (fork-only presentation helper).
 *
 * A group shows exactly one header row: the folded carrier's summary or
 * the expanded carrier's title. This module is the single place that
 * decorates that row, so all four projection paths (tool/custom-message
 * carrier summary, expanded carrier title, thinking-run summary, and
 * thinking-run title) share one look:
 *
 *   ▸ 分组 17 次工具调用 · 4 条消息      (folded)
 *   ▾ 分组 17 次工具调用 · 4 条消息      (expanded)
 *
 * - the disclosure arrow and the `分组` label take the host theme's accent;
 * - an error/warning marker keeps its semantic color (error/warning) and
 *   its position directly after the arrow, so it still outranks every
 *   count and is never squeezed out;
 * - the counts render muted (secondary to the arrow and the label);
 * - the row is filled to the available column width with a neutral theme
 *   background — no hard-coded RGB, no Nerd Font glyphs, one row high; a
 *   theme that leaves panels unbacked (the generated system theme for
 *   terminals that report no colors) simply renders no band;
 * - the label is the only optional part: a terminal too narrow for it
 *   keeps the plain summary row, so decoration can never cost the group
 *   its entry point or trigger a width fallback the plain row survives.
 *
 * The plain summary text, its counts, and the fit/fallback decisions stay
 * in `view.ts`; this module only decorates what that module already fitted.
 * Colors come from the host theme the caller passes in (the runtime injects
 * a live getter over `ctx.ui.theme`), and they are read on every call, so a
 * theme switch is picked up by the next frame — no colored string is
 * cached. Without a theme the header still renders its label and counts,
 * uncolored and unpadded, rather than failing the frame.
 */

import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SegmentSummary } from "./model.ts";
import { summaryLine, summaryMarker, type SummaryTextOptions } from "./view.ts";

/** The label between the arrow and the counts. */
export const GROUP_HEADER_LABEL = "分组";

/**
 * Neutral background slots, most preferred first. `toolPendingBg` is the
 * host theme's near-gray band (the most neutral choice, so the accent
 * label keeps its contrast); `customMessageBg` is the fallback when a host
 * theme leaves the pending band unbacked. Both come from the host theme,
 * so light and dark themes both work.
 */
const BACKGROUND_TOKENS: readonly ThemeBg[] = [
  "toolPendingBg",
  "customMessageBg",
];

/** The theme slice this module reads: the host `Theme`, or a test double. */
export type HeaderTheme = {
  fg(slot: ThemeColor, text: string): string;
  bg(slot: ThemeBg, text: string): string;
  /** The raw opening escape for a background slot, when the theme has one. */
  getBgAnsi?(slot: ThemeBg): string;
};

export type HeaderLineOptions = SummaryTextOptions & {
  /** Overrides the default label (tests). */
  readonly label?: string;
  /** The host theme for this frame; undefined renders uncolored. */
  readonly theme?: HeaderTheme;
};

/**
 * The decorated header row for a group, or undefined when the terminal is
 * too narrow for even the plain summary (the group's existing width
 * fallback then restores its original display).
 */
export function groupHeaderLine(
  summary: SegmentSummary,
  options: HeaderLineOptions,
): string | undefined {
  const plain = summaryLine(summary, options);
  if (plain === undefined) return undefined;

  const theme = options.theme;
  const label = options.label ?? GROUP_HEADER_LABEL;
  const marker = summaryMarker(summary);

  // `plain` is `▸ [✗ ]counts`: the arrow is one cell, the marker (when
  // present) one more. The counts keep their exact bytes.
  const arrow = plain.slice(0, 1);
  let counts = plain.slice(1);
  if (marker !== undefined && counts.startsWith(` ${marker}`)) {
    counts = counts.slice(1 + marker.length);
  }

  // The marker keeps its position right after the arrow: an alert stays at
  // the left edge and never shifts when the label is dropped.
  const head =
    paintForeground(theme, "accent", arrow) +
    (marker === undefined
      ? ""
      : ` ${paintForeground(theme, markerColor(marker), marker)}`);
  const tail = paintForeground(theme, "muted", counts);

  // The label is the only optional part. A terminal too narrow for it keeps
  // the arrow, the error/warning marker, and the counts — each still in its
  // semantic color — at exactly the plain row's cell width, so decoration
  // can never cost the group its entry point or force a width fallback.
  const labelled = `${head} ${paintForeground(theme, "accent", label)}${tail}`;
  const unlabelled = `${head}${tail}`;
  const row =
    [labelled, unlabelled].find(
      (candidate) => visibleWidth(candidate) <= options.width,
    ) ?? plain;
  return paintBackground(theme, row, options.width);
}

/** A single group-level control at the end of an expanded group. */
export function groupFooterLine(options: {
  readonly width: number;
  readonly theme?: HeaderTheme;
}): string | undefined {
  const text = "▴ 收起分组";
  if (visibleWidth(text) > options.width) return undefined;
  return paintBackground(
    options.theme,
    paintForeground(options.theme, "accent", text),
    options.width,
  );
}

function markerColor(marker: string): ThemeColor {
  return marker === "✗" ? "error" : "warning";
}

function paintForeground(
  theme: HeaderTheme | undefined,
  slot: ThemeColor,
  text: string,
): string {
  if (theme === undefined || text.length === 0) return text;
  try {
    return theme.fg(slot, text);
  } catch {
    // A theme without this slot still renders the text, uncolored.
    return text;
  }
}

const BACKGROUND_RESET = "\x1b[49m";

/**
 * The opening background escape for a neutral band, or undefined when the
 * theme has no color for that slot. Themes designed for terminals that
 * report nothing deliberately leave panels unbacked (the system theme sets
 * every `*Bg` slot to ""), and a "" slot yields the plain reset — that is
 * "no band", not a band of some hard-coded color.
 */
function backgroundAnsi(theme: HeaderTheme, slot: ThemeBg): string | undefined {
  try {
    const raw =
      typeof theme.getBgAnsi === "function"
        ? theme.getBgAnsi(slot)
        : theme.bg(slot, "").replace(BACKGROUND_RESET, "");
    return raw.length > 0 && raw !== BACKGROUND_RESET ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fill the row to the available width and paint it with the neutral
 * background. Width is measured in terminal cells (ANSI-aware, CJK double),
 * never with `string.length`. A theme with no panel color leaves the row
 * exactly as it was — no padding, no escapes.
 */
function paintBackground(
  theme: HeaderTheme | undefined,
  row: string,
  width: number,
): string {
  if (theme === undefined) return row;
  for (const slot of BACKGROUND_TOKENS) {
    const ansi = backgroundAnsi(theme, slot);
    if (ansi === undefined) continue;
    const padding = Math.max(0, width - visibleWidth(row));
    const filled = padding === 0 ? row : `${row}${" ".repeat(padding)}`;
    return `${ansi}${filled}${BACKGROUND_RESET}`;
  }
  return row;
}
