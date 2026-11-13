/**
 * How a tool box looks and reacts while it belongs to a group (tool-groups.ts
 * owns the state; this file turns a `ViewPlan` into lines and clicks):
 *
 *    ▸ 3 calls ·  bash×3 · 1 failed · 0.5s     header, carried by the first member
 *    │ ⋯ bash  pnpm test                      a row (only a running call shows while folded)
 *    │ ╭──────────────╮                       a full box, three cells in
 *
 * Also installs the boundary hooks on the message components, which is where
 * the groups get cut.
 */

import { stripVTControlCharacters } from "node:util";
import { MouseRegion, visibleWidth, Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, CustomMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  ANIMATE_MS, closeJobDetails, jobDetails, jobForTool, jobNotes, jobsForTool, noteJobMessage,
  spinnerFrame, toggleJobDetails, type JobDetails, type JobState,
} from "./background-jobs.ts";
import { agentRunning, tidyEnabled } from "../live.ts";
import {
  hoverBand,
  hoverIsTracked,
  hoveredRow,
  isRowHovered,
  lastRenderer,
  markHoverClaimed,
  rememberRenderer,
  setHover,
  type HoverRow,
} from "../hover.ts";
import { messageOnRail, presentTurn, TURN_LAYOUT, TURN_RAIL_CELLS } from "../turns/turn-view.ts";
import { folded, turnFor, turnOptions } from "../turns/turn-state.ts";
import { toggleCodemodeSection, type CodemodeSection } from "./codemode-body.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";
import { clipToWidth, drawFrame, labeledTopBorder, trimBlankEdges } from "../draw/frame-draw.ts";
import {
  formatGroupLine,
  formatThoughtLabel,
  formatThoughtLine,
  formatToolRows,
  formatJobLine,
  GUTTER_CELLS,
  groupGutter,
  formatDuration,
  previewText,
  summarizeResult,
  THOUGHT_LABEL_CELLS,
  THOUGHT_PREVIEW_CELLS,
  THOUGHT_TICK_MS,
} from "./tool-lines.ts";
import {
  carrierPlan,
  classifyAssistant,
  closeGroup,
  currentGroupHasMembers,
  groupMembers,
  groupIsOpen,
  RUNNING_ROW_DELAY_MS,
  noteBoundary,
  noteThinking,
  releaseCarrier,
  thinkingState,
  openGroup,
  planFor,
  summaryFor,
  takeLateJoin,
  thinkingRuns,
  toolCallIds,
  type ViewPlan,
} from "./tool-groups.ts";

/** The slice of ToolExecutionComponent the group view reads. */
export interface GroupedTool {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  isPartial: boolean;
  expanded: boolean;
  result?: { isError?: boolean; durationMs?: number; content?: unknown; details?: unknown };
  imageComponents?: unknown[];
  ui?: { requestRender?(): void };
  setExpanded(expanded: boolean): void;
}

/**
 * Cells a grouped full box is shifted right by: the gutter plus a space. Boxes
 * with images skip the gutter — their lines carry graphics payloads that must
 * start at the left edge.
 */
function boxIndent(tool: GroupedTool, plan: ViewPlan): number {
  return plan.gutter && !(tool.imageComponents?.length ?? 0) ? GUTTER_CELLS + 1 : 0;
}

/**
 * The tool's lines while grouping is on, or `undefined` when it is an
 * always-shown tool and should render as a plain box.
 */
