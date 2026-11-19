import type { Component, TUI } from "@earendil-works/pi-tui";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Box {
  component: Component;
  rect: Rect;
  clip: Rect;
  lineOffset?: number;
  children: Box[];
}
export interface HostDialogGeometry {
  rect: Rect;
  clip: Rect;
  lineOffset: number;
  available: number;
}

/** Pi's editor slot is commonly an ordinary Container, rendered as one leaf
 * layout box. Walk its cached child heights without rendering recursively. */
function childOffset(owner: Component, target: Component): number | undefined {
  if (owner === target) return 0;
  const container = owner as Component & {
    mouseLayout?: {
      children?: Array<{ component: Component; height: number }>;
    };
  };
  let offset = 0;
  for (const child of container.mouseLayout?.children ?? []) {
    const nested = childOffset(child.component, target);
    if (nested !== undefined) return offset + nested;
    offset += child.height;
  }
  return undefined;
}

/** Read-only fullscreen host snapshot; absent on older or regular-mode hosts. */
export function hostDialogGeometry(
  tui: TUI,
  component: Component,
): HostDialogGeometry | undefined {
  // SAFETY: optional host layout is read-only and may not be committed yet.
  const frame = (tui as unknown as { currentLayout?: { root?: Box } })
    .currentLayout;
  const pending: Array<{ box: Box; ancestors: Box[] }> = frame?.root
    ? [{ box: frame.root, ancestors: [] }]
    : [];
  while (pending.length) {
    const { box, ancestors } = pending.pop()!;
    const offset = childOffset(box.component, component);
    if (offset !== undefined) {
      // Do not use the dock's current clip as capacity: that clip depends on
      // the dialog's *previous* measured height and traps a grown terminal or
      // a return from the short feedback editor in its old tiny allocation.
      // Start at the root viewport, reserving fixed siblings and only the
      // minimum of growable siblings (the transcript can yield its space).
      let available = frame?.root?.clip.height ?? box.clip.height;
      const path = [...ancestors, box];
      for (let index = 0; index < path.length - 1; index++) {
        const parent = path[index]!;
        const child = path[index + 1]!;
        const stack = parent.component as Component & {
          layoutType?: string;
          entries?: Array<{
            component: Component;
            grow?: number;
            minSize?: number;
          }>;
        };
        if (stack.layoutType !== "vstack") continue;
        for (const sibling of parent.children ?? []) {
          if (
            sibling === child ||
            sibling.rect.x >= box.rect.x + box.rect.width ||
            sibling.rect.x + sibling.rect.width <= box.rect.x
          )
            continue;
          const entry = stack.entries?.find(
            (item) => item.component === sibling.component,
          );
          available -=
            (entry?.grow ?? 0) > 0
              ? (entry?.minSize ?? 0)
              : sibling.rect.height;
        }
      }
      const lineOffset = box.lineOffset ?? 0;
      const y = box.rect.y + offset - lineOffset;
      const rect = {
        ...box.rect,
        y,
        height: Math.max(0, box.rect.height - offset),
      };
      const top = Math.max(y, box.clip.y);
      const bottom = Math.min(y + rect.height, box.clip.y + box.clip.height);
      const clip = { ...box.clip, y: top, height: Math.max(0, bottom - top) };
      return {
        rect,
        clip,
        lineOffset,
        available: Math.max(0, available - offset),
      };
    }
    for (const child of box.children ?? [])
      pending.push({ box: child, ancestors: [...ancestors, box] });
  }
  return undefined;
}
