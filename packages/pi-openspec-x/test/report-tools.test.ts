/**
 * Reporting-tool tests (design D3; spec "结构化裁决上报").
 *
 * Schema validation runs through pi-ai's `validateToolArguments` — the same
 * validator the host applies to tool calls — so "an invalid verdict is
 * rejected" is pinned against the real gate, not a reimplementation. The
 * registration roundtrip uses a fake pi capturing registerTool, and the
 * execute calls pin the short child-facing confirmation text.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  validateToolArguments,
  type ToolCall,
  type Tool,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";

import {
  createReportTools,
  registerReportTools,
  REPORT_GAP_ANALYSIS_TOOL_NAME,
  REPORT_PLAN_REVIEW_TOOL_NAME,
  REPORT_WORK_TOOL_NAME,
  reportGapAnalysisTool,
  reportPlanReviewTool,
  reportWorkTool,
} from "../src/report-tools.ts";

/** The tools keyed by name, for name-driven validation calls. */
const TOOLS: Record<string, Tool> = Object.fromEntries(
  createReportTools().map((tool) => [tool.name, tool as Tool]),
);

/** Validate raw tool-call arguments exactly like the host does. */
function validate(toolName: string, args: Record<string, unknown>) {
  const toolCall = {
    type: "toolCall",
    id: "test-call",
    name: toolName,
    arguments: args,
  } as ToolCall;
  return validateToolArguments(TOOLS[toolName], toolCall);
}

const validGapAnalysis = {
  intentType: "refactor",
  confidence: 0.8,
  contradictions: [
    { description: "A says X, B says not-X", location: "a.md:1" },
  ],
  missingConstraints: [],
  scopeRisks: [{ description: "Invites a framework rewrite" }],
  unvalidatedAssumptions: [],
  missingAcceptanceCriteria: [
    { description: "No agent-executable check for the export format" },
  ],
  summary: "Mostly sound request with one contradiction.",
};

const validPlanReview = {
  verdict: "OKAY",
  issues: [],
  summary: "Workable as written.",
};

const validWorkReport = {
  taskId: "T-1",
  changedFiles: ["src/a.ts", "src/b.ts"],
  claims: "Implemented the parser and covered it with tests.",
  selfVerification: {
    command: "pnpm test",
    result: "exit 0, 42 passed, 0 failed",
  },
};

describe("report_gap_analysis schema", () => {
  test("a valid payload passes host-identical validation", () => {
    expect(
      validate(REPORT_GAP_ANALYSIS_TOOL_NAME, validGapAnalysis),
    ).toMatchObject({ intentType: "refactor" });
  });

  test("out-of-range confidence is rejected", () => {
    expect(() =>
      validate(REPORT_GAP_ANALYSIS_TOOL_NAME, {
        ...validGapAnalysis,
        confidence: 1.5,
      }),
    ).toThrow();
    expect(() =>
      validate(REPORT_GAP_ANALYSIS_TOOL_NAME, {
        ...validGapAnalysis,
        confidence: -0.1,
      }),
    ).toThrow();
  });

  test("missing required fields are rejected", () => {
    const { summary: _summary, ...withoutSummary } = validGapAnalysis;
    expect(() =>
      validate(REPORT_GAP_ANALYSIS_TOOL_NAME, withoutSummary),
    ).toThrow();
    expect(() =>
      validate(REPORT_GAP_ANALYSIS_TOOL_NAME, {
        ...validGapAnalysis,
        missingAcceptanceCriteria: undefined,
      }),
    ).toThrow();
  });

  test("unknown properties are rejected", () => {
    expect(() =>
      validate(REPORT_GAP_ANALYSIS_TOOL_NAME, {
        ...validGapAnalysis,
        extra: true,
      }),
    ).toThrow();
  });

  test("finding items with unknown properties are rejected", () => {
    expect(() =>
      validate(REPORT_GAP_ANALYSIS_TOOL_NAME, {
        ...validGapAnalysis,
        scopeRisks: [{ description: "x", severity: "high" }],
      }),
    ).toThrow();
  });
});

