/**
 * Parent-side plan gate tools (openspec change add-pi-openspec-x, tasks 7.2 and
 * 7.3).
 *
 * The child reporting tools (`report_gap_analysis` / `report_plan_review`) run
 * in the subagent's own session, so their results reach the main agent but not
 * this extension's process state. The plan flow therefore owns two
 * parent-facing tools the main agent calls with the child's structured result:
 *
 * - `opsx_plan_gap_analysis` persists gap-analysis findings into the change's
 *   append-only plan ledger (advisory: it never gates);
 * - `opsx_plan_verdict` persists the plan-review verdict, derives the round and
 *   the escalation policy from the ledger, and — only on OKAY — opens the
 *   blocking user approval dialog and records the decision.
 *
 * The ledger, not in-memory state, is the source of truth: `/opsx:implement`
 * reads the recorded approval from disk, so approval survives a restart and a
 * fresh session cannot bypass the gate.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { requestPlanApproval, type PlanApproval } from "./approval-gate.ts";
import { changeDirPath } from "./implement-command.ts";
import { appendFlowEntry, OPSX_ENTRY_TYPES } from "./flow-entries.ts";
import { publishLifecycle } from "./lifecycle.ts";
import { activePlanSession } from "./plan-command.ts";
import { sessionKey } from "./command-util.ts";
import {
  readPlanApproval,
  recordEscalation,
  recordGapAnalysis,
  recordPlanReviewVerdict,
  recordPlanApproval,
  type DelegationUsage,
  type PlanVerdict,
} from "./plan-review.ts";

export const OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME = "opsx_plan_gap_analysis";
export const OPSX_PLAN_VERDICT_TOOL_NAME = "opsx_plan_verdict";

const usageSchema = Type.Optional(
  Type.Object(
    {
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
      turns: Type.Number(),
    },
    { additionalProperties: false },
  ),
);

const gapAnalysisParams = Type.Object(
  {
    findings: Type.Array(
      Type.String({
        description: "One concrete gap, specific enough to act on.",
      }),
      { description: "Gap-analysis findings; may be empty." },
    ),
    summary: Type.Optional(Type.String()),
    changeId: Type.Optional(
      Type.String({
        description:
          "OpenSpec change id; defaults to this session's active plan flow.",
      }),
    ),
  },
  { additionalProperties: false },
);

const planReviewParams = Type.Object(
  {
    verdict: Type.Union([
      Type.Literal("OKAY"),
      Type.Literal("ITERATE"),
      Type.Literal("REJECT"),
    ]),
    blockers: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Blocking issues; at most three, each new relative to earlier rounds.",
      }),
    ),
    summary: Type.Optional(Type.String()),
    usage: usageSchema,
    changeId: Type.Optional(
      Type.String({
        description:
          "OpenSpec change id; defaults to this session's active plan flow.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Resolve the change this call belongs to: an explicit argument wins, else the
 * session's active plan flow. Returns undefined when neither is available, so
 * the tool can answer with a corrective message instead of writing to a guess.
 */
function resolveChangeId(
  ctx: ExtensionContext,
  explicit: string | undefined,
): string | undefined {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return activePlanSession(sessionKey(ctx))?.changeId;
}

function requireChangeId(
  ctx: ExtensionContext,
  explicit: string | undefined,
): { changeId: string } | { error: string } {
  const changeId = resolveChangeId(ctx, explicit);
  if (!changeId) {
    return {
      error:
        "No plan flow is active for this session and no changeId was supplied; start /opsx:plan <change-id> first.",
    };
  }
  return { changeId };
}