export function renderGroupedTool(
  tool: GroupedTool,
  width: number,
  theme: ThemeLike,
  options: { icons: boolean; pinned: boolean; highlight?: boolean; rowLines?: number },
  frameBox: (width: number, unframed?: boolean) => string[],
): string[] | undefined {
  // Another extension may have patched a boundary render on top of ours
  // since; re-wrap so the boundaries keep being seen.
  installGroupBoundaries();
  const job = options.pinned ? undefined : jobForTool(tool);
  const jobs = options.pinned ? [] : jobsForTool(tool);
  if (tool.ui) rememberRenderer(tool.ui);
  const now = Date.now();
  const plan = planFor(tool, options.pinned, runningJob(jobs) ?? job, now);
  if (takeLateJoin()) tool.ui?.requestRender?.();
  if (plan.revealIn !== undefined) scheduleReveal(tool, plan.revealIn);
  if (!plan.header && !plan.gutter) {
    nestedRowSpans.delete(tool);
    codemodeSpans.delete(tool);
    return undefined;
  }

  const { icons, highlight, rowLines } = options;
  const hovered = hoveredRow(tool);
  const align = groupAlign(tool);
  // The header is memoized on its own inputs and hands back the same string
  // whenever it did not change, so its identity is a stamp for the whole line.
  const headerLine = plan.header
    ? groupHeaderLine(tool, plan.header, theme, width, icons, hovered === "header", now)
    : undefined;
  // Only a settled transcript is cached: a run in flight, a partial tool or a
  // background job puts a clock, a spinner or a growing body on these rows.
  const live =
    agentRunning.get() || tool.isPartial === true || job !== undefined || jobs.length > 0 || plan.revealIn !== undefined;
  // The body is drawn through the tool's own frame cache, so an unchanged box
  // hands back the same array: its identity says "nothing under this row moved".
  const body = plan.full ? frameBox(Math.max(4, width - BODY_INDENT), true) : undefined;
  // Compared field by field against the last frame rather than through a built
  // key: on a folded row the check has to cost less than the row it skips.
  const cached = live ? undefined : groupedRows.get(tool);
  if (
    cached && cached.width === width && cached.icons === icons && cached.highlight === highlight && cached.rowLines === rowLines && cached.line === plan.line &&
    cached.full === plan.full && cached.hovered === hovered && cached.align === align &&
    cached.header === headerLine && cached.body === body && cached.theme === theme &&
    cached.result === tool.result && cached.args === tool.args
  ) return cached.lines;
  nestedRowSpans.delete(tool);
  codemodeSpans.delete(tool);

  const lines: string[] = [];
  if (headerLine !== undefined) lines.push(headerLine);
  const gutter = groupGutter(theme);
  if (plan.line || plan.full) {
    const spinner = job ? spinnerFrame(job) : undefined;
    const rowWidth = width - GUTTER_CELLS;
    const [row, below] = formatToolRows(tool, theme, { icons, job, spinner, hovered: hovered === "row", width: rowWidth, align, highlight, rowLines });
    // An opened call keeps its row — it does not turn into something else — and
    // takes a tick off the rail to show what hangs below it.
    const line = plan.full ? `${tickGutter(theme)}${withoutLead(row!)}` : gutter + row;
    const drawn = below === undefined ? [line] : [line, `${gutter}${below}`];
    for (const each of drawn) lines.push(hovered === "row" ? hoverBand(each, width, theme) : clipToWidth(each, width, "…"));
    rowsBelow.set(tool, drawn.length - 1);
  }
  if (plan.full && body) {
    // Inside the group the rail already says what belongs to what, so a box
    // would be a frame inside a frame. Only the body is drawn, hanging under
    // the row that opened it.
    const base = lines.length;
    const toggles = (tool as { __codemodeToggles?: Array<{ row: number; section: string }> }).__codemodeToggles ?? [];
    for (const [index, line] of body.entries()) {
      const out = `${gutter}${BODY_PAD}${line.trimEnd()}`;
      const section = toggles.find((toggle) => toggle.row === index)?.section;
      lines.push(section !== undefined && hovered === `codemode:${section}` ? hoverBand(out, width, theme) : out);
    }
    // A codemode body folds its script and output to one row each; those rows
    // answer their own clicks (see routeGroupedMouse).
    codemodeSpans.set(
      tool,
      toggles.map((toggle) => ({ row: base + toggle.row, section: toggle.section as CodemodeSection })),
    );
  }
  const spans: NestedRowSpan[] = [];
  const open = groupIsOpen(tool);
  // What the job reported since it started. A folded group knows one row for a
  // running job, and its pattern is already on it: the matched lines wait until
  // the group is opened, so a watcher that ticks every second costs nothing here.
  // Below the body too, so the body's click geometry stays put.
  if (job && open && !plan.full) {
    for (const note of jobNoteRows(job, theme, `${gutter}${BODY_PAD}`)) lines.push(clipToWidth(note, width, "…"));
  }
  // Nested starts belong to the wrapper, but do not replace its result/error.
  // Keep them below its body so the body's existing click geometry is unchanged.
  // An opened box hangs them inside the body instead: they are what the script
  // produced, on the same rail as its call rows and its output.
  const inBody = plan.full;
  const rowPad = inBody ? `${gutter}${BODY_PAD}${theme.fg("borderMuted", "│")} ` : `${gutter}  `;
  const detailPad = inBody ? `${gutter}${BODY_PAD}${theme.fg("borderMuted", "│")}     ` : `${gutter}      `;
  for (const nested of jobs) {
    if (nested === job) continue;
    const details = jobDetails(nested.id);
    if (!open && !details && (nested.status !== "running" || now - (nested.startTime ?? now) < RUNNING_ROW_DELAY_MS)) continue;
    const from = lines.length;
    const hot = hovered === `job:${nested.id}`;
    const arrow = details ? "▾" : hot ? "▶" : "▸";
    const row = formatJobLine({ toolName: "process", isPartial: false }, nested, theme, icons, spinnerFrame(nested, now));
    const line = `${rowPad}${theme.fg("muted", arrow)}${row}`;
    lines.push(hot ? hoverBand(line, width, theme) : clipToWidth(line, width, "…"));
    if (details) {
      for (const body of renderJobDetails(nested, details, theme)) {
        lines.push(clipToWidth(`${detailPad}${body}`, width, "…"));
      }
    }
    spans.push({ id: nested.id, from, to: lines.length - 1 });
    // Open, the job's own log already carries what it reported; folded, its
    // pattern is on the row and the matched lines stay out of the summary.
    if (!details && open) for (const note of jobNoteRows(nested, theme, `${rowPad}  `)) lines.push(clipToWidth(note, width, "…"));
  }
  nestedRowSpans.set(tool, spans);
  if (!live) groupedRows.set(tool, {
    width, icons, highlight, rowLines, line: plan.line, full: plan.full, hovered, align,
    header: headerLine, body, theme, result: tool.result, args: tool.args, lines,
  });
  return lines;
}

/**
 * The rows each settled tool drew last. A transcript that is not moving asks for
 * the same rows every frame — 40 body rows per opened call, each rebuilt by
 * concatenation and measured — and nothing but the group's own state, the
 * pointer and the box under it can change them.
 */
const groupedRows = new WeakMap<object, {
  width: number;
  icons: boolean;
  highlight: boolean | undefined;
  rowLines: number | undefined;
  line: boolean;
  full: boolean;
  hovered: HoverRow | null;
  align: object;
  header: string | undefined;
  body: readonly string[] | undefined;
  theme: ThemeLike;
  result: unknown;
  args: unknown;
  lines: string[];
}>();

interface NestedRowSpan { id: string; from: number; to: number }
const nestedRowSpans = new WeakMap<object, NestedRowSpan[]>();

/** A codemode body's fold labels: one clickable row each. */
export interface CodemodeRowSpan {
  row: number;
  section: CodemodeSection;
}
const codemodeSpans = new WeakMap<object, CodemodeRowSpan[]>();

/** The fold row at `y`, if there is one. */
export function codemodeFoldAt(rows: readonly CodemodeRowSpan[] | undefined, y: unknown): CodemodeRowSpan | undefined {
  return typeof y === "number" ? rows?.find((span) => span.row === y) : undefined;
}

/**
 * A packet on a codemode fold row, grouped or framed: a click opens or shuts
 * that section, motion lights the row. Presses and drags stay pi's: the row is
 * text like any other.
 */
export function routeCodemodeFold(tool: GroupedTool, event: any, section: CodemodeSection): unknown {
  const click = event?.type === "click" && (event.button === "left" || event.button === 0);
  if (click) {
    toggleCodemodeSection(tool, section);
    (tool as { invalidate?(): void }).invalidate?.();
    tool.ui?.requestRender?.();
    return { handled: true };
  }
  if (event?.type === "move" && hoverIsTracked()) {
    markHoverClaimed();
    if (setHover(tool, `codemode:${section}`, tool.ui)) tool.ui?.requestRender?.();
  }
  return undefined;
}

/** Logs are plain text here: no cursor moves, OSC payloads, tabs or embedded rows. */
function jobText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** At most a few rows: a watcher that ticks every second must not grow the group. */
const NOTE_ROWS = 3;

/**
 * What a job reported since it started, one dim row each. The pattern is on the
 * job's own row (`READY matched`); the matched line itself has nowhere else to go.
 */
