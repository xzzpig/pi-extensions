/**
 * The two one-line views: the group summary (level 0) and a single tool row
 * (level 1). Pure string building — no component or pi state — so both are
 * cheap to render every frame and trivial to test.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { highlightBashCommand } from "./bash-highlight.ts";
import { clipToWidth, visibleText } from "../draw/frame-draw.ts";
import { toolKindIcon } from "../draw/icons.ts";
import { paint } from "../draw/paint.ts";
import type { ThemeLike } from "../theme-access.ts";
import type { JobState } from "./background-jobs.ts";
import type { GroupSummary } from "./tool-groups.ts";

export interface LineOptions {
  /** Prepend each tool's Nerd Font kind icon. */
  icons?: boolean;
  /** Cells the row may occupy, gutter excluded. Absent: a fixed argument budget. */
  width?: number;
  /** Group line only: the group is unfolded (`▾`) rather than folded (`▸`). */
  open?: boolean;
  /** Theme color for a thinking row (default `warning`). */
  thinkingColor?: string;
  /** The pointer is on this row: the glyph turns solid, a tool row gains a `›`. */
  hovered?: boolean;
  /** Group line: the glyph for running background jobs. Tool line: this job's.
   *  Thought line: replaces the brain while the run is still arriving. */
  spinner?: string;
  /** Tool line only: the background job this call started. */
  job?: JobState;
  /**
   * Tool line only: pad the metrics into columns so a group's rows line up
   * (`1 line` under `12 lines`, both durations ending at the same cell) and
   * the whole tail sits against the row's right edge.
   */
  /** Columns to pad the tool-name cell to, so arguments start on one line. */
  align?: { name?: number; note?: number; duration?: number };
  /** Thought line only: a settled row among calls. Its text takes the dimmest colour. */
  quiet?: boolean;
  /** Tool line only: syntax-highlight a bash command. */
  highlight?: boolean;
  /** `formatToolRows` only: 2 lets a call that does not fit go on to a second row. */
  rowLines?: number;
}

const DEFAULT_MAX_ARG_CHARS = 60;
/**
 * Cells a row keeps for the command before the metrics give way. Below this the
 * numbers win nothing: `cd /tmp && gi…` says less than `51 lines · 1.6s` does.
 */
const MIN_ARG_CELLS = 12;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/** `▸ 4 calls ·  bash×3  read×1 · 1.2s` (`▾` while the group is open) */
export function formatGroupLine(summary: GroupSummary, theme: ThemeLike, options: LineOptions = {}): string {
  const { icons = true, open = false, hovered = false } = options;
  const glyph = open ? "▾" : hovered ? "▶" : "▸";
  const parts: string[] = [
    `${theme.fg("accent", glyph)} ${theme.fg("toolTitle", `${summary.count} ${summary.count === 1 ? "call" : "calls"}`)}`,
  ];

  const breakdown = summary.breakdown.map(({ name, count }) => {
    const icon = icons ? `${toolKindIcon(name)} ` : "";
    return theme.fg("muted", `${icon}${name}×${count}`);
  });
  if (breakdown.length > 0) parts.push(breakdown.join(theme.fg("muted", "  ")));

  // Folded, this is the *only* report that anything failed — no row hangs
  // below it — so it takes the red. Open, the rows below each carry their own
  // `✗` and the count goes quiet. No glyph of its own either way: `32 calls`
  // needs no cross beside it, the colour is the signal.
  if (summary.failed > 0) parts.push(theme.fg(open ? "muted" : "error", `${summary.failed} failed`));
  if (summary.thinking || summary.thoughts > 0) {
    // Folded, this is the only sign the reply did any thinking at all: the
    // carrier messages that hold it draw nothing until the group opens. While a
    // run is still arriving the entry says so — the frame set the job row spins
    // with, then the word, the way a running call reads — and the count comes
    // back once it stops. The spinner is the "still arriving" signal, so it does
    // not depend on Nerd Font icons; the static brain does.
    const live = summary.thinking;
    const glyph = live ? (options.spinner ?? "◐") : icons ? THOUGHT_ICON : "";
    const icon = glyph ? `${glyph} ` : "";
    parts.splice(
      parts.length - (summary.failed > 0 ? 1 : 0),
      0,
      paint(theme, options.thinkingColor ?? "warning", `${icon}${live ? "thinking" : plural(summary.thoughts, "thought")}`),
    );
  }
  if (summary.jobsRunning > 0) {
    parts.push(theme.fg("accent", `${options.spinner ?? "◐"} ${summary.jobsRunning} running`));
  }

  if (summary.running) {
    parts.push(theme.fg("warning", `running ${summary.running}`));
  } else if (summary.durationMs > 0) {
    parts.push(theme.fg("muted", formatDuration(summary.durationMs)));
  }

  return ` ${parts.join(theme.fg("muted", " · "))}`;
}

