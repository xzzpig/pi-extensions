/**
 * Screen-space geometry for mouse hit-testing.
 *
 * Two trees hold components the pointer can land on: the overlay stack
 * (`TuiBase.overlayStack`, composited over the layout by `compositeOverlays`)
 * and the layout tree (`TuiAltScreen.currentLayout`, built by
 * `renderLayoutFrame`).
 *
 * ## Overlay geometry
 *
 * `compositeOverlays` does not record where it drew each overlay — it
 * recomputes per frame. Rather than wrap the render pass to copy that
 * geometry out (pi-tui's PR #8037 approach, which re-renders every overlay
 * every frame), geometry is resolved lazily here, on the mouse event that
 * needs it: the same `resolveOverlayLayout(options, 0, …)` → `render(width)`
 * → truncate to `maxHeight` → `resolveOverlayLayout(options, height, …)`
 * sequence the compositor runs, against the receiver's own resolver.
 *
 * The resulting row is already a screen row on 0.84.x: `compositeOverlays`
 * writes an overlay at composed index `viewportStart + row` and
 * `TuiAltScreen.doRender` drops the first `viewportStart` rows before
 * drawing, so the two cancel. (pi-tui's PR #8037 records
 * `viewportStart + row` because it must match the compositor's own bookkeeping
 * before that slice; the lazy path reads after it and needs the final answer.)
 *
 * ## Layout hit-testing
 *
 * Mirrors PR #8037's `getComponentMouseTarget`: a box is a candidate when the
 * point is inside its `rect` and — for boxes scrolled inside a transcript —
 * its screen-space `clip`; children are visited after their parent, so the
 * deepest candidate wins. `rect` of a box inside a scroll view is in content
 * coordinates (`y - scrollTop`), so `row`/`col` on the answer are relative to
 * the content box, which is what "which of my rows was clicked" means for a
 * scrollable component.
 */

import type {
  ComponentMouseEventResult,
  ComponentMouseEventWithTarget,
  MouseTarget,
} from "../api.ts";
import type {
  LayoutBoxLike,
  MouseReceiver,
  OverlayStackEntryLike,
} from "./receiver.ts";

/** A visible overlay and the screen rectangle it was last composited at. */
export interface OverlayGeometry {
  entry: OverlayStackEntryLike;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function containsPoint(
  rect: LayoutBoxLike["rect"],
  x: number,
  y: number,
): boolean {
  return (
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  );
}

function visibleEntries(receiver: MouseReceiver): OverlayStackEntryLike[] {
  const stack = receiver.overlayStack;
  if (!Array.isArray(stack) || stack.length === 0) return [];
  const entries = stack.filter((entry) => {
    try {
      return receiver.isOverlayVisible?.(entry) ?? entry.hidden !== true;
    } catch {
      return false;
    }
  });
  // compositeOverlays draws low `focusOrder` first, so frontmost = highest.
  entries.sort((a, b) => (b.focusOrder ?? 0) - (a.focusOrder ?? 0));
  return entries;
}

function resolveEntryGeometry(
  receiver: MouseReceiver,
  entry: OverlayStackEntryLike,
  termWidth: number,
  termHeight: number,
): OverlayGeometry | undefined {
  const first = receiver.resolveOverlayLayout?.(
    entry.options,
    0,
    termWidth,
    termHeight,
  );
  if (!first) return undefined;
  const width = first.width;
  if (typeof width !== "number" || width < 1) return undefined;
  let lines: readonly unknown[];
  try {
    const rendered = (
      entry.component as { render?: (w: number) => unknown }
    ).render?.(width);
    if (!Array.isArray(rendered)) return undefined;
    lines = rendered;
  } catch {
    // One overlay that cannot render must not take the whole dispatch down.
    return undefined;
  }
  const maxHeight = first.maxHeight;
  if (maxHeight !== undefined && lines.length > maxHeight)
    lines = lines.slice(0, maxHeight);
  const second = receiver.resolveOverlayLayout?.(
    entry.options,
    lines.length,
    termWidth,
    termHeight,
  );
  if (!second) return undefined;
  return { entry, x: second.col, y: second.row, width, height: lines.length };
}

/**
 * Screen rectangles of every visible overlay, frontmost first. Resolved
 * against the receiver's own layout resolver; an entry whose geometry cannot
 * be resolved is skipped rather than failing the rest.
 */
export function overlayGeometries(receiver: MouseReceiver): OverlayGeometry[] {
  const termWidth = receiver.terminal?.columns ?? 0;
  const termHeight = receiver.terminal?.rows ?? 0;
  if (termWidth < 1 || termHeight < 1) return [];
  const geometries: OverlayGeometry[] = [];
  for (const entry of visibleEntries(receiver)) {
    const geometry = resolveEntryGeometry(
      receiver,
      entry,
      termWidth,
      termHeight,
    );
    if (geometry) geometries.push(geometry);
  }
  return geometries;
}

export interface LayoutBoxTarget {
  component: object;
  row: number;
  col: number;
}

/**
 * The deepest layout box containing `(x, y)` whose component satisfies
 * `predicate` (default: any component). Root first, children after, so the
 * last candidate standing is the innermost one.
 */
export function layoutBoxAt(
  root: LayoutBoxLike | undefined,
  x: number,
  y: number,
  predicate?: (component: unknown) => boolean,
): LayoutBoxTarget | undefined {
  if (!root) return undefined;
  let best: LayoutBoxTarget | undefined;
  const visit = (box: LayoutBoxLike): void => {
    if (!containsPoint(box.rect, x, y)) return;
    if (box.clip && !containsPoint(box.clip, x, y)) return;
    if (
      box.component &&
      typeof box.component === "object" &&
      predicate?.(box.component) !== false
    ) {
      best = {
        component: box.component,
        row: y - box.rect.y,
        col: x - box.rect.x,
      };
    }
    for (const child of box.children ?? []) visit(child);
  };
  visit(root);
  return best;
}

export function hasOnMouse(component: unknown): component is {
  onMouse: (
    event: ComponentMouseEventWithTarget,
  ) => ComponentMouseEventResult | undefined;
} {
  return (
    typeof component === "object" &&
    component !== null &&
    typeof (component as { onMouse?: unknown }).onMouse === "function"
  );
}

/**
 * `hitTest`'s answer: the frontmost visible overlay containing the point,
 * else the deepest layout box. Unlike the dispatch, no `onMouse` filter —
 * this answers "what is under the pointer", which is the question a consumer
 * asks before deciding anything of its own.
 */
export function hitTestReceiver(
  receiver: MouseReceiver,
  x: number,
  y: number,
): MouseTarget | undefined {
  for (const geometry of overlayGeometries(receiver)) {
    if (
      x >= geometry.x &&
      x < geometry.x + geometry.width &&
      y >= geometry.y &&
      y < geometry.y + geometry.height
    ) {
      return {
        component: geometry.entry.component,
        row: y - geometry.y,
        col: x - geometry.x,
        source: "overlay",
      };
    }
  }
  const target = layoutBoxAt(receiver.currentLayout?.root, x, y);
  if (!target) return undefined;
  return {
    component: target.component,
    row: target.row,
    col: target.col,
    source: "layout",
  };
}
