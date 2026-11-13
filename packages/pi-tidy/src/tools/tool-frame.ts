/**
 * Rounded transparent frames for *every* tool box.
 *
 * Re-registering tools with `renderShell: "self"` only reaches tools this
 * extension registers itself — tools owned by other extensions (MCP via
 * pi-mcp-adapter, subagents, …) keep pi's default filled-background shell,
 * and the extension API exposes no way to wrap another extension's renderers
 * (`getAllTools()` returns name/description/parameters only).
 *
 * So the frame is applied one level lower, on ToolExecutionComponent — the
 * component pi builds for every tool call regardless of who registered it.
 * Extensions import the same live module instance as the host app, so
 * patching the prototype reaches every tool box in the session.
 *
 * The patches are installed once and read their options from a global slot,
 * so a `/reload` with new settings reaches them (see live.ts).
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Box, Container, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { blankEdges, drawFrame, labeledTopBorder, outsideHyperlink, removeLeadingWord, sameLines, stripBackgroundFills, trimTrailingSpaces, visibleIndexOf, visibleText } from "../draw/frame-draw.ts";
import {
  composeCodemodeBody,
  codemodeSections,
  decorateCodemodeBody,
  type CodemodeBodyOptions,
  type CodemodeToggle,
  type ComposedCodemodeBody,
} from "./codemode-body.ts";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { clipToWidth } from "../draw/frame-draw.ts";
import { fileIcon, PATH_ARG_TOOLS, toolKindIcon } from "../draw/icons.ts";
import { closeJobDetails, jobsForTool, setJobOptions } from "./background-jobs.ts";
import { liveSlot, optionsRevision, tidyEnabled } from "../live.ts";
import { expandTurnForTool, hideTurnTool, railTurnTool } from "../turns/turn-state.ts";
import { joinBoxCorners, railRows, TURN_RAIL_BOX_CELLS, TURN_RAIL_CELLS } from "../turns/turn-view.ts";
import { renderSplitDiff } from "./split-diff.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";
import { pinnedJoints, noteSetExpanded, planFor, setGroupOpenDefault } from "./tool-groups.ts";
import { formatToolLine } from "./tool-lines.ts";
import {
  installGroupBoundaries,
  codemodeFoldAt,
  NOT_GROUPED,
  renderGroupedTool,
  routeCodemodeFold,
  routeGroupedMouse,
  setGroupingActive,
  setIconsEnabled,
  setThinkingColor,
  type CodemodeRowSpan,
  type GroupedTool,
} from "./tool-group-view.ts";
import { codemodeHover, claimHover, hoverBand, installHoverTracking, isRowHovered, requestHoverRender } from "../hover.ts";
import { canCopyText, copyText } from "../clipboard.ts";
import { COPIED_MS, chipLabels, chipWord, repaintChip } from "../turns/code-blocks.ts";

interface MouseTarget {
  render(width: number): string[];
  handleMouse?(event: unknown): unknown;
}

/**
 * Where the box's source rows sit in the framed output, so a click can be
 * translated back into the coordinates pi's own components expect.
 */
interface FrameGeometry {
  /** Output row of source row 0 (rows above it were trimmed padding). */
  top: number;
  /** Source rows rendered, and the width they were rendered at. */
  height: number;
  width: number;
  /** false when the frame was dropped (a body hanging under a group row): column 0 is the body. */
  bordered?: boolean;
}

