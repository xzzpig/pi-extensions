/**
 * `/opsx:rollback <change-id>` — the REJECT rollback entry point (spec:
 * REJECT 回滚带备份).
 *
 * The actual rollback is goal-x's `goal-change-rollback` module (the same
 * implementation `/goal-clear` uses): its safe model is plan -> backup ->
 * execute, the backup is written into the goal archive directory before the
 * worktree is touched (fail-closed when the backup cannot be written), and it
 * reports head-moved and unrecoverable paths explicitly. This command is the
 * thin plugin-side entry point: it resolves the change's goal, reads the
 * execution-window delta, and delegates all three steps, so pi-openspec-x and
 * goal-x can never drift on the rollback logic.
 *
 * When the goal has no baseline commit (non-git project, unborn HEAD, no
 * baseline captured) the command degrades: it reports that rollback is
 * unavailable and changes nothing.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { describeError } from "./dependencies.ts";
import { appendFlowEntry, OPSX_ENTRY_TYPES } from "./flow-entries.ts";
import { findOpsxGoals, type GoalBaseSummary } from "./flow-recovery.ts";
import { sendNotice } from "./command-util.ts";
import {
  readGoalBaseSummaries,
  type GoalStorageContextLike,
} from "./goal-base.ts";
import { readGoalWindowDelta, type ReviewWindowDelta } from "./review-scope.ts";

export const ROLLBACK_NOTICE_CUSTOM_TYPE = "pi-openspec-x/rollback-notice";

/**
 * The slice of goal-x's `goal-change-rollback` this command uses. The real
 * shapes are goal-x's; the seam keeps them opaque and injectable, and the
 * dynamic import is a plain string so an absent peer never breaks the build.
 */
export interface GoalXRollbackFacet {
  planRollback(delta: unknown): {
    goalId: string;
    repos: Array<{ base: string | null; baseKind: string }>;
    restoreCount: number;
    deleteCount: number;
    unrecoverableCount: number;
  };
  writeRollbackBackup(
    ctx: GoalStorageContextLike,
    plan: unknown,
    options?: { now?: Date; maxBytes?: number },
  ): Promise<{
    ok: boolean;
    dir: string | null;
    reason?: string;
    bytes: number;
  }>;
  executeRollback(plan: unknown): Promise<
    Array<{
      restored: number;
      deleted: number;
      failures: Array<{ path: string; reason: string }>;
    }>
  >;
  formatRollbackReport(
    plan: unknown,
    results: unknown,
    backupDir: string | null,
  ): string;
}

const GOAL_ROLLBACK_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-change-rollback.ts";

async function defaultGoalXRollbackLoader(): Promise<GoalXRollbackFacet> {
  return (await import(GOAL_ROLLBACK_MODULE)) as GoalXRollbackFacet;
}

export interface RollbackFlowDeps {
  /** Injectable goal-base reader; defaults to goal-x's active goal files. */
  readGoals?: (ctx: ExtensionContext) => Promise<GoalBaseSummary[]>;
  /** Injectable window-delta reader; defaults to goal-x's baseline + delta. */
  readDelta?: (
    ctx: ExtensionContext,
    goalId: string,
  ) => Promise<ReviewWindowDelta | undefined>;
  /** Injectable goal-x rollback module; defaults to the dynamic import. */
  rollbackModule?: () => Promise<GoalXRollbackFacet>;
  /** Injectable clock for the backup directory stamp. */
  now?: () => Date;
}

/**
 * Register `/opsx:rollback`. Flow: resolve the change's goal, read the window
 * delta, then delegate plan -> backup -> execute to goal-x's rollback module.
 */
