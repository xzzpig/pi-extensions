/**
 * Process-wide controller for the thinking-collapse behavior.
 *
 * Pi re-runs extension factories on every session replacement; this module
 * guarantees the prototype patches and the mouse handler are installed
 * exactly once per process. The state (per-message pins, per-component
 * globals) lives in the controller, so a later session sees the same
 * controller object through the `Symbol.for` slot.
 */

import { installClickHandling } from "./click.ts";
import { CollapseController } from "./state.ts";

const CONTROLLER_KEY = Symbol.for("pi-thinking-collapse.controller.v1");

export interface ThinkingCollapseRuntime {
  /** The collapse state machine (prototype patches installed on first call). */
  readonly collapse: CollapseController;
  /** Install everything; safe to call from every factory run. */
  install(): void;
}

function createRuntime(): ThinkingCollapseRuntime {
  const collapse = new CollapseController();
  let clickInstalled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const retryClick = (): void => {
    retryTimer = undefined;
    if (clickInstalled) return;
    // `installClickHandling` returns undefined when `@xzzpig/pi-mouse-events`
    // has not published its api yet (the extension factories of a session
    // run in load order, and this package may be loaded first). Retry for a
    // few hundred milliseconds so the click feature works regardless of
    // extension order.
    clickInstalled = installClickHandling(collapse) !== undefined;
    if (!clickInstalled) retryTimer = setTimeout(retryClick, 100);
  };
  return {
    collapse,
    install() {
      collapse.install();
      if (clickInstalled || retryTimer !== undefined) return;
      retryClick();
    },
  };
}

export function getThinkingCollapseRuntime(): ThinkingCollapseRuntime {
  const existing = (globalThis as Record<symbol, unknown>)[CONTROLLER_KEY];
  if (existing && typeof existing === "object")
    return existing as ThinkingCollapseRuntime;
  const runtime = createRuntime();
  Object.defineProperty(globalThis, CONTROLLER_KEY, {
    value: runtime,
    configurable: true,
  });
  return runtime;
}
