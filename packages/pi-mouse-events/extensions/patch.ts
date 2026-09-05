/**
 * The prototype patches — the one place Pi's renderer is touched.
 *
 * From 0.84 Pi hands extensions a Proxy over the live renderer and swaps the
 * renderer itself when the TUI mode changes, so patching the shared
 * `TuiAltScreen.prototype` (whose methods the renderer's own input listener
 * invokes through `this`) is the only way to see mouse events at all: the
 * alt-screen registers its viewport listener in its constructor, before any
 * extension can register an input listener, and consumes every mouse report
 * it parses.
 *
 * Two methods are wrapped, and nothing else:
 *
 * - `handleViewportInput` — mouse events are dispatched to components
 *   (`dispatch.ts`), then to registered handlers, then fall through to the
 *   original method, whose built-in scrollbar, selection, and viewport
 *   behavior runs exactly as before for anything nobody handled. Non-mouse
 *   data (every keystroke, focus reports) passes through untouched — this
 *   patch is invisible to the keyboard path.
 * - `copyActiveSelectionToClipboard` — registered handlers run first and may
 *   answer the copy themselves; otherwise the original method runs. Installed
 *   only when the method exists (pi-tui gained it in 0.84.3).
 *
 * The install is process-wide and idempotent: the extension never uninstalls
 * outside tests, so repeated session starts do not grow the wrapper chain.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  MOUSE_EVENT_CHANNEL,
  type CopyHandler,
  type CopyHandlerContext,
  type MouseDispatchEvent,
  type MouseHandler,
  type MouseHandlerRegistrationOptions,
} from "../api.ts";
import { dispatchMouseEvent } from "./dispatch.ts";
import { isPatchable, type MouseReceiver } from "./receiver.ts";
import { parseMouseEventWith } from "./parse.ts";

interface MouseHandlerEntry {
  id: number;
  priority: number;
  handler: MouseHandler;
}

interface CopyHandlerEntry {
  id: number;
  priority: number;
  handler: CopyHandler;
}

export interface MousePatchState {
  addMouseHandler(
    handler: MouseHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;
  addCopyHandler(
    handler: CopyHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;
  readonly copySlotAvailable: boolean;
  /** The renderer instance the wrappers last ran against, if any. */
  liveReceiver(): MouseReceiver | undefined;
  /**
   * Point the event-bus emission at `pi`. The patches are process-wide and
   * outlive any one session's extension runtime, while `pi.events` throws the
   * moment the session that produced it is replaced — the entry point calls
   * this with each new session's `pi` (pi re-runs extension factories on
   * every session replacement).
   */
  refreshBus(pi: ExtensionAPI): void;
}

export interface InstalledPatches {
  state: MousePatchState;
  dispose(): void;
}

interface PatchCore {
  readonly copySlotAvailable: boolean;
  mouseHandlers: MouseHandlerEntry[];
  copyHandlers: CopyHandlerEntry[];
  nextHandlerId: number;
}

function sorted<T extends { priority: number; id: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => b.priority - a.priority || a.id - b.id);
}

/**
 * Wrap `handleViewportInput` and, when present,
 * `copyActiveSelectionToClipboard` on the prototype. Returns undefined when
 * the input entry point itself cannot be replaced — there is no mouse
 * dispatch without it.
 */
