/**
 * Component dispatch — the heart of the `onMouse` hook.
 *
 * Reproduces pi-tui PR #8037's dispatch order inside `handleViewportInput`,
 * before the built-in scrollbar, selection, and viewport handling:
 *
 * 1. visible overlays, frontmost first, using the geometry recorded by
 *    `geometry.ts`; an overlay that implements `onMouse` and handles the event
 *    consumes it; an overlay that implements it but declines lets the event
 *    continue to the next overlay and, past all of them, to the layout beneath;
 * 2. then the layout tree, the deepest box containing the pointer whose
 *    component opts into `onMouse`.
 *
 * One deliberate deviation, documented in the README: overlays are ordered by
 * `focusOrder` descending — the order `compositeOverlays` actually paints
 * them — rather than PR's stack-reversal, which diverges from the paint order
 * once an overlay has been re-focused.
 */

import type {
  ComponentMouseEventResult,
  ComponentMouseEventWithTarget,
  MouseDispatchEvent,
  MouseTarget,
} from "../api.ts";
import type { MouseReceiver } from "./receiver.ts";
import { hasOnMouse, layoutBoxAt, overlayGeometries } from "./geometry.ts";

export interface DispatchOutcome {
  handled: boolean;
  dispatched?: MouseTarget;
}

export function dispatchMouseEvent(
  receiver: MouseReceiver,
  event: MouseDispatchEvent,
): DispatchOutcome {
  for (const geometry of overlayGeometries(receiver)) {
    if (!hasOnMouse(geometry.entry.component)) continue;
    if (
      event.x < geometry.x ||
      event.x >= geometry.x + geometry.width ||
      event.y < geometry.y ||
      event.y >= geometry.y + geometry.height
    ) {
      continue;
    }
    const row = event.y - geometry.y;
    const col = event.x - geometry.x;
    const result = geometry.entry.component.onMouse({ ...event, row, col });
    if (result?.handled) {
      return {
        handled: true,
        dispatched: {
          component: geometry.entry.component,
          row,
          col,
          source: "overlay",
        },
      };
    }
  }

  const target = layoutBoxAt(
    receiver.currentLayout?.root,
    event.x,
    event.y,
    hasOnMouse,
  );
  if (target) {
    // The `hasOnMouse` predicate is what put this box here, so the method
    // exists even though the shared return type carries only `object`.
    const component = target.component as {
      onMouse: (
        event: ComponentMouseEventWithTarget,
      ) => ComponentMouseEventResult | undefined;
    };
    const result = component.onMouse({
      ...event,
      row: target.row,
      col: target.col,
    });
    if (result?.handled) {
      return {
        handled: true,
        dispatched: {
          component: target.component,
          row: target.row,
          col: target.col,
          source: "layout",
        },
      };
    }
  }
  return { handled: false };
}