interface ToolLike {
  toolName: string;
  args?: unknown;
  isPartial: boolean;
  result?: { isError?: boolean; durationMs?: number; content?: unknown; details?: unknown };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The text blocks of a tool result, joined. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function hasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => block?.type === "image");
}

/** Lines of real output, pi's own notices excluded. */
function realLines(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        line.trim() &&
        line.trim() !== "(no output)" &&
        !/^\[Showing /.test(line) &&
        !/^Command (exited with code|terminated)/.test(line),
    );
}

function outputLines(text: string, details: unknown): number {
  const total = (details as { truncation?: { truncated?: unknown; totalLines?: unknown } } | undefined)?.truncation;
  if (total?.truncated === true && typeof total.totalLines === "number") return total.totalLines;
  return realLines(text).length;
}

/**
 * A failure with nothing to read: the call exited non-zero and said nothing —
 * `sed` on a path that moved, a `test`, a probe. Those are mundane; a failure
 * whose output has actual text is where the red belongs. pi's own trailing
 * notices (`Command exited with code 1`, `(no output)`, the truncation line)
 * do not count as text, but a timeout or an abort does.
 */
export function isSilentFailure(result: ToolLike["result"]): boolean {
  if (!result || result.isError !== true) return false;
  return realLines(resultText(result.content)).length === 0;
}

/**
 * What a finished call produced, in a few words — the part of Claude Code's
 * `Read 120 lines` that makes a folded row worth reading. Built-in tools only;
 * anything else (MCP, extensions) gets no note rather than a wrong one.
 */
export function summarizeResult(toolName: string, result: ToolLike["result"]): string {
  if (!result) return "";
  if (toolName === "read" && !result.isError && hasImage(result.content)) return "image";
  const text = resultText(result.content);
  switch (toolName) {
    case "bash": {
      const code = /Command exited with code (\d+)/.exec(text)?.[1];
      if (result.isError) return code ? `exit ${code}` : "";
      const lines = outputLines(text, result.details);
      return lines > 0 ? plural(lines, "line") : "no output";
    }
    case "read":
      return result.isError ? "" : plural(outputLines(text, result.details), "line");
    case "grep":
      if (result.isError) return "";
      return text.trim() === "No matches found" ? "no matches" : plural(outputLines(text, result.details), "match", "matches");
    case "find":
      if (result.isError) return "";
      return /^No files found/.test(text.trim()) ? "no files" : plural(outputLines(text, result.details), "file");
    case "ls":
      if (result.isError) return "";
      return text.trim() === "(empty directory)" ? "empty" : plural(outputLines(text, result.details), "entry", "entries");
    default:
      return "";
  }
}

/**
 * The one-string description of a call's arguments, split: the first line of a
 * shell command (or a path / pattern / first stringish argument), and the
 * ` (+12 lines)` marker that rides behind it. Kept apart because a narrow row
 * has to decide what to spend cells on — the marker is the first thing to go.
 */
