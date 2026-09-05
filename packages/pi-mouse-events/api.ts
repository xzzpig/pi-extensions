/**
 * Public contract of the `pi-mouse-events` extension.
 *
 * This module is import-safe for any Pi extension: it has no runtime
 * dependencies, so loading it never pulls in Pi internals. Everything here is
 * either a type (erased at runtime), a constant, or `getMouseEventsApi()`,
 * which reads a process-global slot written by the extension once it is
 * loaded. Reading through `Symbol.for` — rather than importing the
 * extension's own modules — is what makes the API work across Pi's per
 * extension module isolation, where each extension gets a fresh copy of every
 * non-Pi package it imports.
 *
 * ## The onMouse hook
 *
 * Any component rendered by the fullscreen TUI — an overlay shown through
 * `ctx.ui.custom({ overlay: true })`, or a component docked in the layout
 * tree — may implement the optional `onMouse` method declared below. When a
 * mouse event (a wheel notch, a button press, a release, or a motion report)
 * arrives, the extension dispatches it *before* the built-in scrollbar,
 * selection, and viewport handling:
 *
 * 1. visible overlays, frontmost first, each overlay whose box contains the
 *    pointer;
 * 2. then the layout tree, the deepest box containing the pointer.
 *
 * Returning `{ handled: true }` consumes the event — the built-in handling
 * does not run for it. Returning anything else (or nothing) lets the event
 * fall through, first to the remaining candidates, then to the built-ins, so
 * a component that ignores a wheel notch leaves transcript scrolling intact.
 *
 * `row` and `col` on a dispatched event are relative to the component's own
 * box. For components inside a scrolled transcript that box is the *content*
 * box, so `row` is a content row, not a screen row — exactly what "which of
 * my lines was clicked" means for a scrollable component.
 *
 * ## The global event channel
 *
 * Every parsed mouse event is emitted on the shared extension event bus after
 * the dispatch decision is made, on the `MOUSE_EVENT_CHANNEL` channel:
 *
 * ```ts
 * export default function (pi: ExtensionAPI) {
 *   pi.events.on(MOUSE_EVENT_CHANNEL, (data) => {
 *     const event = data as MouseDispatchEvent;
 *   });
 * }
 * ```
 *
 * The bus payload is observability only — handlers cannot influence the
 * dispatch. To intercept events (consume them before the built-ins) or to
 * intercept selection copies, register a handler through
 * `getMouseEventsApi()`.
 *
 * Note that `pi.on(event, …)` cannot carry custom event names: the runner
 * only dispatches its built-in event set, which is why the bus channel is the
 * integration point.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** The shared event-bus channel every parsed mouse event is emitted on. */
export const MOUSE_EVENT_CHANNEL = "pi-mouse-events:mouse";

/**
 * A mouse event delivered to a component's `onMouse` handler (fullscreen TUI
 * only).
 *
 * Coordinates are 0-based: `x`/`y` are terminal screen coordinates, `row`/`col`
 * are relative to the component's own box (row 0 = the component's first
 * rendered line). `row`/`col` are present on dispatched events; the raw
 * screen-space event is what handlers and bus listeners see.
 */
export interface ComponentMouseEvent {
  /**
   * Raw SGR button code (bits: 0-1 button, 2 shift, 3 meta, 4 ctrl,
   * 5 motion, 6 wheel). Wheel events carry `64` (up) or `65` (down).
   */
  button: number;
  /** Terminal column (0-based). */
  x: number;
  /** Terminal row (0-based). */
  y: number;
  /** True for a button release (SGR "m"). */
  release: boolean;
  /** Wheel direction (-1 up, 1 down) when this is a wheel event. */
  wheel?: -1 | 1;
}

/** A dispatched mouse event: the screen-space event plus box-relative coordinates. */
export interface ComponentMouseEventWithTarget extends ComponentMouseEvent {
  /** Row relative to the receiving component's box (0 = first rendered line). */
  row: number;
  /** Column relative to the receiving component's box. */
  col: number;
}

export interface ComponentMouseEventResult {
  /**
   * True if the component or handler consumed the event. Handled events skip
   * the remaining candidates and the built-in scrollbar, selection, and
   * viewport-scroll handling.
   */
  handled: boolean;
}

/** Where a dispatched or hit-tested component was found. */
export type MouseTargetSource = "overlay" | "layout";

/**
 * A component under the pointer, as answered by `hitTest` or carried in a
 * dispatch payload. `row`/`col` are relative to the component's box (for
 * scrolled components, relative to the content box).
 */
export interface MouseTarget {
  readonly component: unknown;
  readonly row: number;
  readonly col: number;
  readonly source: MouseTargetSource;
}

/** The classification of a parsed mouse event, as carried on the bus. */
export type MouseEventKind = "wheel" | "down" | "up" | "motion";

/** The bus payload: the parsed event plus the outcome of the dispatch. */
export interface MouseDispatchEvent extends ComponentMouseEvent {
  readonly kind: MouseEventKind;
  /** True when a component or handler consumed the event. */
  readonly handled: boolean;
  /** The component that consumed the event, when one did. */
  readonly dispatched?: MouseTarget;
}

