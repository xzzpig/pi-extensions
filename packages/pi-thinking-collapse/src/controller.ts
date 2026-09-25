/**
 * Process-wide controller for the thinking-collapse behavior.
 *
 * Pi re-runs extension factories on every session replacement; this module
 * guarantees the prototype patches are installed exactly once per process.
 * The state (per-component globals) lives in the controller, so a later
 * session sees the same controller object through the `Symbol.for` slot.
 */

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
  return {
    collapse,
    install() {
      collapse.install();
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
