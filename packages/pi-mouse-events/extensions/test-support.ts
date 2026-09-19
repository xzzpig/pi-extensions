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

import type { CopyHandler, MouseDispatchEvent, MouseHandler } from "../api.ts";
import { dispatchMouseEvent } from "./dispatch.ts";

export interface MouseHandlerEntryLike {
  id: number;
  priority: number;
  handler: MouseHandler;
}

export interface CopyHandlerEntryLike {
  id: number;
  priority: number;
  handler: CopyHandler;
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
        event: { ...event, handled: false, dispatched: undefined },
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

export { dispatchMouseEvent };