/** A one-line tool result (no structured details to expose). */
function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Register the two parent-facing gate tools. */
export function registerPlanGateTools(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME,
      label: "Record Gap Analysis",
      description:
        "Record the opsx-gap-analysis gap analysis for the active plan change into the append-only plan ledger. Advisory: it never gates the flow.",
      promptSnippet:
        "Record the opsx-gap-analysis gap analysis after that dispatch returns.",
      promptGuidelines: [
        "Call this once per gap-analysis dispatch with the findings the child reported.",
        "Gap analysis is advisory; its findings must still be absorbed into the plan artifacts.",
      ],
      parameters: gapAnalysisParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const resolved = requireChangeId(ctx, params.changeId);
        if ("error" in resolved) {
          return toolText(resolved.error);
        }
        const changeDir = changeDirPath(ctx.cwd, resolved.changeId);
        recordGapAnalysis(changeDir, {
          findings: params.findings,
          ...(params.summary ? { summary: params.summary } : {}),
        });
        return toolText(
          `Gap analysis recorded (${params.findings.length} findings). Absorb them into the plan artifacts, then continue.`,
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: OPSX_PLAN_VERDICT_TOOL_NAME,
      label: "Record Plan Review",
      description:
        "Record the opsx-plan-review plan verdict into the append-only plan ledger, apply the review-loop policy, and (on OKAY) open the blocking user approval dialog.",
      promptSnippet:
        "Record the opsx-plan-review verdict after that dispatch returns.",
      promptGuidelines: [
        "Call this once per plan-review dispatch with the verdict and blockers the child reported.",
        "Follow the returned instruction: revise and re-review, hand over to the user, or proceed only after approval.",
        "Never treat an OKAY verdict as approval; the user's decision is returned by this tool.",
      ],
      parameters: planReviewParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const resolved = requireChangeId(ctx, params.changeId);
        if ("error" in resolved) {
          return toolText(resolved.error);
        }
        const { changeId } = resolved;
        const changeDir = changeDirPath(ctx.cwd, changeId);
        const verdict = params.verdict as PlanVerdict;
        const blockers = params.blockers ?? [];
        const usage = params.usage as DelegationUsage | undefined;

        const { action } = recordPlanReviewVerdict(changeDir, {
          verdict,
          blockers,
          ...(params.summary ? { summary: params.summary } : {}),
          ...(usage ? { usage } : {}),
        });
        publishLifecycle(pi.events, {
          type: "review_verdict",
          change: changeId,
          mode: "plan",
          verdict,
        });
        // The lifecycle event above is the bus counterpart of this entry.
        appendFlowEntry(pi, OPSX_ENTRY_TYPES.verdict, {
          changeId,
          verdict,
          ...(action.kind === "dispatch" ? {} : { round: action.round }),
        });

        if (action.kind === "revise") {
          return toolText(
            `Verdict ${verdict} recorded for round ${action.round}. ${action.reason}`,
          );
        }
        if (action.kind === "escalate") {
          recordEscalation(changeDir, {
            reason: action.reason,
            round: action.round,
          });
          return toolText(
            `Review loop escalated after round ${action.round}: ${action.reason} Stop the automated loop and ask the user how to proceed.`,
          );
        }
        if (action.kind === "dispatch") {
          return toolText(action.reason);
        }

        // OKAY: the plan is final. Request the user's explicit approval and
        // record the decision before telling the agent anything. A second
        // OKAY round for an already-approved plan must not re-open the dialog
        // or append another approval entry: the ledger is the source of truth.
        const recorded = readPlanApproval(changeDir);
        if (recorded && recorded.decision === "approved") {
          const prior: PlanApproval = { changeId, ...recorded };
          return toolText(approvalInstruction(changeId, prior));
        }
        const approval: PlanApproval = await requestPlanApproval(
          pi,
          ctx,
          changeId,
          pi.events,
        );
        recordPlanApproval(changeDir, {
          changeId,
          decision: approval.decision,
          via: approval.via,
          at: approval.at,
        });
        appendFlowEntry(pi, OPSX_ENTRY_TYPES.approval, {
          changeId,
          decision: approval.decision,
          via: approval.via,
        });
        return toolText(approvalInstruction(changeId, approval));
      },
    }),
  );
}

/** The instruction returned to the agent after the approval dialog closes. */
export function approvalInstruction(
  changeId: string,
  approval: PlanApproval,
): string {
  if (approval.decision === "approved") {
    return `The user approved the plan for "${changeId}". Plan mode is done: stop here. Implementation is a separate step the user starts with /opsx:implement --agent|--direct ${changeId}.`;
  }
  if (approval.decision === "revise") {
    return `The user requested changes to the plan for "${changeId}". Revise the artifacts, then re-run the opsx-plan-review review before asking again.`;
  }
  if (approval.decision === "rejected") {
    return `The user rejected the plan for "${changeId}". Stop the flow and ask how to proceed; do not start implementation.`;
  }
  return `The user's decision for "${changeId}" is still pending (no structured answer was recorded). Do not start implementation; ask the user to approve or revise the plan.`;
}
