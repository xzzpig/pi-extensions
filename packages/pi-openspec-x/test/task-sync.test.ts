/**
 * Tests for tasks.md ⇄ goal task tree reconciliation (task 6.3). Pins the
 * one-directional authority contract: tasks.md wins in every direction, a
 * goal-tree-only edit is removed by the mirror, and a completed goal task
 * (which goal-x never reopens) is surfaced as a blocking divergence instead of
 * a silent half-sync.
 */
import { describe, expect, it } from "vitest";

import {
  assembleAndPlanSync,
  flattenGoalTasks,
  planTaskSync,
  type GoalTaskLike,
} from "../src/task-sync.ts";

const TASKS_MD = [
  "# Tasks",
  "",
  "- [ ] 1.1 First task; 验证：the first test passes",
  "- [x] 1.2 Second task",
].join("\n");

function goalTasks(
  entries: Array<Partial<GoalTaskLike> & { id: string }>,
): GoalTaskLike[] {
  return entries.map((entry) => ({
    title: entry.title,
    status: entry.status ?? "pending",
    ...entry,
  }));
}

describe("planTaskSync", () => {
  it("reports consistency when ids, titles and done state agree", () => {
    const plan = planTaskSync({
      tasksMarkdown: TASKS_MD,
      goalTasks: goalTasks([
        { id: "1.1", title: "First task", status: "pending" },
        { id: "1.2", title: "Second task", status: "complete" },
      ]),
    });

    expect(plan.consistent).toBe(true);
    expect(plan.updates).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.mirror).toEqual([
      {
        id: "1.1",
        title: "First task",
        verification_contract: "the first test passes",
      },
      { id: "1.2", title: "Second task" },
    ]);
  });

  it("mirrors a tasks.md-only task and warns (missing from the goal tree)", () => {
    const plan = planTaskSync({
      tasksMarkdown: TASKS_MD,
      goalTasks: goalTasks([{ id: "1.1", title: "First task" }]),
    });

    expect(plan.consistent).toBe(false);
    expect(plan.missingGoalIds).toEqual(["1.2"]);
    expect(plan.mirror.map((task) => task.id)).toEqual(["1.1", "1.2"]);
    expect(plan.warnings.join(" ")).toMatch(/missing from the goal tree/);
  });

  it("removes a goal-tree-only edit from the mirror and warns", () => {
    const plan = planTaskSync({
      tasksMarkdown: TASKS_MD,
      goalTasks: goalTasks([
        { id: "1.1", title: "First task" },
        { id: "1.2", title: "Second task", status: "complete" },
        { id: "manual-99", title: "Added in the dashboard" },
      ]),
    });

    expect(plan.consistent).toBe(false);
    expect(plan.goalOnlyIds).toEqual(["manual-99"]);
    expect(plan.mirror.map((task) => task.id)).toEqual(["1.1", "1.2"]);
    expect(plan.warnings.join(" ")).toMatch(/never flow back/);
  });

  it("lets tasks.md win a title mismatch through the mirror", () => {
    const plan = planTaskSync({
      tasksMarkdown: TASKS_MD,
      goalTasks: goalTasks([
        { id: "1.1", title: "Renamed in the goal", status: "pending" },
        { id: "1.2", title: "Second task", status: "complete" },
      ]),
    });

    expect(plan.titleMismatches).toEqual(["1.1"]);
    expect(plan.mirror[0]?.title).toBe("First task");
    expect(plan.updates).toEqual([]);
  });

  it("emits a completion follow-up when tasks.md is ahead", () => {
    const plan = planTaskSync({
      tasksMarkdown: TASKS_MD,
      goalTasks: goalTasks([
        { id: "1.1", title: "First task", status: "pending" },
        { id: "1.2", title: "Second task", status: "pending" },
      ]),
    });

    expect(plan.statusMismatches).toEqual(["1.2"]);
    expect(plan.updates).toEqual([
      { taskId: "1.2", status: "complete", requiresEvidence: false },
    ]);
  });

  it("requires evidence when completing a contracted task", () => {
    const plan = planTaskSync({
      tasksMarkdown: "- [x] 1.1 Done; 验证：the suite passes\n",
      goalTasks: goalTasks([{ id: "1.1", title: "Done", status: "pending" }]),
    });

    expect(plan.updates).toEqual([
      { taskId: "1.1", status: "complete", requiresEvidence: true },
    ]);
  });

  it("reopens a skipped task before completing it (skipped cannot complete directly)", () => {
    const plan = planTaskSync({
      tasksMarkdown:
        "- [x] 1.1 First task; 验证：the first test passes\n- [x] 1.2 Second task\n",
      goalTasks: goalTasks([
        { id: "1.1", title: "First task", status: "skipped" },
        { id: "1.2", title: "Second task", status: "complete" },
      ]),
    });

    expect(plan.updates).toEqual([
      { taskId: "1.1", status: "pending", requiresEvidence: false },
      { taskId: "1.1", status: "complete", requiresEvidence: true },
    ]);
  });

  it("reopens a skipped task that tasks.md still marks undone", () => {
    const plan = planTaskSync({
      tasksMarkdown: "- [ ] 1.1 Not done\n",
      goalTasks: goalTasks([
        { id: "1.1", title: "Not done", status: "skipped" },
      ]),
    });

    expect(plan.updates).toEqual([
      { taskId: "1.1", status: "pending", requiresEvidence: false },
    ]);
  });

  it("blocks a completed goal task that tasks.md marks undone", () => {
    const plan = planTaskSync({
      tasksMarkdown: "- [ ] 1.1 Not done\n",
      goalTasks: goalTasks([
        { id: "1.1", title: "Not done", status: "complete" },
      ]),
    });

    expect(plan.statusMismatches).toEqual(["1.1"]);
    expect(plan.blockingIds).toEqual(["1.1"]);
    expect(plan.updates).toEqual([]);
    expect(plan.consistent).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/never reopens a completed task/);
  });

  it("keeps tasks.md authoritative under perturbation in both directions", () => {
    const plan = planTaskSync({
      // tasks.md gained 1.3 and still has 1.1 undone; the goal tree renamed
      // 1.1, completed 1.2, added manual-99, and lost 1.3.
      tasksMarkdown: `${TASKS_MD}\n- [ ] 1.3 Third task\n`,
      goalTasks: goalTasks([
        { id: "1.1", title: "Renamed", status: "pending" },
        { id: "1.2", title: "Second task", status: "complete" },
        { id: "manual-99", title: "Manual" },
      ]),
    });

    expect(plan.consistent).toBe(false);
    expect(plan.mirror.map((task) => task.id)).toEqual(["1.1", "1.2", "1.3"]);
    expect(plan.mirror.find((task) => task.id === "1.1")?.title).toBe(
      "First task",
    );
    expect(plan.missingGoalIds).toEqual(["1.3"]);
    expect(plan.goalOnlyIds).toEqual(["manual-99"]);
    expect(plan.titleMismatches).toEqual(["1.1"]);
    expect(plan.updates).toEqual([]);
  });

  it("flattens nested goal subtasks", () => {
    const flat = flattenGoalTasks([
      {
        id: "1",
        title: "Group",
        status: "pending",
        subtasks: [
          { id: "1.1", title: "Child", status: "complete" },
          { id: "1.2", title: "Child 2", status: "pending" },
        ],
      },
    ]);
    expect(flat.map((task) => task.id)).toEqual(["1", "1.1", "1.2"]);
  });

  it("treats a missing goal tree as an empty tree (first mirror)", () => {
    const plan = planTaskSync({
      tasksMarkdown: TASKS_MD,
      goalTasks: undefined,
    });
    expect(plan.missingGoalIds).toEqual(["1.1", "1.2"]);
    expect(plan.mirror).toHaveLength(2);
  });

  it("assembles the objective and the sync plan together", () => {
    const { assembly, sync } = assembleAndPlanSync({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: TASKS_MD,
      boundaries: { mode: "agent", writable: ["openspec/**"] },
      goalTasks: goalTasks([{ id: "1.1", title: "First task" }]),
    });

    expect(assembly.ok).toBe(true);
    expect(sync.missingGoalIds).toEqual(["1.2"]);
    if (assembly.ok) {
      expect(sync.mirror).toEqual(assembly.goalTasks);
    }
  });
});
