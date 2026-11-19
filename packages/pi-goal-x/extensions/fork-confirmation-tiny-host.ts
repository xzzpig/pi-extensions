import type { Component, TUI } from "@earendil-works/pi-tui";

interface OverlayEntry {
  component: Component;
  options?: { nonCapturing?: boolean };
  bounds?: { row: number; col: number; width: number; height: number };
  focusOrder?: number;
}

function otherVisibleOverlays(
  tui: TUI,
  component: Component,
): OverlayEntry[] | undefined {
  // SAFETY: read-only optional Pi layout state; older hosts use hasOverlay().
  const host = tui as unknown as {
    overlayStack?: OverlayEntry[];
    isOverlayVisible?: (entry: OverlayEntry) => boolean;
  };
  if (
    !Array.isArray(host.overlayStack) ||
    typeof host.isOverlayVisible !== "function"
  )
    return;
  return host.overlayStack.filter(
    (entry) => entry.component !== component && host.isOverlayVisible!(entry),
  );
}

const overlayIds = new WeakMap<OverlayEntry, number>();
let nextOverlayId = 0;

/** Compare visibility/identity before paint without including paint-time bounds. */
function overlayNotificationSignature(tui: TUI, component: Component): string {
  const visible = otherVisibleOverlays(tui, component);
  return JSON.stringify(
    visible
      ? visible.map((entry) => [
          overlayId(entry),
          entry.focusOrder,
          entry.options?.nonCapturing === true,
        ])
      : (tui.hasOverlay?.() ?? false),
  );
}

function overlayId(entry: OverlayEntry): number {
  let id = overlayIds.get(entry);
  if (id === undefined) overlayIds.set(entry, (id = ++nextOverlayId));
  return id;
}

/** Pi handles pointer occlusion. Capture overlay identity and geometry so a
 * changed overlay invalidates a gesture even when another stays visible. */
export function dialogOverlayState(tui: TUI, component: Component) {
  const visible = otherVisibleOverlays(tui, component);
  if (!visible) {
    const blocking = tui.hasOverlay?.() ?? false;
    return { signature: blocking, blocking };
  }
  return {
    signature: visible.map((entry) => {
      return [
        overlayId(entry),
        entry.focusOrder,
        entry.bounds,
        entry.options?.nonCapturing === true,
      ];
    }),
    blocking: visible.some((entry) => entry.options?.nonCapturing !== true),
  };
}

interface FullscreenKeyboardHost {
  getFocusedComponent(): Component | null;
  terminal?: { columns: number; rows: number };
  requestRender(force?: boolean): void;
  handleViewportInput?: (data: string) => unknown;
  shouldDeferViewportInput?: () => boolean;
  shouldDeferViewportInputToOverlay?: () => boolean;
}

/** Per-renderer compatibility with the host's keyboard priority and resize
 * notifications. All input (including mouse) still uses native Pi dispatch. */
function installDialogHostHooks(
  tui: TUI,
  component: Component,
  usesViewportKey: (data: string) => boolean,
  invalidateGesture: () => void,
): () => void {
  // SAFETY: feature-detected Pi fullscreen methods; no prototype or global changes.
  const host = tui as unknown as FullscreenKeyboardHost;
  const predicate =
    typeof host.shouldDeferViewportInput === "function"
      ? "shouldDeferViewportInput"
      : "shouldDeferViewportInputToOverlay";
  const originalPredicate = host[predicate];
  const originalViewport = host.handleViewportInput;
  const originalRender = host.requestRender;
  let receiver: FullscreenKeyboardHost | undefined;
  let active = true;
  let keyboardPriority = false;
  let columns = host.terminal?.columns,
    rows = host.terminal?.rows;
  let overlays = overlayNotificationSignature(tui, component);
  const render = function (this: FullscreenKeyboardHost, force?: boolean) {
    receiver = this;
    const nextColumns = this.terminal?.columns,
      nextRows = this.terminal?.rows;
    if (active) {
      // Pi queues a paint after changing the overlay stack and after resize.
      // Observe each notification even if the queued paints coalesce.
      const nextOverlays = overlayNotificationSignature(tui, component);
      if (
        columns !== nextColumns ||
        rows !== nextRows ||
        overlays !== nextOverlays
      ) {
        columns = nextColumns;
        rows = nextRows;
        overlays = nextOverlays;
        invalidateGesture();
      }
    }
    return originalRender.call(this, force);
  };
  const prefer = function (this: FullscreenKeyboardHost) {
    return keyboardPriority || originalPredicate?.call(this) === true;
  };
  const viewport = function (this: FullscreenKeyboardHost, data: string) {
    const previous = keyboardPriority;
    keyboardPriority =
      active &&
      this.getFocusedComponent() === component &&
      usesViewportKey(data);
    try {
      return originalViewport?.call(this, data);
    } finally {
      keyboardPriority = previous;
    }
  };
  host.requestRender = render;
  if (
    typeof originalPredicate === "function" &&
    typeof originalViewport === "function"
  ) {
    host[predicate] = prefer;
    host.handleViewportInput = viewport;
  }
  // Resolve Pi's dynamic UI reference to the renderer we actually installed on.
  host.requestRender();
  return () => {
    active = false;
    if (!receiver) return;
    if (receiver.requestRender === render)
      receiver.requestRender = originalRender;
    if (receiver[predicate] === prefer) receiver[predicate] = originalPredicate;
    if (receiver.handleViewportInput === viewport)
      receiver.handleViewportInput = originalViewport;
  };
}

/** The native dock has no editor rows at terminal height one. */
export function installOneRowDialogFallback(
  tui: TUI,
  component: Component,
  usesViewportKey: (data: string) => boolean,
  invalidateGesture: () => void,
): { hide(): void } | undefined {
  // SAFETY: only hosts with the runtime focus getter can install this fallback.
  const host = tui as unknown as FullscreenKeyboardHost;
  if (
    typeof tui.showOverlay !== "function" ||
    typeof host.getFocusedComponent !== "function" ||
    typeof tui.setFocus !== "function"
  )
    return;
  const restoreHost = installDialogHostHooks(
    tui,
    component,
    usesViewportKey,
    invalidateGesture,
  );
  const previous = host.getFocusedComponent();
  tui.setFocus(component);
  const tiny = tui.showOverlay(component, {
    width: "100%",
    maxHeight: 1,
    anchor: "top-left",
    nonCapturing: true,
    visible: (_width, height) => height === 1,
  });
  tui.setFocus(previous);
  return {
    hide() {
      restoreHost();
      tiny.hide();
    },
  };
}