function jobNoteRows(job: JobState, theme: ThemeLike, pad: string): string[] {
  const notes = jobNotes(job);
  if (notes.length === 0) return [];
  const shown = notes.slice(-NOTE_ROWS);
  const earlier = notes.length - shown.length;
  const rows = shown.map((note) => `${pad}${theme.fg("muted", `· ${note.text}`)}`);
  if (earlier > 0) rows.unshift(`${pad}${theme.fg("muted", `· +${earlier} earlier`)}`);
  return rows;
}

function renderJobDetails(job: JobState, details: JobDetails, theme: ThemeLike): string[] {
  const lines = [theme.fg("muted", `id: ${jobText(job.id)}`)];
  if (details.command) lines.push(theme.fg("toolOutput", `$ ${jobText(details.command)}`));
  if (details.cwd) lines.push(theme.fg("muted", `cwd: ${jobText(details.cwd)}`));
  if (!details.logs) lines.push(theme.fg("muted", "Logs unavailable."));
  else if (details.logs.length === 0) lines.push(theme.fg("muted", "No output yet."));
  else for (const entry of details.logs) {
    lines.push(theme.fg(entry.type === "stderr" ? "error" : "toolOutput", `${entry.type}: ${jobText(entry.text)}`));
  }
  return lines;
}

function closeGroupJobDetails(component: object): void {
  for (const member of groupMembers(component)) closeJobDetails(jobsForTool(member as GroupedTool).map((job) => job.id));
}

function runningJob(jobs: JobState[]): JobState | undefined {
  return jobs.filter((job) => job.status === "running").sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity))[0];
}

/**
 * The note and duration columns for a group: the widest of each, so every row
 * pads to the same width and the metrics line up down the block. Recomputed
 * when the group's membership changes, not per row — `summarizeResult` walks a
 * result's whole output, and doing that once per row would be quadratic.
 */
const alignCache = new WeakMap<readonly object[], { count: number; settled: number; name: number; note: number; duration: number }>();

function groupAlign(anchor: object): { name: number; note: number; duration: number } {
  const members = groupMembers(anchor);
  // A result landing changes the columns without changing the membership.
  let settled = 0;
  for (const member of members) if (member.result) settled++;
  const cached = alignCache.get(members);
  if (cached && cached.count === members.length && cached.settled === settled) return cached;
  let name = NAME_COLUMN_MIN;
  let note = 0;
  let duration = 0;
  for (const member of members) {
    name = Math.max(name, visibleWidth(member.toolName));
    note = Math.max(note, visibleWidth(summarizeResult(member.toolName, member.result)));
    duration = Math.max(duration, visibleWidth(formatDuration(member.result?.durationMs ?? 0)));
  }
  // One long MCP name would push every argument out of reach; past the cap the
  // column stops growing and those rows keep one space after their name.
  name = Math.min(name, NAME_COLUMN_MAX);
  const entry = { count: members.length, settled, name, note, duration };
  alignCache.set(members, entry);
  return entry;
}

/**
 * The narrowest name column whose arguments start where a thinking row's text
 * does: `bash ✓` has to fill the width of `thinking`. Every group gets it, so a
 * thought arriving later does not move the rows, and groups line up with each other.
 */
const NAME_COLUMN_MIN = 6;

/** Cells the tool-name column may take before an argument column stops paying off. */
const NAME_COLUMN_MAX = 14;

/**
 * The rail with a tick: `├─`. Used by an opened call's row, whose output hangs
 * below it — the horizontal line is what points at the row the block belongs to.
 */
function tickGutter(theme: ThemeLike): string {
  return ` ${theme.fg("borderMuted", "├─")}`;
}

/**
 * A row without its one-cell lead, which is where a tick's extra cell goes: the row's
 * columns then stay under the unopened rows'. An italic row keeps it behind its escape.
 */
function withoutLead(row: string): string {
  return row.replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1");
}

/** Cells an opened call's body is pushed in by, under its row: the rail plus three. */
const BODY_INDENT = GUTTER_CELLS + 3;
const BODY_PAD = "   ";

/**
 * The group's summary line. Carried by the first member — or by a leading
 * carrier, which renders before that member does (see `carrierPlan`).
 */
function groupHeaderLine(
  anchor: object,
  header: "closed" | "open",
  theme: ThemeLike,
  width: number,
  icons: boolean,
  hovered: boolean,
  now: number,
): string | undefined {
  const jobs: JobState[] = [];
  const summary = summaryFor(
    anchor,
    (member) => {
      const owned = jobsForTool(member as GroupedTool);
      jobs.push(...owned);
      return owned;
    },
    now,
  );
  if (!summary) return undefined;
  // One spinner for the row: a running job, or a thought still arriving.
  const spinner = summary.thinking ? thinkingSpinner(now) : groupSpinner(jobs);
  const thinkingColor = thinkingColorFor();
  // Every group's line is drawn on every frame, and building it costs more
  // than it looks: measuring a styled row with icons is a walk over every
  // grapheme. The line is a function of these fields only.
  const key = [
    summary.count,
    summary.breakdown.map(({ name, count }) => `${name}×${count}`).join(" "),
    summary.thoughts,
    summary.thinking,
    summary.durationMs,
    summary.running ?? "",
    summary.failed,
    summary.jobsRunning,
    header,
    spinner,
    hovered,
    width,
    icons,
    thinkingColor,
    theme.fg("accent", "·"),
  ].join("\u0000");
  const cached = headerLines.get(anchor);
  if (cached?.key === key) return cached.line;
  const formatted = formatGroupLine(summary, theme, {
    icons,
    open: header === "open",
    spinner,
    thinkingColor,
    hovered,
  });
  const line = hovered ? hoverBand(formatted, width, theme) : clipToWidth(formatted, width, "…");
  headerLines.set(anchor, { key, line });
  return line;
}

/** The summary line each anchor drew last, keyed by everything that went into it. */
const headerLines = new WeakMap<object, { key: string; line: string }>();

/** A quarter-turn frame that follows the wall clock, so any repaint advances it. */
function thinkingSpinner(now: number): string {
  return spinnerFrame({ id: "", name: "", status: "running", startTime: now }, now);
}

const revealScheduled = new WeakSet<object>();

/**
 * A running row hidden for its first second must appear on time even if
 * nothing else repaints (a quiet tool, or a background job's first second).
 */
