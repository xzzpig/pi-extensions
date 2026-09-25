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
 * ## Component-level mouse handling
 *
 * Components handle their own mouse events through Pi's native
 * `Component.handleMouse` (pi-tui >= 0.85), which the fullscreen renderer
 * dispatches itself. This extension does not duplicate that path: it exists
 * for what `handleMouse` cannot reach — global handlers in front of Pi's
 * built-ins, the copy slot, the observation channel, and pointer queries.
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
 *
 * The bus reports what this extension's own handlers decided. Anything they
 * leave unconsumed continues into Pi's built-in handling (and, there, into
 * component-level `handleMouse` dispatch), which this extension does not
 * observe — so `handled: false` on the bus never means "nothing handled it".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** The shared event-bus channel every parsed mouse event is emitted on. */
export const MOUSE_EVENT_CHANNEL = "pi-mouse-events:mouse";

/**
 * A parsed mouse event, as handed to a registered handler or emitted on the
 * bus (fullscreen TUI only).
 *
 * Coordinates are 0-based terminal screen coordinates. A component's own
 * box-relative coordinates are what `hitTest` answers with; this event is
 * raw screen space.
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

export interface ComponentMouseEventResult {
  /**
   * True if the component or handler consumed the event. Handled events skip
   * the remaining candidates and the built-in scrollbar, selection, and
   * viewport-scroll handling.
   */
  handled: boolean;
}

/** Where a hit-tested component was found. */
export type MouseTargetSource = "overlay" | "layout";

/**
 * A component under the pointer, as answered by `hitTest`. `row`/`col` are
 * relative to the component's box (for scrolled components, relative to the
 * content box).
 */
export interface MouseTarget {
  readonly component: unknown;
  readonly row: number;
  readonly col: number;
  readonly source: MouseTargetSource;
}

/** The classification of a parsed mouse event, as carried on the bus. */
export type MouseEventKind = "wheel" | "down" | "up" | "motion";

/** The bus payload: the parsed event plus this extension's outcome. */
export interface MouseDispatchEvent extends ComponentMouseEvent {
  readonly kind: MouseEventKind;
  /**
   * True when one of this extension's handlers consumed the event, so Pi's
   * built-in handling never ran for it. `false` means only that no handler
   * claimed it — the built-ins may still have acted on it.
   */
  readonly handled: boolean;
}

/** The argument of a registered mouse handler. */
export interface MouseHandlerContext {
  readonly event: MouseDispatchEvent;
  /**
   * The live fullscreen renderer that parsed the event. Typed as `TUI`;
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
 * `v2` is the contract version: fields and methods below will not be removed
 * or reshaped within the same major version.
 *
 * v2 removed the component-side hook this package used to declare, along with
 * the payload field that named the component consuming an event:
 * component-level mouse handling is Pi's native `handleMouse`, and the bus
 * payload no longer names a consumption that no longer happens.
 */
export interface MouseEventsApi {
  readonly version: 2;
  readonly eventChannel: typeof MOUSE_EVENT_CHANNEL;

  /**
   * Register a handler that runs on every parsed mouse event, before the
   * built-in scrollbar, selection, and viewport handling. Returning
   * `{ handled: true }` consumes the event: the built-ins do not run for it.
   * Returning anything else lets the event continue to the remaining
   * handlers and then through to the built-ins unchanged.
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
   * layout box. The answer is whatever is there — no method on the component
   * is required.
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

/**
 * The process-global key the extension publishes its API under. The version
 * in the key names the shape, not compatibility with the previous key: a
 * consumer that imports an older copy of this package reads the old key and
 * gets `undefined`, which its own `version` check turns into "unavailable".
 */
export const MOUSE_EVENTS_API_KEY: unique symbol = Symbol.for(
  "pi-mouse-events.api.v2",
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
