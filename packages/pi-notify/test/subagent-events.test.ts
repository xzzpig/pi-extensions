import { describe, expect, it } from "vitest";

import {
  parseSubagentCompletion,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_FOREGROUND_COMPLETE_EVENT,
} from "../extensions/subagent-events.js";

describe("pi-subagents event names", () => {
  it("matches the public completion channels", () => {
    expect(SUBAGENT_ASYNC_COMPLETE_EVENT).toBe("subagent:async-complete");
    expect(SUBAGENT_FOREGROUND_COMPLETE_EVENT).toBe(
      "subagent:foreground-complete",
    );
  });
});

describe("parseSubagentCompletion", () => {
  it("maps canonical async statuses", () => {
    expect(
      parseSubagentCompletion({ status: "completed", agent: "worker" }),
    ).toEqual({ kind: "task-completed", label: "worker" });
    expect(
      parseSubagentCompletion({ status: "failed", agent: "worker" }),
    ).toEqual({
      kind: "integration-error",
      label: "worker",
    });
    for (const silent of ["paused", "stopped", "detached"]) {
      expect(parseSubagentCompletion({ status: silent })).toEqual({
        kind: "silent",
      });
    }
  });

  it("maps foreground success and failure", () => {
    expect(
      parseSubagentCompletion({ success: true, state: "complete" }),
    ).toEqual({ kind: "task-completed" });
    expect(
      parseSubagentCompletion({ success: false, state: "failed" }),
    ).toEqual({ kind: "integration-error" });
  });

  it("maps timeout to integration-error", () => {
    expect(parseSubagentCompletion({ success: false, timedOut: true })).toEqual(
      { kind: "integration-error" },
    );
  });

  it("stays silent for cancelled, stopped, paused and interrupted runs", () => {
    expect(parseSubagentCompletion({ success: false, stopped: true })).toEqual({
      kind: "silent",
    });
    expect(
      parseSubagentCompletion({ success: false, interrupted: true }),
    ).toEqual({ kind: "silent" });
    expect(parseSubagentCompletion({ state: "stopped" })).toEqual({
      kind: "silent",
    });
    expect(parseSubagentCompletion({ state: "paused" })).toEqual({
      kind: "silent",
    });
    expect(parseSubagentCompletion({ detached: true })).toEqual({
      kind: "silent",
    });
    expect(
      parseSubagentCompletion({ processSignal: "SIGTERM", exitCode: 143 }),
    ).toEqual({ kind: "silent" });
  });

  it("uses exit codes when no other signal is present", () => {
    expect(parseSubagentCompletion({ exitCode: 0 })).toEqual({
      kind: "task-completed",
    });
    expect(parseSubagentCompletion({ exitCode: 1 })).toEqual({
      kind: "integration-error",
    });
  });

  it("aggregates grouped run children by status", () => {
    expect(
      parseSubagentCompletion({
        results: [{ status: "completed" }, { status: "completed" }],
      }),
    ).toEqual({ kind: "task-completed" });
    expect(
      parseSubagentCompletion({
        results: [{ status: "completed" }, { status: "failed" }],
      }),
    ).toEqual({ kind: "integration-error" });
    expect(
      parseSubagentCompletion({ results: [{ status: "stopped" }] }),
    ).toEqual({ kind: "silent" });
  });

  it("sanitizes the agent label and is silent for malformed events", () => {
    expect(
      parseSubagentCompletion({ status: "completed", agent: "a\nb\u0000" }),
    ).toEqual({ kind: "task-completed", label: "a b" });
    expect(parseSubagentCompletion(null)).toEqual({ kind: "silent" });
    expect(parseSubagentCompletion({})).toEqual({ kind: "silent" });
  });
});
