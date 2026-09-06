/**
 * Resolve which assistant message a mouse click landed on, and whether the
 * clicked row is inside its thinking region.
 *
 * Pi's layout tree knows every component's rectangle, but the transcript is
 * folded into a single scroll-view leaf box: message components extend
 * `Container`, which carries no `LAYOUT_NODE`, so `boxesAt` can never return
 * one of them. Ownership inside the transcript has to come from the
 * *component* tree — the same conclusion `pi-starline`'s `mouse/tool-box.ts`
 * reaches, and the same walk:
 *
 * `Container.render(width)` renders each child at the same width and
 * concatenates the results with no gap, so a child occupies rows
 * `[sum of preceding siblings' heights, + its own height)` of its parent's
 * output — provided the child's rendered lines appear **verbatim, in place**
 * in the parent's output at that offset. The walk checks that premise as it
 * descends, and stops at the first component where it breaks (for example
 * `AssistantMessageComponent` wraps its output in OSC 133 zones, so its own
 * children never verify — which is exactly right: the message is then the
 * component that drew those rows).
 *
 * The walk runs on a click, never per frame, and pi's `Text`/`Markdown`
 * cache their renders, so a repeat render is a cache probe.
 *
 * The layout half mirrors `pi-starline`'s `hit-test.ts`: find the innermost
 * scroll view under the pointer, read its content box (`rect.width` is the
 * width the content was rendered at; `rect.y` maps a screen row to a content
 * row), then walk from the content component.
 */

import type { CollapseController } from "./state.ts";
import type { AssistantMessageLike } from "./state.ts";

export type Rect = { x: number; y: number; width: number; height: number };

export type LayoutBox = {
  component?: unknown;
  rect: Rect;
  clip?: Rect;
  children?: readonly LayoutBox[];
  scrollView?: unknown;
  scrollContentLines?: readonly string[];
};

/** The slice of the fullscreen renderer this module reads. */
export type ReceiverLike = {
  currentLayout?: { root?: LayoutBox | undefined };
  hasOverlay?(): boolean;
};

type ComponentLike = {
  children?: readonly unknown[];
  render(width: number): readonly string[];
};

function rectContains(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  );
}

function visible(box: LayoutBox, x: number, y: number): boolean {
  if (!rectContains(box.rect, x, y)) return false;
  // A box scrolled partly out of its container draws nothing outside the
  // clip; a question asked in screen space must honour it.
  return box.clip ? rectContains(box.clip, x, y) : true;
}

/** Root first, innermost last. Empty when the point is outside the root. */
export function boxesAt(root: LayoutBox, x: number, y: number): LayoutBox[] {
  const path: LayoutBox[] = [];
  let current: LayoutBox | undefined = root;
  while (current && visible(current, x, y)) {
    path.push(current);
    current = current.children?.find((box) => visible(box, x, y));
  }
  return path;
}

/** The innermost scroll view whose box contains the screen cell. */
function scrollViewAt(
  root: LayoutBox,
  x: number,
  y: number,
): object | undefined {
  let found: unknown;
  for (const box of boxesAt(root, x, y)) {
    if (box.scrollView !== undefined) found = box.scrollView;
  }
  return typeof found === "object" && found !== null ? found : undefined;
}

/** The box holding a scroll view's content, or undefined. */
function scrollContentOrigin(
  root: LayoutBox | undefined,
  scrollView: unknown,
): LayoutBox | undefined {
  if (!root) return undefined;
  if (root.scrollView === scrollView) return root.children?.[0];
  for (const child of root.children ?? []) {
    const found = scrollContentOrigin(child, scrollView);
    if (found) return found;
  }
  return undefined;
}

function renderAt(child: unknown, width: number): readonly string[] {
  const candidate = child as Partial<ComponentLike> | null;
  return typeof candidate?.render === "function" ? candidate.render(width) : [];
}

function matchesAt(
  lines: readonly string[],
  offset: number,
  childLines: readonly string[],
): boolean {
  if (offset + childLines.length > lines.length) return false;
  for (let i = 0; i < childLines.length; i++) {
    if (lines[offset + i] !== childLines[i]) return false;
  }
  return true;
}

