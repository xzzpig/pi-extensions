import type { MouseDispatchEvent, PointerShape } from "../api.ts";
import type { MouseReceiver } from "./receiver.ts";

/** Coordinate pointer requests made while Pi dispatches one hover event. */
export function createPointerController() {
  const frames: Array<{ requested?: PointerShape }> = [];
  let current: PointerShape = "default";
  let host: MouseReceiver | undefined;
  let generation = 0;

  const write = (receiver: MouseReceiver | undefined, shape: PointerShape) => {
    try {
      receiver?.terminal?.write?.(`\x1b]22;${shape}\x1b\\`);
    } catch {
      // A closed or unsupported terminal must not break input dispatch.
    }
  };

  const reset = () => {
    generation++;
    if (current !== "default") write(host, "default");
    current = "default";
    host = undefined;
    frames.length = 0;
  };

  const request = (shape: PointerShape) => {
    if (shape !== "default" && shape !== "pointer" && shape !== "text") return;
    const frame = frames.at(-1);
    if (frame) frame.requested = shape;
  };

  const dispatch = <T>(
    event: MouseDispatchEvent,
    receiver: MouseReceiver,
    run: () => T,
  ): T => {
    // Only an unpressed motion is a hover. Presses and drags leave the current
    // shape alone, exactly as Pi's component move dispatch does.
    if (event.kind !== "motion" || event.release || (event.button & 3) !== 3)
      return run();
    const frame: { requested?: PointerShape } = {};
    const dispatchGeneration = generation;
    frames.push(frame);
    try {
      return run();
    } finally {
      frames.pop();
      if (dispatchGeneration === generation) {
        const next = frame.requested ?? "default";
        if (host !== receiver) {
          if (current !== "default") write(host, "default");
          current = "default";
          host = receiver;
        }
        if (next !== current) {
          current = next;
          write(host, next);
        }
      }
    }
  };

  return { request, dispatch, reset };
}
