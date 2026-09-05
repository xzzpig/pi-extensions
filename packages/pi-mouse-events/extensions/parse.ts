/**
 * Parsing of raw terminal mouse reports.
 *
 * The dispatch prefers the live renderer's own `parseWheelEvent` and
 * `parseSgrMouseEvent` — calling pi-tui's parsers keeps the dispatch byte for
 * byte faithful to the running Pi build, whatever it accepts. The local
 * implementations here are the fallback for a receiver without them and the
 * engine behind the public `parseMouseEvent`/`isMouseSequence` API, which has
 * no receiver at hand. Both are read against pi-tui 0.84.2's
 * `tui-alt-screen.js` and pinned by the contract tests.
 */

import type { MouseEventKind, MouseDispatchEvent } from "../api.ts";
import type {
  MouseReceiver,
  ParsedSgrMouseEvent,
  ParsedWheelEvent,
} from "./receiver.ts";

/** SGR: `\x1b[<button;column;row(M|m)` — `M` press/motion, `m` release. */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

const WHEEL_BIT = 64;

export function parseWheelEventLocal(
  data: string,
): ParsedWheelEvent | undefined {
  const sgr = SGR_MOUSE_RE.exec(data);
  if (sgr) {
    const button = Number.parseInt(sgr[1], 10);
    if ((button & WHEEL_BIT) === 0) return undefined;
    const direction = button & 3;
    if (direction !== 0 && direction !== 1) return undefined;
    return {
      direction: direction === 0 ? -1 : 1,
      x: Number.parseInt(sgr[2], 10) - 1,
      y: Number.parseInt(sgr[3], 10) - 1,
    };
  }
  if (data.length === 6 && data.startsWith("\x1b[M")) {
    const button = data.charCodeAt(3) - 32;
    if ((button & WHEEL_BIT) === 0) return undefined;
    const direction = button & 3;
    if (direction !== 0 && direction !== 1) return undefined;
    return {
      direction: direction === 0 ? -1 : 1,
      x: data.charCodeAt(4) - 33,
      y: data.charCodeAt(5) - 33,
    };
  }
  return undefined;
}

export function parseSgrMouseEventLocal(
  data: string,
): ParsedSgrMouseEvent | undefined {
  const match = SGR_MOUSE_RE.exec(data);
  if (!match) return undefined;
  return {
    button: Number.parseInt(match[1], 10),
    x: Number.parseInt(match[2], 10) - 1,
    y: Number.parseInt(match[3], 10) - 1,
    release: match[4] === "m",
  };
}

/** A wheel notch as the dispatch sees it: pi-tui maps direction onto bit 6. */
function wheelButton(direction: -1 | 1): number {
  return direction === -1 ? 64 : 65;
}

function wheelKind(): MouseEventKind {
  return "wheel";
}

export function kindForMouseEvent(event: {
  wheel?: -1 | 1;
  release: boolean;
  button: number;
}): MouseEventKind {
  if (event.wheel !== undefined) return wheelKind();
  if (event.release) return "up";
  if ((event.button & 32) !== 0) return "motion";
  return "down";
}

/**
 * The unified parsed event, or undefined for every non-mouse chunk.
 *
 * Prefers the receiver's own parsers; a receiver without them (a future
 * pi-tui that moved or renamed them) falls back to the local ones rather than
 * dropping mouse support entirely.
 */
export function parseMouseEventWith(
  receiver: MouseReceiver,
  data: string,
): MouseDispatchEvent | undefined {
  const wheel = receiver.parseWheelEvent?.(data) ?? parseWheelEventLocal(data);
  if (wheel) {
    const wheelDirection = wheel.direction as -1 | 1;
    return {
      kind: wheelKind(),
      button: wheelButton(wheelDirection),
      x: wheel.x,
      y: wheel.y,
      release: false,
      wheel: wheelDirection,
      handled: false,
    };
  }
  const mouse =
    receiver.parseSgrMouseEvent?.(data) ?? parseSgrMouseEventLocal(data);
  if (!mouse) return undefined;
  const kind = kindForMouseEvent(mouse);
  return {
    kind,
    button: mouse.button,
    x: mouse.x,
    y: mouse.y,
    release: mouse.release,
    handled: false,
  };
}

/** Whether `data` is any recognised mouse report, wheel or button. */
export function isMouseSequenceLocal(data: string): boolean {
  if (parseWheelEventLocal(data) !== undefined) return true;
  return parseSgrMouseEventLocal(data) !== undefined;
}
