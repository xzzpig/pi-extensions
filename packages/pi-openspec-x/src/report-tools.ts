/**
 * Structured reporting tools the opsx subagents submit their results through
 * (design D3; spec "结构化裁决上报").
 *
 * Three child-facing tools are registered into the running pi process at
 * extension init, one per reporting subagent role:
 *
 * - `report_gap_analysis` (opsx-gap-analysis): pre-planning gap analysis;
 * - `report_plan_review` (opsx-plan-review): work-plan verdict OKAY/ITERATE/REJECT;
 * - `report_work` (opsx-worker): per-task completion report with evidence.
 *
 * Gates read the structured arguments, never the child's free text: a payload
 * that does not satisfy the schema is rejected by the host's tool-argument
 * validation before `execute` runs, so an invalid verdict can never reach a
 * gate. The opsx-reviewer has deliberately NO plugin-side verdict tool — its
 * final ruling goes through the execution base's structured_output channel
 * (design D3/D10); it only reports progress through goal-x's
 * `report_auditor_progress`.
 *
 * Tool results stay short: they are appended to the subagent's context, so a
 * one-line confirmation plus the structured payload in `details` is all a
 * call returns. There is no progress bar here — a tool may be called any
 * number of times; projection of the calls is a later concern.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REPORT_GAP_ANALYSIS_TOOL_NAME = "report_gap_analysis";
export const REPORT_PLAN_REVIEW_TOOL_NAME = "report_plan_review";
export const REPORT_WORK_TOOL_NAME = "report_work";

/**
 * One located finding. `location` is free-form ("src/cli.ts:42",
 * "tasks.md#Step 3") because artifact sections do not always map to lines.
 */
