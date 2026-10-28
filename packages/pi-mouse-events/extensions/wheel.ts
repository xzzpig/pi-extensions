import type { MouseDispatchEvent } from "../api.ts";

/** Normalize Pi's private routeWheel argument without mutating it. */
export function wheelDispatchEvent(
  raw: unknown,
): MouseDispatchEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const event = raw as {
    direction?: unknown;
    x?: unknown;
    y?: unknown;
    button?: unknown;
  };
  if (
    (event.direction !== -1 && event.direction !== 1) ||
    typeof event.x !== "number" ||
    !Number.isFinite(event.x) ||
    typeof event.y !== "number" ||
    !Number.isFinite(event.y)
  )
    return undefined;
  return {
    kind: "wheel",
    button:
      typeof event.button === "number"
        ? event.button
        : event.direction === -1
          ? 64
          : 65,
    x: event.x,
    y: event.y,
    release: false,
    wheel: event.direction,
    handled: false,
  };
}
