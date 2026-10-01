/**
 * Tests for the subagent progress projection (task 9.2).
 */
import { describe, expect, it } from "vitest";

import { createProgressObserverHandler } from "../src/progress-observer.ts";

import {
  projectProgress,
  renderProgressBoard,
  type ProgressUpdate,
  progressUpdateFrom,
} from "../src/progress-projection.ts";

function update(
  agent: string,
  phase: string,
  percentage: number,
  label = phase,
): ProgressUpdate {
  return { agent, phase, label, percentage };
}

describe("projectProgress", () => {
  it("folds repeated same-phase updates to the highest percentage", () => {
    const projected = projectProgress([
      update("opsx-reviewer", "Checking plan compliance", 20),
      update("opsx-reviewer", "Checking plan compliance", 30),
      update("opsx-reviewer", "Checking plan compliance", 25),
      update("opsx-reviewer", "Verifying evidence", 60),
    ]);
    expect(projected).toEqual([
      {
        agent: "opsx-reviewer",
        phase: "Checking plan compliance",
        label: "Checking plan compliance",
        percentage: 30,
      },
      {
        agent: "opsx-reviewer",
        phase: "Verifying evidence",
        label: "Verifying evidence",
        percentage: 60,
      },
    ]);
  });

  it("keeps first-seen order and separates different agents", () => {
    const projected = projectProgress([
      update("opsx-gap-analysis", "gap analysis", 50),
      update("opsx-plan-review", "plan review", 10),
      update("opsx-gap-analysis", "gap analysis", 80),
    ]);
    expect(projected.map((row) => `${row.agent}:${row.percentage}`)).toEqual([
      "opsx-gap-analysis:80",
      "opsx-plan-review:10",
    ]);
  });

  it("clamps out-of-range and non-finite percentages", () => {
    const projected = projectProgress([
      update("a", "p", 150),
      update("b", "p", -20),
      update("c", "p", Number.NaN),
    ]);
    expect(projected.map((row) => row.percentage)).toEqual([100, 0, 0]);
  });
});

describe("renderProgressBoard", () => {
  it("renders one line per projected row", () => {
    const board = renderProgressBoard(
      projectProgress([
        update("opsx-plan-review", "plan review", 40, "Reviewing references"),
      ]),
    );
    expect(board).toContain("opsx progress:");
    expect(board).toContain(
      "opsx-plan-review [plan review] Reviewing references — 40%",
    );
  });

  it("renders an explicit empty board", () => {
    expect(renderProgressBoard([])).toBe(
      "opsx progress: (no subagent activity)",
    );
  });
});

describe("progressUpdateFrom", () => {
  it("reads the structured progress of a report tool", () => {
    expect(
      progressUpdateFrom("report_work", {
        progress: { phase: "verifying", percentage: 80, label: "npm test" },
      }),
    ).toEqual({
      agent: "opsx-worker",
      phase: "verifying",
      label: "npm test",
      percentage: 80,
    });
  });

  it("defaults the label to the phase name", () => {
    expect(
      progressUpdateFrom("report_gap_analysis", {
        progress: { phase: "analyzing", percentage: 40 },
      }),
    ).toMatchObject({ agent: "opsx-gap-analysis", label: "analyzing" });
    expect(
      progressUpdateFrom("report_plan_review", {
        progress: { phase: "reviewing", percentage: 10 },
      }),
    ).toMatchObject({ agent: "opsx-plan-review" });
  });

  it("ignores reports without progress or with a malformed field", () => {
    expect(progressUpdateFrom("report_work", {})).toBeUndefined();
    expect(
      progressUpdateFrom("report_work", { progress: { phase: "x" } }),
    ).toBeUndefined();
    expect(
      progressUpdateFrom("report_work", {
        progress: { phase: "", percentage: 10 },
      }),
    ).toBeUndefined();
    expect(
      progressUpdateFrom("report_work", {
        progress: { phase: "x", percentage: Number.NaN },
      }),
    ).toBeUndefined();
    expect(
      progressUpdateFrom("read", { progress: { phase: "x", percentage: 1 } }),
    ).toBeUndefined();
  });
});

describe("createProgressObserverHandler", () => {
  it("folds report-tool progress into a board entry per session", () => {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const pi = {
      appendEntry(customType: string, data?: unknown) {
        appended.push({ customType, data });
      },
    };
    const handler = createProgressObserverHandler(pi as never);
    const ctx = {
      sessionManager: { getSessionId: () => "s1" },
    };
    handler(
      {
        toolName: "report_work",
        input: { progress: { phase: "editing", percentage: 50 } },
        isError: false,
      } as never,
      ctx as never,
    );
    handler(
      {
        toolName: "report_work",
        input: { progress: { phase: "editing", percentage: 90 } },
        isError: false,
      } as never,
      ctx as never,
    );
    // Same agent+phase folds into one row at the highest percentage.
    expect(appended).toHaveLength(2);
    const board = appended.at(-1)?.data as { rows: unknown[] };
    expect(board.rows).toEqual([
      {
        agent: "opsx-worker",
        phase: "editing",
        label: "editing",
        percentage: 90,
      },
    ]);
  });

  it("ignores non-report tools, errors and reports without progress", () => {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const handler = createProgressObserverHandler({
      appendEntry(customType: string, data?: unknown) {
        appended.push({ customType, data });
      },
    } as never);
    const ctx = { sessionManager: { getSessionId: () => "s1" } };
    handler(
      { toolName: "read", input: {}, isError: false } as never,
      ctx as never,
    );
    handler(
      {
        toolName: "report_work",
        input: { progress: { phase: "x", percentage: 1 } },
        isError: true,
      } as never,
      ctx as never,
    );
    handler(
      { toolName: "report_work", input: {}, isError: false } as never,
      ctx as never,
    );
    expect(appended).toEqual([]);
  });
});