function argParts(args: unknown): { text: string; suffix: string; rest: string[] } {
  if (!args || typeof args !== "object") return { text: "", suffix: "", rest: [] };
  const record = args as Record<string, unknown>;

  const command = typeof record.command === "string" ? record.command : undefined;
  if (command) {
    const line = oneLine(command);
    return { ...line, text: shortenCd(line.text) };
  }

  for (const key of ["path", "file_path", "filePath", "pattern", "url", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value) return oneLine(value);
  }

  for (const value of Object.values(record)) {
    if (typeof value === "string" && value) return oneLine(value);
  }
  return { text: "", suffix: "", rest: [] };
}

/** `cd <path> &&` or `cd <path>;` with a command behind it, and no expansion in the path. */
const CD_PREFIX = /^cd\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;&|'"`$()]+))(\s*(?:&&|;)\s*)(?=\S)/;

/**
 * `cd ~/Projects/fork/pi/pi-tidy && rg x` reads `cd …/pi-tidy && rg x`. Agents
 * start nearly every command this way, and on a one-line row the path spends the
 * cells the command needs. Only the row is shortened: the opened box keeps it whole.
 */
function shortenCd(line: string): string {
  const match = CD_PREFIX.exec(line);
  if (!match) return line;
  const path = match[1] ?? match[2] ?? match[3]!;
  const last = path.replace(/\/+$/, "").split("/").pop();
  // `…/..` would name a directory the path never mentions.
  if (!last || last === "." || last === "..") return line;
  const short = `…/${last}`;
  if (short.length >= path.length) return line;
  return `cd ${short}${match[4]}${line.slice(match[0].length)}`;
}

/**
 * One row means one line, for every argument — not just `command`.
 *
 * A row is a single string in the lines array the renderer hands back, so a
 * multi-line value (a script, a file body, anything an MCP tool takes) used to
 * come through with real newlines in it. The terminal then drew three physical
 * rows where pi's frame counted one, and every row below it — the status
 * spinner included — painted two rows off, leaving fragments of the previous
 * frame behind. A multi-line value keeps its first line and counts the rest.
 */
function oneLine(value: string): { text: string; suffix: string; rest: string[] } {
  const [first, ...rest] = value.split("\n");
  return { text: first.trim(), suffix: moreLines(rest.length), rest };
}

const moreLines = (count: number) => (count > 0 ? ` (+${count} lines)` : "");

/**
 * Cut `text` to `cells` for a row with a second one under it: at a space when one
 * is near enough, so the words stay whole. Undefined when the text cannot be cut
 * cleanly, which means escapes of its own: the row then clips as usual.
 */
function splitAtCells(text: string, cells: number): { first: string; second: string; gap: number } | undefined {
  const plain = visibleText(clipToWidth(text, cells, ""));
  if (!plain || !text.startsWith(plain)) return undefined;
  const space = plain.lastIndexOf(" ");
  return space > plain.length / 2
    ? { first: plain.slice(0, space), second: text.slice(space + 1), gap: 1 }
    : { first: plain, second: text.slice(plain.length), gap: 0 };
}

/** A `codemode` script's nested calls, counted by tool. */
export interface NestedCallSummary {
  /** `bash×3 read×1` — empty when the script called no tools. */
  kinds: string;
  failed: number;
  total: number;
}

/**
 * The nested tool calls of a `codemode` script, from `result.details.calls`.
 *
 * A script's calls are not tool rows: they never reach the model as calls, so
 * pi keeps them as `{ name, status, durationMs, error }` records on the parent
 * result instead of components. Nothing else in the transcript counts them, so
 * the folded row is the only place a glance can see what a script ran.
 */
export function summarizeNestedCalls(details: unknown): NestedCallSummary {
  const calls = (details as { calls?: unknown } | undefined)?.calls;
  if (!Array.isArray(calls) || calls.length === 0) return { kinds: "", failed: 0, total: 0 };
  const counts = new Map<string, number>();
  let failed = 0;
  for (const call of calls as Array<{ name?: unknown; status?: unknown }>) {
    const name = typeof call?.name === "string" && call.name ? call.name : "call";
    // `mcp__chrome_devtools__take_screenshot` says less than its server does and
    // eats the row; one server with three tools is one entry.
    const key = name.startsWith("mcp__") ? (name.split("__")[1] ?? name) : name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (call?.status === "error" || call?.status === "cancelled") failed++;
  }
  const kinds = [...counts].map(([name, count]) => `${name}×${count}`).join(" ");
  return { kinds, failed, total: calls.length };
}

