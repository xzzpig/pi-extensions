import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getThinkingCollapseRuntime } from "./src/controller.ts";

/**
 * pi-thinking-collapse entry point.
 *
 * Installs the per-message thinking collapse state machine (prototype
 * patches): thinking stays visible while streaming and collapses once the
 * message ends. Clicking a block to toggle it is Pi's own behavior (the
 * renderer wraps thinking blocks in `MouseRegion`), so this entry registers
 * no mouse handling and needs no companion extension. Safe to run on every
 * session factory invocation: installation is idempotent per process.
 */
export default function extension(_pi: ExtensionAPI): void {
  getThinkingCollapseRuntime().install();
}
