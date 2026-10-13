/**
 * Child-only extension entry for opsx-worker (design D1).
 *
 * Loaded exclusively through that agent's `subagentOnlyExtensions`; it
 * registers exactly one tool and never loads the main extension, so the work
 * report tool exists only inside the worker child process.
 *
 * The worker's Task section carries `[OPSX WORKER DISPATCH task=<taskId>]`.
 * The attempt records that marker when the prompt names exactly one task; a
 * resumed prompt without one is still recordable but cannot authorize a tick
 * (design D3).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerChildReportTool } from "../child-report-reader.ts";
import { reportWorkTool } from "../report-tools.ts";

/** Role this entry serves; must match the agent name in `agents.ts`. */
export const WORKER_CHILD_AGENT = "opsx-worker";

export default function workerChildReportExtension(pi: ExtensionAPI): void {
  registerChildReportTool(pi, {
    agent: WORKER_CHILD_AGENT,
    tool: reportWorkTool,
  });
}
