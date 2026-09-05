/**
 * The structural slice of `TuiAltScreen` this extension reads or patches.
 *
 * pi-tui's internals carry no stability contract and most of this surface is
 * TS-private without being runtime-private — the compiled prototype has no
 * `#` fields, so these members exist and work; the declarations here simply
 * name them. Every read is guarded at the call site, and the contract tests
 * pin the shape against the installed pi-tui so a release that moves them
 * fails here before it fails for a user.
 */

export interface LayoutRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A node of pi-tui's layout tree (`layout.js`). `rect` of a box inside a
 * scrolled transcript is the *content* box — its `y` sits at
 * `viewportY - scrollTop` — while `clip` is always screen-space, which is
 * what makes point-in-box tests honest for scrolled content.
 */
export interface LayoutBoxLike {
  component?: unknown;
  rect: LayoutRectLike;
  clip?: LayoutRectLike;
  children?: readonly LayoutBoxLike[];
}

/** One entry of `TuiBase.overlayStack`, as laid out by `showOverlay`. */
export interface OverlayStackEntryLike {
  component: unknown;
  options?: unknown;
  hidden?: boolean;
  focusOrder?: number;
}

export interface OverlayLayoutResult {
  width: number;
  maxHeight?: number;
  row: number;
  col: number;
}

export interface ParsedWheelEvent {
  direction: -1 | 1;
  x: number;
  y: number;
}

export interface ParsedSgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

/**
 * What the dispatch reads off the live renderer instance. Every member after
 * `TUI`'s own surface is an internal of pi-tui 0.84.x, reached through a
 * structural cast and guarded at the call site.
 */
export interface MouseReceiver {
  terminal?: {
    columns?: number;
    rows?: number;
    write?: (data: string) => void;
  };
  requestRender?(force?: boolean): void;
  hasOverlay?(): boolean;
  overlayStack?: OverlayStackEntryLike[];
  currentLayout?: { root?: LayoutBoxLike } | undefined;
  isOverlayVisible?(entry: OverlayStackEntryLike): boolean;
  resolveOverlayLayout?(
    options: unknown,
    overlayHeight: number,
    termWidth: number,
    termHeight: number,
  ): OverlayLayoutResult;
  parseWheelEvent?(data: string): ParsedWheelEvent | undefined;
  parseSgrMouseEvent?(data: string): ParsedSgrMouseEvent | undefined;
}

/** Whether `name` on the prototype chain is a replaceable function. */
export function isPatchable(prototype: object, name: string): boolean {
  try {
    let current: object | null = prototype;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        if (typeof descriptor.value !== "function") return false;
        return descriptor.writable === true && descriptor.configurable === true;
      }
      current = Object.getPrototypeOf(current);
    }
    return false;
  } catch {
    // A prototype that throws on inspection is one we do not touch.
    return false;
  }
}
