/**
 * Turn tracking and outcome classification tests (change task 2.3).
 *
 * Pins the conservative classifier and the first-start-to-final-settle
 * tracker: intermediate agent ends, retries, compaction recovery, and
 * waiting UI never fold; aborted/error/length turns are abnormal; unknown
 * evidence is never promoted to success; toolUse termination needs an
 * explicit completed basis; and only the latest candidate evidence counts.
 */

import { describe, expect, test } from "vitest";
import {
  TurnTracker,
  classifySettle,
  type LifecycleEvent,
  type SettledTurn,
} from "../src/lifecycle.ts";

describe("classifySettle", () => {
  test("explicit abort is abnormal", () => {
    expect(classifySettle({ aborted: true })).toBe("abnormal");
    expect(classifySettle({ aborted: true, lastStopReason: "stop" })).toBe(
      "abnormal",
    );
  });

  test("aborted=false alone is not success", () => {
    expect(classifySettle({ aborted: false })).toBe("unknown");
  });

  test("error, aborted, and length stop reasons are abnormal", () => {
    for (const lastStopReason of ["error", "aborted", "length"]) {
      expect(classifySettle({ aborted: false, lastStopReason })).toBe(
        "abnormal",
      );
    }
  });

  test("before_settle error/aborted outcomes are abnormal", () => {
    expect(classifySettle({ beforeSettleOutcome: "error" })).toBe("abnormal");
    expect(classifySettle({ beforeSettleOutcome: "aborted" })).toBe("abnormal");
  });

  test("plain stop is normal", () => {
    expect(classifySettle({ aborted: false, lastStopReason: "stop" })).toBe(
      "normal",
    );
  });

  test("toolUse termination needs an explicit completed basis", () => {
    expect(classifySettle({ lastStopReason: "toolUse" })).toBe("unknown");
    expect(
      classifySettle({
        lastStopReason: "toolUse",
        beforeSettleOutcome: "completed",
      }),
    ).toBe("normal");
  });

  test("completed outcome is normal even with toolUse ending", () => {
    expect(
      classifySettle({
        aborted: false,
        lastStopReason: "toolUse",
        beforeSettleOutcome: "completed",
      }),
    ).toBe("normal");
  });

  test("missing evidence stays unknown", () => {
    expect(classifySettle({})).toBe("unknown");
    expect(classifySettle({ aborted: false, lastStopReason: undefined })).toBe(
      "unknown",
    );
  });
});

function trackerWithLog(log: SettledTurn[]): TurnTracker {
  return new TurnTracker({ onSettled: (settled) => log.push(settled) });
}

describe("TurnTracker", () => {
  test("a simple run settles once with the stop candidate", () => {
    const log: SettledTurn[] = [];
    const tracker = trackerWithLog(log);
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["toolUse"] });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["stop"] });
    tracker.apply({ type: "agent_settled", aborted: false });
    expect(log).toEqual([{ turn: 1, outcome: "normal" }]);
    expect(tracker.isRunning()).toBe(false);
  });

  test("intermediate ends, retries, compaction recovery never settle", () => {
    const log: SettledTurn[] = [];
    const tracker = trackerWithLog(log);
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["error"] });
    // Auto-retry restarts the loop.
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "compaction", willRetry: true });
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["stop"] });
    expect(log).toEqual([]);
    expect(tracker.isRunning()).toBe(true);
    tracker.apply({ type: "agent_settled", aborted: false });
    expect(log).toEqual([{ turn: 1, outcome: "normal" }]);
  });

  test("a retried error does not poison the completed turn", () => {
    const log: SettledTurn[] = [];
    const tracker = trackerWithLog(log);
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["error"] });
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["stop"] });
    tracker.apply({ type: "agent_settled", aborted: false });
    expect(log[0]?.outcome).toBe("normal");
  });

  test("an aborted settle is abnormal and closes the turn", () => {
    const log: SettledTurn[] = [];
    const tracker = trackerWithLog(log);
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "agent_settled", aborted: true });
    expect(log).toEqual([{ turn: 1, outcome: "abnormal" }]);

    // The next run opens a fresh turn.
    tracker.apply({ type: "agent_start" });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["stop"] });
    tracker.apply({ type: "agent_settled", aborted: false });
    expect(log[1]).toEqual({ turn: 2, outcome: "normal" });
  });

  test("before_settle outcome feeds the classification", () => {
    const log: SettledTurn[] = [];
    const tracker = trackerWithLog(log);
    tracker.apply({ type: "agent_start" });
    tracker.apply({
      type: "agent_before_settle",
      outcome: "completed",
    });
    tracker.apply({ type: "agent_end", assistantStopReasons: ["toolUse"] });
    tracker.apply({ type: "agent_settled", aborted: false });
    expect(log).toEqual([{ turn: 1, outcome: "normal" }]);
  });

  test("a settled event with no open turn is ignored", () => {
    const log: SettledTurn[] = [];
    const tracker = trackerWithLog(log);
    tracker.apply({ type: "agent_settled", aborted: false });
    expect(log).toEqual([]);
    expect(tracker.settledTurns()).toBe(0);
  });

  test("hosts without aborted reporting still classify from candidates", () => {
    const log: SettledTurn[] = [];
    const tracker = trackerWithLog(log);
    const events: LifecycleEvent[] = [
      { type: "agent_start" },
      { type: "agent_end", assistantStopReasons: ["stop"] },
      // pi 1.0.0-era settle without an aborted field.
      { type: "agent_settled" },
    ];
    for (const event of events) tracker.apply(event);
    expect(log).toEqual([{ turn: 1, outcome: "normal" }]);
  });
});