/** One component's own rows, as an interval of the walk root's output. */
export type RowSpan = {
  component: unknown;
  start: number;
  end: number;
};

/**
 * The path of components owning content `row`, root first, deepest last.
 * Stops descending where the concatenation premise fails.
 */
export function ownershipPath(
  root: unknown,
  width: number,
  lines: readonly string[],
  row: number,
): RowSpan[] {
  const path: RowSpan[] = [{ component: root, start: 0, end: lines.length }];
  walk(root, width, lines, row, path, 0);
  return path;
}

function walk(
  node: unknown,
  width: number,
  parentLines: readonly string[],
  row: number,
  path: RowSpan[],
  base: number,
): void {
  const candidate = node as Partial<ComponentLike> | null;
  const children = candidate?.children;
  if (!Array.isArray(children) || children.length === 0) return;
  let cursor = 0;
  for (const child of children) {
    const childLines = renderAt(child, width);
    if (childLines.length === 0) continue;
    if (!matchesAt(parentLines, cursor, childLines)) {
      // The parent is not a plain concatenator on this row — it owns the row.
      return;
    }
    if (row >= cursor && row < cursor + childLines.length) {
      path.push({
        component: child,
        start: base + cursor,
        end: base + cursor + childLines.length,
      });
      walk(child, width, childLines, row - cursor, path, base + cursor);
      return;
    }
    cursor += childLines.length;
  }
}

/** A patched message under the pointer, with the geometry to reason about it. */
export type ThinkingTarget = {
  component: AssistantMessageLike;
  /** Row of the click within the component's own output. */
  row: number;
  /** Width the transcript content is currently rendered at. */
  width: number;
};

/**
 * The patched assistant message component under screen cell (x, y), or
 * undefined. Resolved against the live layout on every call: a running tool
 * re-renders under the pointer, so the answer is only true of the frame on
 * screen at this instant.
 */
export function thinkingTargetAt(
  controller: CollapseController,
  receiver: ReceiverLike,
  x: number,
  y: number,
): ThinkingTarget | undefined {
  const root = receiver.currentLayout?.root;
  if (!root) return undefined;
  // Pi resolves no scroll view while an overlay is up, so neither does this:
  // a click on a dialog must not reach the transcript behind it.
  if (receiver.hasOverlay?.()) return undefined;
  const scrollView = scrollViewAt(root, x, y);
  if (scrollView === undefined) return undefined;
  const origin = scrollContentOrigin(root, scrollView);
  if (!origin || origin.rect.width <= 0) return undefined;
  const row = y - origin.rect.y;
  if (row < 0) return undefined;

  // Render the content root NOW rather than trusting the last frame's
  // captured lines: pi's components re-render with current state (for
  // example the collapsed label of a finished message), so stale lines can
  // diverge from what a re-render produces, and the walk's verbatim premise
  // would fail at the first such component. A fresh render makes every
  // child's lines consistent within this tick.
  const lines = renderAt(origin.component, origin.rect.width);
  if (lines.length === 0) return undefined;
  if (row >= lines.length) return undefined;

  const path = ownershipPath(origin.component, origin.rect.width, lines, row);
  for (const span of path) {
    if (!controller.isPatchedComponent(span.component)) continue;
    return {
      component: span.component as AssistantMessageLike,
      row: row - span.start,
      width: origin.rect.width,
    };
  }
  return undefined;
}

/**
 * Row intervals (within the component's own output) that belong to thinking
 * blocks, derived by rendering the recorded thinking children in place.
 */
export function thinkingRowIntervals(
  controller: CollapseController,
  component: AssistantMessageLike,
  width: number,
): Array<[number, number]> {
  const container = component.contentContainer;
  const children = container?.children;
  if (!Array.isArray(children)) return [];
  const thinking = new Set(controller.thinkingChildrenOf(component) ?? []);
  const intervals: Array<[number, number]> = [];
  let cursor = 0;
  for (const child of children) {
    const childLines = renderAt(child, width);
    if (!thinking.has(child)) {
      cursor += childLines.length;
      continue;
    }
    intervals.push([cursor, cursor + childLines.length]);
    cursor += childLines.length;
  }
  return intervals;
}
