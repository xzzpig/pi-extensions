import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SandboxConfig } from "./config.ts";

import { warnIfLinuxUnenforcedGlobs } from "./ui.ts";

/** Cosmetic warnings must not reject a successfully initialized headless session. */
export function warnIfLinuxUnenforcedGlobsSafely(
  ctx: ExtensionContext,
  config: SandboxConfig,
): void {
  try {
    warnIfLinuxUnenforcedGlobs(ctx, config);
  } catch {
    // A missing UI or renderer failure does not change sandbox enforcement.
  }
}
