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
 * Input, wheel and copy methods are wrapped when available, plus an optional
 * selection-render workaround:
 *
 * - `handleViewportInput` — mouse events are parsed and handed to the
 *   registered handlers, then fall through to the original method, whose
 *   built-in scrollbar, selection, viewport, and component-level
 *   `handleMouse` behavior runs exactly as before for anything nobody
 *   handled. Non-mouse data (every keystroke, focus reports) passes through
 *   untouched — this patch is invisible to the keyboard path.
 *
 * A handler that consumes a *release* while the preceding press went
 * through to the built-ins leaves the renderer's own gesture and selection
 * state mid-gesture: the press branch is where Pi arms the state, and the
 * release branch — skipped because the event never reached it — is where Pi
 * clears it. The wrapper therefore restores that state after a consuming
 * release that did not consume its own press (see `restoreCoreGesture`).
 * - `copyActiveSelectionToClipboard` — registered handlers run first and may
 *   answer the copy themselves; otherwise the original method runs. Installed
 *   only when the method exists (pi-tui gained it in 0.84.3).
 * - `routeWheel` — when patchable, offer Pi's computed wheel delta to
 *   registered handlers before its default router, after native components.
 * - `applySelection` — when patchable, remove duplicate caret markers from
 *   rendered selection rows without changing any other content.
 *
 * The install is process-wide and idempotent: the extension never uninstalls
 * outside tests, so repeated session starts do not grow the wrapper chain.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MOUSE_EVENT_CHANNEL,
  type AsyncCopyHandler,
  type CopyHandler,
  type MouseDispatchEvent,
  type MouseHandler,
  type MouseHandlerRegistrationOptions,
  type PointerShape,
  type WheelHandler,
} from "../api.ts";
import { restoreCoreGesture } from "./restore.ts";
import {
  runAsyncCopyHandlersInPriorityOrder,
  runCopyHandlersInPriorityOrder,
  runMouseHandlersInPriorityOrder,
  runWheelHandlersInPriorityOrder,
} from "./test-support.ts";
import { isPatchable, type MouseReceiver } from "./receiver.ts";
import { parseMouseEventWith } from "./parse.ts";
import { createPointerController } from "./pointer.ts";
import { installSelectionMarkerDedupe } from "./selection-markers.ts";
import { wheelDispatchEvent } from "./wheel.ts";

interface MouseHandlerEntry {
  id: number;
  priority: number;
  handler: MouseHandler;
}

interface WheelHandlerEntry {
  id: number;
  priority: number;
  handler: WheelHandler;
}

type CopyHandlerEntry =
  | { id: number; priority: number; handler: CopyHandler; async: false }
  | { id: number; priority: number; handler: AsyncCopyHandler; async: true };

