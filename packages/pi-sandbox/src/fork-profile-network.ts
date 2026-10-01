import type { ISandboxManager } from "@xzzpig/sandbox-runtime";

import { type SandboxConfig } from "./config.ts";
import { isNetworkUnrestricted } from "./policy.ts";
import {
  initializeSandbox,
  type SessionAllowances,
  updateSandboxConfig,
} from "./sandbox-runtime.ts";

/**
 * Apply a changed sandbox configuration to an already-initialized manager.
 *
 * A profile *may* declare `network.disabled: false` (it may not declare
 * `true` — registration rejects that), and the fork's profile layer lets a
 * profile inherit the baseline's `disabled` state. So selecting a profile can
 * turn network restriction ON for a manager that was initialized while the
 * global config had network disabled. In that case the runtime never started
 * its network proxy, and a plain `updateConfig` cannot start one: the next
 * sandboxed command would fail closed with "Sandbox network proxy is not
 * initialized". Detect exactly that transition and re-initialize the manager
 * so the proxy exists; every other change stays a cheap in-place `updateConfig`
 * that never tears down a proxy used by concurrent commands.
 *
 * The converse transition (a profile inheriting `disabled: true`, i.e. running
 * with restriction off) needs no re-initialization: no proxy is required.
 */
export async function applySandboxConfigChange(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances: SessionAllowances,
): Promise<void> {
  const networkRestricted = !isNetworkUnrestricted(config);
  if (networkRestricted && !(await manager.waitForNetworkInitialization())) {
    await manager.reset();
    await initializeSandbox(manager, config, allowances);
    return;
  }
  updateSandboxConfig(manager, config, allowances);
}