/** The argument of a registered mouse handler. */
export interface MouseHandlerContext {
  readonly event: MouseDispatchEvent;
  /**
   * The live fullscreen renderer the event dispatched into. Typed as `TUI`;
   * internals of `TuiAltScreen` (`currentLayout`, `wheelScrollLines`, …) are
   * reachable through a structural cast, exactly as pi-tui's own consumers
   * reach them.
   */
  readonly tui: TUI;
}

/** The argument of a registered copy handler. */
export interface CopyHandlerContext {
  /** The live fullscreen renderer the copy was requested from. */
  readonly tui: TUI;
}

export type MouseHandler = (context: MouseHandlerContext) => MouseHandlerResult;
export type CopyHandler = (context: CopyHandlerContext) => CopyHandlerResult;
export type MouseHandlerResult = ComponentMouseEventResult | undefined | void;
export type CopyHandlerResult = ComponentMouseEventResult | undefined | void;

export interface MouseHandlerRegistrationOptions {
  /**
   * Handlers with a higher priority run first; ties resolve by registration
   * order. Defaults to 0.
   */
  priority?: number;
}

/**
 * The runtime API the extension publishes once it is loaded.
 *
 * `v1` is the contract version: fields and methods below will not be removed
 * or reshaped within the same major version.
 */
export interface MouseEventsApi {
  readonly version: 1;
  readonly eventChannel: typeof MOUSE_EVENT_CHANNEL;

  /**
   * Register a handler that runs on every parsed mouse event after component
   * dispatch missed and before the built-in scrollbar, selection, and
   * viewport handling. Returning `{ handled: true }` consumes the event.
   */
  addMouseHandler(
    handler: MouseHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;

  /**
   * Register a handler in front of `TuiAltScreen.copyActiveSelectionToClipboard`
   * — the method Pi's copy key (default ctrl+x) reaches. Returning
   * `{ handled: true }` answers the copy yourself; anything else calls through.
   */
  addCopyHandler(
    handler: CopyHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;

  /**
   * The component under a screen cell, queried against the live renderer:
   * the frontmost visible overlay containing the point, else the deepest
   * layout box. Unlike dispatch, this does not require the component to
   * implement `onMouse`.
   */
  hitTest(tui: TUI, x: number, y: number): MouseTarget | undefined;

  /**
   * Parse a raw terminal input chunk into a mouse event, using the same SGR
   * and legacy X10 rules pi-tui applies. Returns undefined for everything
   * else, including keyboard data.
   */
  parseMouseEvent(data: string): MouseDispatchEvent | undefined;

  /** Whether `data` looks like an SGR or legacy X10 mouse report at all. */
  isMouseSequence(data: string): boolean;

  /**
   * Whether the copy slot is installed. It needs
   * `TuiAltScreen.prototype.copyActiveSelectionToClipboard`, which pi-tui
   * gained in 0.84.3 — on older builds `addCopyHandler` still registers, but
   * the handler is never invoked.
   */
  readonly copySlotAvailable: boolean;

  /**
   * The renderer instance the patches last ran against, or undefined before
   * the first viewport input of the session. The input wrapper sees every
   * keystroke as well as every mouse report, so this is the current
   * `TuiAltScreen` from the first input onward — the hook render-time
   * consumers (hints, footer metadata) need to read renderer state without
   * waiting for a mouse event. Inside a handler, prefer the per-event
   * `ctx.tui`, which is always current for that event.
   */
  liveReceiver(): TUI | undefined;

  /**
   * Point the event-bus emission at `pi`. The patches are process-wide and
   * outlive any one session's extension runtime, while `pi.events` starts
   * throwing the moment the session that produced it is replaced — so the
   * entry point calls this with every new session's `pi` (pi re-runs
   * extension factories on every session replacement). Lifecycle plumbing
   * for the entry point; consumers have no reason to call it.
   */
  refreshBus(pi: ExtensionAPI): void;
}

/** The process-global key the extension publishes its API under. */
export const MOUSE_EVENTS_API_KEY: unique symbol = Symbol.for(
  "pi-mouse-events.api.v1",
);

/**
 * The published API, or undefined when the extension is not loaded (or this
 * copy of the package predates the running one's contract). Safe to call at
 * any time; check `version` before relying on newer surface.
 */
export function getMouseEventsApi(): MouseEventsApi | undefined {
  return (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY] as
    | MouseEventsApi
    | undefined;
}

/**
 * The optional component hook this extension dispatches. Declared here so
 * consumers that import this module get it on every `Component`; the
 * dispatch itself duck-types, so the method works regardless of the
 * consumer's pi-tui types.
 */
declare module "@earendil-works/pi-tui" {
  interface Component {
    /**
     * Optional handler for mouse events on the component's own box
     * (fullscreen TUI only), dispatched before the built-in scrollbar,
     * selection, and viewport handling. Return `{ handled: true }` to
     * consume the event.
     */
    onMouse?(
      event: ComponentMouseEventWithTarget,
    ): ComponentMouseEventResult | undefined;
  }
}
