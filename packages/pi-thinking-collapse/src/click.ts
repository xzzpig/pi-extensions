/**
 * Mouse click-to-toggle for thinking blocks, modeled on pi-starline's
 * click-on-shell protocol (`mouse/index.ts`):
 *
 * - the **press is never consumed** — Pi's selection machinery anchors on it,
 *   so a drag that starts on a thinking block still selects text;
 * - the **release of a plain click is consumed** — Pi's own release path
 *   treats it as a no-op, so consuming it cannot break anything else;
 * - the release **re-resolves** the target against the live layout rather
 *   than trusting the press's answer: a running tool re-renders between the
 *   two events and rows move under the pointer. The press is kept only as an
 *   identity check — the toggle happens on the *current* component, and only
 *   if it is the same component the press landed on;
 * - a motion bit on any event marks the press as a drag, which cancels the
 *   click; a release on a different cell cancels it too;
 * - a second click on the same cell within 500ms is a double-click and is
 *   ignored (Pi's own double-click machinery wants those events);
 * - clicks are rejected while an overlay is open, mirroring Pi resolving no
 *   scroll view under an overlay.
 *
 * Events arrive from `@xzzpig/pi-mouse-events` ahead of Pi's built-in
 * handlers. The same `Symbol.for` slot that `getMouseEventsApi` reads is
 * writable from tests, so the whole protocol is exercised against a fake
 * dispatch pipeline with real `AssistantMessageComponent` instances inside a
 * real layout tree.
 */

import { getMouseEventsApi } from "@xzzpig/pi-mouse-events/api";

import { thinkingTargetAt, thinkingRowIntervals } from "./ownership.ts";
import type { ReceiverLike } from "./ownership.ts";
import type { CollapseController } from "./state.ts";

const MOTION_BIT = 32;
const WHEEL_BIT = 64;
/** Mirrors pi's DOUBLE_CLICK_INTERVAL_MS. */
const DOUBLE_CLICK_MS = 500;

export type MouseEventLike = {
  button: number;
  x: number;
  y: number;
  release: boolean;
};

export function isLeftButtonPress(event: unknown): event is MouseEventLike {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as Partial<MouseEventLike>;
  if (typeof candidate.button !== "number") return false;
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number")
    return false;
  if (candidate.release) return false;
  if ((candidate.button & (MOTION_BIT | WHEEL_BIT)) !== 0) return false;
  return candidate.button === 0;
}

export function isLeftButtonRelease(event: unknown): event is MouseEventLike {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as Partial<MouseEventLike>;
  if (typeof candidate.button !== "number") return false;
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number")
    return false;
  if (!candidate.release) return false;
  if ((candidate.button & (MOTION_BIT | WHEEL_BIT)) !== 0) return false;
  return candidate.button === 0;
}

export function isButtonMotion(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as Partial<MouseEventLike>;
  if (typeof candidate.button !== "number") return false;
  return (candidate.button & MOTION_BIT) !== 0;
}

type TogglePress = {
  x: number;
  y: number;
  component: unknown;
  dragged: boolean;
};

let press: TogglePress | undefined;
let lastToggle: { x: number; y: number; at: number } | undefined;

/** Resolve and toggle; `{ handled: true }` when this module consumed it. */
export function dispatchClick(
  controller: CollapseController,
  event: unknown,
  tui: unknown,
  now: number,
): { handled: true } | undefined {
  // SAFETY: the mouse bus hands out the fullscreen TUI; ReceiverLike is the
  // structural slice this module reads.
  const receiver = tui as ReceiverLike;
  if (isLeftButtonPress(event)) {
    // Identity only: the release re-resolves.
    const target = thinkingTargetAt(controller, receiver, event.x, event.y);
    press = target
      ? { x: event.x, y: event.y, component: target.component, dragged: false }
      : undefined;
    return undefined;
  }
  if (press && isButtonMotion(event)) {
    press.dragged = true;
    return undefined;
  }
  if (!isLeftButtonRelease(event)) return undefined;
  const pressed = press;
  press = undefined;
  if (!pressed || pressed.dragged) return undefined;
  if (pressed.x !== event.x || pressed.y !== event.y) return undefined;
  const target = thinkingTargetAt(controller, receiver, event.x, event.y);
  if (!target || target.component !== pressed.component) return undefined;
  if (
    lastToggle &&
    lastToggle.x === pressed.x &&
    lastToggle.y === pressed.y &&
    now - lastToggle.at < DOUBLE_CLICK_MS
  ) {
    return undefined;
  }
  // Only toggle when the release landed on one of the message's thinking
  // rows — the label when collapsed, the thinking text when expanded. Clicks
  // on the answer text stay selection material.
  const intervals = thinkingRowIntervals(
    controller,
    target.component,
    target.width,
  );
  const onThinkingRow = intervals.some(
    ([start, end]) => target.row >= start && target.row < end,
  );
  if (!onThinkingRow) return undefined;
  if (!controller.toggle(target.component)) return undefined;
  requestRender(tui);
  lastToggle = { x: pressed.x, y: pressed.y, at: now };
  return { handled: true };
}

function requestRender(tui: unknown): void {
  const candidate = tui as { requestRender?: () => void } | null;
  candidate?.requestRender?.();
}

/**
 * Register the click handler on the session-scoped mouse bus. Returns a
 * cleanup, or undefined when `@xzzpig/pi-mouse-events` is not loaded yet —
 * callers retry on the next session factory run.
 */
export function installClickHandling(
  controller: CollapseController,
): (() => void) | undefined {
  const api = getMouseEventsApi();
  if (!api) return undefined;
  return api.addMouseHandler(
    ({ event, tui }) => dispatchClick(controller, event, tui, Date.now()),
    { priority: 20 },
  );
}
