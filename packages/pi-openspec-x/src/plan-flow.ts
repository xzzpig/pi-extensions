/**
 * `/opsx:plan` phase model and append-only injection blocks (design D5; openspec
 * change add-pi-openspec-x, task 7.1).
 *
 * The plan flow never rewrites the system prompt and never adds or removes a
 * skill mid-session (that would break the prompt-prefix cache): the mode
 * contract is one appended message, and each phase appends exactly one
 * instruction block, built live from
 * `openspec instructions <artifact> --change <id> --json`. When the CLI cannot
 * answer (no change yet, CLI error, malformed output) the block degrades to a
 * built-in skeleton and the caller raises a notice — the flow never stops.
 *
 * This module is pure: phase selection and block rendering take data and
 * return data. The command/turn_end wiring lives in ./plan-command.ts.
 */
import type { OpenspecArtifactInstructions } from "./cli.ts";

/** The spec-driven artifact order, used only for the built-in skeleton text. */
const PLAN_ARTIFACT_ORDER = ["proposal", "specs", "design", "tasks"] as const;

type PlanArtifact = string;

/** The validated slice of `openspec status --change <id> --json`. */
export interface PlanStatusArtifact {
  id: string;
  status: string;
  requires?: string[];
}

export interface PlanStatus {
  artifacts?: PlanStatusArtifact[];
}

/** The next thing the plan flow must do. */
export type PlanPhase =
  | { kind: "artifact"; artifact: PlanArtifact }
  | { kind: "review" };

/**
 * The first artifact that is neither done nor skipped, in the status output's
 * own order (which is the schema's dependency order). Every artifact done
 * means the plan is ready for the plan-review gate.
 */
export function nextPlanPhase(status: PlanStatus): PlanPhase {
  const pending = (status.artifacts ?? []).find(
    (artifact) => artifact.status !== "done" && artifact.status !== "skipped",
  );
  return pending
    ? { kind: "artifact", artifact: pending.id }
    : { kind: "review" };
}

/** The decision-complete slice every phase block carries. */
const DECISION_COMPLETE_RULES = [
  "Decision-complete rules for this artifact:",
  '- Name exact file paths and symbols; never write "the relevant file".',
  "- Reference every dependency exhaustively: what to read, what to change.",
  "- State Must-NOT-Have explicitly: what is out of scope.",
  '- Every acceptance criterion must be executable by an agent (a command, a file check, a test run); no "the user confirms".',
  "- Leave the implementer zero judgment calls.",
];

const ARTIFACT_SKELETONS: Record<string, string> = {
  proposal:
    "Write proposal.md: Why, What Changes, Capabilities (New/Modified), Impact. Keep it to the change's intent and boundaries.",
  specs:
    "Write the spec deltas under specs/: ADDED/MODIFIED/REMOVED requirements with WHEN/THEN scenarios. Keep capability paths stable.",
  design:
    "Write design.md: Context, Goals/Non-Goals, Decisions (including rejected alternatives), Risks, Migration, Open Questions.",
  tasks:
    "Write tasks.md: `## N. Group` headings and `- [ ] X.Y ...` checkbox tasks; every task states how to verify completion.",
};

const GENERIC_SKELETON =
  "Follow the schema's artifact requirements; the CLI instructions are authoritative whenever they are available.";

/** The mode-contract message appended once when the plan mode is entered. */
export function renderPlanModeContract(changeId: string): string {
  return [
    `[OPSX PLAN MODE change=${changeId}]`,
    `You are now in the opsx planning flow for change "${changeId}". Your writes are restricted to openspec/ (the opsx-planner sandbox profile); everything else is read-only.`,
    "Flow: write the change artifacts in dependency order, each following its live `openspec instructions <artifact> --change <id> --json` output. Dispatch the read-only opsx-gap-analysis gap analyst mid-way, absorb its findings into the artifacts, and record them with the `opsx_plan_gap_analysis` tool. When every artifact is done, dispatch the read-only opsx-plan-review plan reviewer, record each verdict with `opsx_plan_verdict`, and follow that tool's instruction: revise and re-review, hand over to the user when it escalates, or — only after OKAY — let it open the blocking user approval dialog.",
    "Discipline: decision-complete writing (exact paths, exhaustive references, explicit Must-NOT-Have, agent-executable acceptance criteria). Do not implement code in this mode. Only the user's explicit approval unlocks implementation; an OKAY verdict is not approval.",
  ].join("\n");
}

export interface PlanPhaseBlock {
  artifact: PlanArtifact;
  content: string;
  /** True when the live CLI instructions were unavailable and the skeleton was used. */
  degraded: boolean;
}

/**
 * Render one phase's append-only instruction block. `instructions === undefined`
 * is the explicit degradation path (no change yet, CLI error, malformed
 * output): the block says so and falls back to the built-in skeleton.
 */
export function renderPlanPhaseBlock(
  artifact: PlanArtifact,
  instructions: OpenspecArtifactInstructions | undefined,
): PlanPhaseBlock {
  const skeleton = ARTIFACT_SKELETONS[artifact] ?? GENERIC_SKELETON;
  if (!instructions) {
    return {
      artifact,
      degraded: true,
      content: [
        `[OPSX PLAN PHASE: ${artifact}] (live CLI instructions unavailable — built-in skeleton)`,
        "Re-run `openspec instructions " +
          artifact +
          ' --change "<change-id>" --json` once the CLI answers, and follow that output over this skeleton.',
        "",
        skeleton,
        "",
        ...DECISION_COMPLETE_RULES,
      ].join("\n"),
    };
  }

  const lines = [`[OPSX PLAN PHASE: ${artifact}]`, instructions.instruction];
  if (instructions.resolvedOutputPath) {
    lines.push("", `Write to: ${instructions.resolvedOutputPath}`);
  }
  if (instructions.template) {
    lines.push("", "Template:", instructions.template);
  }
  if (instructions.rules && instructions.rules.length > 0) {
    lines.push("", "Rules:", ...instructions.rules.map((rule) => `- ${rule}`));
  }
  lines.push("", ...DECISION_COMPLETE_RULES);
  return { artifact, degraded: false, content: lines.join("\n") };
}
