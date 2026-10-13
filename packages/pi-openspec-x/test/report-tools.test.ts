/**
 * Reporting-tool tests (design D3; spec "结构化裁决上报").
 *
 * Schema validation runs through pi-ai's `validateToolArguments` — the same
 * validator the host applies to tool calls — so "an invalid verdict is
 * rejected" is pinned against the real gate, not a reimplementation. The
 * registration roundtrip uses a fake pi capturing registerTool, and the
 * execute calls pin the short child-facing confirmation text.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  validateToolArguments,
  type ToolCall,
  type Tool,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";

import {
  CHILD_REPORT_ATTEMPT_ENTRY,
  CHILD_REPORT_ATTEMPT_VERSION,
  CHILD_REPORT_ENVELOPE_VERSION,
  scanDispatchMarkers,
} from "../src/child-report-reader.ts";
import {
  createReportTools,
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

describe("child-only registration (design D1)", () => {
  /** Minimal pi capturing registrations; only the hooks we assert on are kept. */
  function capturePi() {
    const tools: ToolDefinition[] = [];
    const beforeStart: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const entries: Array<{ customType: string; data: unknown }> = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => {
        tools.push(tool);
      },
      on: (
        event: string,
        handler: (event: unknown, ctx: unknown) => unknown,
      ) => {
        if (event === "before_agent_start") beforeStart.push(handler);
        return () => {};
      },
      appendEntry: (customType: string, data?: unknown) => {
        entries.push({ customType, data });
      },
    } as unknown as ExtensionAPI;
    return { pi, tools, beforeStart, entries };
  }

  const ctx = {
    sessionManager: { getSessionId: () => "child-session-1" },
  } as unknown as ExtensionContext;

  const ENTRIES = [
    {
      module: "../src/child-report-extensions/gap-analysis.ts",
      agent: "opsx-gap-analysis",
      toolName: REPORT_GAP_ANALYSIS_TOOL_NAME,
      params: validGapAnalysis,
    },
    {
      module: "../src/child-report-extensions/plan-review.ts",
      agent: "opsx-plan-review",
      toolName: REPORT_PLAN_REVIEW_TOOL_NAME,
      params: validPlanReview,
    },
    {
      module: "../src/child-report-extensions/worker.ts",
      agent: "opsx-worker",
      toolName: REPORT_WORK_TOOL_NAME,
      params: validWorkReport,
    },
  ] as const;

  test("each role entry registers exactly its own tool plus the attempt hook", async () => {
    for (const entry of ENTRIES) {
      const captured = capturePi();
      const mod = (await import(entry.module)) as {
        default: (pi: ExtensionAPI) => void;
      };
      mod.default(captured.pi);
      expect(captured.tools.map((tool) => tool.name)).toEqual([entry.toolName]);
      expect(captured.tools[0].executionMode).toBe("sequential");
      expect(captured.beforeStart).toHaveLength(1);
    }
  });

  test("the attempt hook records a v1 attempt entry with a fresh nonce", async () => {
    const captured = capturePi();
    const mod = (await import(ENTRIES[0].module)) as {
      default: (pi: ExtensionAPI) => void;
    };
    mod.default(captured.pi);
    captured.beforeStart[0](
      { type: "before_agent_start", prompt: "analyse the request" },
      ctx,
    );
    expect(captured.entries).toHaveLength(1);
    const entry = captured.entries[0];
    expect(entry.customType).toBe(CHILD_REPORT_ATTEMPT_ENTRY);
    const data = entry.data as {
      version: number;
      attemptId: string;
      agent: string;
      sessionId?: string;
      promptSha256: string;
      taskMarker?: string;
    };
    expect(data.version).toBe(CHILD_REPORT_ATTEMPT_VERSION);
    expect(data.agent).toBe("opsx-gap-analysis");
    expect(data.sessionId).toBe("child-session-1");
    expect(data.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.taskMarker).toBeUndefined();
  });

  test("a new prompt gets a new nonce and never inherits the previous one", async () => {
    const captured = capturePi();
    const mod = (await import(ENTRIES[2].module)) as {
      default: (pi: ExtensionAPI) => void;
    };
    mod.default(captured.pi);
    const marker = `[OPSX WORKER DISPATCH task=${encodeURIComponent("1.1")}]`;
    captured.beforeStart[0](
      { type: "before_agent_start", prompt: `Task: ${marker}` },
      ctx,
    );
    captured.beforeStart[0](
      { type: "before_agent_start", prompt: `Resume: ${marker}` },
      ctx,
    );
    const [first, second] = captured.entries.map(
      (e) =>
        e.data as {
          attemptId: string;
          taskMarker?: string;
        },
    );
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.taskMarker).toBe("1.1");
    expect(second.taskMarker).toBe("1.1");
  });

  test("the wrapped execute returns the envelope with the current attempt nonce", async () => {
    const captured = capturePi();
    const mod = (await import(ENTRIES[1].module)) as {
      default: (pi: ExtensionAPI) => void;
    };
    mod.default(captured.pi);
    captured.beforeStart[0](
      { type: "before_agent_start", prompt: "review the plan" },
      ctx,
    );
    const attemptId = (captured.entries[0].data as { attemptId: string })
      .attemptId;
    const result = await captured.tools[0].execute(
      "call-envelope",
      validPlanReview as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content[0]).toMatchObject({
      text: "Plan review recorded: verdict OKAY (0 issues, 0 blocking).",
    });
    expect(result.isError).toBeFalsy();
    expect(result.details).toEqual({
      version: CHILD_REPORT_ENVELOPE_VERSION,
      attemptId,
      agent: "opsx-plan-review",
      report: validPlanReview,
    });
  });

  test("a report without a recorded attempt fails loudly instead of faking success", async () => {
    const captured = capturePi();
    const mod = (await import(ENTRIES[2].module)) as {
      default: (pi: ExtensionAPI) => void;
    };
    mod.default(captured.pi);
    // No before_agent_start fired: nothing is attributable this turn.
    const result = await captured.tools[0].execute(
      "call-unattributable",
      validWorkReport as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.details)).toContain("attempt-unavailable");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Report rejected"),
    });
  });

  test("an attempt whose entry write throws is not reportable", async () => {
    const captured = capturePi();
    const failingPi = {
      ...captured.pi,
      appendEntry: () => {
        throw new Error("session is read-only");
      },
    } as unknown as ExtensionAPI;
    const mod = (await import(ENTRIES[0].module)) as {
      default: (pi: ExtensionAPI) => void;
    };
    mod.default(failingPi);
    captured.beforeStart[0](
      { type: "before_agent_start", prompt: "analyse" },
      ctx,
    );
    const result = await captured.tools[0].execute(
      "call-write-failed",
      validGapAnalysis as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.isError).toBe(true);
  });

  test("the dispatch marker is read wherever it appears, and ambiguity is visible", () => {
    expect(
      scanDispatchMarkers(
        `Task: [OPSX WORKER DISPATCH task=${encodeURIComponent("2.3")}] rest`,
      ),
    ).toEqual(["2.3"]);
    expect(scanDispatchMarkers("no marker here")).toEqual([]);
    expect(
      scanDispatchMarkers(
        `[OPSX WORKER DISPATCH task=1.1] and [OPSX WORKER DISPATCH task=1.2]`,
      ),
    ).toEqual(["1.1", "1.2"]);
    expect(
      scanDispatchMarkers(
        `[OPSX WORKER DISPATCH task=${encodeURIComponent("1.1")}] repeated [OPSX WORKER DISPATCH task=${encodeURIComponent("1.1")}]`,
      ),
    ).toEqual(["1.1"]);
  });
});

describe("registration surface", () => {
  test("no batch registration helper is exported any more", async () => {
    const mod = (await import("../src/report-tools.ts")) as Record<
      string,
      unknown
    >;
    expect(mod.registerReportTools).toBeUndefined();
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
