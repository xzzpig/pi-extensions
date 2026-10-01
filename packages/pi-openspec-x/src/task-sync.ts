/**
 * tasks.md ⇄ goal task tree reconciliation (design D10; openspec change
 * add-pi-openspec-x, task 6.3).
 *
 * `tasks.md` is the openspec contract and the authoritative task source; the
 * goal task tree is the execution base's state. Synchronization is
 * ONE-DIRECTIONAL: the assembler mirrors tasks.md through `set_goal_tasks`,
 * the main agent ticks tasks.md after review and follows with
 * `update_goal_task`, and a goal-tree-only change (a manual edit in the
 * dashboard) never flows back into tasks.md.
 *
 * This module is the pure reconciliation core: it compares the parsed
 * tasks.md against the current goal tree, reports every divergence with
 * tasks.md as the winner, and produces the two payloads the caller needs —
 * the authoritative flat mirror for `set_goal_tasks` and the ordered
 * `update_goal_task` follow-ups that align task status.
 *
 * Two goal states cannot be reconciled automatically because goal-x forbids
 * them: a completed task is immutable, so a goal task that is `complete` while
 * tasks.md says it is not done cannot be reopened. That divergence is surfaced
 * as a blocking warning instead of a silent half-sync.
 */
import {
  assembleOpsxObjective,
  type FlatGoalTaskInput,
  type OpsxBoundaries,
} from "./objective.ts";
import { goalStatusForTask, parseTasksMarkdown } from "./tasks-md.ts";

/** Minimal structural view of goal-x's GoalTask (no runtime import). */
export interface GoalTaskLike {
  id: string;
  title?: string;
  /** pending | complete | skipped (goal-x has no distinct "start" status). */
  status?: string;
  subtasks?: GoalTaskLike[];
}

/** One ordered `update_goal_task` follow-up. */
export interface TaskSyncUpdate {
  taskId: string;
  status: "pending" | "complete";
  /** True when completing a contracted task needs evidence. */
  requiresEvidence: boolean;
}

export interface TaskSyncPlan {
  /** True when ids, titles and done status all agree. */
  consistent: boolean;
  /** The authoritative flat mirror to pass to `set_goal_tasks`. */
  mirror: FlatGoalTaskInput[];
  /** Ordered follow-ups to align the goal tree's status with tasks.md. */
  updates: TaskSyncUpdate[];
  /** tasks.md ids missing from the goal tree (the mirror adds them). */
  missingGoalIds: string[];
  /** Goal-tree ids with no tasks.md counterpart (the mirror removes them). */
  goalOnlyIds: string[];
  /** Same id, different title (the mirror rewrites the title). */
  titleMismatches: string[];
  /** Same id, different done state (an update aligns it, or a warning blocks). */
  statusMismatches: string[];
  /** Divergences that cannot be reconciled automatically. */
  blockingIds: string[];
  /** Human-readable warnings; empty when consistent. */
  warnings: string[];
}

/** Flatten a goal task tree into roots-first document order. */
export function flattenGoalTasks(
  tasks: readonly GoalTaskLike[] | undefined,
): GoalTaskLike[] {
  const flat: GoalTaskLike[] = [];
  const walk = (list: readonly GoalTaskLike[]): void => {
    for (const task of list) {
      flat.push(task);
      if (task.subtasks && task.subtasks.length > 0) walk(task.subtasks);
    }
  };
  if (tasks) walk(tasks);
  return flat;
}

/**
 * Reconcile tasks.md against the current goal task tree. tasks.md always wins:
 * a goal-only id is removed by the mirror, a missing id is added, a title
 * mismatch is rewritten, and a status mismatch is corrected by the emitted
 * updates (unless goal-x forbids it, which is reported as blocking).
 */
