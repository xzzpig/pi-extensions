import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getThinkingCollapseRuntime } from "./src/controller.ts";

/**
 * pi-thinking-collapse entry point.
 *
 * Installs the per-message thinking collapse state machine (prototype
 * patches) and, when the `pi-mouse-events` extension is available, the
 * click-to-toggle mouse handling. Safe to run on every session factory
 * invocation: installation is idempotent per process.
 */
export default function extension(_pi: ExtensionAPI): void {
  getThinkingCollapseRuntime().install();
}