function scheduleReveal(tool: GroupedTool, ms: number): void {
  if (revealScheduled.has(tool)) return;
  revealScheduled.add(tool);
  const timer = setTimeout(() => {
    revealScheduled.delete(tool);
    tool.ui?.requestRender?.();
  }, Math.max(0, ms) + 20);
  timer.unref?.();
}

/**
 * The repaint that takes a stalled thinking row (and its spinner) off screen.
 * Nothing else will ask for it: the run is quiet and pi is idle by then.
 */
const settleScheduled = new WeakSet<object>();

function scheduleSettle(component: object, ms: number): void {
  if (settleScheduled.has(component)) return;
  settleScheduled.add(component);
  const timer = setTimeout(() => {
    settleScheduled.delete(component);
    lastRenderer()?.requestRender?.();
  }, Math.max(0, ms) + 20);
  timer.unref?.();
}

/** The header's glyph: spinning while any running job is young, then still. */
function groupSpinner(jobs: JobState[]): string {
  const now = Date.now();
  const running = jobs.filter((job) => job.status === "running");
  const young = running.some((job) => job.startTime === undefined || now - job.startTime < ANIMATE_MS);
  return young ? spinnerFrame({ id: "", name: "", status: "running", startTime: now }, now) : "●";
}

/** The rows a call's own row runs on to under it: its second row, when it drew one. */
const rowsBelow = new WeakMap<object, number>();

/** Which of this tool's clickable rows sits at `y`, if any. */
function hoverRowAt(tool: object, plan: ViewPlan, y: number | undefined): HoverRow | null {
  if (typeof y !== "number") return null;
  if (plan.header && y === 0) return "header";
  const row = plan.header ? y - 1 : y;
  return plan.line && row >= 0 && row <= (rowsBelow.get(tool) ?? 0) ? "row" : null;
}

/** `routeGroupedMouse` result meaning "not grouped: handle it as a plain box". */
export const NOT_GROUPED = Symbol("not grouped");

export interface MouseRouting {
  pinned: boolean;
  /** Run `fn` as pointer-driven (pi's box toggle must not read as ctrl+o). */
  asPointer<T>(fn: () => T): T;
  /** Hand the event to the full box, shifted by the gutter and header. */
  boxMouse(event: any, dx: number, dy: number): unknown;
}

/**
 * Clicks on a grouped tool. Only left clicks on our own rows are taken —
 * presses and drags fall through so text selection keeps working.
 */
