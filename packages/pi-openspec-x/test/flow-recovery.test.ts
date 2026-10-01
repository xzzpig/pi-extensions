/**
 * Tests for the pure recovery/divergence logic (task 6.4): the crash → restart
 * → resume sequence and the manual clear/pause/completion forks, with
 * tasks.md/goal-base authority kept explicit.
 */
import { describe, expect, it } from "vitest";

import {
  detectFlowDivergence,
  diagnoseFlow,
  findOpsxGoals,
  isUnfinishedGoalStatus,
  opsxChangeIdFromObjective,
  resolveRecoveryEntry,
  type GoalBaseSummary,
} from "../src/flow-recovery.ts";

function goal(id: string, status: string, changeId?: string): GoalBaseSummary {
  return {
    id,
    status,
    objective: changeId
      ? `Implement the OpenSpec change "${changeId}".\n\nSteps:\n1. [1.1] Do the work`
      : "A plain user goal.\nSuccess criteria: something.",
  };
}

describe("opsx objective detection", () => {
  it("extracts the change id from an opsx objective and ignores plain goals", () => {
    expect(
      opsxChangeIdFromObjective(
        'Implement the OpenSpec change "add-pi-openspec-x".\n\nSteps:',
      ),
    ).toBe("add-pi-openspec-x");
    expect(opsxChangeIdFromObjective("Fix the flaky test.")).toBeUndefined();
  });

  it("finds only the opsx goals and keeps their change ids", () => {
    const refs = findOpsxGoals([
      goal("g1", "active", "change-a"),
      goal("g2", "paused"),
      goal("g3", "complete", "change-b"),
    ]);
    expect(refs).toEqual([
      { goalId: "g1", changeId: "change-a", status: "active" },
      { goalId: "g3", changeId: "change-b", status: "complete" },
    ]);
    expect(isUnfinishedGoalStatus("complete")).toBe(false);
    expect(isUnfinishedGoalStatus("paused")).toBe(true);
  });
});

describe("resolveRecoveryEntry", () => {
  it("returns none when no unfinished opsx goal exists", () => {
    expect(
      resolveRecoveryEntry([
        goal("g1", "complete", "change-a"),
        goal("g2", "active"),
      ]),
    ).toEqual({ kind: "none" });
  });

  it("offers /goal-resume for a single unfinished opsx goal", () => {
    const resolution = resolveRecoveryEntry([goal("g1", "paused", "change-a")]);
    expect(resolution.kind).toBe("resume");
    if (resolution.kind !== "resume") return;
    expect(resolution.entry.goal).toEqual({
      goalId: "g1",
      changeId: "change-a",
      status: "paused",
    });
    expect(resolution.entry.message).toContain("/goal-resume");
  });

  it("reports ambiguity for several unfinished opsx goals", () => {
    const resolution = resolveRecoveryEntry([
      goal("g1", "active", "change-a"),
      goal("g2", "active", "change-b"),
    ]);
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") return;
    expect(resolution.candidates).toHaveLength(2);
    expect(resolution.message).toContain("Several");
  });

  it("scopes the search to a change id", () => {
    const goals = [
      goal("g1", "active", "change-a"),
      goal("g2", "active", "change-b"),
    ];
    const resolution = resolveRecoveryEntry(goals, { changeId: "change-b" });
    expect(resolution.kind).toBe("resume");
    if (resolution.kind !== "resume") return;
    expect(resolution.entry.goal.goalId).toBe("g2");
  });
});

describe("detectFlowDivergence", () => {
  const active = { goalId: "g1", changeId: "change-a" };

  it("returns undefined while the flow and the base agree", () => {
    expect(detectFlowDivergence(undefined, [])).toBeUndefined();
    expect(
      detectFlowDivergence(active, [goal("g1", "active", "change-a")]),
    ).toBeUndefined();
  });

  it("detects a cleared goal", () => {
    const divergence = detectFlowDivergence(active, [
      goal("other", "active", "change-a"),
    ]);
    expect(divergence?.kind).toBe("goal_cleared");
    expect(divergence?.options.length).toBeGreaterThan(0);
  });

  it("detects a paused or blocked goal", () => {
    expect(
      detectFlowDivergence(active, [goal("g1", "paused", "change-a")])?.kind,
    ).toBe("goal_paused");
    expect(
      detectFlowDivergence(active, [goal("g1", "blocked", "change-a")])?.kind,
    ).toBe("goal_paused");
  });

  it("detects a goal completed out from under the flow", () => {
    expect(
      detectFlowDivergence(active, [goal("g1", "complete", "change-a")])?.kind,
    ).toBe("goal_completed");
  });
});

describe("diagnoseFlow", () => {
  it("is read-only and requires confirmation for every repair", () => {
    const diagnosis = diagnoseFlow({
      active: { goalId: "g1", changeId: "change-a" },
      goals: [goal("g1", "paused", "change-a")],
      changeId: "change-a",
    });
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.divergence?.kind).toBe("goal_paused");
    expect(diagnosis.recovery?.goal.goalId).toBe("g1");
    expect(diagnosis.repairRequiresConfirmation).toBe(true);
    expect(diagnosis.notices.length).toBeGreaterThan(0);
  });

  it("reports a healthy flow with no divergence", () => {
    const diagnosis = diagnoseFlow({
      goals: [goal("g1", "active", "change-a")],
      changeId: "change-a",
    });
    expect(diagnosis.ok).toBe(true);
    expect(diagnosis.divergence).toBeUndefined();
    expect(diagnosis.recovery?.goal.changeId).toBe("change-a");
  });
});
