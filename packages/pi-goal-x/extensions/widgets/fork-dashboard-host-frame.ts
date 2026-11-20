import type { Component, TUI } from "@earendil-works/pi-tui";
import { hostDialogGeometry } from "../fork-confirmation-host.ts";
import { dialogOverlayState } from "../fork-confirmation-tiny-host.ts";

export interface DashboardHostFrame {
  renderer: TUI;
  columns: number | undefined;
  rows: number | undefined;
  overlays: string;
}

export function dashboardHostFrame(
  tui: TUI,
  widget: Component,
): DashboardHostFrame {
  // Pi's dynamic TUI reference binds methods to the live renderer. The
  // inherited valueOf returns that receiver (and is a no-op on a direct TUI).
  const renderer = tui.valueOf() as TUI;
  const { signature } = dialogOverlayState(renderer, widget);
  // Bounds are populated during paint. Keep only visible overlay identity
  // and ordering so a paint alone cannot invalidate a fresh gesture.
  const overlays = Array.isArray(signature)
    ? signature.map(([id, focusOrder, _bounds, nonCapturing]) => [
        id,
        focusOrder,
        nonCapturing,
      ])
    : signature;
  return {
    renderer,
    columns: renderer.terminal?.columns,
    rows: renderer.terminal?.rows,
    overlays: JSON.stringify(overlays),
  };
}

export function sameDashboardHostFrame(
  a: DashboardHostFrame,
  b: DashboardHostFrame,
): boolean {
  return (
    a.renderer === b.renderer &&
    a.columns === b.columns &&
    a.rows === b.rows &&
    a.overlays === b.overlays
  );
}

/** Observe resize/overlays before paint, and the dock position after paint.
 * A sibling can move this widget without changing its rendered local rows. */
export function observeDashboardHostFrame(
  tui: TUI,
  widget: Component,
  onHostChange: () => void,
  onPlacementChange: () => void,
) {
  let previous: DashboardHostFrame | undefined;
  let previousPlacement: string | null | undefined;
  let detach: (() => void) | undefined;
  let disposed = false;
  const observePlacement = () => {
    const host = previous?.renderer;
    if (host?.mode !== "fullscreen") return;
    // Reuse the host's committed layout and Container child offsets; don't
    // remeasure the dock or infer placement from the rendered button text.
    const geometry = hostDialogGeometry(host, widget);
    const placement = geometry
      ? JSON.stringify([geometry.rect.x, geometry.rect.y, geometry.clip])
      : null;
    if (previousPlacement !== undefined && previousPlacement !== placement)
      onPlacementChange();
    previousPlacement = placement;
  };
  return {
    observePlacement,
    sync(): DashboardHostFrame {
      const frame = dashboardHostFrame(tui, widget);
      if (disposed || previous?.renderer === frame.renderer) return frame;
      detach?.();
      detach = undefined;
      if (previous) onHostChange();
      previous = frame;
      previousPlacement = undefined;
      if (frame.renderer.mode === "fullscreen") {
        detach = observeHostRender(
          frame.renderer,
          () => {
            const next = dashboardHostFrame(tui, widget);
            if (previous && !sameDashboardHostFrame(previous, next))
              onHostChange();
            // If Pi has switched renderers, let sync attach to the new one.
            if (next.renderer === frame.renderer) previous = next;
          },
          observePlacement,
        );
      }
      return frame;
    },
    dispose(): void {
      disposed = true;
      detach?.();
      detach = undefined;
      previous = undefined;
    },
  };
}

type RenderHost = {
  requestRender(force?: boolean): void;
  doRender?(): void;
};

function observeHostRender(
  host: RenderHost,
  beforeRequest: () => void,
  afterPaint: () => void,
): () => void {
  const stopRequest = observeRenderMethod(host, "requestRender", beforeRequest);
  const stopPaint = observeRenderMethod(
    host,
    "doRender",
    undefined,
    afterPaint,
  );
  return () => {
    stopPaint?.();
    stopRequest?.();
  };
}

function observeRenderMethod(
  host: RenderHost,
  key: keyof RenderHost,
  before?: () => void,
  after?: () => void,
): (() => void) | undefined {
  const original = host[key];
  if (typeof original !== "function") return undefined;
  const own = Object.getOwnPropertyDescriptor(host, key);
  const observe = function (this: RenderHost, force?: boolean): void {
    before?.();
    original.call(this, force);
    after?.();
  };
  host[key] = observe;
  return () => {
    before = after = undefined;
    // Another plugin may have stacked its own observer after this one.
    if (host[key] !== observe) return;
    if (own) Object.defineProperty(host, key, own);
    else Reflect.deleteProperty(host, key);
  };
}