export function routeGroupedMouse(tool: GroupedTool, event: any, routing: MouseRouting): unknown {
  const job = routing.pinned ? undefined : jobForTool(tool);
  const jobs = routing.pinned ? [] : jobsForTool(tool);
  const plan = planFor(tool, routing.pinned, runningJob(jobs) ?? job);
  if (!plan.header && !plan.gutter) return NOT_GROUPED;

  // pi-tui names buttons ("left"); accept the raw SGR code too.
  const click = event?.type === "click" && (event.button === "left" || event.button === 0);
  let y = event?.y;
  // A codemode body's fold labels: the script and the output open in place.
  const fold = codemodeFoldAt(codemodeSpans.get(tool), y);
  if (fold) return routeCodemodeFold(tool, event, fold.section);
  const nested = typeof y === "number" ? nestedRowSpans.get(tool)?.find((span) => y >= span.from && y <= span.to) : undefined;
  if (nested) {
    if (event?.type === "move" && hoverIsTracked()) {
      const row: HoverRow | null = y === nested.from ? `job:${nested.id}` : null;
      if (row) markHoverClaimed();
      if (setHover(row ? tool : null, row, tool.ui)) tool.ui?.requestRender?.();
    }
    if (click && y === nested.from) {
      toggleJobDetails(nested.id);
      setHover(null, null);
      tool.ui?.requestRender?.();
      return { handled: true };
    }
    // The log body is selectable text, not the enclosing script's expand switch.
    return undefined;
  }

  // Pointer motion: light up the row under it, but never consume the packet —
  // pi still needs it for drag-selection. Repaint only when the row changes.
  if (event?.type === "move") {
    if (!hoverIsTracked()) return undefined;
    markHoverClaimed();
    const row = hoverRowAt(tool, plan, y);
    const changed = setHover(row ? tool : null, row, tool.ui);
    if (changed) tool.ui?.requestRender?.();
    return undefined;
  }
  if (plan.header) {
    if (y === 0) {
      if (!click) return undefined;
      if (plan.header === "closed") openGroup(tool);
      else {
        closeGroupJobDetails(tool);
        for (const member of closeGroup(tool)) routing.asPointer(() => (member as GroupedTool).setExpanded(false));
      }
      // 行几何变了，上一帧的高亮不再对应原来那一行
      setHover(null, null);
      // 层级是跨组件的状态;pi 每帧都重渲染整个 transcript,请求一帧即可
      tool.ui?.requestRender?.();
      return { handled: true };
    }
    y -= 1;
  }
  if (plan.line) {
    if (y < 0 || y > (rowsBelow.get(tool) ?? 0) || !click) return undefined;
    // A row always means "this call's box" — also the running/failed row
    // under a folded header, which opens the group on the way.
    openGroup(tool);
    setHover(null, null);
    // 走 setExpanded 而不是直接改字段:pi 的 updateDisplay 才会重建盒子
    routing.asPointer(() => tool.setExpanded(true));
    tool.ui?.requestRender?.();
    return { handled: true };
  }
  // dy is one less than the row above the border: the box's own leading blank
  // row is dropped when it is drawn under the gutter.
  if (plan.full) return routing.boxMouse(event, boxIndent(tool, plan), (plan.header ? 1 : 0) - 1 + (rowsBelow.get(tool) ?? 0));
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary hooks
// ─────────────────────────────────────────────────────────────────────────────

const BOUNDARY_WRAPPER = Symbol.for("pi-toolbox:group-boundary");
/** This carrier's thinking was expanded by a click on its `🧠` row. */
const THOUGHT_OPEN = Symbol.for("pi-toolbox:thought-open");
const CARRIER_MOUSE = Symbol.for("pi-toolbox:carrier-mouse");
/**
 * Where this frame put the rows a click can land on. `null` = this frame drew
 * no carrier rows at all, so nothing here belongs to us — the record has to be
 * per frame because a component's role changes under it: an assistant step
 * streams as a carrier, then its text arrives and it becomes a boundary.
 */
const CARRIER_CLICK = Symbol.for("pi-toolbox:carrier-click");
type CarrierClickMap = { header: number | null; from: number; to: number };

/**
 * A carrier message inside an open group: one `🧠` row per thinking run. The
 * collapsed row is the whole point — the group header counts the runs, and the
 * rows are where the model's reasoning actually shows up in the transcript.
 *
 * Clicking a row expands *that message's* thinking: pi draws it (markdown, its
 * own colour) from `thinkingVisibilityOverrides`, the same switch pi's own
 * click uses, so the two can never disagree. pi's `hideThinkingBlock` setting
 * is deliberately ignored here: the row is the one behaviour, open or shut.
 */
function renderCarrier(component: any, width: number): BoundaryDraw {
  const message = component.lastMessage;
  const runs = thinkingRuns(message);
  const plan = carrierPlan(component, { ids: toolCallIds(message), runs });
  // The run count just changed and the summary line is drawn by someone else:
  // ask for the frame that catches it up.
  if (plan.counted) lastRenderer()?.requestRender?.();
  // A live run goes quiet on its own after its last token. By then pi may be
  // painting nothing at all, so the frame that drops the row is ours.
  if (plan.settlesIn !== undefined) scheduleSettle(component, plan.settlesIn);
  if (plan.plain) return "plain";
  const theme = getTheme();
  if (!theme || width <= GUTTER_CELLS + 8) return "plain";
  const icons = iconsEnabled();
  const thinkingColor = thinkingColorFor();
  installCarrierMouse(component);
  const lines: string[] = [];
  // Row indices of what this frame draws, in the component's own coordinates.
  // `from` is -1 while no thought row has been drawn: an empty range.
  const clickMap: CarrierClickMap = { header: null, from: -1, to: -1 };
  component[CARRIER_CLICK] = clickMap;
  if (plan.header) {
    const line = groupHeaderLine(
      component,
      plan.header,
      theme,
      width,
      icons,
      isRowHovered(component, "header"),
      Date.now(),
    );
    if (line !== undefined) {
      clickMap.header = lines.length;
      lines.push(line);
    }
  }
  if (!plan.rows) return { lines };
  const gutter = groupGutter(theme);
  const hovered = isRowHovered(component, "row");
  // `thinkingVisibilityOverrides` is pi's own per-run switch: false = shown, and
  // pi renders the markdown itself. We flip the same map, so its click and
  // ours can never disagree about what is open.
  const open = component[THOUGHT_OPEN] === true && component.thinkingVisibilityOverrides?.get?.(0) === false;
  if (component[THOUGHT_OPEN] && !open) {
    // pi's own click on the expanded text folded it again; follow it.
    component[THOUGHT_OPEN] = false;
  }
  // Folded, a live run is a sliding window: one row, newest words, so the group
  // says what it is working on without being opened. The animation lives on the
  // summary line, not here — and the window moves on a tick, not per frame.
  const now = Date.now();
  const align = groupAlign(component);
  // The text starts in the arguments' column (lead, icon, name, status and gap) and
  // stops short of the metrics the rows around it carry on the right.
  const metrics = 2 + (align.note > 0 ? align.note + 3 : 0) + align.duration;
  const context = GUTTER_CELLS + 1 + (icons ? 2 : 0) + align.name + 4 + metrics;
  const liveTexts = plan.live && !open ? liveRowText(component, runs, runs.map(() => width - context), now) : undefined;
  const firstRow = lines.length;
  // Settled rows are the same every frame, and a transcript holds hundreds. Handing
  // back the same array also lets the rail's own cache hit, which keys on it.
  const settled = !plan.live && !open && !hovered;
  const header = clickMap.header === null ? undefined : lines[clickMap.header];
  const cached = settled ? settledCarriers.get(component) : undefined;
  if (
    cached && cached.runs === runs && cached.width === width && cached.context === context && cached.header === header &&
    cached.theme === theme && cached.icons === icons && cached.thinkingColor === thinkingColor && cached.name === align.name
  ) {
    clickMap.from = firstRow;
    clickMap.to = cached.lines.length - 1;
    return { lines: cached.lines };
  }
  for (const index of runs.keys()) {
    const text = liveTexts?.[index] ?? settledRowText(runs, width - context)[index];
    // One still arriving or opened is what the reader is looking at, so it keeps its label and colour.
    const row = formatThoughtLine(text, theme, { icons, thinkingColor, align, quiet: !plan.live && !open });
    // Open: the row keeps its place and takes a tick, exactly like an opened
    // call — the reasoning hangs under it instead of replacing it.
    const line = open ? `${tickGutter(theme)}${withoutLead(row)}` : gutter + row;
    lines.push(hovered ? hoverBand(line, width, theme) : clipToWidth(line, width, "…"));
  }
  if (open) {
    const body = trimBlankEdges(renderThinkingBody(component, iconBodyWidth(width)));
    for (const line of body) lines.push(`${gutter}${BODY_PAD}${theme.fg("thinkingText", line)}`);
  }
  clickMap.from = firstRow;
  clickMap.to = lines.length - 1;
  if (settled) settledCarriers.set(component, { runs, width, context, header, theme, icons, thinkingColor, name: align.name, lines });
  return { lines };
}

/** The last settled rows of a carrier, with everything they were drawn from. */
const settledCarriers = new WeakMap<object, {
  runs: readonly string[];
  width: number;
  context: number;
  header: string | undefined;
  theme: ThemeLike;
  icons: boolean;
  thinkingColor: ReturnType<typeof thinkingColorFor>;
  name: number;
  lines: string[];
}>();

/** The width an opened thinking run's text is laid out at, inside its indent. */
function iconBodyWidth(width: number): number {
  return Math.max(8, width - BODY_INDENT);
}

/**
 * pi's own rendering of the expanded run (markdown, its colours, code blocks) —
 * pulled through the message's thinking child rather than re-implemented.
 */function renderThinkingBody(component: any, width: number): string[] {
  const kids = component.contentContainer?.children;
  if (Array.isArray(kids)) {
    for (const kid of kids) if (kid instanceof MouseRegion) return kid.render(width) as string[];
  }
  return [];
}

/**
 * Clicks on a `🧠` row unfold that message's thinking; motion lights the row.
 * Both are ours to route — the component draws the rows itself, so nothing
 * below it is listening.
 *
 * Everything outside the rows this frame drew goes back to the handler that was
 * here before us. A component's role changes under it (a streaming step is a
 * carrier, the same object becomes a boundary when its text arrives), and a
 * handler that answered "row" to every `y` swallowed the whole message: any
 * click below the row opened the thinking instead of reaching the text.
 */
function installCarrierMouse(component: any): void {
  if (component[CARRIER_MOUSE]) return;
  component[CARRIER_MOUSE] = true;
  const previous = component.handleMouse;
  const pass = (event: any) => previous?.call(component, event);
  /** Where `y` sits in what this frame drew, or null when it is not ours. */
  const rowAt = (y: unknown): HoverRow | null => {
    const map = component[CARRIER_CLICK] as CarrierClickMap | null | undefined;
    if (!map || typeof y !== "number" || y < 0) return null;
    if (map.header !== null && y === map.header) return "header";
    return map.from >= 0 && y >= map.from && y <= map.to ? "row" : null;
  };
  component.handleMouse = (event: any) => {
    if (event?.type === "move") {
      if (!hoverIsTracked()) return pass(event);
      const row = rowAt(event.y);
      // Only a row claims the packet; the alt-screen hook drops the band when
      // nothing does, so motion across the rest of the message clears it.
      if (row) markHoverClaimed();
      if (setHover(row ? component : null, row, lastRenderer())) lastRenderer()?.requestRender?.();
      return pass(event);
    }
    if (event?.type !== "click" || (event.button !== "left" && event.button !== 0)) return pass(event);
    const theme = getTheme();
    if (!theme) return pass(event);
    const row = rowAt(event.y);
    if (!row) return pass(event);
    // Expanded, the run's box hangs under its row and the whole block is ours:
    // the frame was drawn by us, so the click that folds it back has to be too.
    // Only its own rows: the summary line is a second target on the same
    // component, and an expanded run beside it used to eat the header's click
    // (the group stayed open and the reasoning folded instead).
    const expanded = component[THOUGHT_OPEN] && component.thinkingVisibilityOverrides?.get?.(0) === false;
    if (expanded && row === "row") {
      const overrides = component.thinkingVisibilityOverrides;
      for (let i = 0; i < Math.max(1, thinkingRuns(component.lastMessage).length); i++) overrides?.set?.(i, true);
      component[THOUGHT_OPEN] = false;
      component.updateContent?.(component.lastMessage);
      component.invalidate?.();
      setHover(null, null);
      lastRenderer()?.requestRender?.();
      return { handled: true };
    }
    if (row === "header") {
      // Same toggle the first member's header does: shut folds every box inside.
      const { header } = carrierPlan(component);
      if (header === "closed") openGroup(component);
      else {
        closeGroupJobDetails(component);
        for (const member of closeGroup(component)) (member as GroupedTool).setExpanded(false);
      }
      setHover(null, null);
      lastRenderer()?.requestRender?.();
      return { handled: true };
    }
    const overrides = component.thinkingVisibilityOverrides;
    for (let i = 0; i < Math.max(1, thinkingRuns(component.lastMessage).length); i++) overrides?.set?.(i, false);
    component[THOUGHT_OPEN] = true;
    component.updateContent?.(component.lastMessage);
    component.invalidate?.();
    setHover(null, null);
    lastRenderer()?.requestRender?.();
    return { handled: true };
  };
}

type RenderFn = ((this: any, ...args: any[]) => string[]) & { [BOUNDARY_WRAPPER]?: true };

/** Whether grouping is on right now (the tool patch keeps this current). */
let groupingActive: () => boolean = () => true;

/** Whether Nerd Font icons are on (`icons: false` on a terminal without one). */
let iconsEnabled: () => boolean = () => true;
/** `tidy.thinkingColor`: the brain, the count and an expanded box border. */
let thinkingColorFor: () => string = () => "warning";

export function setGroupingActive(active: () => boolean): void {
  groupingActive = active;
}

export function setIconsEnabled(icons: () => boolean): void {
  iconsEnabled = icons;
}

export function setThinkingColor(color: () => string): void {
  thinkingColorFor = color;
}

/**
 * A live thinking row changes on a tick, not on every frame: pi repaints while
 * streaming, and a window recomputed per paint slides one cell per token, which
 * reads as flicker. The row keeps its last string until the tick expires.
 */
const liveRows = new Map<object, { at: number; texts: string[] }>();

/**
 * The preview for one live run, held steady between ticks. Text short enough to
 * fit is shown whole and never moves; only an overflowing run slides.
 */
function liveRowText(component: object, runs: readonly string[], budgets: number[], now: number): string[] {
  const cached = liveRows.get(component);
  if (cached && now - cached.at < THOUGHT_TICK_MS && cached.texts.length === runs.length) return cached.texts;
  const texts = runs.map((run, i) => previewText(run, budgets[i] ?? 0, true));
  liveRows.set(component, { at: now, texts });
  return texts;
}

/**
 * The settled preview of each run, at one budget. Flattening a run's whitespace
 * walks all of its text, and every message with thinking asks on every frame;
 * `thinkingRuns` hands back the same array until the text changes, so the
 * previews are kept against it.
 */
const settledRows = new WeakMap<readonly string[], { budget: number; texts: string[] }>();

function settledRowText(runs: readonly string[], budget: number): string[] {
  const cached = settledRows.get(runs);
  if (cached?.budget === budget) return cached.texts;
  const texts = runs.map((run) => previewText(run, budget));
  settledRows.set(runs, { budget, texts });
  return texts;
}

/**
 * What a boundary component draws this frame: `plain` trims pi's padding,
 * `untrimmed` preserves the render verbatim, `rethink` restyles its `Thinking...`
 * labels (see `restyleThinking`), `lines` are drawn verbatim, `hidden` draws
 * nothing.
 */
type BoundaryDraw = "hidden" | "plain" | "untrimmed" | "rethink" | { lines: string[] };

/** A box border costs two cells of its width. */
const BOX_CELLS = 2;

/**
 * pi draws thinking as a child component of the message: a one-line label while
 * it is hidden, the full markdown once it is shown, wrapped in a `MouseRegion`
 * so a click toggles it. That child is where our rows belong, so the message is
 * reassembled child by child: every other child keeps pi's own lines verbatim
 * (they carry the OSC 133 prompt markers), and each thinking child becomes a
 * `thinking` row — or, expanded, the same rounded box a tool result gets.
 *
 * A `MouseRegion` sits around the body, so a click on our row still reaches pi's
 * toggle: collapsed → expanded → collapsed. `hideThinkingBlock` is ignored: the
 * run starts hidden here no matter what pi's setting says, so the first click is
 * always "open it".
 */
/** The presentation tree from the last frame, not a second hit-test table. */
const MESSAGE_VIEW = Symbol.for("pi-toolbox:message-view");
const MESSAGE_MOUSE = Symbol.for("pi-toolbox:message-mouse");

/** Native child routing, with just one transform for the outer edge trim. */
class MessageView extends Container {
  private trimTop = 0;
  private rawHeight = 0;

  override render(width: number): string[] {
    const lines = super.render(width);
    const trimmed = trimMessageEdges(lines);
    this.trimTop = trimmed.top;
    this.rawHeight = lines.length;
    return trimmed.lines;
  }

  override handleMouse(event: TuiMouseEvent) {
    return super.handleMouse({ ...event, y: event.y + this.trimTop, height: this.rawHeight });
  }
}

function installMessageMouse(component: any): void {
  if (component[MESSAGE_MOUSE]) return;
  component[MESSAGE_MOUSE] = true;
  const previous = component.handleMouse;
  component.handleMouse = (event: TuiMouseEvent) => {
    const view = component[MESSAGE_VIEW] as MessageView | undefined;
    // An unhandled event belongs to selection/scrolling, not the old layout.
    return view ? view.handleMouse(event) : previous?.call(component, event);
  };
}

function restyleThinking(component: any, lines: string[] | undefined, width: number, rethink: boolean, hideThinking = false): string[] {
  const kids = component.contentContainer?.children;
  // If pi's structure changes, keep both its rendering and mouse routing intact.
  if (!Array.isArray(kids) || kids.length === 0) return lines ?? [];
  const theme = rethink ? getTheme() : undefined;
  const runs = thinkingRuns(component.lastMessage);
  const overrides = component.thinkingVisibilityOverrides as Map<number, boolean> | undefined;
  if (theme) {
    for (let i = 0; i < runs.length; i++) if (!overrides?.has?.(i)) overrides?.set?.(i, true);
  }

  const icons = iconsEnabled();
  const color = thinkingColorFor();
  // Keep the existing live preview/spinner; only its layout ownership changes.
  if (theme && runs.length > 0) noteThinking(component, runs);
  const thought = theme && runs.length > 0 ? thinkingState(component) : undefined;
  if (thought?.settlesIn !== undefined) scheduleSettle(component, thought.settlesIn);
  const budget = Math.max(1, width - THOUGHT_LABEL_CELLS - 1);
  const liveTexts = thought?.live ? liveRowText(component, runs, runs.map(() => budget), Date.now()) : undefined;
  const spinner = thought?.live ? thinkingSpinner(Date.now()) : undefined;
  const view = new MessageView();
  const hiddenMarkers: string[] | undefined = hideThinking ? [] : undefined;
  let cursor = 0;
  let run = 0;
  for (const kid of kids) {
    if (hideThinking && kid instanceof MouseRegion && run < runs.length) {
      run++;
      if (lines) {
        const count = (kid.render(width) as string[]).length;
        hiddenMarkers!.push(...(lines.slice(cursor, cursor + count).join("").match(ZONE_MARKERS) ?? []));
        cursor += count;
      }
      continue;
    }
    const own = kid.render(width) as string[];
    const taken = lines?.slice(cursor, cursor + own.length) ?? own;
    cursor += own.length;
    if (!theme || runs.length === 0 || !(kid instanceof MouseRegion)) {
      // Preserve pi's OSC markers without changing the child's geometry.
      // MouseRegion forwards to the actual child, retaining its capture/focus
      // target rather than making this presentation wrapper the target.
      const rows = taken.length === own.length ? taken : own;
      const region = new MouseRegion(kid, () => undefined);
      region.render = () => rows;
      view.addChild(region);
      continue;
    }
    const index = run++;
    const open = overrides?.get?.(index) === false;
    const body = open ? trimBlankEdges(kid.render(Math.max(4, width - BOX_CELLS)) as string[]) : [];
    let rows: string[];
    if (body.length > 0) {
      // Open, the box carries the label in its top border (`╭─ 󰧑 thinking ──╮`):
      // the row it opened from would only repeat the first words of the box.
      rows = drawFrame(body, width, theme, color);
      rows[0] = labeledTopBorder(width, theme, color, formatThoughtLabel(theme, { icons, thinkingColor: color, spinner }));
    } else {
      const text = liveTexts?.[index] ?? settledRowText(runs, Math.min(budget, THOUGHT_PREVIEW_CELLS))[index] ?? "";
      rows = [formatThoughtLine(text, theme, { icons, thinkingColor: color, spinner })];
    }
    // A final thinking block carries pi's end-of-message markers too.
    for (const marker of taken.join("").match(ZONE_MARKERS) ?? []) {
      if (marker === "\x1b]133;A\x07") rows[0] = marker + rows[0];
      else rows[rows.length - 1] += marker;
    }
    view.addChild(new MouseRegion({ render: () => rows, invalidate() {} }, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      // The title and its entire box are one native click region.
      overrides?.set?.(index, overrides?.get?.(index) === false);
      component.updateContent?.(component.lastMessage);
      component.invalidate?.();
      lastRenderer()?.requestRender?.();
      return { handled: true };
    }));
  }
  const tail = lines?.slice(cursor) ?? [];
  if (tail.length > 0) view.addChild({ render: () => tail, invalidate() {} });
  const rendered = view.render(width);
  if (!lines && rendered.length) {
    rendered[0] = "\x1b]133;A\x07" + rendered[0];
    rendered[rendered.length - 1] = "\x1b]133;B\x07\x1b]133;C\x07" + rendered[rendered.length - 1];
  }
  if (rendered.length && hiddenMarkers) for (const marker of hiddenMarkers) {
    if (marker === "\x1b]133;A\x07") rendered[0] = marker + rendered[0];
    else rendered[rendered.length - 1] += marker;
  }
  component[MESSAGE_VIEW] = view;
  installMessageMouse(component);
  return rendered;
}

