import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { isPatchable } from "./receiver.ts";

/** Pi's selection slicing can duplicate a caret marker on one rendered row. */
export function dedupeCursorMarkers(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const first = line.indexOf(CURSOR_MARKER);
    if (first < 0) return line;
    const end = first + CURSOR_MARKER.length;
    const remainder = line.slice(end);
    return remainder.includes(CURSOR_MARKER)
      ? line.slice(0, end) + remainder.split(CURSOR_MARKER).join("")
      : line;
  });
}

/** Internal Pi workaround; unavailable or non-string results are left untouched. */
export function installSelectionMarkerDedupe(prototype: {
  applySelection?: unknown;
}): (() => void) | undefined {
  if (!isPatchable(prototype, "applySelection")) return undefined;
  const target = prototype;
  // Pi's applySelection returns rendered rows; the runtime guard below still
  // preserves unexpected values from a future host implementation.
  const original = target.applySelection as (...args: unknown[]) => string[];
  function patched(this: unknown, ...args: unknown[]): string[] {
    // Forward the receiver without trusting an own, shadowed `.apply` method.
    // pi-lens-ignore: no-reflect-apply
    const result = Reflect.apply(original, this, args);
    if (
      !Array.isArray(result) ||
      !result.every((line) => typeof line === "string")
    )
      return result;
    return dedupeCursorMarkers(result);
  }
  try {
    target.applySelection = patched;
  } catch {
    return undefined;
  }
  return () => {
    if (target.applySelection === patched) target.applySelection = original;
  };
}