/**
 * The one-string description of a call's arguments: a shell command's first
 * line, a file's path, or the first stringish argument it can find.
 */
export function summarizeArgs(toolName: string, args: unknown, maxWidth = DEFAULT_MAX_ARG_CHARS): string {
  const { text, suffix } = argParts(args);
  return text ? `${clipToWidth(text, maxWidth, "…")}${suffix}` : "";
}

/** `running 12s · READY matched` / `exited 0 · 20s` / `killed SIGTERM · 3s` */
export function describeJob(job: JobState, now = Date.now()): string {
  const end = job.status === "running" ? now : job.endTime;
  const took = job.startTime !== undefined && end !== undefined ? formatElapsed(end - job.startTime) : "";
  const parts: string[] = [];
  switch (job.status) {
    case "running":
      parts.push(took ? `running ${took}` : "running");
      break;
    case "done":
      parts.push(`exited ${job.exitCode ?? 0}`);
      break;
    case "failed":
      parts.push(typeof job.exitCode === "number" ? `exit ${job.exitCode}` : "failed");
      break;
    case "killed":
      parts.push(job.signal ? `killed ${job.signal}` : "killed");
      break;
    case "gone":
      return "not running";
  }
  if (job.status !== "running" && took) parts.push(took);
  if (job.note) parts.push(job.note);
  return parts.join(" · ");
}

/** Whole seconds, then minutes: `12s`, `3m05s`, `1h02m`. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60).toString().padStart(2, "0")}m`;
}

/**
 * Where a row starts. A row in a column block puts the outcome behind the name, so
 * the kind icons run straight down with the thinking rows' brain, which has no
 * outcome to put in front of it.
 */
function rowHead(status: string, label: string, toolName: string, align: LineOptions["align"]): string {
  if (!align) return ` ${status} ${label}`;
  const pad = Math.max(0, (align.name ?? 0) - visibleWidth(toolName));
  return ` ${label} ${status}${" ".repeat(pad + 1)}`;
}

/** ` ✓ bash cd ~ && python3 - <<'PY' (+26 lines)  3 lines · 0.1s` */
export function formatToolLine(tool: ToolLike, theme: ThemeLike, options: LineOptions = {}): string {
  return formatToolRows(tool, theme, { ...options, rowLines: 1 })[0]!;
}