/** A rendered row with every escape sequence gone: what the reader sees. */
const WITHOUT_ESCAPES = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;
/** pi's shell-integration zone markers, which ride on the rows we trim. */
const ZONE_MARKERS = /\x1b\]133;[ABC]\x07/g;

/**
 * Trim pi's padding rows off a message block, without dropping the OSC 133 zone
 * markers that sit on them: the terminal uses those to place prompts, so they
 * move onto the rows that survive.
 */
function trimMessageEdges(lines: string[]): { lines: string[]; top: number } {
  const blank = (line: string | undefined) => (line ?? "").replace(WITHOUT_ESCAPES, "").trim() === "";
  let start = 0;
  let end = lines.length;
  while (start < end && blank(lines[start])) start++;
  while (end > start && blank(lines[end - 1])) end--;
  if (start === 0 && end === lines.length) return { lines, top: 0 };
  if (start === end) return { lines: [], top: start };
  const kept = lines.slice(start, end);
  const head = lines.slice(0, start).join("").match(ZONE_MARKERS) ?? [];
  const tail = lines.slice(end).join("").match(ZONE_MARKERS) ?? [];
  if (head.length > 0) kept[0] = head.join("") + kept[0];
  if (tail.length > 0) kept[kept.length - 1] = kept[kept.length - 1] + tail.join("");
  return { lines: kept, top: start };
}

