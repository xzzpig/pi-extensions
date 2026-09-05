/**
 * The published `MouseEventsApi` and its process-global slot.
 *
 * The API object is written once at extension load, under
 * `Symbol.for("pi-mouse-events.api.v1")`, and never removed — the Symbol is
 * process-global by spec, so a consumer that imported its own fresh copy of
 * this package still reaches the same slot. The consumer-side accessor lives
 * in `../api` (import-safe, reads but never writes).
 */

import type { TUI } from "@earendil-works/pi-tui";
import {
  MOUSE_EVENTS_API_KEY,
  MOUSE_EVENT_CHANNEL,
  type CopyHandler,
  type MouseDispatchEvent,
  type MouseEventsApi,
  type MouseHandler,
  type MouseHandlerRegistrationOptions,
} from "../api.ts";
import { hitTestReceiver } from "./geometry.ts";
import {
  isMouseSequenceLocal,
  parseSgrMouseEventLocal,
  parseWheelEventLocal,
} from "./parse.ts";
import type { InstalledPatches } from "./patch.ts";
import type { MouseReceiver } from "./receiver.ts";

export function createMouseEventsApi(
  patches: InstalledPatches,
): MouseEventsApi {
  return {
    version: 1,
    eventChannel: MOUSE_EVENT_CHANNEL,
    copySlotAvailable: patches.state.copySlotAvailable,
    liveReceiver() {
      return patches.state.liveReceiver() as unknown as TUI | undefined;
    },
    refreshBus(pi) {
      patches.state.refreshBus(pi);
    },
    addMouseHandler(
      handler: MouseHandler,
      options?: MouseHandlerRegistrationOptions,
    ) {
      return patches.state.addMouseHandler(handler, options);
    },
    addCopyHandler(
      handler: CopyHandler,
      options?: MouseHandlerRegistrationOptions,
    ) {
      return patches.state.addCopyHandler(handler, options);
    },
    hitTest(tui: TUI, x: number, y: number) {
      return hitTestReceiver(tui as unknown as MouseReceiver, x, y);
    },
    parseMouseEvent(data: string): MouseDispatchEvent | undefined {
      const wheel = parseWheelEventLocal(data);
      if (wheel) {
        return {
          kind: "wheel",
          button: wheel.direction === -1 ? 64 : 65,
          x: wheel.x,
          y: wheel.y,
          release: false,
          wheel: wheel.direction,
          handled: false,
        };
      }
      const mouse = parseSgrMouseEventLocal(data);
      if (!mouse) return undefined;
      return {
        kind: mouse.release
          ? "up"
          : (mouse.button & 32) !== 0
            ? "motion"
            : "down",
        button: mouse.button,
        x: mouse.x,
        y: mouse.y,
        release: mouse.release,
        handled: false,
      };
    },
    isMouseSequence(data: string) {
      return isMouseSequenceLocal(data);
    },
  };
}

/** Publish the API under the process-global key. Idempotent: last write wins. */
export function publishApi(api: MouseEventsApi): void {
  (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY] = api;
}