export interface MousePatchState {
  addMouseHandler(
    handler: MouseHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;
  addWheelHandler(
    handler: WheelHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;
  addCopyHandler(
    handler: CopyHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;
  addAsyncCopyHandler(
    handler: AsyncCopyHandler,
    options?: MouseHandlerRegistrationOptions,
  ): () => void;
  readonly copySlotAvailable: boolean;
  readonly wheelSlotAvailable: boolean;
  requestPointerShape(shape: PointerShape): void;
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
  wheelHandlers: WheelHandlerEntry[];
  copyHandlers: CopyHandlerEntry[];
  nextHandlerId: number;
}

/**
 * Wrap `handleViewportInput` and, when present,
 * `copyActiveSelectionToClipboard` on the prototype. Returns undefined when
 * the input entry point itself cannot be replaced — there is no mouse
 * dispatch without it.
 */
export function installMousePatches<T extends object>(
  pi: ExtensionAPI,
  prototype: T,
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

  const wheelAvailable = isPatchable(prototype, "routeWheel");
  const core: PatchCore = {
    copySlotAvailable: copyAvailable,
    mouseHandlers: [],
    wheelHandlers: [],
    copyHandlers: [],
    nextHandlerId: 0,
  };
  const pointer = createPointerController();
  const onProcessExit = () => pointer.reset();
  process.once("exit", onProcessExit);
  const disposeSelection = installSelectionMarkerDedupe(
    prototype as { applySelection?: unknown },
  );

  // The renderer instance the wrappers last ran against. `handleViewportInput`
  // sees every keystroke as well as every mouse report, so this is the live
  // `TuiAltScreen` from the first input of the session onward — the hook
  // render-time consumers (hints, footer metadata) need to read renderer
  // state without waiting for a mouse event.
  let live: MouseReceiver | undefined;

  // Whether the press of the gesture in progress was consumed by a handler.
  // Written on each press, read on its release; a press that was never
  // parsed as one leaves the previous value, which only matters for a
  // release that follows no press at all.
  let consumedPress = false;

  // The event-bus handle for emission, plus whether pi has already refused it.
  // pi invalidates a session's extension runtime the moment that session is
  // replaced — `pi.events.emit` on a stale handle throws — and the patches
  // here outlive sessions, so the handle is refreshed by the entry point on
  // every factory run (one per session).
  let bus: ExtensionAPI | undefined = pi;
  let busInvalid = false;

  const emit = (event: MouseDispatchEvent): void => {
    // Session replacement leaves a window in which the previous runtime is
    // already invalidated while the replacement's factories have not run yet:
    // pi disposes the old session first and only then builds the new runtime,
    // which re-runs extension factories (`refreshBus`). This wrapper is
    // process-wide and the input path stays live throughout, so a mouse report
    // delivered in that window reached the dead handle — and because the call
    // sits inside an input callback, the throw surfaced as an
    // uncaughtException that terminated pi (a later event would fail the same
    // way, since nothing could clear the dead handle).
    //
    // No live bus exists to reach for in that window: the replacement session
    // has no runtime yet, and `refreshBus` runs before `session_start`. The
    // event is therefore dropped — it is observability, no consumer can act on
    // it before the next factory run, and dropping it keeps dispatch itself
    // intact: components and handlers have already run, and the built-in
    // fall-through is unaffected. A refusal is remembered rather than retried,
    // and an invalid handle is replaced by the next `refreshBus`.
    if (busInvalid || !bus) return;
    try {
      // The bus wraps handlers against throwing; emit is fire and forget.
      bus.events.emit(MOUSE_EVENT_CHANNEL, event);
    } catch {
      busInvalid = true;
    }
  };

  const target = prototype as Record<string, unknown>;

  // Hoisted so the dispose closure below can restore whichever wrappers were
  // installed: the copy wrapper only exists when its method did.
  let originalCopy:
    | ((this: unknown, ...args: unknown[]) => Promise<boolean>)
    | undefined;
  let patchedCopy:
    | ((this: unknown, ...args: unknown[]) => Promise<boolean> | boolean)
    | undefined;
  const originalWheel = wheelAvailable
    ? (target.routeWheel as (this: unknown, ...args: unknown[]) => void)
    : undefined;
  let patchedWheel: ((this: unknown, ...args: unknown[]) => void) | undefined;

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
    // SAFETY: the wrapper is installed on TuiAltScreen.prototype and is always
    // invoked as a method of a TuiAltScreen instance, so `this` is the
    // renderer whose state `MouseReceiver` describes.
    const receiver = this as unknown as MouseReceiver;
    live = receiver;
    const event = parseMouseEventWith(receiver, data);
    if (!event) {
      // Keystrokes, focus reports, paste — nothing to do with the mouse.
      // Forwarding to the method this wrapper replaced on a shared prototype:
      // a direct call or `.apply` would dispatch through a possibly shadowed
      // own `apply`, changing the semantics of every keystroke path.
      // pi-lens-ignore: no-reflect-apply
      return Reflect.apply(originalViewportInput, this, [data, ...rest]) as
        | { consume: boolean }
        | undefined;
    }

    // Registered handlers, and nothing else: a component's own mouse handling
    // is Pi's native `handleMouse`, dispatched by the built-in path this
    // wrapper falls through to when no handler consumes the event.
    //
    // The press/release pair is tracked because a consuming *release* whose
    // press went to the built-ins leaves Pi's own gesture and selection state
    // armed: arming happens in the press branch, clearing in the release
    // branch, and the consuming release never reaches the latter. A press
    // this extension consumed armed nothing, and an unhandled release is
    // cleared by the built-ins itself, so only the mixed case is restored.
    return pointer.dispatch(event, receiver, () => {
      const handled = runMouseHandlersInPriorityOrder(
        core.mouseHandlers,
        event,
        receiver,
      );
      const pressWasConsumed = consumedPress;
      if (!event.release) consumedPress = handled;

      emit({ ...event, handled });
      if (handled) {
        if (event.release && !pressWasConsumed) restoreCoreGesture(receiver);
        return { consume: true };
      }
      // pi-lens-ignore: no-reflect-apply
      return Reflect.apply(originalViewportInput, this, [data, ...rest]) as
        | { consume: boolean }
        | undefined;
    });
  }
  target.handleViewportInput = patchedViewportInput;

  if (originalWheel) {
    patchedWheel = function patchedWheel(
      this: unknown,
      ...args: unknown[]
    ): void {
      // SAFETY: routeWheel is called with the live TuiAltScreen receiver.
      const receiver = this as unknown as MouseReceiver;
      live = receiver;
      const event = wheelDispatchEvent(args[0]);
      const delta =
        typeof args[1] === "number" && Number.isFinite(args[1])
          ? args[1]
          : undefined;
      if (
        event &&
        runWheelHandlersInPriorityOrder(
          core.wheelHandlers,
          event,
          receiver,
          delta,
        )
      ) {
        receiver.requestRender?.();
        return undefined;
      }
      // pi-lens-ignore: no-reflect-apply
      return Reflect.apply(originalWheel, this, args);
    };
    target.routeWheel = patchedWheel;
  }

  if (copyAvailable) {
    originalCopy = target.copyActiveSelectionToClipboard as (
      this: unknown,
      ...args: unknown[]
    ) => Promise<boolean>;
    patchedCopy = function patchedCopy(
      this: unknown,
      ...args: unknown[]
    ): Promise<boolean> | boolean {
      // SAFETY: as above — copyActiveSelectionToClipboard is a TuiAltScreen
      // method, so `this` is the live renderer.
      live = this as unknown as MouseReceiver;
      if (core.copyHandlers.some((entry) => entry.async)) {
        return runAsyncCopyHandlersInPriorityOrder(
          core.copyHandlers,
          this,
        ).then((handled) => {
          if (handled) return true;
          // pi-lens-ignore: no-reflect-apply
          return Reflect.apply(originalCopy!, this, args);
        });
      }
      const synchronous = core.copyHandlers.filter((entry) => !entry.async);
      if (runCopyHandlersInPriorityOrder(synchronous, this)) return true;
      // Preserve the original synchronous-handler dispatch and forward Pi's
      // own promise unchanged when no asynchronous handler is registered.
      // pi-lens-ignore: no-reflect-apply
      return Reflect.apply(originalCopy!, this, args);
    };
    target.copyActiveSelectionToClipboard = patchedCopy;
  }

  return {
    state: {
      copySlotAvailable: copyAvailable,
      wheelSlotAvailable: wheelAvailable,
      requestPointerShape(shape) {
        pointer.request(shape);
      },
      liveReceiver() {
        return live;
      },
      refreshBus(next) {
        pointer.reset();
        bus = next;
        busInvalid = false;
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
      addWheelHandler(handler, options) {
        const entry: WheelHandlerEntry = {
          id: core.nextHandlerId++,
          priority: options?.priority ?? 0,
          handler,
        };
        core.wheelHandlers.push(entry);
        return () => {
          core.wheelHandlers = core.wheelHandlers.filter(
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
          async: false,
        };
        core.copyHandlers.push(entry);
        return () => {
          core.copyHandlers = core.copyHandlers.filter(
            (candidate) => candidate !== entry,
          );
        };
      },
      addAsyncCopyHandler(handler, options) {
        const entry: CopyHandlerEntry = {
          id: core.nextHandlerId++,
          priority: options?.priority ?? 0,
          handler,
          async: true,
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
      process.removeListener("exit", onProcessExit);
      pointer.reset();
      disposeSelection?.();
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
      if (patchedWheel && target.routeWheel === patchedWheel) {
        target.routeWheel = originalWheel;
      }
      core.mouseHandlers = [];
      core.wheelHandlers = [];
      core.copyHandlers = [];
      live = undefined;
      bus = undefined;
      busInvalid = false;
    },
  };
}
