import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

export function pointerShapes(writes: string[]): string[] {
  const escape = String.fromCharCode(27);
  return writes.flatMap((data) => data.split(`${escape}]22;`).slice(1)
    .map((part) => part.split(`${escape}\\`)[0]!));
}

// The TUI schedules its first layout through nextTick + a render timer. A fixed
// sleep can expire before that timer under a busy parallel test run.
export async function waitForFrame(ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!ready() && performance.now() < deadline) await setTimeout(5);
  assert.ok(ready(), "TUI did not produce its initial layout within 5s");
}