const findingItem = Type.Object(
  {
    description: Type.String({
      description:
        "The finding itself, specific enough to act on without re-deriving it.",
    }),
    location: Type.Optional(
      Type.String({
        description:
          "Where the finding applies: file path, and line or section when known.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Structured progress (spec: 子 agent 的过程进度 MUST 经结构化上报 —— 阶段标签 +
 * 百分比，或等效字段). Optional: a report that carries no progress simply leaves
 * the parent's board unchanged.
 */
const progressField = Type.Optional(
  Type.Object(
    {
      phase: Type.String({
        description:
          "The stage this update belongs to, e.g. reading, analyzing, editing, verifying.",
      }),
      percentage: Type.Number({
        description: "How far through this stage the agent is, 0 to 100.",
        minimum: 0,
        maximum: 100,
      }),
      label: Type.Optional(
        Type.String({
          description:
            "Short human-readable detail for the board; defaults to the phase name.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
);

const gapAnalysisParams = Type.Object(
  {
    progress: progressField,
    intentType: Type.String({
      description:
        "Classified user intent, e.g. refactor, build-from-scratch, mid-sized, collaborative, architecture, or research.",
    }),
    confidence: Type.Number({
      description: "Confidence in the intent classification, from 0 to 1.",
      minimum: 0,
      maximum: 1,
    }),
    contradictions: Type.Array(findingItem, {
      description: "Requirements or statements that conflict with each other.",
    }),
    missingConstraints: Type.Array(findingItem, {
      description:
        "Constraints the request implies but never states (platform, compatibility, performance, security, ...).",
    }),
    scopeRisks: Type.Array(findingItem, {
      description:
        "Scope-inflation or gold-plating risks, including premature abstraction and over-validation.",
    }),
    unvalidatedAssumptions: Type.Array(findingItem, {
      description:
        "Assumptions the plan relies on without evidence (environment, behavior, availability).",
    }),
    missingAcceptanceCriteria: Type.Array(findingItem, {
      description:
        "Outcomes that lack an agent-executable acceptance criterion (no 'user manually tests' criteria).",
    }),
    summary: Type.String({
      description: "One-paragraph synthesis of the analysis.",
    }),
  },
  { additionalProperties: false },
);

const planReviewParams = Type.Object(
  {
    progress: progressField,
    verdict: Type.Union(
      [Type.Literal("OKAY"), Type.Literal("ITERATE"), Type.Literal("REJECT")],
      {
        description:
          "OKAY: executable as written. ITERATE: workable after targeted, non-blocking revisions. REJECT: not executable as written.",
      },
    ),
    issues: Type.Array(
      Type.Object(
        {
          severity: Type.Union(
            [
              Type.Literal("blocker"),
              Type.Literal("major"),
              Type.Literal("minor"),
            ],
            { description: "How badly the issue threatens execution." },
          ),
          file: Type.Optional(
            Type.String({
              description: "Plan file the issue applies to, when located.",
            }),
          ),
          line: Type.Optional(
            Type.Number({
              description: "Line number in that file, when known.",
            }),
          ),
          description: Type.String({
            description:
              "The issue, concrete and actionable (what to change, not a taste judgment).",
          }),
          blocking: Type.Boolean({
            description:
              "True only for REJECT blockers; ITERATE/OKAY issues are never blocking.",
          }),
        },
        { additionalProperties: false },
      ),
      { description: "Found issues; may be empty for a clean OKAY." },
    ),
    summary: Type.String({
      description:
        "One-paragraph verdict rationale; for REJECT it must reference which earlier blockers (if any) are now resolved.",
    }),
  },
  { additionalProperties: false },
);

const workReportParams = Type.Object(
  {
    progress: progressField,
    taskId: Type.String({
      description: "The dispatched task identifier (e.g. the tasks.md item).",
    }),
    changedFiles: Type.Array(Type.String(), {
      description:
        "Every file this task created or modified, with paths relative to the project root.",
    }),
    claims: Type.String({
      description:
        "What was done and what the result is. Only claims backed by evidence below.",
    }),
    selfVerification: Type.Object(
      {
        command: Type.Optional(
          Type.String({
            description:
              "The verification command actually run (e.g. build/test).",
          }),
        ),
        result: Type.Optional(
          Type.String({
            description:
              "The real command output summary (exit status, failing/passing counts). Never invented.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    verificationPassed: Type.Optional(
      Type.Boolean({
        description:
          "Structured verdict: whether the verification actually passed. When provided the gate trusts it and does not parse the result text; when absent the result text is scanned heuristically.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Count of non-empty finding lists, for the one-line confirmation text. */
function countFindings(params: {
  contradictions: unknown[];
  missingConstraints: unknown[];
  scopeRisks: unknown[];
  unvalidatedAssumptions: unknown[];
  missingAcceptanceCriteria: unknown[];
}): number {
  return (
    params.contradictions.length +
    params.missingConstraints.length +
    params.scopeRisks.length +
    params.unvalidatedAssumptions.length +
    params.missingAcceptanceCriteria.length
  );
}

/** The gap-analysis tool (opsx-gap-analysis's reporting channel). */
export const reportGapAnalysisTool = defineTool({
  name: REPORT_GAP_ANALYSIS_TOOL_NAME,
  label: "Report Gap Analysis",
  description:
    "Submit the pre-planning gap analysis (intent classification, contradictions, missing constraints, scope risks, unvalidated assumptions, missing acceptance criteria) to the parent orchestrator.",
  promptSnippet: "Submit the structured pre-planning gap analysis.",
  promptGuidelines: [
    "Submit your complete analysis through this tool; the parent only reads the structured fields.",
    "Call it again whenever the analysis changes — later submissions supersede earlier ones.",
  ],
  parameters: gapAnalysisParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    return {
      content: [
        {
          type: "text",
          text: `Gap analysis recorded: intent ${params.intentType} (confidence ${params.confidence}), ${countFindings(params)} findings.`,
        },
      ],
      details: params,
    };
  },
});

/** The plan-review tool (opsx-plan-review's verdict channel). */
export const reportPlanReviewTool = defineTool({
  name: REPORT_PLAN_REVIEW_TOOL_NAME,
  label: "Report Plan Review",
  description:
    "Submit the work-plan review verdict (OKAY/ITERATE/REJECT) with the issue list to the parent orchestrator.",
  promptSnippet: "Submit the structured plan review verdict.",
  promptGuidelines: [
    "The parent gates on the verdict field; free text is never parsed.",
    "REJECT carries at most 3 blocking issues, each new relative to your previous review rounds.",
  ],
  parameters: planReviewParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    const blocking = params.issues.filter((issue) => issue.blocking).length;
    return {
      content: [
        {
          type: "text",
          text: `Plan review recorded: verdict ${params.verdict} (${params.issues.length} issues, ${blocking} blocking).`,
        },
      ],
      details: params,
    };
  },
});

/** The work-report tool (opsx-worker's completion channel). */
export const reportWorkTool = defineTool({
  name: REPORT_WORK_TOOL_NAME,
  label: "Report Work",
  description:
    "Submit the completed-task report (task id, changed files, completion claims, self-verification evidence) to the parent orchestrator.",
  promptSnippet: "Submit the structured completion report for a task.",
  promptGuidelines: [
    "Report every file you changed; the parent reviews the diff against these claims.",
    "Self-verification must carry real command output, never an invented result.",
  ],
  parameters: workReportParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    return {
      content: [
        {
          type: "text",
          text: `Work report recorded for task ${params.taskId} (${params.changedFiles.length} changed files).`,
        },
      ],
      details: params,
    };
  },
});

/** The three reporting tools, in registration order. */
export function createReportTools() {
  return [reportGapAnalysisTool, reportPlanReviewTool, reportWorkTool];
}

/** Register the three reporting tools into the running pi process. */
export function registerReportTools(pi: ExtensionAPI): void {
  for (const tool of createReportTools()) {
    pi.registerTool(tool);
  }
}
