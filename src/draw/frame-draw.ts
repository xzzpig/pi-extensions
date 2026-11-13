/**
 * Drawing helpers shared by the tool and message frames: background-fill
 * stripping, visible-width padding, escape-aware text search, and the rounded
 * border itself. Pure string work — no pi components.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../theme-access.ts";
import { paint } from "./paint.ts";

// Solid background fills: truecolor/256 "48;…" sequences and the standard
// 40-47 / 100-107 bg colors. pi's shell and some built-in renderers (edit)
// paint toolPendingBg/toolSuccessBg/toolErrorBg into their lines; stripping
// the fills keeps the whole frame transparent. \x1b[49m (default bg) is kept.
const BG_FILL_RE = /\x1b\[48;[0-9;]*m|\x1b\[(?:4[0-7]|10[0-7])m/g;

export function stripBackgroundFills(line: string): string {
  return line.replace(BG_FILL_RE, "");
}

const TIME_TOKENS = /YYYY|MM?|DD?|HH?|mm|ss/g;

/**
 * Local time. `auto` is the clock, with the date only when the message is not from
 * today; anything else is a pattern of `YYYY M MM D DD H HH mm ss` and literal text.
 */
export function formatMessageTime(timestamp: number, format = "auto", now = Date.now()): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  if (format !== "auto") {
    const parts: Record<string, string> = {
      YYYY: String(date.getFullYear()),
      M: String(date.getMonth() + 1),
      MM: pad(date.getMonth() + 1),
      D: String(date.getDate()),
      DD: pad(date.getDate()),
      H: String(date.getHours()),
      HH: pad(date.getHours()),
      mm: pad(date.getMinutes()),
      ss: pad(date.getSeconds()),
    };
    return format.replace(TIME_TOKENS, (token) => parts[token] as string);
  }
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString()
    ? clock
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** Muted and italic: the timestamp belongs to the border, not to the message. */
export function italicDim(theme: ThemeLike, text: string): string {
  const dim = theme.fg("dim", text);
  return theme.italic ? theme.italic(dim) : dim;
}

const TRAILING_SGR_RE = /\x1b\[[0-9;:]*m$/;

/** Drop the padding a row was filled out with, keeping the escapes that close its styles. */
export function trimTrailingSpaces(line: string): string {
  let body = line;
  let tail = "";
  for (;;) {
    const sgr = TRAILING_SGR_RE.exec(body);
    if (sgr) {
      tail = sgr[0] + tail;
      body = body.slice(0, -sgr[0].length);
    } else if (body.endsWith(" ")) {
      body = body.replace(/ +$/, "");
    } else {
      return body + tail;
    }
  }
}

/**
 * `truncateToWidth`, but only for lines that are actually too wide.
 *
 * pi-tui's truncateToWidth runs an `Intl.Segmenter` over the whole string
 * whether or not anything is cut: ~17us for a 100-cell styled row, against
 * ~90ns for `visibleWidth` on the same line. Rows that already fit are the
 * common case, and this guard keeps their bytes exactly as they were.
 */
export function clipToWidth(line: string, width: number, ellipsis = "…"): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, ellipsis);
}

export function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w < width) return line + " ".repeat(width - w);
  return truncateToWidth(line, width);
}

/**
 * Cache key for a rendered frame: the exact lines that were framed.
 *
 * A digest of (count, first line, last line) is not enough. Tool boxes are
 * bordered by constant frame and padding rows, so a change confined to the
 * middle — the elapsed counter ticking from `Elapsed 0.0s` to `Elapsed 1.0s` —
 * left the digest untouched, and the box re-served the stale frame until
 * something else (a click toggling `expanded`) invalidated the cache.
 *
 * `Box` and `Text` hand back the same cached line array while their content is
 * unchanged, so in the common case this is a pointer comparison per row and
 * allocates nothing.
 */
export function sameLines(cached: readonly string[] | undefined, lines: readonly string[]): boolean {
  if (!cached || cached.length !== lines.length) return false;
  for (let i = 0; i < lines.length; i++) {
    if (cached[i] !== lines[i]) return false;
  }
  return true;
}

const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;

/** CSI and OSC (BEL- or ST-terminated) escape sequences. */
const ESCAPE_RE = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;

/** Map a row's visible characters to their raw string indices, skipping escapes. */
function visibleCharMap(row: string): { plain: string; map: number[] } {
  let plain = "";
  const map: number[] = [];
  let last = 0;
  for (const m of row.matchAll(ESCAPE_RE)) {
    for (let j = last; j < m.index; j++) {
      map.push(j);
      plain += row[j];
    }
    last = m.index + m[0].length;
  }
  for (let j = last; j < row.length; j++) {
    map.push(j);
    plain += row[j];
  }
  return { plain, map };
}

export function visibleIndexOf(row: string, needle: string): number {
  const { plain, map } = visibleCharMap(row);
  const pi = plain.lastIndexOf(needle);
  return pi >= 0 ? map[pi] : -1;
}

/** A row's text with every escape sequence removed. */
export function visibleText(row: string): string {
  return visibleCharMap(row).plain;
}

/** The raw index of the visible character at `plainIndex`, or -1. */
export function rawIndexOfVisible(row: string, plainIndex: number): number {
  const { map } = visibleCharMap(row);
  return plainIndex >= 0 && plainIndex < map.length ? map[plainIndex] : -1;
}

/**
 * Remove the leading tool name from a call row — with the kind icon in
 * front, the word is redundant (`󰛦 edit ~/x.ts` reads choppier than
 * `󰛦 ~/x.ts`). No-op when the row doesn't start with the word.
 * Removes a *visible-text* range (word + one following space) so escape
 * sequences interleaved between them (the name's style closers) can't
 * strand a double space.
 */
