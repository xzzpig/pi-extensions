/**
 * Child-only extension entry for opsx-plan-review (design D1).
 *
 * Loaded exclusively through that agent's `subagentOnlyExtensions`; it
 * registers exactly one tool and never loads the main extension, so the plan
 * review reporting tool exists only inside the plan-review child process.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerChildReportTool } from "../child-report-reader.ts";
import { reportPlanReviewTool } from "../report-tools.ts";

/** Role this entry serves; must match the agent name in `agents.ts`. */
export const PLAN_REVIEW_CHILD_AGENT = "opsx-plan-review";

export default function planReviewChildReportExtension(pi: ExtensionAPI): void {
  registerChildReportTool(pi, {
    agent: PLAN_REVIEW_CHILD_AGENT,
    tool: reportPlanReviewTool,
  });
}