/**
 * Wrap `proto.render` unless the outermost wrapper is already ours. `view`
 * decides per render: draw as usual, draw nothing, draw under the group
 * gutter (two cells narrower, `│` in front), or draw its own rows.
 */
function wrapBoundaryRender(
  proto: { render?: RenderFn } | undefined,
  view: (component: any, width: number) => BoundaryDraw,
  /** How it draws with grouping off; pi's own render when absent. */
  ungrouped?: BoundaryDraw,
): void {
  const render = proto?.render;
  if (typeof render !== "function" || render[BOUNDARY_WRAPPER]) return;
  const assistant = proto === AssistantMessageComponent.prototype;
  const wrapped: RenderFn = function (this: any, ...args: any[]) {
    // Reset before even the disabled path: old handlers survive /reload and
    // streaming carrier/boundary transitions, but their old layout must not.
    this[CARRIER_CLICK] = null;
    this[MESSAGE_VIEW] = undefined;
    const width = typeof args[0] === "number" ? args[0] : 80;
    // Rows drawn here are final, so they must leave room for the rail. One cell too
    // wide and pi cuts the row, closing colours included: a hover band then bleeds on.
    const room = assistant && messageOnRail(this) ? Math.max(1, width - TURN_RAIL_CELLS) : width;
    const how = groupingActive() ? view(this, room) : ungrouped && tidyEnabled.get() ? ungrouped : "untrimmed";
    const options = assistant ? turnOptions.get() : undefined;
    if (!options || (options.collapseTurns === "off" && !options.frameFinalReply)) {
      if (this[TURN_LAYOUT]) this[TURN_LAYOUT] = undefined;
      if (how === "hidden") return [];
      if (how === "untrimmed") return render.apply(this, args);
      if (typeof how === "object") return how.lines;
      // `plain` is a step whose call pi draws itself (an expanded pinned
      // edit) or a message with nothing to fold. Its thinking is still our
      // row: leaving it bare makes pi's `Thinking...` float over the box.
      return restyleThinking(this, render.apply(this, args), width, how === "rethink" || how === "plain");
    }
    const draw = (room: number, hideThinking = false) => {
      if (how === "hidden") return [];
      if (how === "untrimmed") return render.call(this, room, ...args.slice(1));
      if (typeof how === "object") return how.lines;
      // The same native view owns both rendering and mouse geometry.
      const turn = turnOptions.get().collapseTurns !== "off" ? turnFor(this.lastMessage) : undefined;
      const foldedTurn = !!turn && folded(turn);
      const skipThinking = hideThinking || (foldedTurn && Array.isArray(this.contentContainer?.children));
      return restyleThinking(this, skipThinking ? undefined : render.call(this, room, ...args.slice(1)), room, how === "rethink" || how === "plain", hideThinking || foldedTurn);
    };
    return presentTurn(this, width, draw);
  };
  wrapped[BOUNDARY_WRAPPER] = true;
  proto!.render = wrapped;
}

