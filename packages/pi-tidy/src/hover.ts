import { TuiAltScreen } from "@earendil-works/pi-tui";
import type { CodemodeSection } from "./tools/codemode-body.ts";
import { padToWidth } from "./draw/frame-draw.ts";
import type { ThemeLike } from "./theme-access.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Hover
//
// `move` packets (1003 all-motion tracking, which pi enables outside tmux) are
// routed to the component under the pointer even with no button down, so a
// folded row can react to the pointer without a click. The row handler never
// consumes the event: pi still gets it for text selection, and the repaint is
// requested directly.
// ─────────────────────────────────────────────────────────────────────────────

export type HoverRow = "header" | "turn-header" | "row" | "title" | `job:${string}` | `codemode:${CodemodeSection}`;

/**
 * `ui` is kept as the object, not its `requestRender`: pi's TUI is a class, so
 * an extracted method would lose `this`.
 */
type Renderer = { requestRender?(): void };

/**
 * Last renderer a tool handed us. Carrier components have no `ui` of their own,
 * and a hovered row needs a repaint, so we borrow the neighbouring tool's.
 */
let lastUi: Renderer | undefined;

export function rememberRenderer(ui: Renderer): void {
  lastUi = ui;
}

export function lastRenderer(): Renderer | undefined {
  return lastUi;
}

let hoverState: { tool: object | null; row: HoverRow | null; ui?: Renderer } = { tool: null, row: null };
/** Set by a row that wants this packet; the alt-screen wrapper clears otherwise. */
let hoverClaimed = false;
/** Only tracked once the clear hook is in place — a stale band is worse than none. */
let hoverTracking = false;

export function hoverIsTracked(): boolean {
  return hoverTracking;
}

/** A row wants this packet, so the alt-screen wrapper must not clear the band. */
export function markHoverClaimed(): void {
  hoverClaimed = true;
}

/** Next render pass: which row of which tool the pointer is on, if any. */
export function setHover(tool: object | null, row: HoverRow | null, ui?: Renderer): boolean {
  if (hoverState.tool === tool && hoverState.row === row) {
    if (ui) hoverState.ui = ui;
    return false;
  }
  hoverState = { tool, row, ui: ui ?? hoverState.ui };
  return true;
}

/** The pointer left our rows (or the app): drop the band and repaint it away. */
function clearHover(): boolean {
  if (!hoverState.tool) return false;
  hoverState = { tool: null, row: null, ui: hoverState.ui };
  hoverState.ui?.requestRender?.();
  return true;
}

/** The alt screen that routes the packets: its renderer is the one that repaints. */
let hoverRenderer: { requestRender?(): void } | undefined;

/** Repaint after the pointer entered or left a row that is not a tool row. */
export function requestHoverRender(): void {
  lastUi?.requestRender?.();
  hoverRenderer?.requestRender?.();
}

/**
 * Turn rows share this state with the tool rows: one source for the band, the
 * hand and the clear-on-leave hook. Only claim while move tracking is live.
 */
export function claimHover(target: object | null, row: HoverRow | null): boolean {
  if (!hoverTracking) return false;
  if (row) hoverClaimed = true;
  return setHover(row ? target : null, row);
}

/** The row of this component the pointer is on, if any. */
export function hoveredRow(target: object): HoverRow | null {
  return hoverState.tool === target ? hoverState.row : null;
}

/** Whether the pointer is on this component's row, after the leave hook ran. */
export function isRowHovered(target: object, row: HoverRow): boolean {
  return hoverState.tool === target && hoverState.row === row;
}

/** A codemode body's fold row the pointer is on, if that is where it is. */
export function codemodeHover(tool: object): CodemodeSection | undefined {
  if (hoverState.tool !== tool) return undefined;
  const row = hoverState.row;
  return row?.startsWith("codemode:") ? (row.slice("codemode:".length) as CodemodeSection) : undefined;
}

/** A full-width band behind the row: the whole row is the click target. */
export function hoverBand(line: string, width: number, theme: ThemeLike): string {
  const padded = padToWidth(line, width);
  return theme.bg ? theme.bg("selectedBg", padded) : padded;
}

const HOVER_HOOK = Symbol.for("pi-toolbox:hover-hook");

/**
 * OSC 22, the pointer shape, in CSS's cursor names (Ghostty, kitty, foot,
 * WezTerm). A lit row is a click target, so it gets the hand. `default` is the
 * arrow a terminal shows while mouse tracking is on — the shape pi runs under —
 * so it is what the pointer goes back to. Terminals without OSC 22 ignore both.
 */
const POINTER_SHAPE = "\x1b]22;pointer\x1b\\";
const DEFAULT_SHAPE = "\x1b]22;default\x1b\\";
/** What the terminal was last told, so a move along the same row writes nothing. */
let pointerShown = false;

type TerminalLike = { write?(data: string): void } | undefined;

function syncPointer(terminal: TerminalLike, lit: boolean): void {
  if (lit === pointerShown || typeof terminal?.write !== "function") return;
  pointerShown = lit;
  terminal.write(lit ? POINTER_SHAPE : DEFAULT_SHAPE);
}

/**
 * Every mouse packet goes through the alt screen. Watching it is what makes
 * hover honest: a pointer that moves off our rows — onto the editor, a message,
 * the scrollbar — produces no event for us at all, so without this hook the
 * last row would stay lit forever. No hook, no hover.
 *
 * The pointer shape follows the band: a hand while a row is lit, the arrow
 * again once nothing is.
 */
export function installHoverTracking(): void {
  const proto = (TuiAltScreen as unknown as { prototype?: Record<PropertyKey, any> })?.prototype;
  if (!proto || proto[HOVER_HOOK]) return;
  const original = proto.handleMouseEvent;
  if (typeof original !== "function") return;
  proto.handleMouseEvent = function (this: { terminal?: TerminalLike; requestRender?(): void }, raw: unknown) {
    hoverRenderer = this;
    hoverClaimed = false;
    const result = original.call(this, raw);
    if (!hoverClaimed && clearHover()) requestHoverRender();
    syncPointer(this.terminal, hoverState.tool !== null);
    return result;
  };
  // Leaving the alt screen (exit, suspend, an external editor) must not leave
  // the hand behind. It goes first: once pi turns mouse tracking off, Ghostty
  // puts its own text cursor back, and an arrow written after that would stick.
  const stop = proto.beforeTerminalStop;
  if (typeof stop === "function") {
    proto.beforeTerminalStop = function (this: { terminal?: TerminalLike }, ...args: unknown[]) {
      syncPointer(this.terminal, false);
      return stop.apply(this, args);
    };
  }
  proto[HOVER_HOOK] = true;
  hoverTracking = true;
}

/** Test seam: pretend the packets are being watched. */
export function enableHoverForTests(): void {
  hoverTracking = true;
}

/** Test seam: pretend nothing is watching the packets. */
export function disableHoverForTests(): void {
  hoverTracking = false;
}

/** Test seam: forget what is hovered. */
export function resetHover(): void {
  hoverState = { tool: null, row: null };
  hoverClaimed = false;
  pointerShown = false;
}