/** The call's row, and a second one under it when it is allowed one and has more to say. */
export function formatToolRows(tool: ToolLike, theme: ThemeLike, options: LineOptions = {}): string[] {
  const { icons = true, job, width } = options;
  if (job) return [formatJobLine(tool, job, theme, icons, options.spinner, options.align)];
  const { isPartial } = tool;
  const isError = !isPartial && tool.result?.isError === true;
  // A silent failure keeps its red glyph and drops the rest to `dim`: it is
  // still visibly a failure, but it stops competing with the reply's text.
  const silent = isSilentFailure(tool.result);
  const body = silent ? "dim" : undefined;

  const status = isPartial
    ? theme.fg("muted", "⋯")
    : isError
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");

  const icon = icons ? `${toolKindIcon(tool.toolName)} ` : "";
  // One column for the names in a group: the arguments start on the same cell
  // on every row, whatever the name's length (see groupAlign). The kind icon is
  // the same width on every row, so only the word is padded.
  const head = rowHead(status, theme.fg(body ?? "toolTitle", `${icon}${tool.toolName}`), tool.toolName, options.align);
  // A codemode script's “arguments” are its source, which the open box already
  // shows. What a folded row is missing is what the script ran: the nested
  // calls take the arguments' place instead of the script's first line.
  const nested = tool.toolName === "codemode" ? summarizeNestedCalls(tool.result?.details) : undefined;
  const { text, suffix, rest } = nested?.kinds ? { text: nested.kinds, suffix: "", rest: [] } : argParts(tool.args);

  // `  12 lines · 0.3s` — what it produced, then how long it took.
  const note = isPartial ? "" : summarizeResult(tool.toolName, tool.result);
  // A script that caught a nested failure still succeeds, so its row is a green
  // `✓` with nothing red on it. The count is what says a call inside it failed.
  const nestedFailed = !isPartial && (nested?.failed ?? 0) > 0;
  const failedNote = nestedFailed ? `${nested!.failed} failed` : "";
  const durationMs = tool.result?.durationMs;
  const duration = !isPartial && typeof durationMs === "number" && durationMs > 0 ? formatDuration(durationMs) : "";
  const paint = (value: string) => theme.fg(body ?? "muted", value);
  const shownNote = note || failedNote;
  // Padding is outside the colour, so the columns line up whatever the theme
  // does to the text.
  const notePad = Math.max(0, (options.align?.note ?? 0) - visibleWidth(shownNote));
  const durationPad = Math.max(0, (options.align?.duration ?? 0) - visibleWidth(duration));
  const tail = [
    shownNote
      ? " ".repeat(notePad) +
        [note && paint(note), failedNote && theme.fg("error", failedNote)].filter(Boolean).join(theme.fg("muted", " · "))
      : "",
    duration ? " ".repeat(durationPad) + paint(duration) : "",
  ].filter(Boolean);
  const hint = options.hovered ? theme.fg("muted", "  ›") : "";

  // Before the width was known the row took a fixed 60 cells of arguments and
  // let `truncateToWidth` cut the end off afterwards — which on a narrow
  // terminal meant the metrics went first and the command kept a ragged stub.
  if (typeof width !== "number") {
    const argText = nested?.kinds ? `${text}${suffix}` : summarizeArgs(tool.toolName, tool.args);
    const detail = text ? theme.fg(body ?? "toolOutput", ` ${argText}`) : "";
    const tailText = tail.length > 0 ? `  ${tail.join(theme.fg("muted", " · "))}` : "";
    return [`${head}${detail}${tailText}${hint}`];
  }

  const fixed = visibleWidth(head) + 1 /* the space before the arguments */ + visibleWidth(hint);
  const tailText = tail.length > 0 ? `  ${tail.join(theme.fg("muted", " · "))}` : "";
  // The metrics only take what is left over, and step aside entirely when
  // paying for them would leave nothing readable of the command.
  const keepTail = tailText !== "" && width - fixed - visibleWidth(tailText) >= MIN_ARG_CELLS;
  let budget = width - fixed - (keepTail ? visibleWidth(tailText) : 0);
  let shownSuffix = suffix;
  if (budget - visibleWidth(suffix) < MIN_ARG_CELLS) {
    // `(+12 lines)` is a nicety; the command is not.
    shownSuffix = "";
    budget += visibleWidth(suffix);
  }
  const highlighted = options.highlight && !body && tool.toolName === "bash";
  const paintArgs = (value: string, more: string) =>
    (highlighted ? highlightClipped(value, theme) + theme.fg("muted", more) : theme.fg(body ?? "toolOutput", `${value}${more}`));

  const room = width - visibleWidth(head) - 1;
  const overflow = options.rowLines === 2 && text && budget > 1 && room >= MIN_ARG_CELLS
    ? secondRow(text, rest, budget, room)
    : undefined;
  let detail: string;
  let below: string | undefined;
  if (overflow) {
    const painted = highlighted && overflow.joined
      ? paintJoined(overflow.first, overflow.second, overflow.gap, theme)
      : [paintArgs(overflow.first, ""), paintArgs(overflow.second, "")];
    detail = ` ${painted[0]}`;
    below = `${" ".repeat(visibleWidth(head) + 1)}${painted[1]}${overflow.more ? theme.fg("muted", overflow.more) : ""}`;
  } else {
    // The clip closes its `…` with a full reset, which would end a hover band there.
    const shown = text && budget > 1 ? visibleText(clipToWidth(text, budget - visibleWidth(shownSuffix), "…")) : "";
    detail = shown ? ` ${paintArgs(shown, shownSuffix)}` : "";
  }
  const rows = (first: string) => (below ? [first, below] : [first]);
  if (!keepTail) return rows(`${head}${detail}${hint}`);
  // Only a caller that asked for columns gets the right edge; a row rendered on
  // its own keeps the metrics where they belong, right after the arguments.
  const gap = options.align
    ? width - visibleWidth(head) - visibleWidth(detail) - visibleWidth(hint) - visibleWidth(tailText)
    : 0;
  return rows(`${head}${detail}${gap > 0 ? " ".repeat(gap) : ""}${tailText}${hint}`);
}

