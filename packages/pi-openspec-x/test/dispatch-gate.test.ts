/**
 * Tests for the enforced "review before tick" gate (task 8.2).
 */
import { describe, expect, it } from "vitest";

import {
  DispatchReviewTracker,
  evaluateTickGate,
} from "../src/dispatch-gate.ts";

function report(
  taskId: string,
  changedFiles: string[],
  result?: string,
): {
  taskId: string;
  changedFiles: string[];
  claims: string;
  selfVerification: { command?: string; result?: string };
} {
  return {
    taskId,
    changedFiles,
    claims: "did the task",
    selfVerification: { command: "npm test", ...(result ? { result } : {}) },
  };
}

describe("DispatchReviewTracker", () => {
  it("records dispatches, reports and ticks", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    expect(tracker.dispatched("1.1")).toBe(true);
    expect(tracker.reportFor("1.1")).toBeUndefined();

    tracker.rememberReport(report("1.1", ["src/a.ts", "src/b.ts"]));
    expect(tracker.reportFor("1.1")?.changedFiles).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(tracker.traces()).toEqual([
      { taskId: "1.1", changedFiles: 2, ticked: false },
    ]);

    tracker.noteTick("1.1");
    expect(tracker.traces()[0]!.ticked).toBe(true);
  });

  it("detects a task dispatched repeatedly with no reported work", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.noteDispatch("1.1");
    expect(tracker.stalled()).toEqual(["1.1"]);

    // A tick or a reported change resets the stall.
    const progressed = new DispatchReviewTracker();
    progressed.noteDispatch("1.1");
    progressed.rememberReport(report("1.1", ["src/a.ts"]));
    progressed.noteDispatch("1.1");
    expect(progressed.stalled()).toEqual([]);
  });

  it("counts a dispatch whose payload never named the task", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch(undefined);
    // The gate must not deadlock on a task-id parsing miss.
    expect(tracker.dispatched("1.1")).toBe(true);
    expect(tracker.traces()).toEqual([
      { taskId: "<unknown>", changedFiles: 0, ticked: false },
    ]);
  });

  it("attaches a report to the most recent dispatch of that task", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch(undefined);
    tracker.rememberReport(report("1.1", ["src/a.ts"], "ok"));
    expect(tracker.reportFor("1.1")?.changedFiles).toEqual(["src/a.ts"]);
    expect(tracker.traces()[0]!.changedFiles).toBe(1);
  });

  it("resets all state", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(report("1.1", ["src/a.ts"]));
    tracker.reset();
    expect(tracker.dispatched("1.1")).toBe(false);
    expect(tracker.reportFor("1.1")).toBeUndefined();
    expect(tracker.traces()).toEqual([]);
  });
});

describe("evaluateTickGate", () => {
  it("holds when no dispatch was observed", () => {
    const decision = evaluateTickGate(new DispatchReviewTracker(), {
      taskId: "1.1",
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("no observed opsx-worker dispatch");
  });

  it("holds when the dispatch was never reviewed", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    const decision = evaluateTickGate(tracker, { taskId: "1.1" });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("has not been reviewed");
    expect(decision.reason).toContain("report_work");
  });

  it("allows a reviewed dispatch whose files match the window delta", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(report("1.1", ["src/a.ts"], "12 passed"));
    expect(
      evaluateTickGate(tracker, {
        taskId: "1.1",
        observedChangedFiles: ["src/a.ts"],
      }),
    ).toEqual({ allow: true, warnings: [] });
  });

  it("warns but does not hold when the delta has files the report omitted", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(report("1.1", ["src/a.ts"], "ok"));
    const decision = evaluateTickGate(tracker, {
      taskId: "1.1",
      observedChangedFiles: ["src/a.ts", "src/extra.ts"],
    });
    // The delta also carries tool-runtime noise no report can declare, so an
    // omitted file is a warning rather than a deadlock.
    expect(decision.allow).toBe(true);
    if (!decision.allow) throw new Error("expected an allow");
    expect(decision.warnings.join(" ")).toContain("src/extra.ts");
  });

  it("ignores tool-runtime paths in the window delta", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(report("1.1", ["src/a.ts"], "ok"));
    const decision = evaluateTickGate(tracker, {
      taskId: "1.1",
      observedChangedFiles: [
        "src/a.ts",
        ".pi-lens-probe-home/cascade.log",
        ".pi/goals/x.md",
      ],
    });
    expect(decision).toEqual({ allow: true, warnings: [] });
  });

  it("treats build-output directories as task output, not noise", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(report("1.1", ["dist/bundle.js"], "ok"));
    // dist/, coverage/, node_modules/ and .cache/ are the agent write
    // allowlist: filtering them would turn a legitimate report into a phantom
    // claim and deadlock the task.
    expect(
      evaluateTickGate(tracker, {
        taskId: "1.1",
        observedChangedFiles: ["dist/bundle.js", "coverage/lcov.info"],
      }),
    ).toEqual({
      allow: true,
      warnings: [
        "The window delta contains file(s) the report did not declare: coverage/lcov.info. Confirm none of them belongs to this task before ticking.",
      ],
    });
  });

  it("holds when the report claims a file nobody changed", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(report("1.1", ["src/a.ts", "src/ghost.ts"], "ok"));
    const decision = evaluateTickGate(tracker, {
      taskId: "1.1",
      observedChangedFiles: ["src/a.ts"],
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("did not change");
  });

  it("holds when the recorded verification failed", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(report("1.1", ["src/a.ts"], "1 test FAILED"));
    const decision = evaluateTickGate(tracker, { taskId: "1.1" });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("verification failed");
  });

  it("holds when the report carries no verification evidence at all", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport({
      taskId: "1.1",
      changedFiles: ["src/a.ts"],
      claims: "x",
      selfVerification: {},
    });
    const decision = evaluateTickGate(tracker, { taskId: "1.1" });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("verification has not been run");
  });

  it("does not treat a clean run as a failure", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport(
      report("1.1", ["src/a.ts"], "0 failures, 12 passed"),
    );
    expect(evaluateTickGate(tracker, { taskId: "1.1" })).toEqual({
      allow: true,
      warnings: [],
    });
  });
});