interface ToolBoxInternals extends GroupedTool {
  __tidyTurnRendered?: boolean;
  hideComponent: boolean;
  toolName: string;
  result?: { isError: boolean; durationMs?: number; content?: unknown; details?: unknown };
  selfRenderContainer: MouseTarget;
  contentBox: MouseTarget;
  contentText: MouseTarget;
  /** The MouseRegion pi wraps around `contentText` (no renderer definition). */
  contentTextRegion?: MouseTarget;
  imageComponents: Array<{ render(width: number): string[] }>;
  imageSpacers: Array<{ render(width: number): string[] }>;
  /** The component pi wrapped around the call renderer's output (the edit Box). */
  callRendererComponent?: {
    preview?: { diff?: unknown; error?: unknown };
    children?: ReadonlyArray<{ render(width: number): string[] }>;
    /** A renderer that returns one component hands back its rows, not children. */
    render?(width: number): string[];
  };
  hasRendererDefinition(): boolean;
  getRenderShell(): "default" | "self";
  __frameCache?: {
    width: number;
    color: string;
    expanded: boolean;
    /** `optionsRevision()` when it was built: every option a frame reads, in one number. */
    revision: number;
    unframed: boolean;
    /** The framed codemode fold row wearing the hover band ("" for none). */
    hovered: string;
    raw: string[];
    out: string[];
    geometry: FrameGeometry;
  };
  __frameGeometry?: FrameGeometry;
  __railCells?: number;
  /** The chip label a file box draws, and the path it copies: set by the frame, measured below. */
  __pathChip?: string;
  __pathText?: string;
  /**
   * A file box's path chip, on the rows this component displays: where it is and what a
   * click copies. Measured there rather than on the frame's own rows, because a group
   * and a turn's rail put their cells in front of them.
   */
  __pathCopy?: { row: number; x: number; end: number; text: string };
  /** While the chip reads `copied`, after a click. */
  __pathCopyFlashUntil?: number;
  /** The split diff last built for this box, and what it was built from. */
  __splitCache?: {
    diff: string;
    width: number;
    maxLines: number | undefined;
    filePath: string | undefined;
    theme: ThemeLike;
    call: string[];
    value: { raw: string[]; bgRows: ReadonlySet<number> } | undefined;
  };
  /** Row indices of the codemode fold labels in the last framed body. */
  __codemodeToggles?: CodemodeToggle[];
  /** A framed codemode box's fold rows, in its own output rows; unset for every other box. */
  __codemodeFolds?: CodemodeRowSpan[];
  /** The last composed codemode body, and what it was composed from. */
  __codemodeComposed?: {
    body: string[];
    details: unknown;
    script: boolean;
    output: boolean;
    revision: number;
    width: number | undefined;
    hovered: string | undefined;
    sample: string;
    value: ComposedCodemodeBody;
  };
  /** The framed list built on the last composed body. */
  __codemodeList?: { composed: ComposedCodemodeBody; w: number; revision: number; value: { title: string; lines: string[]; toggles: CodemodeToggle[] } };
  /** The expanded rendering a framed codemode box composes from, and what it was built from. */
  __codemodeFull?: {
    args: unknown;
    result: unknown;
    isPartial: boolean;
    sample: string;
    body: Component | undefined;
  };
  /** pi's own fields, read to draw the body a second time at `expanded: true`. */
  toolDefinition?: {
    renderCall?(args: unknown, theme: unknown, context: unknown): Component;
    renderResult?(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
  };
  cwd?: string;
  outputPad?: number;
  argsComplete?: boolean;
}

export interface ToolFrameOptions {
  /** Prepend a Nerd Font icon (tool kind or target file type) to the call row. */
  icons?: boolean;
  /** Per-tool-name border color for successful executions (theme fg color names). */
  toolColors?: Record<string, string>;
  /**
   * Collapse each assistant segment's tool calls into one summary line
   * (`▸ 4 calls · bash×3 read×1`), expanding to one row per call, then to the
   * full box. Click a line to step down a level; `ctrl+o` still expands all.
   */
  groupTools?: boolean;
  /**
   * Start each new group open (`▾` header, one row per call) instead of folded
   * to its summary line; a click on the header or `ctrl+o` still folds it.
   */
  groupOpen?: boolean;
  /** Tools that never fold into a group (default edit/write: the diff is the point). */
  alwaysShowTools?: string[];
  /**
   * Track background jobs a call started (pi-processes): the row shows the
   * job's live state instead of the call's.
   */
  backgroundJobs?: boolean;
  /** Skip drawing a job's notification messages when its row shows the same. */
  hideJobNotifications?: boolean;
  /** Render the edit diff as two panes (old | new) when the box is wide enough. */
  splitDiff?: boolean;
  /** Box width below which the split falls back to pi's unified diff (default 72). */
  splitDiffMinWidth?: number;
  /** Diff rows shown while the box is collapsed (default 20; `0` shows none). */
  diffLines?: number;
  /** Theme color for thinking rows and the expanded thinking box (default `warning`). */
  thinkingColor?: string;
  /** Syntax-highlight bash commands on group rows. */
  highlightBash?: boolean;
  /** Rows a group's call may take: 2 lets one that does not fit go on to a second. */
  toolRowLines?: number;
}

interface ResolvedToolFrameOptions {
  icons: boolean;
  toolColors: Record<string, string>;
  groupTools: boolean;
  groupOpen: boolean;
  alwaysShow: Set<string>;
  splitDiff: boolean;
  splitDiffMinWidth: number;
  diffLines: number;
  thinkingColor: string;
  highlightBash: boolean;
  toolRowLines: number;
}

const toolOptions = liveSlot<ResolvedToolFrameOptions>("tool-frame-options", {
  icons: false,
  toolColors: {},
  groupTools: true,
  groupOpen: false,
  alwaysShow: new Set(["edit", "write"]),
  splitDiff: true,
  splitDiffMinWidth: 72,
  diffLines: 20,
  thinkingColor: "warning",
  highlightBash: true,
  toolRowLines: 1,
});

const grouping = () => tidyEnabled.get() && toolOptions.get().groupTools;

/** `$HOME` as `~`, the form a title shows its path in. */
function shortenPath(path: string): string {
  const home = homedir();
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * A file box's path chip, in its lit states: lit under the pointer, a tick for a moment
 * after a click. The rows are only copied when a state shows, so the frame cache still
 * holds what the box looks like at rest and an idle box costs one comparison.
 */
function withCopyChip(box: ToolBoxInternals, rows: string[], theme: ThemeLike): string[] {
  const copy = box.__pathCopy;
  const until = box.__pathCopyFlashUntil;
  const copied = until !== undefined && Date.now() < until;
  const hot = copy !== undefined && isRowHovered(box, "title");
  if (!copy || rows.length === 0 || (!copied && !hot)) return rows;
  const labels = chipLabels(toolOptions.get().icons);
  return repaintChip(rows, { row: copy.row, index: 0, x: copy.x, end: copy.end }, theme, copied ? labels.copied : labels.copy, hot);
}

/**
 * Where the chip landed on the rows the component displays. They carry the rail or the
 * group's gutter in front, and a pointer reports columns on the same rows, so this is
 * the only place the two agree.
 */
function measurePathChip(box: ToolBoxInternals, rows: readonly string[]): void {
  const chip = box.__pathChip;
  box.__pathCopy = undefined;
  if (!chip) return;
  for (let row = 0; row < rows.length; row++) {
    const plain = visibleText(rows[row]!);
    const at = plain.indexOf(chip);
    if (at < 0) continue;
    const x = visibleWidth(plain.slice(0, at));
    box.__pathCopy = { row, x, end: x + visibleWidth(chip), text: box.__pathText ?? "" };
    return;
  }
}

/** One frame of a box: its chip measured, and painted for the pointer or a copy. */
function finishBox(box: ToolBoxInternals, rows: string[], theme: ThemeLike): string[] {
  measurePathChip(box, rows);
  return withCopyChip(box, rows, theme);
}

/** A codemode box drawn in a frame of its own: grouping off, or codemode in `alwaysShowTools`. */
const framedCodemode = (tool: ToolBoxInternals) =>
  tidyEnabled.get() && (!toolOptions.get().groupTools || toolOptions.get().alwaysShow.has(tool.toolName));

/** The component pi routes a box's clicks through (its result MouseRegions live inside). */
function mouseTarget(tool: ToolBoxInternals): MouseTarget | undefined {
  if (!tool.hasRendererDefinition()) return tool.contentTextRegion;
  return tool.getRenderShell() === "self" ? tool.selfRenderContainer : tool.contentBox;
}

export function patchToolBoxFrames(options: ToolFrameOptions = {}): void {
  const {
    icons = false,
    toolColors = {},
    groupTools = true,
    groupOpen = false,
    alwaysShowTools = ["edit", "write"],
    backgroundJobs = true,
    hideJobNotifications = true,
    splitDiff = true,
    splitDiffMinWidth = 72,
    diffLines = 20,
    thinkingColor = "warning",
    highlightBash = true,
    toolRowLines = 1,
  } = options;
  toolOptions.set({
    icons,
    toolColors,
    groupTools,
    groupOpen,
    alwaysShow: new Set(alwaysShowTools),
    splitDiff,
    splitDiffMinWidth,
    diffLines,
    thinkingColor,
    highlightBash,
    toolRowLines,
  });
  setJobOptions({ enabled: backgroundJobs, hideNotifications: hideJobNotifications });
  // Value, not a closure: the patch runs again on `/reload`, which is what
  // pushes a changed `groupOpen` down to the grouping state machine.
  setGroupOpenDefault(groupOpen);

  const proto = ToolExecutionComponent.prototype as unknown as ToolBoxInternals & {
    render(width: number): string[];
    __toolboxFramed?: boolean;
  };
  if (proto.__toolboxFramed) return;
  proto.__toolboxFramed = true;

  const originalRender = proto.render;
  const anyProto = proto as unknown as Record<string, any>;
  const originalHandleMouse = anyProto.handleMouse;
  const originalSetExpanded = anyProto.setExpanded;

  setGroupingActive(grouping);
  setIconsEnabled(() => toolOptions.get().icons);
  setThinkingColor(() => toolOptions.get().thinkingColor);
  installGroupBoundaries();
  installHoverTracking();

  // >0 while pi's own mouse handling runs: its box click reaches setExpanded
  // from in here, ctrl+o's expand/collapse-all from anywhere else.
  let pointerDepth = 0;
  const asPointer = <T>(fn: () => T): T => {
    pointerDepth++;
    try {
      return fn();
    } finally {
      pointerDepth--;
    }
  };

  /**
   * A click on a file box's path chip copies the path, and the pointer over it gets the
   * hand instead of the box's expand switch. The chip's row and columns were measured on
   * these rows, so the event needs no translation — which is what makes it work under a
   * group's header row and on a turn's rail, where a click belongs to someone else.
   */
  function pathChipMouse(this: ToolBoxInternals, event: any): unknown {
    const copy = this.__pathCopy;
    if (!copy || typeof event?.x !== "number" || typeof event?.y !== "number") return undefined;
    const over = event.y === copy.row && event.x >= copy.x && event.x < copy.end;
    if (event.type === "move") {
      // Only a row of ours is given back: a move over the box's body may belong to a job
      // row inside it, and this runs before the group has had its say.
      if (!over && !isRowHovered(this, "title")) return undefined;
      if (claimHover(this, over ? "title" : null)) requestHoverRender();
      return over ? { handled: true } : undefined;
    }
    if (!over || event.type !== "click" || (event.button !== "left" && event.button !== 0)) return undefined;
    const until = Date.now() + COPIED_MS;
    this.__pathCopyFlashUntil = until;
    void copyText(copy.text).catch(() => {
      if (this.__pathCopyFlashUntil === until) this.__pathCopyFlashUntil = undefined;
    });
    setTimeout(() => {
      if (this.__pathCopyFlashUntil !== until) return;
      this.__pathCopyFlashUntil = undefined;
      requestHoverRender();
    }, COPIED_MS).unref?.();
    return { handled: true, render: true };
  }

  /**
   * A click on the framed box, translated into the source component's own
   * coordinates. pi's handler would measure the *unframed* layout (and, for
   * `renderShell: "self"` tools, read a height only its own render records),
   * so clicks landed on the wrong row or — for edit and MCP boxes — nowhere.
   */
  function boxMouse(this: ToolBoxInternals, event: any, dx = 0, dy = 0): unknown {
    // A framed codemode call list is tidy's own rows, not pi's layout: its fold
    // rows open their section, and every other cell is the box's expand switch.
    const folds = this.__codemodeFolds;
    if (folds) {
      const fold = codemodeFoldAt(folds, event?.y - dy);
      if (fold) return routeCodemodeFold(this, event, fold.section);
      const click = event?.type === "click" && (event.button === "left" || event.button === 0);
      if (!click) return undefined;
      asPointer(() => this.setExpanded(!this.expanded));
      return { handled: true };
    }
    const geometry = this.__frameGeometry;
    const target = mouseTarget(this);
    if (!geometry || typeof target?.handleMouse !== "function") {
      return asPointer(() => originalHandleMouse?.call(this, event));
    }
    const y = event.y - dy - geometry.top;
    if (y >= 0 && y < geometry.height) {
      // Column 0 of the source sits right of the left border — unless the frame
      // was dropped, in which case the body starts where the row does.
      const x = event.x - dx - (geometry.bordered === false ? 0 : 1);
      const handled = asPointer(() =>
        target.handleMouse!({ ...event, x, y, width: geometry.width, height: geometry.height }),
      );
      if (handled !== undefined) return handled;
    }
    // Nothing under the pointer took it. The rows we draw are not always rows
    // pi's own layout knows about: a split diff is painted here, so pi's
    // sub-components keep the height they had before the preview arrived (a
    // streamed frame leaves them at two or three rows), and an unframed body is
    // shifted by the gutter. Every cell of the box is the expand switch, so a
    // click that found no owner toggles it here instead of doing nothing.
    const click = event?.type === "click" && (event.button === "left" || event.button === 0);
    if (!click) return undefined;
    asPointer(() => this.setExpanded(!this.expanded));
    return { handled: true };
  }

  anyProto.handleMouse = function (this: ToolBoxInternals, event: any) {
    if (!tidyEnabled.get()) return originalHandleMouse?.call(this, event);
    if (hideTurnTool(this.toolCallId)) return undefined;
    // Before the rail is discounted and before a group gets its say: the chip is the one
    // cell range of the box that copies instead of opening, wherever the row came from.
    const chip = pathChipMouse.call(this, event);
    if (chip !== undefined) return chip;
    // Everything below measures from where the call starts, which is past the rail.
    if (railTurnTool(this.toolCallId) && typeof event?.x === "number") {
      const cells = this.__railCells ?? TURN_RAIL_CELLS;
      event = { ...event, x: Math.max(0, event.x - cells), width: event.width - cells };
    }
    if (grouping()) {
      const routed = routeGroupedMouse(this, event, {
        pinned: toolOptions.get().alwaysShow.has(this.toolName),
        asPointer,
        boxMouse: (shifted, dx, dy) => boxMouse.call(this, shifted, dx, dy),
      });
      if (routed !== NOT_GROUPED) return routed;
    }
    return boxMouse.call(this, event);
  };

  // ctrl+o 与 pi 自己的展开都走 setExpanded:先改层级,再让 pi 记自己的状态
  anyProto.setExpanded = function (this: ToolBoxInternals, expanded: boolean) {
    if (tidyEnabled.get() && pointerDepth === 0 && (this.__tidyTurnRendered || expanded)) {
      expandTurnForTool(this.toolCallId, expanded);
    }
    if (grouping()) {
      if (!expanded && pointerDepth === 0 && !toolOptions.get().alwaysShow.has(this.toolName)) {
        closeJobDetails(jobsForTool(this).map((job) => job.id));
      }
      noteSetExpanded(this, expanded, pointerDepth > 0);
    }
    // A framed codemode box draws its call list whatever pi's flag says (see
    // fullCodemodeBody), so what expanding opens there is the script and the
    // output: ctrl+o shows everything, and a click on the box does the same for
    // that one box. Its fold rows still open one section at a time.
    if (this.toolName === "codemode" && framedCodemode(this)) {
      const sections = codemodeSections(this);
      sections.script = expanded;
      sections.output = expanded;
    }
    return originalSetExpanded.call(this, expanded);
  };

  /**
 * Tools whose body is a diff worth splitting. pi's write box previews the new
 * file as highlighted source, not a diff, so it is not one of them.
 */
const SPLIT_DIFF_TOOLS = new Set(["edit"]);

/**
 * The files a result reports, in the shape pi uses for a mutation.
 *
 * A tool that wraps `edit` can take something other than `{ path }` — aft's
 * hashline mode takes `{ patch }` and names the files it touched in its result
 * instead — so a box cannot assume the call arguments carry one.
 */
function resultFiles(details: unknown): Array<{ path?: unknown; sourcePath?: unknown }> {
  const files = (details as { files?: unknown } | undefined)?.files;
  return Array.isArray(files) ? files.filter((file) => file && typeof file === "object") : [];
}

/**
 * The file a box is about: the call's own `path`, or the one its result reports.
 *
 * Reading the result is what makes the path chip, the file-type icon and the
 * shortened title work for a tool that supplies its own renderers: those skip
 * pi's edit renderer, and with it `args.path` and the `preview` it keeps state on.
 * A result names files relative to the working directory (`aft` reports the
 * patch's own path), so those are resolved here: the box shows an absolute path
 * everywhere else, and a relative one would neither line up with it nor be worth
 * copying.
 */
function targetPath(tool: { args?: unknown; result?: { details?: unknown }; cwd?: string }, toolName: string): string | undefined {
  if (!PATH_ARG_TOOLS.has(toolName)) return undefined;
  const path = (tool.args as { path?: unknown } | undefined)?.path;
  if (typeof path === "string" && path) return path;
  for (const file of resultFiles(tool.result?.details)) {
    for (const candidate of [file.path, file.sourcePath]) {
      if (typeof candidate !== "string" || !candidate) continue;
      return isAbsolute(candidate) ? candidate : resolve(tool.cwd ?? process.cwd(), candidate);
    }
  }
  return undefined;
}

/**
 * The unified diff an edit box can draw.
 *
 * pi's edit renderer serialises it onto its call component (`preview.diff`),
 * which is the only source while the edit is still streaming. Once the result
 * is in, `details.diff` carries the same string — and it is the only one a tool
 * with renderers of its own leaves behind. Undefined means "keep what pi drew":
 * a preview error, or nothing to draw yet.
 */
function editDiff(tool: { callRendererComponent?: { preview?: unknown }; result?: { details?: unknown } }): string | undefined {
  const preview = tool.callRendererComponent?.preview as { diff?: unknown; error?: unknown } | undefined;
  if (preview) {
    if ("error" in preview) return undefined;
    if (typeof preview.diff === "string" && preview.diff) return preview.diff;
  }
  const diff = (tool.result?.details as { diff?: unknown } | undefined)?.diff;
  return typeof diff === "string" && diff ? diff : undefined;
}

/**
 * Rebuild an edit box's rows as two panes.
 *
 * pi's edit renderer keeps the unified diff string on its call component
 * (`preview.diff`) and renders it with `renderDiff`; the coloured lines are not
 * reversible, so the panes are built from that string instead. Undefined means
 * "keep what pi drew": no preview yet (streaming), a preview error, a narrow
 * box, or a diff that cannot be laid out.
 */
function splitEditBody(
  tool: ToolBoxInternals,
  innerWidth: number,
  callWidth: number,
  theme: ThemeLike,
): { raw: string[]; bgRows: ReadonlySet<number> } | undefined {
  const { splitDiff, splitDiffMinWidth, diffLines } = toolOptions.get();
  if (!splitDiff || !SPLIT_DIFF_TOOLS.has(tool.toolName) || innerWidth < splitDiffMinWidth) return undefined;
  const component = tool.callRendererComponent;
  const preview = component?.preview;
  if (preview && "error" in preview) return undefined;
  const diff = editDiff(tool);
  if (!diff) return undefined;
  const filePath = targetPath(tool, tool.toolName);
  // Collapsed, the body is a window on the diff; `ctrl+o` draws all of it.
  const maxLines = tool.expanded ? undefined : diffLines;
  // Row 0 is the call row (`edit ~/x.ts`), which keeps pi's rendering so the
  // icon prefix and path shortening still apply; the body starts with its own
  // summary row (`↳ diff +1 -1 [...]`). pi's edit renderer keeps the row as the
  // first child of a container; a renderer that hands back one component (aft's
  // hashline `edit`) has no children, and its own first row is the call row.
  const child = component?.children?.[0];
  const call = child ? child.render(callWidth) : (component?.render?.(callWidth) ?? []).slice(0, 1);
  // pi renders the whole transcript every frame — every wheel tick, every
  // streamed token — so each edit box in the history comes through here each
  // time. Rebuilding (and re-highlighting) its panes is what made scrolling a
  // long session crawl; the panes only change with these inputs. getTheme()
  // returns the actual instance, which pi replaces on theme switches/reloads.
  // Compare it directly: different themes may share the same added-text colour.
  // Unlike the codemode path below, which renders components and compares coloured
  // body rows, this cache starts from an uncoloured diff, so it must track the theme.
  const cache = tool.__splitCache;
  if (
    cache &&
    cache.diff === diff &&
    cache.width === innerWidth &&
    cache.maxLines === maxLines &&
    cache.filePath === filePath &&
    cache.theme === theme &&
    sameLines(cache.call, call)
  ) {
    return cache.value;
  }
  const body = renderSplitDiff({ diff, width: innerWidth, theme, filePath, maxLines });
  const offset = call.length;
  const value = body
    ? { raw: [...call, ...body.lines], bgRows: new Set(body.bgRows.map((row) => row + offset)) }
    : undefined;
  tool.__splitCache = { diff, width: innerWidth, maxLines, filePath, theme, call, value };
  return value;
}

/**
 * A codemode box's body as pi draws it expanded, without expanding the box.
 *
 * Collapsed, pi's renderer keeps ten script lines, the last eight calls and five
 * output lines, so a call list folded from that would drop calls and miscount
 * both sections. The framed call list is composed from a second rendering by
 * the same renderers at `expanded: true`, with components and state of its own:
 * pi's box, and anything another renderer keeps on its state, are never touched.
 * `executionStarted: false` keeps pi's timer out of it (it would arm an interval
 * on that state); the timer row is dropped from the composed body anyway.
 */
function fullCodemodeBody(tool: ToolBoxInternals, width: number, theme: ThemeLike): string[] | undefined {
  const definition = tool.toolDefinition;
  if (typeof definition?.renderCall !== "function") return undefined;
  const sample = theme.fg("toolTitle", "x");
  let cache = tool.__codemodeFull;
  if (
    !cache ||
    cache.args !== tool.args ||
    cache.result !== tool.result ||
    cache.isPartial !== tool.isPartial ||
    cache.sample !== sample
  ) {
    const state = {};
    const context = {
      args: tool.args,
      toolCallId: tool.toolCallId,
      invalidate: () => {
        tool.__codemodeFull = undefined;
        tool.ui?.requestRender?.();
      },
      lastComponent: undefined,
      state,
      cwd: tool.cwd,
      executionStarted: false,
      argsComplete: tool.argsComplete,
      isPartial: tool.isPartial,
      expanded: true,
      showImages: false,
      isError: tool.result?.isError ?? false,
      durationMs: tool.isPartial ? undefined : tool.result?.durationMs,
      outputPad: tool.outputPad ?? 1,
    };
    let body: Component | undefined;
    try {
      // The same shell pi draws into, so the rows line up with what it would show.
      const shell = tool.getRenderShell() === "self" ? new Container() : new Box(tool.outputPad ?? 1, 1);
      shell.addChild(definition.renderCall(tool.args, theme, context));
      if (tool.result && typeof definition.renderResult === "function") {
        const { content, details } = tool.result;
        shell.addChild(definition.renderResult({ content, details }, { expanded: true, isPartial: tool.isPartial }, theme, context));
      }
      body = shell;
    } catch {
      body = undefined;
    }
    cache = { args: tool.args, result: tool.result, isPartial: tool.isPartial, sample, body };
    tool.__codemodeFull = cache;
  }
  return cache.body?.render(width);
}

/**
 * `composeCodemodeBody`, kept per box. Every framed codemode box in the history
 * is composed on every frame, and every grouped one once it is open (all of
 * them after ctrl+o); splitting a body walks the text of each of its rows.
 */
function composedCodemode(
  tool: ToolBoxInternals,
  body: string[],
  theme: ThemeLike,
  options: CodemodeBodyOptions,
): ComposedCodemodeBody {
  const state = codemodeSections(tool);
  const details = tool.result?.details;
  const sample = theme.fg("accent", "x");
  const revision = optionsRevision();
  const cache = tool.__codemodeComposed;
  if (
    cache &&
    cache.details === details &&
    cache.script === state.script &&
    cache.output === state.output &&
    cache.revision === revision &&
    cache.width === options.width &&
    cache.hovered === options.hovered &&
    cache.sample === sample &&
    sameLines(cache.body, body)
  ) {
    return cache.value;
  }
  const value = composeCodemodeBody(body, details, state, theme, options);
  tool.__codemodeComposed = {
    body,
    details,
    script: state.script,
    output: state.output,
    revision,
    width: options.width,
    hovered: options.hovered,
    sample,
    value,
  };
  return value;
}

/**
 * A framed codemode box as a call list: the row a group would show for it
 * (`✓ codemode bash×2 read×1 · 0.1s`) in place of pi's title, then the calls,
 * with the script and the output folded to one row each. The row is handed
 * back apart from the body: every other framed tool puts its title in the top
 * border, and this one had no title of its own to put there. Undefined keeps
 * pi's layout: no renderer to draw it again, or nothing to fold yet (the
 * script is still streaming, or the output cannot be told from the calls).
 */
function composeFramedCodemode(
  tool: ToolBoxInternals,
  w: number,
  theme: ThemeLike,
  icons: boolean,
): { title: string; lines: string[]; toggles: CodemodeToggle[] } | undefined {
  const width = w - 2;
  const body = fullCodemodeBody(tool, width, theme);
  if (!body) return undefined;
  // The rules and the title stop a cell short of the right border: pi's rows
  // keep a cell of padding there, as they do on the left.
  const composed = composedCodemode(tool, body, theme, { icons, width: width - 1, hovered: codemodeHover(tool) });
  if (composed.toggles.length === 0) return undefined;
  // The title reads the result, which the body was drawn from: a new result is
  // a new body, and so a new composition.
  const revision = optionsRevision();
  const cache = tool.__codemodeList;
  if (cache && cache.composed === composed && cache.w === w && cache.revision === revision) return cache.value;
  // The row goes into the top border, so it has to pay for the border's own
  // `╭─ ` and ` ─╮` cells before the body does: laid out at the full width it
  // would be clipped there, and the clip takes the duration first.
  const title = formatToolLine(tool, theme, { icons, width: Math.max(1, w - 6) });
  const value = { title, lines: composed.lines, toggles: composed.toggles };
  tool.__codemodeList = { composed, w, revision, value };
  return value;
}

/** The rounded box at width `w` (what pi would draw, reframed). */
  function frameBox(this: ToolBoxInternals, w: number, theme: ThemeLike, unframed = false): string[] {
    const { icons, toolColors } = toolOptions.get();
    const source = !this.hasRendererDefinition()
      ? this.contentText
      : this.getRenderShell() === "self"
        ? this.selfRenderContainer
        : this.contentBox;
    // The icon cells come off the call row's render width so nothing
    // truncates. Layout: ` <kind> <file> /tmp/x.ts` — the kind icon leads
    // (replacing the tool-name word, which is removed as redundant), the
    // file-type icon sits directly in front of the path (the same role
    // `$` plays for bash). When the path can't be located in the rendered
    // row, the file icon falls back into the prefix.
    let kindPrefix = "";
    let fileGlyph = "";
    let filePath = "";
    const pathArg = targetPath(this, this.toolName);
    // Read whether the icons are on or not: the path is also what the border's chip
    // copies, and that is not an icon.
    if (typeof pathArg === "string" && pathArg) filePath = pathArg;
    if (icons) {
      kindPrefix = ` ${toolKindIcon(this.toolName)} `;
      if (filePath) fileGlyph = fileIcon(filePath);
    }
    const iconCells = (kindPrefix ? visibleWidth(kindPrefix) : 0) + (fileGlyph ? visibleWidth(fileGlyph) + 1 : 0);
    const sourceWidth = w - 2 - iconCells;
    const split = splitEditBody(this, w - 2, sourceWidth, theme);
    // Inside a group a codemode body is a call list: the script and the output
    // fold to one row each (they open on click, see tool-group-view.ts), and
    // every row sits one rail deeper than the call it belongs to. In a frame of
    // its own it is the same list, under the row a group would show for it.
    const codemode = this.toolName === "codemode";
    const collapse = codemode && unframed;
    const listed = codemode && !unframed ? composeFramedCodemode(this, w, theme, icons) : undefined;
    const railCells = collapse ? 2 : 0;
    const codemodeRows: CodemodeToggle[] = [];
    let raw: string[];
    if (collapse) {
      const body = source.render(sourceWidth - railCells);
      const composed = composedCodemode(this, body, theme, {
        icons,
        width: sourceWidth - railCells,
        hovered: codemodeHover(this),
      });
      const rail = `${theme.fg("borderMuted", "│")} `;
      raw = composed.lines.map((line) => rail + line);
      codemodeRows.push(...composed.toggles);
    } else if (listed) {
      raw = listed.lines;
    } else {
      raw = codemode
        ? decorateCodemodeBody(split ? split.raw : source.render(sourceWidth), this.result?.details, { icons, width: sourceWidth })
        : split
          ? split.raw
          : source.render(sourceWidth);
    }
    this.__codemodeToggles = codemodeRows;
    // The framed list's fold rows, as rows of this box's output: the top border
    // is row 0 and the body starts under it, so every row is one deeper.
    this.__codemodeFolds = listed?.toggles.map((toggle) => ({ row: toggle.row + 1, section: toggle.section }));
    // An open fold row reads the same hovered or not; only the band tells.
    const hovered = listed ? (codemodeHover(this) ?? "") : "";

    // The whole returned array is cached, not just the framed body.
    // pi-powerline-footer's compositor re-renders the entire root on every
    // mouse packet while scrolling, so an unchanged box must cost a key
    // check and nothing more — no re-framing its lines.
    //
    // Border color tracks tool state, then per-tool identity: pending is
    // grey and error is red no matter what; a successful box takes its
    // tool's configured color, falling back to the theme accent.
    const color = this.isPartial ? "borderMuted" : this.result?.isError ? "error" : toolColors[this.toolName] || "accent";
    // Image boxes skip the cache entirely: the line key says nothing about
    // an image component being swapped in (kitty PNG conversion finishes
    // asynchronously and rebuilds them), so a hit would freeze the box on
    // its pre-conversion frame.
    const cacheable = this.imageComponents.length === 0;
    const revision = optionsRevision();
    const cache = this.__frameCache;
    if (
      cacheable &&
      cache &&
      cache.width === w &&
      cache.color === color &&
      cache.expanded === this.expanded &&
      cache.revision === revision &&
      cache.unframed === unframed &&
      cache.hovered === hovered &&
      sameLines(cache.raw, raw)
    ) {
      this.__frameGeometry = cache.geometry;
      return cache.out;
    }

    // pi's default shell pads content by one cell on every side; the frame
    // supplies the vertical part, so only the blank padding rows are dropped.
    // `Text` hands back its own cached array — never write into `raw`.
    const edges = blankEdges(raw);
    let content = edges.start === 0 && edges.end === raw.length ? raw : raw.slice(edges.start, edges.end);
    // The kind icon prefixes the call row that pi drew first. A composed codemode
    // body has no call row: its first row is the script's fold label, which the
    // row above already introduces, and prefixing it pushed that row off the
    // body's rail (issue #31 review).
    if (icons && content.length > 0 && !collapse && !listed) {
      let first = content[0];
      // The kind icon already names the tool — drop the redundant word.
      if (PATH_ARG_TOOLS.has(this.toolName)) {
        const stripped = removeLeadingWord(first, this.toolName);
        if (stripped !== first) first = stripped.replace(/^ +/, "");
      }
      let row = kindPrefix + first;
      if (fileGlyph) {
        // renderToolPath shortens $HOME to `~` in the display text — try
        // the raw path first, then its shortened form.
        const home = homedir();
        const candidates = filePath.startsWith(home) ? [filePath, `~${filePath.slice(home.length)}`] : [filePath];
        let at = -1;
        for (const candidate of candidates) {
          const idx = visibleIndexOf(row, candidate);
          if (idx >= 0) {
            at = outsideHyperlink(row, idx);
            break;
          }
        }
        row = at >= 0 ? row.slice(0, at) + fileGlyph + " " + row.slice(at) : kindPrefix + fileGlyph + " " + first;
      }
      content = [row, ...content.slice(1)];
    }
    // Unframed means the call row is already the row above it: the body is the
    // output, not the command again. The blank row that separated them goes too.
    // A composed codemode body has already dropped pi's call row, and its first
    // row is the script's fold label, which is the body's to keep.
    if (unframed && content.length > 0 && !collapse) {
      content = content.slice(1);
      const rest = blankEdges(content);
      content = rest.start === 0 && rest.end === content.length ? content : content.slice(rest.start, rest.end);
    }
    // A file tool's call row is a title (`󰛦 󰈔 path`), not body: the frame's top
    // border is where a title belongs. So is a framed codemode list's summary
    // row, which a group draws above the box — the same row, one line up. Only
    // framed boxes have a border; inside a group the row above already carries
    // the call.
    const pathTitle = !unframed && !collapse && !listed && PATH_ARG_TOOLS.has(this.toolName) && content.length > 1
      ? trimTrailingSpaces(stripBackgroundFills(content[0])).trim()
      : "";
    let titleShift = 0;
    if (pathTitle) {
      // The write preview puts a blank row between its title and the text;
      // the border already separates them, so the body never starts with one.
      let lead = 1;
      while (lead < content.length && !visibleText(content[lead]).trim()) lead++;
      content = content.slice(lead);
      titleShift = lead;
    }
    const title = pathTitle || (listed?.title.trim() ?? "");
    // The fold row under the pointer wears the hover band, inside the frame.
    let banded: ReadonlySet<number> | undefined;
    const bandRow = hovered ? listed?.toggles.find((toggle) => toggle.section === hovered)?.row : undefined;
    if (bandRow !== undefined && bandRow < content.length) {
      content = content.slice();
      content[bandRow] = hoverBand(content[bandRow]!, w - 2, theme);
      banded = new Set([bandRow]);
    }
    const drawn: string[] = [];
    this.__pathChip = undefined;
    if (content.length > 0) {
      // Split-diff rows carry their own tint, as does a hovered fold row;
      // everything else stays transparent.
      const splitBg = split && edges.start > 0
        ? new Set([...split.bgRows].map((row) => row - edges.start).filter((row) => row >= 0))
        : split?.bgRows;
      const bgRows = banded ?? (splitBg && titleShift
        ? new Set([...splitBg].map((row) => row - titleShift).filter((row) => row >= 0))
        : splitBg);
      const framed = drawFrame(content, w, theme, color, bgRows);
      // A border that names a file carries a chip: the path is the one thing a reader
      // wants out of a write or edit box, and dragging its border for it is not obvious.
      const chipText = pathTitle && filePath && canCopyText() ? chipLabels(icons).copy : "";
      const paintedChip = chipText ? chipWord(theme, chipText, false) : "";
      const label = chipText
        ? `${clipToWidth(title, Math.max(1, w - 6 - visibleWidth(chipText) - 1), "…")} ${paintedChip}`
        : clipToWidth(title, Math.max(1, w - 6), "…");
      if (title) framed[0] = labeledTopBorder(w, theme, color, label);
      // The chip is measured on the rows this component displays, not on this frame:
      // a group's header row and a turn's rail sit in front of it.
      this.__pathChip = chipText && visibleText(framed[0]!).includes(chipText) ? chipText : undefined;
      this.__pathText = chipText ? shortenPath(filePath) : undefined;
      // Unframed: the row above already carries the frame of reference (the
      // group rail), so only the body is drawn — borders dropped, cells kept.
      if (unframed) {
        // Borders dropped, cells kept: the body is the content columns only.
        for (const line of framed.slice(1, -1)) drawn.push(sliceByColumn(line, 1, Math.max(1, w - 2)));
      } else {
        for (const line of framed) drawn.push(line);
      }
    }
    // No leading spacer: the box butts against whatever came before it. pi
    // puts one there for its own unframed shell, which we replaced with the
    // frame — inside a transcript it just reads as a stray blank row.
    const out: string[] = drawn;
    // Output: [spacer, top border, content…, bottom border] — content row 0
    // is source row `edges.start`. Unframed drops the spacer and both borders,
    // so the body starts on the first line.
    const geometry: FrameGeometry = unframed
      ? { top: -(edges.start + 1), height: raw.length, width: sourceWidth - 2, bordered: false }
      : { top: 1 - edges.start - titleShift, height: raw.length, width: sourceWidth };
    this.__frameGeometry = content.length > 0 ? geometry : undefined;
    // Images stay outside the frame: their lines carry terminal graphics
    // payloads that padding/truncation would corrupt.
    for (let i = 0; i < this.imageComponents.length; i++) {
      const spacer = this.imageSpacers[i];
      if (spacer) for (const line of spacer.render(w)) out.push(line);
      const image = this.imageComponents[i];
      if (image) for (const line of image.render(w)) out.push(line);
    }

    if (out.length === 0) return [];
    if (cacheable) this.__frameCache = { width: w, color, expanded: this.expanded, revision, unframed, hovered, raw, out, geometry };
    return out;
  }

  proto.render = function (this: ToolBoxInternals, width: number): string[] {
    const theme = getTheme();
    if (!theme || !tidyEnabled.get()) {
      this.__frameGeometry = undefined;
      this.__pathChip = undefined;
      measurePathChip(this, []);
      return originalRender.call(this, width);
    }
    try {
      this.__tidyTurnRendered = true;
      if (this.hideComponent) {
        measurePathChip(this, []);
        return [];
      }
      if (hideTurnTool(this.toolCallId)) {
        // Carriers still register while the turn is folded. Its tools must
        // register too, especially the pinned boundaries that split groups.
        if (grouping()) planFor(this, toolOptions.get().alwaysShow.has(this.toolName));
        measurePathChip(this, []);
        return [];
      }
      const railed = railTurnTool(this.toolCallId);
      const w = Math.max(4, railed ? width - TURN_RAIL_CELLS : width);
      if (grouping()) {
        const { icons, alwaysShow, highlightBash, toolRowLines } = toolOptions.get();
        const grouped = renderGroupedTool(
          this,
          w,
          theme,
          { icons, pinned: alwaysShow.has(this.toolName), highlight: highlightBash, rowLines: toolRowLines },
          (boxWidth, unframed) => frameBox.call(this, boxWidth, theme, unframed),
        );
        if (grouped) {
          this.__railCells = TURN_RAIL_CELLS;
          return finishBox(this, railed ? railRows(grouped, theme) : grouped, theme);
        }
      }
      if (!railed) return finishBox(this, frameBox.call(this, w, theme), theme);
      this.__railCells = TURN_RAIL_BOX_CELLS;
      const box = frameBox.call(this, Math.max(4, width - TURN_RAIL_BOX_CELLS), theme);
      // On the rail a box's corner sits in its neighbouring groups' rail column. With
      // grouping off nothing has registered, so there is nothing to meet.
      const { above, below } = pinnedJoints(this);
      return finishBox(this, railRows(joinBoxCorners(box, above, below), theme, " "), theme);
    } catch {
      this.__frameGeometry = undefined;
      measurePathChip(this, []);
      return originalRender.call(this, width);
    }
  };
}