export function installMousePatches(
  pi: ExtensionAPI,
  prototype: object,
): InstalledPatches | undefined {
  if (!isPatchable(prototype, "handleViewportInput")) {
    console.warn(
      "[pi-mouse-events] TuiAltScreen.prototype.handleViewportInput is missing or not " +
        "replaceable on this pi-tui build; mouse event dispatch is unavailable.",
    );
    return undefined;
  }
  const copyAvailable = isPatchable(
    prototype,
    "copyActiveSelectionToClipboard",
  );
  if (!copyAvailable) {
    console.warn(
      "[pi-mouse-events] TuiAltScreen.prototype.copyActiveSelectionToClipboard is missing " +
        "(pi-tui < 0.84.3?); the copy handler slot is unavailable this build.",
    );
  }

  const core: PatchCore = {
    copySlotAvailable: copyAvailable,
    mouseHandlers: [],
    copyHandlers: [],
    nextHandlerId: 0,
  };

  // The renderer instance the wrappers last ran against. `handleViewportInput`
  // sees every keystroke as well as every mouse report, so this is the live
  // `TuiAltScreen` from the first input of the session onward — the hook
  // render-time consumers (hints, footer metadata) need to read renderer
  // state without waiting for a mouse event.
  let live: MouseReceiver | undefined;

  // The event-bus handle for emission. pi invalidates a session's extension
  // runtime the moment that session is replaced — `pi.events.emit` on a stale
  // handle throws — and the patches here outlive sessions, so the handle is
  // refreshed by the entry point on every factory run (one per session).
  // Deliberately no guard: emission uses whatever handle is current, and a
  // throw is a real contract violation that propagates.
  let bus: ExtensionAPI | undefined = pi;

  const emit = (event: MouseDispatchEvent): void => {
    // The bus wraps handlers against throwing; emit is fire and forget.
    bus!.events.emit(MOUSE_EVENT_CHANNEL, event);
  };

  const target = prototype as Record<string, unknown>;

  // Hoisted so the dispose closure below can restore whichever wrappers were
  // installed: the copy wrapper only exists when its method did.
  let originalCopy:
    | ((this: unknown, ...args: unknown[]) => unknown)
    | undefined;
  let patchedCopy: ((this: unknown, ...args: unknown[]) => unknown) | undefined;

  const originalViewportInput = target.handleViewportInput as (
    this: unknown,
    data: string,
    ...rest: unknown[]
  ) => unknown;
  function patchedViewportInput(
    this: unknown,
    data: string,
    ...rest: unknown[]
  ): { consume: boolean } | undefined {
    const receiver = this as unknown as MouseReceiver;
    live = receiver;
    const event = parseMouseEventWith(receiver, data);
    if (!event) {
      // Keystrokes, focus reports, paste — nothing to do with the mouse.
      return Reflect.apply(originalViewportInput, this, [data, ...rest]) as
        | { consume: boolean }
        | undefined;
    }

    // 1) Components that opted in.
    const outcome = dispatchMouseEvent(receiver, event);
    let handled = outcome.handled;
    const dispatched = outcome.dispatched;

    // 2) Registered handlers, when no component took the event.
    if (!handled) {
      for (const entry of sorted(core.mouseHandlers)) {
        let result: { handled?: boolean } | undefined | void;
        try {
          result = entry.handler({
            event: { ...event, handled: false, dispatched: undefined },
            tui: receiver as unknown as TUI,
          });
        } catch (error) {
          console.error("[pi-mouse-events] mouse handler error:", error);
          continue;
        }
        if (result?.handled) {
          handled = true;
          break;
        }
      }
    }

    emit({ ...event, handled, dispatched });
    if (handled) return { consume: true };
    return Reflect.apply(originalViewportInput, this, [data, ...rest]) as
      | { consume: boolean }
      | undefined;
  }
  target.handleViewportInput = patchedViewportInput;

  if (copyAvailable) {
    originalCopy = target.copyActiveSelectionToClipboard as (
      this: unknown,
      ...args: unknown[]
    ) => unknown;
    patchedCopy = function patchedCopy(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      live = this as unknown as MouseReceiver;
      for (const entry of sorted(core.copyHandlers)) {
        let result: { handled?: boolean } | undefined | void;
        try {
          result = entry.handler({ tui: this as unknown as TUI });
        } catch (error) {
          console.error("[pi-mouse-events] copy handler error:", error);
          continue;
        }
        if (result?.handled) return true;
      }
      return Reflect.apply(originalCopy!, this, args);
    };
    target.copyActiveSelectionToClipboard = patchedCopy;
  }

  return {
    state: {
      copySlotAvailable: copyAvailable,
      liveReceiver() {
        return live;
      },
      refreshBus(next) {
        bus = next;
      },
      addMouseHandler(handler, options) {
        const id = core.nextHandlerId++;
        const entry: MouseHandlerEntry = {
          id,
          priority: options?.priority ?? 0,
          handler,
        };
        core.mouseHandlers.push(entry);
        return () => {
          core.mouseHandlers = core.mouseHandlers.filter(
            (candidate) => candidate !== entry,
          );
        };
      },
      addCopyHandler(handler, options) {
        const id = core.nextHandlerId++;
        const entry: CopyHandlerEntry = {
          id,
          priority: options?.priority ?? 0,
          handler,
        };
        core.copyHandlers.push(entry);
        return () => {
          core.copyHandlers = core.copyHandlers.filter(
            (candidate) => candidate !== entry,
          );
        };
      },
    },
    dispose() {
      // Test-only: restore the prototypes exactly as they were found.
      if (target.handleViewportInput === patchedViewportInput) {
        target.handleViewportInput = originalViewportInput;
      }
      if (
        patchedCopy &&
        target.copyActiveSelectionToClipboard === patchedCopy
      ) {
        target.copyActiveSelectionToClipboard = originalCopy;
      }
      core.mouseHandlers = [];
      core.copyHandlers = [];
      live = undefined;
      bus = undefined;
    },
  };
}