/**
 * Group boundaries are seen through the message components' render. These
 * wrappers must be the *outermost* layer: a restyle patch that never calls its
 * predecessor — tidy's own user-message rail, or another extension's patch
 * installed after tidy's — would hide a wrapper underneath it. Hence this runs
 * at patch time and again from the tool render, by which time every extension
 * has installed its patches.
 */
export function installGroupBoundaries(): void {
  wrapBoundaryRender((AssistantMessageComponent as any)?.prototype, (component, width) => {
    const role = classifyAssistant(component.lastMessage);
    if (role === "boundary") noteBoundary(component);
    else if (role === "carrier") return renderCarrier(component, width);
    // A step still streaming its thinking mid-segment is, almost always, a
    // carrier whose tool call hasn't arrived yet. Fold it with the group now
    // rather than flash `Thinking...` under the summary for a second; text,
    // if it comes, makes it a boundary and it shows. At a turn's start the
    // group is empty and the label stays as a sign of life.
    else if (component.isStreaming === true && currentGroupHasMembers()) {
      return renderCarrier(component, width);
    }
    // A plain step (no text, no call) was never a row of the group; if it was
    // counted while its thinking streamed, give the run back as well.
    else releaseCarrier(component);
    // A message with both thinking and text is the group *boundary*: its text
    // renders as pi draws it and its thinking stays pi's own label — but the
    // label is the same thing our rows are, so it wears the same format, right
    // above the text. It is not one of the group's rows, so it is not counted.
    return "rethink";
    // Grouping off there is nothing to fold a step into, but its thinking is
    // still tidy's row rather than a bare `Thinking...` floating over the box:
    // the row has nothing to do with folding calls.
  }, "rethink");
  wrapBoundaryRender((UserMessageComponent as any)?.prototype, (component) => {
    noteBoundary(component);
    return "untrimmed";
  });
  // A background job's notifications (`[process] "ticker" matched stdout:
  // READY`) say what a row already shows. The model still receives them —
  // this only skips drawing them, and the row they belong to carries the
  // matched line itself (see `jobNoteRows`). Turn folding does not change that:
  // the job's group is one click away, and a folded turn's summary counts them.
  // Everything else keeps its own edges: a custom message is pi's
  // `Box(1, 1, customMessageBg)` too, so the same trim that ate the user
  // message's padding was eating its inset as well.
  wrapBoundaryRender((CustomMessageComponent as any)?.prototype, (component) =>
    noteJobMessage(component.message) ? "hidden" : "untrimmed",
  );
}
