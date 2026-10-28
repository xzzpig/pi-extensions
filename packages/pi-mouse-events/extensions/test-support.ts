/**
 * Test support: the dispatch semantics the slot-based API promises, as pure
 * functions.
 *
 * `installMousePatches` wires these same loops into the patched
 * `handleViewportInput` / `copyActiveSelectionToClipboard`, so consumers (and
 * consumer-side test shims — e.g. pi-starline's) can pin the contract without
 * booting a patched TUI: registered handlers run in priority order (higher
 * first, ties by registration order), the first `{ handled: true }` consumes
 * and stops the chain, a throwing handler is skipped, and "none handled" falls
 * through to the built-in behavior.
 */

import type {
  AsyncCopyHandler,
  CopyHandler,
  MouseDispatchEvent,
  MouseHandler,
  WheelHandler,
} from "../api.ts";

export interface MouseHandlerEntryLike {
  id: number;
  priority: number;
  handler: MouseHandler;
}

export interface WheelHandlerEntryLike {
  id: number;
  priority: number;
  handler: WheelHandler;
}

export interface CopyHandlerEntryLike {
  id: number;
  priority: number;
  handler: CopyHandler;
}

export interface AsyncCopyHandlerEntryLike {
  id: number;
  priority: number;
  handler: AsyncCopyHandler;
}

function sorted<T extends { priority: number; id: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => b.priority - a.priority || a.id - b.id);
}

/**
 * Run registered mouse handlers in priority order. Returns whether any
 * handler consumed the event (`{ handled: true }`); the first consumer stops
 * the chain.
 */
export function runMouseHandlersInPriorityOrder(
  entries: readonly MouseHandlerEntryLike[],
  event: MouseDispatchEvent,
  tui: unknown,
): boolean {
  for (const entry of sorted(entries)) {
    let result: { handled?: boolean } | undefined | void;
    try {
      result = entry.handler({
        event: { ...event, handled: false },
        tui: tui as never,
      });
    } catch (error) {
      console.error("[pi-mouse-events] mouse handler error:", error);
      continue;
    }
    if (result?.handled) {
      return true;
    }
  }
  return false;
}

/** Run post-component wheel handlers in priority order. */
export function runWheelHandlersInPriorityOrder(
  entries: readonly WheelHandlerEntryLike[],
  event: MouseDispatchEvent,
  tui: unknown,
  wheelDelta?: number,
): boolean {
  for (const entry of sorted(entries)) {
    try {
      const result = entry.handler({
        event: { ...event, handled: false },
        tui: tui as never,
        wheelDelta,
      });
      if (result?.handled) return true;
    } catch (error) {
      console.error("[pi-mouse-events] wheel handler error:", error);
    }
  }
  return false;
}

/**
 * Run registered copy handlers in priority order. Returns whether any handler
 * answered the copy (`{ handled: true }`).
 */
export function runCopyHandlersInPriorityOrder(
  entries: readonly CopyHandlerEntryLike[],
  tui: unknown,
): boolean {
  for (const entry of sorted(entries)) {
    let result: { handled?: boolean } | undefined | void;
    try {
      result = entry.handler({ tui: tui as never });
    } catch (error) {
      console.error("[pi-mouse-events] copy handler error:", error);
      continue;
    }
    if (result?.handled) return true;
  }
  return false;
}

/** Run synchronous and asynchronous copy handlers in one priority order. */
export async function runAsyncCopyHandlersInPriorityOrder(
  entries: readonly AsyncCopyHandlerEntryLike[],
  tui: unknown,
): Promise<boolean> {
  for (const entry of sorted(entries)) {
    try {
      const result = await entry.handler({ tui: tui as never });
      if (result?.handled) return true;
    } catch (error) {
      console.error("[pi-mouse-events] copy handler error:", error);
    }
  }
  return false;
}
