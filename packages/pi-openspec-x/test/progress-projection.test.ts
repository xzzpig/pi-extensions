/**
 * Tests for the subagent progress projection (task 9.2).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  progressBoardFor,
  recordChildReportProgress,
  resetProgressObserverForTests,
} from "../src/progress-observer.ts";

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

describe("recordChildReportProgress", () => {
  function recorder() {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    return {
      appended,
      pi: {
        appendEntry(customType: string, data?: unknown) {
          appended.push({ customType, data });
        },
      },
    };
  }

  beforeEach(() => {
    resetProgressObserverForTests();
  });

  it("projects two real progress updates in order", () => {
    const { appended, pi } = recorder();
    const first = recordChildReportProgress(pi as never, "s1", {
      toolName: "report_gap_analysis",
      report: { progress: { phase: "analyzing", percentage: 40 } },
    });
    const second = recordChildReportProgress(pi as never, "s1", {
      toolName: "report_plan_review",
      report: { progress: { phase: "reviewing", percentage: 10 } },
    });
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(appended).toHaveLength(2);
    // Both rows survive, in first-seen order.
    expect(progressBoardFor("s1")).toEqual([
      {
        agent: "opsx-gap-analysis",
        phase: "analyzing",
        label: "analyzing",
        percentage: 40,
      },
      {
        agent: "opsx-plan-review",
        phase: "reviewing",
        label: "reviewing",
        percentage: 10,
      },
    ]);
  });

  it("folds a higher percentage for the same agent+phase into one row", () => {
    const { appended, pi } = recorder();
    recordChildReportProgress(pi as never, "s1", {
      toolName: "report_work",
      report: { progress: { phase: "editing", percentage: 50 } },
    });
    recordChildReportProgress(pi as never, "s1", {
      toolName: "report_work",
      report: { progress: { phase: "editing", percentage: 90 } },
    });
    expect(appended).toHaveLength(2);
    expect(progressBoardFor("s1")).toEqual([
      {
        agent: "opsx-worker",
        phase: "editing",
        label: "editing",
        percentage: 90,
      },
    ]);
  });

  it("a duplicate update is not appended again", () => {
    const { appended, pi } = recorder();
    const update = {
      toolName: "report_work",
      report: { progress: { phase: "editing", percentage: 50 } },
    };
    expect(recordChildReportProgress(pi as never, "s1", update)).toBe(true);
    // Re-delivery of the same report must not grow the board.
    expect(recordChildReportProgress(pi as never, "s1", update)).toBe(false);
    expect(appended).toHaveLength(1);
  });

  it("ignores non-report tools and reports without progress", () => {
    const { appended, pi } = recorder();
    expect(
      recordChildReportProgress(pi as never, "s1", {
        toolName: "read",
        report: { progress: { phase: "x", percentage: 1 } },
      }),
    ).toBe(false);
    expect(
      recordChildReportProgress(pi as never, "s1", {
        toolName: "report_work",
        report: {},
      }),
    ).toBe(false);
    expect(
      recordChildReportProgress(pi as never, "s1", {
        toolName: "report_work",
        report: { progress: { phase: "", percentage: 10 } },
      }),
    ).toBe(false);
    expect(appended).toEqual([]);
  });

  it("boards are per session and touch nothing but progress entries", () => {
    const { appended, pi } = recorder();
    recordChildReportProgress(pi as never, "s1", {
      toolName: "report_work",
      report: { progress: { phase: "editing", percentage: 50 } },
    });
    recordChildReportProgress(pi as never, "s2", {
      toolName: "report_work",
      report: { progress: { phase: "verifying", percentage: 70 } },
    });
    expect(progressBoardFor("s1")).toHaveLength(1);
    expect(progressBoardFor("s2")).toHaveLength(1);
    expect(progressBoardFor("s1")[0]!.phase).toBe("editing");
    // Progress never writes a task tick or an approval — display only.
    for (const entry of appended) {
      expect(entry.customType).toContain("progress");
    }
  });
});
