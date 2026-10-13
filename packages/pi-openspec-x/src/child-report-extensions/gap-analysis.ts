/**
 * Child-only extension entry for opsx-gap-analysis (design D1).
 *
 * Loaded exclusively through that agent's `subagentOnlyExtensions`; it
 * registers exactly one tool and never loads the main extension, so the gap
 * analysis reporting tool exists only inside the gap-analysis child process.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerChildReportTool } from "../child-report-reader.ts";
import { reportGapAnalysisTool } from "../report-tools.ts";

/** Role this entry serves; must match the agent name in `agents.ts`. */
export const GAP_ANALYSIS_CHILD_AGENT = "opsx-gap-analysis";

export default function gapAnalysisChildReportExtension(
  pi: ExtensionAPI,
): void {
  registerChildReportTool(pi, {
    agent: GAP_ANALYSIS_CHILD_AGENT,
    tool: reportGapAnalysisTool,
  });
}
