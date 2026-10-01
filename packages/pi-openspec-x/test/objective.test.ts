/**
 * Tests for the objective assembler (task 6.2). Covers the four required
 * inputs — tasks present / no tracked tasks / no tasks.md / more than the
 * set_goal_tasks limit — plus the Steps, Boundaries/Don'ts and
 * `Verification contract:` output, the binary pending/complete mirror, and the
 * per-mode boundary rendering.
 */
import { describe, expect, it } from "vitest";

import {
  assembleOpsxObjective,
  MAX_GOAL_TASKS,
  OPSX_VERIFICATION_CONTRACT,
  toFlatGoalTasks,
} from "../src/objective.ts";
import { parseTasksMarkdown } from "../src/tasks-md.ts";

const AGENT_BOUNDARIES = {
  mode: "agent" as const,
  writable: ["openspec/**", "node_modules/**", "dist/**"],
};

const TASKS_MD = [
  "# Tasks",
  "",
  "## 1. Setup",
  "",
  "- [ ] 1.1 Create the module; 验证：the files exist",
  "- [ ] 1.2 Add the dependency",
  "",
  "## 2. Core",
  "",
  "- [x] 2.1 Implement the parser",
].join("\n");

function tasksMarkdownWith(count: number): string {
  const lines = ["# Tasks", ""];
  for (let index = 0; index < count; index += 1) {
    lines.push(`- [ ] 1.${index + 1} Task ${index + 1}`);
  }
  return lines.join("\n");
}

describe("worker dispatch contract", () => {
  it("requires the six-section dispatch brief in agent mode only", () => {
    const proxy = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: TASKS_MD,
      boundaries: AGENT_BOUNDARIES,
    });
    const direct = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: TASKS_MD,
      boundaries: { mode: "direct", writable: [] },
    });
    if (!proxy.ok || !direct.ok) throw new Error("assembly failed");
    expect(proxy.objective).toContain("Worker dispatch contract");
    expect(proxy.objective).toContain("Expected output");
    expect(proxy.objective).toContain("Must not do");
    expect(proxy.objective).toContain("Do not tick tasks.md or any checkbox");
    expect(direct.objective).not.toContain("Worker dispatch contract");
  });
});

describe("assembleOpsxObjective", () => {
  it("assembles Steps, Boundaries/Don'ts and the Verification contract", () => {
    const result = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: TASKS_MD,
      boundaries: AGENT_BOUNDARIES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tasks.map((task) => task.id)).toEqual(["1.1", "1.2", "2.1"]);
    expect(result.verificationContract).toBe(OPSX_VERIFICATION_CONTRACT);
    expect(result.objective).toContain(
      'Implement the OpenSpec change "add-pi-openspec-x".',
    );
    expect(result.objective).toContain("Steps:");
    expect(result.objective).toContain(
      "1. [1.1] Create the module — verification: the files exist",
    );
    expect(result.objective).toContain("2. [1.2] Add the dependency");
    expect(result.objective).toContain("3. [2.1] Implement the parser");

    // The contract line must be exactly the single line goal-x extracts.
    expect(
      result.objective
        .split("\n")
        .filter((line) => line.startsWith("Verification contract:")),
    ).toEqual([`Verification contract: ${OPSX_VERIFICATION_CONTRACT}`]);

    // Boundaries/Don'ts: the read-only boundary and the flow discipline.
    expect(result.objective).toContain("Boundaries:");
    expect(result.objective).toContain("Don'ts:");
    expect(result.objective).toContain(
      "Writable: openspec/**, node_modules/**, dist/**.",
    );
    expect(result.objective).toContain("read-only");
    expect(result.objective).toContain("opsx-worker dispatch");
    expect(result.objective).toContain("Do not idle-wait between tasks");
    expect(result.objective).toContain(
      "Do not change global goal policy settings",
    );
    // Agent mode starts a sisyphus goal (task 6.4).
    expect(result.goalStart).toEqual({
      objective: result.objective,
      mode: "sisyphus",
    });
  });

  it("mirrors the tasks as a flat, binary pending/complete goal task list", () => {
    const tasks = parseTasksMarkdown(TASKS_MD);
    const goalTasks = toFlatGoalTasks(tasks);

    expect(goalTasks).toEqual([
      {
        id: "1.1",
        title: "Create the module",
        verification_contract: "the files exist",
      },
      { id: "1.2", title: "Add the dependency" },
      { id: "2.1", title: "Implement the parser" },
    ]);
    // set_goal_tasks has no status field: a fresh mirror is all pending, and
    // the parser's done flag is the only thing that ever maps to complete.
    for (const task of goalTasks) {
      expect(Object.keys(task)).not.toContain("status");
    }
  });

  it("renders the direct-mode boundaries without a sandbox restriction", () => {
    const result = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: TASKS_MD,
      boundaries: { mode: "direct", writable: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.objective).toContain(
      "The main session implements directly: no role switch and no sandbox restriction.",
    );
    expect(result.objective).not.toContain("opsx-worker dispatch");
    // Direct mode starts a regular autoContinue goal (task 6.4).
    expect(result.goalStart.mode).toBe("regular");
  });

  it("refuses a tasks.md with no tracked tasks", () => {
    const result = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: "# Tasks\n\n## 1. Group\n\nProse only.\n",
      boundaries: AGENT_BOUNDARIES,
    });
    expect(result).toMatchObject({ ok: false, code: "no_tasks" });
    if (result.ok) return;
    expect(result.guidance).toMatch(/checkbox tasks/);
  });

  it("refuses when tasks.md is missing and points at /opsx:plan", () => {
    const result = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: undefined,
      boundaries: AGENT_BOUNDARIES,
    });
    expect(result).toMatchObject({ ok: false, code: "no_tasks_file" });
    if (result.ok) return;
    expect(result.guidance).toContain("/opsx:plan");
  });

  it("refuses more than the set_goal_tasks limit and guides splitting", () => {
    const atLimit = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: tasksMarkdownWith(MAX_GOAL_TASKS),
      boundaries: AGENT_BOUNDARIES,
    });
    expect(atLimit.ok).toBe(true);

    const overLimit = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: tasksMarkdownWith(MAX_GOAL_TASKS + 1),
      boundaries: AGENT_BOUNDARIES,
    });
    expect(overLimit).toMatchObject({ ok: false, code: "too_many_tasks" });
    if (overLimit.ok) return;
    expect(overLimit.message).toContain(String(MAX_GOAL_TASKS));
    expect(overLimit.guidance).toMatch(/Split the change/);
  });

  it("refuses duplicate task ids", () => {
    const result = assembleOpsxObjective({
      changeId: "add-pi-openspec-x",
      tasksMarkdown: "- [ ] 1.1 First\n- [ ] 1.1 Second\n",
      boundaries: AGENT_BOUNDARIES,
    });
    expect(result).toMatchObject({ ok: false, code: "duplicate_ids" });
    if (result.ok) return;
    expect(result.message).toContain("1.1");
  });
});