export function planTaskSync(input: {
  tasksMarkdown: string | undefined;
  goalTasks: readonly GoalTaskLike[] | undefined;
}): TaskSyncPlan {
  const tasks = input.tasksMarkdown
    ? parseTasksMarkdown(input.tasksMarkdown)
    : [];
  const goalFlat = flattenGoalTasks(input.goalTasks);
  const goalById = new Map(goalFlat.map((task) => [task.id, task]));
  const taskIds = new Set(tasks.map((task) => task.id));

  const mirror = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    ...(task.verificationContract
      ? { verification_contract: task.verificationContract }
      : {}),
  }));

  const missingGoalIds: string[] = [];
  const titleMismatches: string[] = [];
  const statusMismatches: string[] = [];
  const blockingIds: string[] = [];
  const updates: TaskSyncUpdate[] = [];

  for (const task of tasks) {
    const goalTask = goalById.get(task.id);
    if (!goalTask) {
      missingGoalIds.push(task.id);
      continue;
    }
    if (goalTask.title !== undefined && goalTask.title !== task.title) {
      titleMismatches.push(task.id);
    }
    const expected = goalStatusForTask(task);
    const actual = goalTask.status ?? "pending";
    if (actual === expected) continue;
    statusMismatches.push(task.id);
    if (actual === "complete") {
      // goal-x: completed tasks are immutable, so tasks.md cannot win here.
      blockingIds.push(task.id);
      continue;
    }
    if (actual === "skipped" && expected === "complete") {
      // skipped cannot complete directly; reopen, then complete.
      updates.push({
        taskId: task.id,
        status: "pending",
        requiresEvidence: false,
      });
      updates.push({
        taskId: task.id,
        status: "complete",
        requiresEvidence: Boolean(task.verificationContract),
      });
      continue;
    }
    updates.push({
      taskId: task.id,
      status: expected,
      requiresEvidence:
        expected === "complete" && Boolean(task.verificationContract),
    });
  }

  const goalOnlyIds = goalFlat
    .filter((task) => !taskIds.has(task.id))
    .map((task) => task.id);

  const warnings: string[] = [];
  if (missingGoalIds.length > 0) {
    warnings.push(
      `tasks.md has ${missingGoalIds.length} task(s) missing from the goal tree (${missingGoalIds.join(", ")}); tasks.md is authoritative, so re-mirroring adds them.`,
    );
  }
  if (goalOnlyIds.length > 0) {
    warnings.push(
      `The goal tree has ${goalOnlyIds.length} task(s) that tasks.md does not (${goalOnlyIds.join(", ")}); goal-tree-only edits never flow back, so re-mirroring removes them.`,
    );
  }
  if (titleMismatches.length > 0) {
    warnings.push(
      `Task title(s) differ from tasks.md (${titleMismatches.join(", ")}); tasks.md wins and re-mirroring rewrites them.`,
    );
  }
  if (statusMismatches.length > 0) {
    warnings.push(
      `Task status differs from tasks.md (${statusMismatches.join(", ")}); tasks.md wins and update_goal_task follows to align it.`,
    );
  }
  if (blockingIds.length > 0) {
    warnings.push(
      `Task(s) ${blockingIds.join(", ")} are complete in the goal tree but not done in tasks.md; goal-x never reopens a completed task, so this cannot be auto-reconciled — fix tasks.md or start a fresh goal.`,
    );
  }

  return {
    consistent:
      missingGoalIds.length === 0 &&
      goalOnlyIds.length === 0 &&
      titleMismatches.length === 0 &&
      statusMismatches.length === 0,
    mirror,
    updates,
    missingGoalIds,
    goalOnlyIds,
    titleMismatches,
    statusMismatches,
    blockingIds,
    warnings,
  };
}

/**
 * Assemble the objective and derive the authoritative mirror in one step. The
 * task-count gate stays in the assembler (a change over the `set_goal_tasks`
 * limit is refused there, never mirrored partially).
 */
export function assembleAndPlanSync(input: {
  changeId: string;
  tasksMarkdown: string | undefined;
  boundaries: OpsxBoundaries;
  goalTasks: readonly GoalTaskLike[] | undefined;
}): {
  assembly: ReturnType<typeof assembleOpsxObjective>;
  sync: TaskSyncPlan;
} {
  const assembly = assembleOpsxObjective({
    changeId: input.changeId,
    tasksMarkdown: input.tasksMarkdown,
    boundaries: input.boundaries,
  });
  const sync = planTaskSync({
    tasksMarkdown: input.tasksMarkdown,
    goalTasks: input.goalTasks,
  });
  return { assembly, sync };
}
