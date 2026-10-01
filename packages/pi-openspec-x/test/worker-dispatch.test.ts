/**
 * Tests for the worker dispatch contract and the tick gate (task 8.2).
 */
import { describe, expect, it } from "vitest";

import {
  decideTaskTick,
  detectStalledDispatch,
  STANDARD_WORKER_MUST_NOT_DO,
  type WorkReportLike,
} from "../src/worker-dispatch.ts";

function report(overrides: Partial<WorkReportLike> = {}): WorkReportLike {
  return {
    taskId: "1.1",
    changedFiles: ["src/a.ts"],
    claims: "Implemented a.",
    selfVerification: { command: "pnpm test", result: "12 passed" },
    ...overrides,
  };
}

describe("decideTaskTick", () => {
  const cleanReview = {
    observedChangedFiles: ["src/a.ts"],
    verification: { ran: true, passed: true, evidence: "12 passed" },
  };

  it("ticks a reconciled, verified dispatch", () => {
    expect(decideTaskTick(report(), cleanReview)).toEqual({
      kind: "tick",
      taskId: "1.1",
      evidence: "12 passed",
    });
  });

  it("holds when no report was submitted", () => {
    expect(decideTaskTick(undefined, cleanReview)).toMatchObject({
      kind: "hold",
    });
  });

  it("holds on phantom claimed files and on unclaimed changed files", () => {
    expect(
      decideTaskTick(
        report({ changedFiles: ["src/a.ts", "src/ghost.ts"] }),
        cleanReview,
      ),
    ).toMatchObject({ kind: "hold" });
    expect(
      decideTaskTick(report(), {
        ...cleanReview,
        observedChangedFiles: ["src/a.ts", "src/extra.ts"],
      }),
    ).toMatchObject({ kind: "hold" });
  });

  it("holds until verification ran and passed", () => {
    expect(
      decideTaskTick(report(), {
        ...cleanReview,
        verification: { ran: false, passed: false },
      }),
    ).toMatchObject({ kind: "hold" });
    expect(
      decideTaskTick(report(), {
        ...cleanReview,
        verification: { ran: true, passed: false, evidence: "3 failed" },
      }),
    ).toMatchObject({ kind: "hold" });
  });

  it("normalizes path separators before comparing", () => {
    expect(
      decideTaskTick(report({ changedFiles: [".\\src\\a.ts"] }), cleanReview),
    ).toMatchObject({ kind: "tick" });
  });
});

describe("detectStalledDispatch", () => {
  it("flags a task that spins twice without progress", () => {
    expect(
      detectStalledDispatch([
        { taskId: "1.1", changedFiles: 0, ticked: false },
        { taskId: "1.1", changedFiles: 0, ticked: false },
      ]),
    ).toEqual({ stalled: true, taskIds: ["1.1"] });
  });

  it("does not flag progress or a single empty dispatch", () => {
    expect(
      detectStalledDispatch([
        { taskId: "1.1", changedFiles: 0, ticked: false },
        { taskId: "1.1", changedFiles: 1, ticked: false },
        { taskId: "1.2", changedFiles: 0, ticked: false },
        { taskId: "1.2", changedFiles: 0, ticked: true },
      ]),
    ).toEqual({ stalled: false, taskIds: [] });
  });
});