/**
 * What goes on a call's second row, if anything: the words its first line could not
 * fit, or else the next line of a multi-line command. `joined` says the two rows are
 * one piece of text cut in two, so a quote may be open across them.
 */
function secondRow(
  text: string,
  rest: readonly string[],
  budget: number,
  room: number,
): { first: string; second: string; gap: number; more: string; joined: boolean } | undefined {
  const clip = (value: string, more: string) => visibleText(clipToWidth(value, room - visibleWidth(more), "…"));
  if (visibleWidth(text) > budget) {
    const split = splitAtCells(text, budget);
    if (!split) return undefined;
    const more = moreLines(rest.length);
    return { first: split.first, second: clip(split.second, more), gap: split.gap, more, joined: true };
  }
  const next = rest.findIndex((line) => line.trim());
  if (next < 0) return undefined;
  const more = moreLines(rest.length - next - 1);
  return { first: text, second: clip(rest[next]!.trim(), more), gap: 0, more, joined: false };
}

/** Highlight the two rows as the one command they are, so a quote stays a quote across the cut. */
function paintJoined(first: string, second: string, gap: number, theme: ThemeLike): [string, string] {
  const whole = highlightClipped(`${first}${" ".repeat(gap)}${second}`, theme);
  const cells = visibleWidth(first);
  // A slice can stop inside a token's colour, and what follows must not inherit it.
  const close = "\x1b[39m";
  return [
    sliceByColumn(whole, 0, cells) + close,
    sliceByColumn(whole, cells + gap, visibleWidth(second)) + close,
  ];
}

/** Highlighted after clipping, so a row never measures through its colours. */
function highlightClipped(shown: string, theme: ThemeLike): string {
  try {
    return highlightBashCommand(shown, (token, value) => theme.fg(token, value));
  } catch {
    return theme.fg("toolOutput", shown); // never break the row on a tokenizer bug
  }
}

/** The `│` that runs down the left of an open group, under its `▾`. */
export function groupGutter(theme: ThemeLike): string {
  return ` ${theme.fg("borderMuted", "│")}`;
}

/**
 * A thinking run as one line: the brain in the thinking colour, the label, then
 * as much of the text as fits. `previewText` does the measuring so the row
 * itself stays a pure string.
 */
export function formatThoughtLine(text: string, theme: ThemeLike, options: LineOptions = {}): string {
  const color = options.thinkingColor ?? "warning";
  // A thought row outside a group has no summary line above it to spin, so the
  // row carries the frame set itself: "still arriving" has to be visible
  // without opening anything. The spinner needs no Nerd Font; the brain does.
  const glyph = options.spinner ?? (options.icons === false ? "" : THOUGHT_ICON);
  const icon = glyph ? `${glyph} ` : "";
  const labelText = `${icon}thinking`;
  const label = paint(theme, color, labelText);
  const body = theme.fg(options.quiet ? "dim" : "thinkingText", text);
  // Inside a group the label sits in the same column as the tool names, so the
  // thought's text starts where the arguments do (see formatToolLine).
  const name = options.align?.name;
  const gap =
    name === undefined
      ? 2
      : Math.max(2, (options.icons === false ? 0 : 2) + name + 4 - visibleWidth(labelText));
  const row = ` ${label}${" ".repeat(gap)}${body}`;
  return theme.italic ? theme.italic(row) : row;
}