export function registerRollbackFlow(
  pi: ExtensionAPI,
  deps: RollbackFlowDeps = {},
): void {
  const readGoals =
    deps.readGoals ??
    ((ctx: ExtensionContext) =>
      readGoalBaseSummaries({
        cwd: ctx.cwd,
        sessionManager: ctx.sessionManager,
      }));
  const readDelta =
    deps.readDelta ??
    ((ctx: ExtensionContext, goalId: string) =>
      readGoalWindowDelta(
        { cwd: ctx.cwd, sessionManager: ctx.sessionManager },
        goalId,
      ));
  const loadRollback = deps.rollbackModule ?? defaultGoalXRollbackLoader;
  const now = deps.now ?? (() => new Date());

  pi.registerCommand("opsx:rollback", {
    description:
      "Roll back the execution window of a REJECTed opsx goal: goal-x plans, backs every discarded file up, then restores the worktree from the goal baseline.",
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const changeId = args.trim();
      if (!changeId) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          "Usage: /opsx:rollback <change-id>",
        );
        return;
      }

      let goals: GoalBaseSummary[];
      try {
        goals = await readGoals(ctx);
      } catch (error) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          `Cannot read the goal base, so there is nothing to roll back: ${describeError(error)}`,
        );
        return;
      }
      const goal = findOpsxGoals(goals).find(
        (candidate) => candidate.changeId === changeId,
      );
      if (!goal) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          `No opsx goal in the active base owns change "${changeId}". Rollback only applies to the execution window of a goal this plugin created; nothing was changed.`,
        );
        return;
      }

      let delta: ReviewWindowDelta | undefined;
      try {
        delta = await readDelta(ctx, goal.goalId);
      } catch {
        delta = undefined;
      }
      if (!delta) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          `Rollback is unavailable for change "${changeId}": the goal base has no baseline commit to roll back to (not a git repository, an unborn HEAD, or no baseline was captured). Nothing was changed.`,
        );
        return;
      }

      let facet: GoalXRollbackFacet;
      try {
        facet = await loadRollback();
      } catch (error) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          `Rollback is unavailable for change "${changeId}": the goal-x rollback module could not be loaded (${describeError(error)}). Nothing was changed.`,
        );
        return;
      }

      // Step 1 — plan (goal-x, pure; touches nothing).
      let plan: ReturnType<GoalXRollbackFacet["planRollback"]>;
      try {
        plan = facet.planRollback(delta as never);
      } catch (error) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          `Rollback aborted: could not plan against the window delta (${describeError(error)}). Nothing was changed.`,
        );
        return;
      }
      const restorable =
        plan.repos.length > 0 &&
        plan.repos.some(
          (repo) => repo.baseKind !== "status-only" && repo.base !== null,
        );
      if (!restorable) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          `Rollback is unavailable for change "${changeId}": no repository in the window has a baseline commit to restore from. Nothing was changed.`,
        );
        return;
      }

      // Step 2 — back up. Goal-x writes the backup into the goal archive
      // directory and returns ok:false on any failure; the worktree must not
      // be touched until the whole backup is on disk.
      const backup = await facet.writeRollbackBackup(
        { cwd: ctx.cwd, sessionManager: ctx.sessionManager },
        plan,
        { now: now() },
      );
      if (!backup.ok) {
        sendNotice(
          pi,
          ROLLBACK_NOTICE_CUSTOM_TYPE,
          `Rollback aborted before touching the worktree: the backup could not be written (${backup.reason ?? "unknown reason"}). Nothing was changed.`,
        );
        return;
      }

      // Step 3 — execute (goal-x; failures are collected, never thrown).
      const results = await facet.executeRollback(plan);
      appendFlowEntry(pi, OPSX_ENTRY_TYPES.rollback, {
        changeId,
        goalId: goal.goalId,
        restored: results.reduce((sum, result) => sum + result.restored, 0),
        deleted: results.reduce((sum, result) => sum + result.deleted, 0),
      });
      sendNotice(
        pi,
        ROLLBACK_NOTICE_CUSTOM_TYPE,
        facet.formatRollbackReport(plan, results, backup.dir),
      );
    },
  });
}
