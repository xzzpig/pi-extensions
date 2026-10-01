/**
 * Objective assembler for the `/opsx:implement` execution base (design D10;
 * openspec change add-pi-openspec-x, task 6.2).
 *
 * The implementation flow runs on top of a persistent pi-goal-x goal, and the
 * goal's objective is where the opsx orchestration contract lives. This module
 * turns the authoritative `tasks.md` into:
 *
 * - the objective text handed to goal-x's `create_goal`: a `Steps` section (the
 *   task list), a `Boundaries`/`Don'ts` section (the read-only boundary and the
 *   flow discipline), and the single `Verification contract:` line goal-x
 *   extracts;
 * - the flat task list handed to goal-x's `set_goal_tasks` (mirror of the same
 *   tasks, ids preserved 1:1 so the bidirectional sync in task 6.3 can follow);
 * - the task count gate: `set_goal_tasks` accepts at most 50 nodes, so a
 *   larger tasks.md is refused with guidance instead of silently truncated.
 *
 * Flow discipline is written into the objective text on purpose (design D10:
 * "策略调校同受流程隔离约束"). Global goal policy settings are never touched
 * — a global switch would change every plain `/goal`, and the objective is the
 * per-goal carrier that cannot leak.
 *
 * The assembler is pure: it reads the tasks.md string it is given and returns
 * data. Callers own file reading and goal-tool invocation.
 */
import {
  duplicateTaskIds,
  parseTasksMarkdown,
  type OpsxTask,
} from "./tasks-md.ts";

/** `set_goal_tasks` hard limit (goal-task-tools.ts MAX_TASKS). */
export const MAX_GOAL_TASKS = 50;

/**
 * The objective's `Verification contract:` value. goal-x extracts this line
 * into the goal's own verificationContract, and the completion audit reads it.
 */
export const OPSX_VERIFICATION_CONTRACT =
  "Implementation completion requires the goal completion audit to APPROVE; a fully ticked tasks.md is not completion.";

/** Which implementation mode the objective describes. */
export type OpsxImplementationMode = "agent" | "direct";

/** The read-only boundary the objective encodes, per implementation mode. */
export interface OpsxBoundaries {
  mode: OpsxImplementationMode;
  /**
   * Write allowlist globs for the agent sandbox (design D4). Ignored in
   * direct mode, where the main session keeps normal permissions.
   */
  writable: string[];
}

export interface AssembleObjectiveInput {
  /** The openspec change id the goal implements. */
  changeId: string;
  /** Raw tasks.md content; `undefined` when the file does not exist. */
  tasksMarkdown: string | undefined;
  boundaries: OpsxBoundaries;
}

/** One `set_goal_tasks` entry (flat, parent-linked shape; all roots here). */
export interface FlatGoalTaskInput {
  id: string;
  title: string;
  verification_contract?: string;
}

/** Why the assembler refused to build an objective. */
export type ObjectiveAssemblyFailureCode =
  | "no_tasks_file"
  | "no_tasks"
  | "too_many_tasks"
  | "duplicate_ids";

export type ObjectiveAssembly =
  | {
      ok: true;
      objective: string;
      tasks: OpsxTask[];
      /** The flat task list to mirror through `set_goal_tasks`. */
      goalTasks: FlatGoalTaskInput[];
      verificationContract: string;
      /**
       * The `create_goal` invocation the main agent makes to start the flow:
       * sisyphus in agent mode (patient ordered execution), a regular
       * autoContinue goal in direct mode (task 6.4).
       */
      goalStart: { objective: string; mode: "regular" | "sisyphus" };
    }
  | {
      ok: false;
      code: ObjectiveAssemblyFailureCode;
      message: string;
      guidance: string;
    };

/**
 * Build the flat goal task list from the parsed tasks. Ids are preserved
 * verbatim (the sync key), and the per-task verification contract travels
 * along so the goal completion gate can demand evidence.
 */
export function toFlatGoalTasks(
  tasks: readonly OpsxTask[],
): FlatGoalTaskInput[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    ...(task.verificationContract
      ? { verification_contract: task.verificationContract }
      : {}),
  }));
}

import { STANDARD_WORKER_MUST_NOT_DO } from "./worker-dispatch.ts";