/**
 * `󰧑 thinking` on its own: what an open thinking box carries in its top border,
 * in place of the row it opened from. Same glyph, colour and slant as the row.
 */
export function formatThoughtLabel(theme: ThemeLike, options: LineOptions = {}): string {
  const glyph = options.spinner ?? (options.icons === false ? "" : THOUGHT_ICON);
  const label = paint(theme, options.thinkingColor ?? "warning", `${glyph ? `${glyph} ` : ""}thinking`);
  return theme.italic ? theme.italic(label) : label;
}

/**
 * `nf-md-brain`. Not the emoji 🧠: it is absent from every monospace Nerd Font
 * and falls back to a two-cell colour glyph, which breaks the row's alignment.
 */
export const THOUGHT_ICON = "\u{f09d1}";

/** Cells the `🧠 thinking` label takes on a row: brain + space + the word + two spaces. */
export const THOUGHT_LABEL_CELLS = 2 + "thinking".length + 2;

/**
 * A thinking row outside a group is a glance, not a paragraph. It is drawn at full
 * strength, so past this many cells it reads as prose wedged into the transcript.
 * Inside a group the text is dim and takes the whole row.
 */
export const THOUGHT_PREVIEW_CELLS = 56;

/**
 * How often a live thinking row is allowed to change. pi repaints ~30x/s while
 * streaming, so a window recomputed every frame slides one cell per token and
 * the line never holds still; this turns it into a tick.
 */
export const THOUGHT_TICK_MS = 300;

/**
 * A thinking run squeezed onto one row. Measured in cells (`truncateToWidth`),
 * not in characters: a CJK run is two cells a glyph.
 */
export function previewText(text: string, maxWidth: number, tail = false): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (maxWidth <= 1) return "";
  // The clip closes its `…` with a full reset, which would end a hover band there.
  if (!tail) return visibleText(clipToWidth(flat, maxWidth, "…"));
  // A run that is still arriving reads as a sliding window over its tail: the
  // newest words are the interesting ones, and the row stays one line. The cut
  // lands on a word break, so the window does not shave half a word off — that
  // shaving is what made the line look like it was shaking.
  let out = flat;
  for (let i = 0; i < flat.length && visibleWidth(out) > maxWidth - 1; i++) {
    out = out.slice(Math.max(1, Math.ceil(out.length / 8)));
  }
  if (out.length >= flat.length) return flat;
  const breakAt = out.indexOf(" ");
  if (breakAt > 0 && breakAt < out.length - 1) out = out.slice(breakAt + 1);
  return `…${clipToWidth(out, maxWidth - 1)}`;
}

/** Cells `groupGutter` takes. */
export const GUTTER_CELLS = 2;

/** A call that started a background job: the row tracks the job, not the call. */
export function formatJobLine(tool: ToolLike, job: JobState, theme: ThemeLike, icons: boolean, spinner = "◐", align?: LineOptions["align"]): string {
  const status =
    job.status === "running"
      ? theme.fg("accent", spinner)
      : job.status === "done"
        ? theme.fg("success", "✓")
        : job.status === "failed"
          ? theme.fg("error", "✗")
          : theme.fg("muted", "⊘");
  const icon = icons ? `${toolKindIcon(tool.toolName)} ` : "";
  const name = theme.fg("toolTitle", `${icon}${tool.toolName}`);
  const color = job.status === "failed" ? "error" : job.status === "running" ? "warning" : "muted";
  return `${rowHead(status, name, tool.toolName, align)}${theme.fg("toolOutput", ` ${job.name.replace(/\s+/g, " ")}`)}  ${theme.fg(color, describeJob(job).replace(/\s+/g, " "))}`;
}

export { formatDuration };