describe("report_plan_review schema", () => {
  test("a valid payload passes host-identical validation", () => {
    expect(
      validate(REPORT_PLAN_REVIEW_TOOL_NAME, validPlanReview),
    ).toMatchObject({ verdict: "OKAY" });
  });

  test("an invalid verdict is rejected by the schema", () => {
    for (const verdict of ["PASS", "okay", "Approved", 1, null]) {
      expect(() =>
        validate(REPORT_PLAN_REVIEW_TOOL_NAME, { ...validPlanReview, verdict }),
      ).toThrow();
    }
  });

  test("all three legal verdicts validate", () => {
    for (const verdict of ["OKAY", "ITERATE", "REJECT"]) {
      expect(
        validate(REPORT_PLAN_REVIEW_TOOL_NAME, { ...validPlanReview, verdict }),
      ).toMatchObject({ verdict });
    }
  });

  test("an invalid issue severity is rejected", () => {
    expect(() =>
      validate(REPORT_PLAN_REVIEW_TOOL_NAME, {
        ...validPlanReview,
        issues: [
          {
            severity: "critical",
            description: "boom",
            blocking: true,
          },
        ],
      }),
    ).toThrow();
  });

  test("issue entries missing blocking or description are rejected", () => {
    expect(() =>
      validate(REPORT_PLAN_REVIEW_TOOL_NAME, {
        ...validPlanReview,
        issues: [{ severity: "blocker", description: "boom" }],
      }),
    ).toThrow();
    expect(() =>
      validate(REPORT_PLAN_REVIEW_TOOL_NAME, {
        ...validPlanReview,
        issues: [{ severity: "blocker", blocking: true }],
      }),
    ).toThrow();
  });

  test("a fully populated REJECT issue validates", () => {
    expect(
      validate(REPORT_PLAN_REVIEW_TOOL_NAME, {
        verdict: "REJECT",
        issues: [
          {
            severity: "blocker",
            file: "tasks.md",
            line: 12,
            description: "Task 3 cites src/missing.ts, which does not exist",
            blocking: true,
          },
        ],
        summary: "Not executable as written.",
      }),
    ).toMatchObject({ verdict: "REJECT" });
  });
});

describe("report_work schema", () => {
  test("a valid payload passes host-identical validation", () => {
    expect(validate(REPORT_WORK_TOOL_NAME, validWorkReport)).toMatchObject({
      taskId: "T-1",
    });
  });

  test("missing selfVerification or taskId is rejected", () => {
    const { selfVerification: _sv, ...withoutVerification } = validWorkReport;
    expect(() =>
      validate(REPORT_WORK_TOOL_NAME, withoutVerification),
    ).toThrow();
    const { taskId: _taskId, ...withoutTaskId } = validWorkReport;
    expect(() => validate(REPORT_WORK_TOOL_NAME, withoutTaskId)).toThrow();
  });

  test("array items follow host coercion: numbers coerce, objects are rejected", () => {
    // The host validator coerces primitives for LLM robustness — pin that
    // gates never see a non-string slipped through as an object.
    expect(
      validate(REPORT_WORK_TOOL_NAME, {
        ...validWorkReport,
        changedFiles: [42],
      }),
    ).toMatchObject({ changedFiles: ["42"] });
    expect(() =>
      validate(REPORT_WORK_TOOL_NAME, {
        ...validWorkReport,
        changedFiles: [{ path: "src/a.ts" }],
      }),
    ).toThrow();
  });
});

describe("registration roundtrip", () => {
  test("registerReportTools registers the three tools sequentially", () => {
    const registered: Array<{ name: string; executionMode?: string }> = [];
    const fakePi = {
      registerTool: (tool: { name: string; executionMode?: string }) => {
        registered.push(tool);
      },
    } as unknown as ExtensionAPI;

    registerReportTools(fakePi);

    expect(registered.map((tool) => tool.name)).toEqual([
      REPORT_GAP_ANALYSIS_TOOL_NAME,
      REPORT_PLAN_REVIEW_TOOL_NAME,
      REPORT_WORK_TOOL_NAME,
    ]);
    expect(
      registered.every((tool) => tool.executionMode === "sequential"),
    ).toBe(true);
  });

  test("every tool carries a parameter schema and a description", () => {
    for (const tool of createReportTools()) {
      expect(tool.parameters).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.label.length).toBeGreaterThan(0);
    }
  });
});

describe("execute confirmations", () => {
  /** First text content of a tool result (all our results are text-only). */
  function resultText(result: {
    content: Array<{ type: string; text?: string }>;
  }): string {
    return result.content[0]?.text ?? "";
  }

  test("gap analysis returns a one-line confirmation and echoes details", async () => {
    const result = await reportGapAnalysisTool.execute(
      "call-1",
      validGapAnalysis as never,
      undefined,
      undefined,
      {} as never,
    );
    const text = resultText(result);
    expect(text).toMatch(/^Gap analysis recorded: intent refactor/);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(200);
    expect(result.details).toEqual(validGapAnalysis);
  });

  test("plan review reports the verdict and blocking count", async () => {
    const result = await reportPlanReviewTool.execute(
      "call-2",
      {
        verdict: "REJECT",
        issues: [
          { severity: "blocker", description: "a", blocking: true },
          { severity: "minor", description: "b", blocking: false },
        ],
        summary: "Not executable.",
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(resultText(result)).toBe(
      "Plan review recorded: verdict REJECT (2 issues, 1 blocking).",
    );
  });

  test("work report names the task and file count", async () => {
    const result = await reportWorkTool.execute(
      "call-3",
      validWorkReport as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(resultText(result)).toBe(
      "Work report recorded for task T-1 (2 changed files).",
    );
  });
});