function agentBoundaries(writable: readonly string[]): string[] {
  const writableText = writable.length > 0 ? writable.join(", ") : "(none)";
  return [
    "Boundaries:",
    `- Writable: ${writableText}. Nothing else is writable.`,
    "- Everything else, including the source tree, is read-only.",
    "- Source changes happen only through an opsx-worker dispatch; the main agent never edits a source file itself.",
    "- openspec/ plan files (tasks.md, proposal.md, specs/, design.md) are read-only for opsx-worker; only the main agent ticks tasks.md, after review.",
    "",
    "Worker dispatch contract (task 8.2): every opsx-worker dispatch carries these six sections, in this order:",
    "1. Task — the task id and title.",
    "2. Expected output — the concrete files/behavior the dispatch must produce.",
    "3. Tools — the tools the worker needs for this task.",
    "4. Must do — the task-specific obligations.",
    "5. Must not do — the task-specific prohibitions, plus:",
    ...STANDARD_WORKER_MUST_NOT_DO.map((rule) => `   - ${rule}`),
    "6. Context — the files/behavior/constraints the worker needs to know.",
    "After the dispatch: review its full diff and its verification output, then call report_work with taskId, changedFiles and the verification command/result. Ticking a task before that report exists is blocked by the tick gate, and a report that claims files the dispatch did not change (or omits files it did) is held for reconciliation.",
    "",
    "Don'ts:",
    "- Do not edit source files directly, not even for a one-line fix; dispatch opsx-worker.",
    "- Do not tick a task in tasks.md before reviewing the worker's full diff and running its verification.",
    "- Do not idle-wait between tasks; after a reviewed dispatch, immediately start the next pending task.",
    "- Do not change global goal policy settings; the flow discipline lives in this objective.",
  ];
}

function directBoundaries(): string[] {
  return [
    "Boundaries:",
    "- The main session implements directly: no role switch and no sandbox restriction.",
    "- tasks.md is the task authority and openspec/ is the plan contract.",
    "- The completion audit still gates completion: every task being ticked is not completion.",
    "",
    "Don'ts:",
    "- Do not skip a task's stated verification.",
    "- Do not tick a task in tasks.md before its verification passes.",
    "- Do not idle-wait between tasks; after finishing one, immediately start the next pending task.",
    "- Do not change global goal policy settings; the flow discipline lives in this objective.",
  ];
}

/**
 * Assemble the objective text and goal task mirror for one implementation
 * flow. Refuses (never truncates) when there is no usable task list:
 *
 * - no tasks.md → run `/opsx:plan` first (or point at the change's tasks.md);
 * - no tracked task → the change has nothing to implement;
 * - more than {@link MAX_GOAL_TASKS} tasks → split the change, because
 *   `set_goal_tasks` cannot mirror a longer list;
 * - duplicate ids → the mirror would silently drop or collide tasks.
 */
export function assembleOpsxObjective(
  input: AssembleObjectiveInput,
): ObjectiveAssembly {
  if (input.tasksMarkdown === undefined) {
    return {
      ok: false,
      code: "no_tasks_file",
      message: `No tasks.md was found for change "${input.changeId}".`,
      guidance:
        "Run /opsx:plan to produce the change plan (proposal/specs/design/tasks) first, then retry /opsx:implement.",
    };
  }

  const tasks = parseTasksMarkdown(input.tasksMarkdown);
  if (tasks.length === 0) {
    return {
      ok: false,
      code: "no_tasks",
      message: `tasks.md for change "${input.changeId}" contains no tracked tasks.`,
      guidance:
        "tasks.md must list checkbox tasks (`- [ ] 1.1 ...`); add them (or re-run /opsx:plan) before implementing.",
    };
  }

  const duplicates = duplicateTaskIds(tasks);
  if (duplicates.length > 0) {
    return {
      ok: false,
      code: "duplicate_ids",
      message: `tasks.md for change "${input.changeId}" repeats task id(s): ${duplicates.join(", ")}.`,
      guidance:
        "Task ids must be unique because the goal task mirror is keyed by id; fix the duplicate ids in tasks.md and retry.",
    };
  }

  if (tasks.length > MAX_GOAL_TASKS) {
    return {
      ok: false,
      code: "too_many_tasks",
      message: `tasks.md for change "${input.changeId}" has ${tasks.length} tasks; set_goal_tasks accepts at most ${MAX_GOAL_TASKS}.`,
      guidance:
        "Split the change into smaller changes (or merge trivial tasks) so tasks.md stays within the limit, then retry /opsx:implement.",
    };
  }

  const lines: string[] = [
    `Implement the OpenSpec change "${input.changeId}".`,
    "",
    "Steps:",
  ];
  tasks.forEach((task, index) => {
    const contract = task.verificationContract
      ? ` — verification: ${task.verificationContract}`
      : "";
    lines.push(`${index + 1}. [${task.id}] ${task.title}${contract}`);
  });
  lines.push("");
  lines.push(
    ...(input.boundaries.mode === "agent"
      ? agentBoundaries(input.boundaries.writable)
      : directBoundaries()),
  );
  lines.push("");
  lines.push(`Verification contract: ${OPSX_VERIFICATION_CONTRACT}`);

  return {
    ok: true,
    objective: lines.join("\n"),
    tasks,
    goalTasks: toFlatGoalTasks(tasks),
    verificationContract: OPSX_VERIFICATION_CONTRACT,
    goalStart: {
      objective: lines.join("\n"),
      mode: input.boundaries.mode === "agent" ? "sisyphus" : "regular",
    },
  };
}
