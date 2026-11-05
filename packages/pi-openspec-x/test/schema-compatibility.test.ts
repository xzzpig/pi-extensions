import { compile } from "@earendil-works/pi-schema";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  registerPlanGateTools,
  OPSX_PLAN_VERDICT_TOOL_NAME,
} from "../src/plan-gate.ts";
import { reportPlanReviewTool } from "../src/report-tools.ts";

const tools: ToolDefinition[] = [];
registerPlanGateTools({
  registerTool: (tool: ToolDefinition) => tools.push(tool),
} as unknown as ExtensionAPI);
const verdictTool = tools.find(
  (tool) => tool.name === OPSX_PLAN_VERDICT_TOOL_NAME,
)!;

describe("Pi 1.5 native plan schemas", () => {
  test("parent verdict keeps optional usage and closed nested objects", () => {
    const validator = compile(verdictTool.parameters);
    expect(validator.check({ verdict: "OKAY" })).toBe(true);
    expect(validator.check({ verdict: "OKAY", extra: true })).toBe(false);
    expect(validator.check({ verdict: "OKAY", usage: { input: 1 } })).toBe(
      false,
    );
    expect(validator.check({ verdict: "UNKNOWN" })).toBe(false);
  });

  test("the host coerces native schemas and drops optional nulls", () => {
    const args = { verdict: "OKAY", blockers: "one issue", summary: null };
    expect(
      validateToolArguments(verdictTool, {
        type: "toolCall",
        id: "schema-test",
        name: verdictTool.name,
        arguments: args,
      }),
    ).toEqual({ verdict: "OKAY", blockers: ["one issue"] });
    expect(args).toEqual({
      verdict: "OKAY",
      blockers: "one issue",
      summary: null,
    });
  });

  test("child progress preserves bounds and required nested fields", () => {
    const validator = compile(reportPlanReviewTool.parameters);
    const report = { verdict: "OKAY", issues: [], summary: "Ready" };
    expect(validator.check(report)).toBe(true);
    expect(
      validator.check({
        ...report,
        progress: { phase: "review", percentage: 101 },
      }),
    ).toBe(false);
    expect(
      validator.check({
        ...report,
        progress: { phase: "review", percentage: 100 },
      }),
    ).toBe(true);
    expect(
      validator.check({
        ...report,
        progress: { phase: "review", percentage: 50, extra: true },
      }),
    ).toBe(false);
  });
});