export function removeLeadingWord(line: string, word: string): string {
  const { plain, map } = visibleCharMap(line);
  const start = plain.search(/\S/);
  if (start < 0 || !plain.startsWith(word, start)) return line;
  const after = plain[start + word.length];
  if (after !== undefined && after !== " ") return line;
  const endPlain = after === " " ? start + word.length + 1 : start + word.length;
  const rawStart = map[start];
  const rawEnd = map[endPlain - 1] + 1;
  return line.slice(0, rawStart) + line.slice(rawEnd);
}

/**
 * When `idx` sits inside an OSC 8 hyperlink (opener before it, no closer in
 * between), return the opener's start so the icon lands outside the link.
 * Otherwise return `idx` unchanged.
 */
export function outsideHyperlink(row: string, idx: number): number {
  const opener = row.lastIndexOf("\x1b]8;;", idx);
  if (opener < 0) return idx;
  const after = row[opener + 6];
  if (after === "\x07" || after === "\x1b") return idx; // that's a closer
  const closer = Math.max(row.lastIndexOf("\x1b]8;;\x07", idx), row.lastIndexOf("\x1b]8;;\x1b\\", idx));
  return opener > closer ? opener : idx;
}

/** A padding row from pi's default shell: spaces plus background escapes. */
function isBlankRow(line: string): boolean {
  return line.replace(ANSI_RE, "").trim() === "";
}

/** The index range left after dropping blank rows at both ends. */
export function blankEdges(lines: readonly string[]): { start: number; end: number } {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankRow(lines[start])) start++;
  while (end > start && isBlankRow(lines[end - 1])) end--;
  return { start, end };
}

export function trimBlankEdges(lines: string[]): string[] {
  const { start, end } = blankEdges(lines);
  return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

export type HeaderStyle = "inline" | "split";

/**
 * What a message's top edge says: who it is from and when. `split` sets a rule between
 * the two and a longer one in front (`── model ── 13:09 ───`), and goes back to `inline`
 * on an edge too narrow for that. Both parts arrive painted; `lead` is the rule's length
 * in front of the label.
 */
export function messageHeader(
  theme: ThemeLike,
  color: string,
  identity: string,
  time: string,
  style: HeaderStyle,
  width: number,
): { label: string; lead: number } {
  const inline = { label: time ? `${identity} ${time}` : identity, lead: 1 };
  if (style !== "split") return inline;
  const label = time ? `${identity} ${paint(theme, color, "──")} ${time}` : identity;
  // `╭── ` and ` ──╮`.
  return visibleWidth(label) + 8 <= width ? { label, lead: 2 } : inline;
}

/**
 * A rounded top border with a label set into it: `╭─ label ─────╮`. Falls
 * back to the plain border when the label does not fit. `label` arrives
 * painted; only the rule is colored here.
 */
export function labeledTopBorder(
  width: number,
  theme: ThemeLike,
  color: string,
  label: string,
  align: "left" | "right" = "left",
  lead = 1,
  /**
   * Cells the label really takes. A Nerd Font glyph draws one cell wider than
   * `visibleWidth` measures it, and a border that trusts the table alone loses
   * its right corner to the truncation.
   */
  labelCells = visibleWidth(label),
): string {
  const inner = Math.max(2, width - 2);
  const bc = (s: string) => paint(theme, color, s);
  const rest = inner - 2 - lead - labelCells;
  if (rest < 1) return bc(`╭${"─".repeat(inner)}╮`);
  const start = "─".repeat(lead);
  return align === "right"
    ? `${bc(`╭${"─".repeat(rest)} `)}${label}${bc(` ${start}╮`)}`
    : `${bc(`╭${start} `)}${label}${bc(` ${"─".repeat(rest)}╮`)}`;
}

/** A rule with a label set into it: `─ label ─────`. Plain when the label does not fit. */
export function labeledRule(
  width: number,
  theme: ThemeLike,
  color: string,
  label: string,
  align: "left" | "right" = "left",
  lead = 1,
): string {
  const rest = width - 2 - lead - visibleWidth(label);
  if (!label || rest < 1) return paint(theme, color, "─".repeat(width));
  const start = "─".repeat(lead);
  return align === "right"
    ? `${paint(theme, color, `${"─".repeat(rest)} `)}${label}${paint(theme, color, ` ${start}`)}`
    : `${paint(theme, color, `${start} `)}${label}${paint(theme, color, ` ${"─".repeat(rest)}`)}`;
}

/**
 * Draw the rounded frame. Border color tracks tool state:
 *   pending (streaming/executing) → borderMuted (grey)
 *   success                      → success (green)
 *   error                        → error (red)
 */
export function drawFrame(
  lines: string[],
  width: number,
  theme: ThemeLike,
  color: string,
  /**
   * Rows whose background fill belongs to the content (the split diff's tinted
   * rows). Every other row is stripped — the frame is transparent by design.
   */
  keepBg?: ReadonlySet<number>,
): string[] {
  const inner = Math.max(2, width - 2);
  const bc = (s: string) => paint(theme, color, s);
  const out: string[] = [bc(`╭${"─".repeat(inner)}╮`)];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const kept = keepBg?.has(i) ? line : stripBackgroundFills(line);
    out.push(`${bc("│")}${padToWidth(kept, inner)}${bc("│")}`);
  }
  out.push(bc(`╰${"─".repeat(inner)}╯`));
  return out;
}