describe("evaluateTickGate regression: verification is never bypassed", () => {
  function trackerWith(
    changedFiles: string[],
    selfVerification: { command?: string; result?: string },
  ) {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport({
      taskId: "1.1",
      changedFiles,
      claims: "x",
      selfVerification,
    });
    return tracker;
  }

  // These four cases are the probe that exposed the bug: because the delta
  // usually contains a file the report did not declare, the "omitted" hold
  // came first and the verification checks never ran.
  it("holds a failed verification even when the delta has an extra file", () => {
    const decision = evaluateTickGate(
      trackerWith(["src/a.ts"], {
        command: "npm test",
        result: "1 test FAILED",
      }),
      { taskId: "1.1", observedChangedFiles: ["src/a.ts", "src/other.ts"] },
    );
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("verification failed");
  });

  it("holds a missing verification even when the delta has an extra file", () => {
    const decision = evaluateTickGate(trackerWith(["src/a.ts"], {}), {
      taskId: "1.1",
      observedChangedFiles: ["src/a.ts", "src/other.ts"],
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("verification has not been run");
  });

  it("allows a build-output task whose only change is under dist/", () => {
    const decision = evaluateTickGate(
      trackerWith(["dist/bundle.js"], {
        command: "npm run build",
        result: "ok",
      }),
      { taskId: "1.1", observedChangedFiles: ["dist/bundle.js"] },
    );
    // Build output is exactly what the agent write allowlist permits, so it
    // must not be filtered out of the task's own evidence.
    expect(decision).toEqual({ allow: true, warnings: [] });
  });

  it("does not hold on tool-runtime noise in the delta", () => {
    const decision = evaluateTickGate(
      trackerWith(["src/a.ts"], { command: "npm test", result: "12 passed" }),
      {
        taskId: "1.1",
        observedChangedFiles: [
          "src/a.ts",
          ".pi-lens-probe-home/cascade.log",
          ".pi/goals/x.md",
        ],
      },
    );
    expect(decision).toEqual({ allow: true, warnings: [] });
  });

  it("still holds a phantom claim that sits next to an extra delta file", () => {
    const decision = evaluateTickGate(
      trackerWith(["src/a.ts", "src/ghost.ts"], {
        command: "npm test",
        result: "ok",
      }),
      { taskId: "1.1", observedChangedFiles: ["src/a.ts", "src/other.ts"] },
    );
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("did not change");
  });
});

describe("evaluateTickGate: structured verdict wins over text", () => {
  it("trusts verificationPassed: true even when the result text looks failed", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport({
      taskId: "1.1",
      changedFiles: ["src/a.ts"],
      claims: "x",
      selfVerification: { command: "npm test", result: "1 test FAILED" },
      verificationPassed: true,
    });
    expect(evaluateTickGate(tracker, { taskId: "1.1" })).toEqual({
      allow: true,
      warnings: [],
    });
  });

  it("trusts verificationPassed: false even with a clean-looking result", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport({
      taskId: "1.1",
      changedFiles: ["src/a.ts"],
      claims: "x",
      selfVerification: { command: "npm test", result: "12 passed" },
      verificationPassed: false,
    });
    const decision = evaluateTickGate(tracker, { taskId: "1.1" });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected a hold");
    expect(decision.reason).toContain("verification failed");
  });

  it("still falls back to the text heuristic when the verdict is absent", () => {
    const tracker = new DispatchReviewTracker();
    tracker.noteDispatch("1.1");
    tracker.rememberReport({
      taskId: "1.1",
      changedFiles: ["src/a.ts"],
      claims: "x",
      selfVerification: { command: "npm test", result: "1 test FAILED" },
    });
    const decision = evaluateTickGate(tracker, { taskId: "1.1" });
    expect(decision.allow).toBe(false);
  });
});
