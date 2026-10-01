/**
 * Final review gate: point one opsx goal's completion audit at the custom
 * opsx-reviewer, and turn the audit's structured verdict into the flow's next
 * action (design D3/D10; openspec change add-pi-openspec-x, task 8.3).
 *
 * goal-x's completion transaction runs an independent audit BEFORE committing
 * completion, so the final gate needs no plugin-side verdict channel:
 *
 * - S1 (per-goal auditor override, goal-x fork): `setGoalAuditorOverride`
 *   attaches the opsx-reviewer request/prompt settings to exactly one goal id.
 * - S2 (cross-extension resolver, goal-x fork): `registerAuditorAgentResolver`
 *   supplies the opsx-reviewer runtime definition, which file-based preflight
 *   discovery cannot see.
 *
 * Both are keyed to the opsx goal, so a user's ordinary `/goal` keeps the
 * default auditor and checklist. A disapproved audit leaves the goal active
 * (goal-x semantics): the flow fixes and re-reviews until approved, then guides
 * the user to archive — the plugin never archives for them.
 */
import type { RuntimeAgentDefinition } from "@xzzpig/pi-subagents/agents";

import { OPSX_AGENT_DEFINITIONS } from "./agents.ts";

export const OPSX_REVIEWER_AGENT_NAME = "opsx-reviewer";

/** The four review dimensions injected into the auditor's checklist. */
export const OPSX_REVIEW_CHECKLIST = [
  "Plan conformance: every task and requirement in tasks.md/design is verifiably satisfied or reported as a finding.",
  "Code quality: the change is coherent, follows project conventions, and has no obvious defects.",
  "Verification evidence: every claim is backed by real, reproducible command output.",
  "Scope fidelity: every changed file belongs to the plan; unrequested changes are findings.",
];

/** The extra instructions injected into the auditor's prompt. */
export const OPSX_REVIEW_INSTRUCTIONS = [
  "This goal was created by pi-openspec-x for an OpenSpec change. Review the execution-window delta injected in your dispatch context, not the whole repository.",
  "Your verdict drives a fix/re-review loop: disapprove with concrete, actionable findings so the next round can address them exactly.",
].join("\n");

/** Per-goal auditor settings the S1 override carries. */
export interface OpsxAuditorOverride {
  agent: string;
  checklistExtra: string[];
  instructions: string;
}

/** Build the per-goal auditor override for an opsx goal. */
export function buildOpsxAuditorOverride(): OpsxAuditorOverride {
  return {
    agent: OPSX_REVIEWER_AGENT_NAME,
    checklistExtra: [...OPSX_REVIEW_CHECKLIST],
    instructions: OPSX_REVIEW_INSTRUCTIONS,
  };
}

/**
 * The S2 resolver: answer only for the opsx-reviewer name, with the runtime
 * definition this plugin registered. Every other name (including the default
 * `goal-auditor`) is a miss, so ordinary goals keep their original path.
 *
 * The resolver is a module-level singleton so repeated installs register the
 * same function reference.
 */
let opsxResolverSingleton:
  | ((agentName: string) => RuntimeAgentDefinition | undefined)
  | undefined;

export function createOpsxAuditorResolver(): (
  agentName: string,
) => RuntimeAgentDefinition | undefined {
  opsxResolverSingleton ??= (agentName: string) =>
    agentName === OPSX_REVIEWER_AGENT_NAME
      ? OPSX_AGENT_DEFINITIONS[OPSX_REVIEWER_AGENT_NAME]
      : undefined;
  return opsxResolverSingleton;
}

/** The slice of goal-x the final gate needs (structurally the S1/S2 APIs). */
export interface OpsxAuditorInstaller {
  setGoalAuditorOverride(
    goalId: string,
    override: Record<string, unknown>,
  ): void;
  registerAuditorAgentResolver(
    resolver: (agentName: string) => RuntimeAgentDefinition | undefined,
  ): () => void;
}

/**
 * Register the S2 resolver once for the process. Idempotent: repeated calls
 * hand goal-x the same function reference, which its registry dedupes.
 */
export function registerOpsxAuditorResolver(goalX: {
  registerAuditorAgentResolver(
    resolver: (agentName: string) => RuntimeAgentDefinition | undefined,
  ): () => void;
}): () => void {
  return goalX.registerAuditorAgentResolver(createOpsxAuditorResolver());
}

/**
 * Install the opsx final-audit configuration for one goal: the per-goal
 * override plus the cross-extension resolver. Returns the resolver dispose
 * function (the override lives for the session; goal-x clears it with the
 * goal). Throws only if goal-x rejects the override (a plugin bug, not a user
 * error).
 */
export function installOpsxAuditorForGoal(
  goalX: OpsxAuditorInstaller,
  goalId: string,
): { disposeResolver: () => void } {
  goalX.setGoalAuditorOverride(goalId, { ...buildOpsxAuditorOverride() });
  const disposeResolver = registerOpsxAuditorResolver(goalX);
  return { disposeResolver };
}

/** The structured completion-audit result the gate consumes. */
export interface FinalAuditResult {
  approved: boolean;
  report: string;
  findings: string[];
}

export type FinalGateDecision =
  | { kind: "approved"; report: string }
  | { kind: "fix"; findings: string[] };

/**
 * Map the completion audit's structured verdict to the flow's next action.
 * `approved` completes the goal (goal-x already committed it); otherwise the
 * goal stays active and the findings drive the fix round.
 */
export function decideFinalGate(result: FinalAuditResult): FinalGateDecision {
  if (result.approved) {
    return { kind: "approved", report: result.report };
  }
  return {
    kind: "fix",
    findings:
      result.findings.length > 0
        ? [...result.findings]
        : [
            "The completion audit disapproved without naming findings; re-run the audit with concrete findings.",
          ],
  };
}

/**
 * The archive guidance shown after approval. The plugin never archives: the
 * user runs the openspec archive flow themselves.
 */
export function renderArchiveGuidance(changeId: string): string {
  return [
    `[OPSX FINAL AUDIT APPROVED change=${changeId}]`,
    `The completion audit approved change "${changeId}". The goal is complete.`,
    `Archive when you are ready: run the openspec archive flow (e.g. \`openspec archive "${changeId}"\`). pi-openspec-x never archives for you.`,
  ].join("\n");
}
