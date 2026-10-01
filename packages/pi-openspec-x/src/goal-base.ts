/**
 * Read-only goal-base adapter (design D10; openspec change add-pi-openspec-x,
 * task 6.4).
 *
 * The plugin never owns the goal state — goal-x does. This module is the one
 * place that reads it: it resolves goal-x's storage root and parses its active
 * goal files through goal-x's own exported helpers, so the plugin can never
 * drift from the on-disk format. The import is dynamic because pi-goal-x is an
 * optional peer (task 6.6): a missing goal-x yields an empty base, never a
 * load-time crash.
 *
 * Nothing here writes, mutates, or locks a goal. Recovery and repair stay
 * goal-x's own `/goal-resume` and `/goal-clear`, surfaced by the session-start
 * notice below.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { GoalBaseSummary } from "./flow-recovery.ts";
import {
  diagnoseFlow,
  findOpsxGoals,
  isUnfinishedGoalStatus,
} from "./flow-recovery.ts";
import type { GoalTaskLike } from "./task-sync.ts";

/** The goal-x context shape `goalStorageRoot` accepts. */
export interface GoalStorageContextLike {
  cwd: string;
  sessionManager?: { getSessionId(): string | undefined };
}

/**
 * The slice of goal-x's storage the reader needs. `parseGoalFile` actually
 * returns goal-x's full GoalRecord; the extra fields are optional here so the
 * fake facets in tests stay minimal while the task-tree reader can still see
 * `taskList` (structural typing — no runtime import of the optional peer).
 */
export interface GoalXStorageFacet {
  goalStorageRoot(ctx: GoalStorageContextLike): string;
  parseGoalFile(filePath: string): {
    id: string;
    status: string;
    objective: string;
    taskList?: { tasks?: GoalTaskLike[] } | undefined;
  } | null;
}

/** Injectable dynamic-import seam; tests supply a fake storage facet. */
export type GoalXStorageLoader = () => Promise<GoalXStorageFacet>;

// Typed as `string` so TypeScript treats the dynamic import as unresolved at
// compile time (the peer may be absent at runtime).
const GOAL_ROOT_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/storage/goal-root.ts";
const GOAL_FILES_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/storage/goal-files.ts";

async function defaultGoalXStorageLoader(): Promise<GoalXStorageFacet> {
  const rootModule = (await import(GOAL_ROOT_MODULE)) as {
    goalStorageRoot: GoalXStorageFacet["goalStorageRoot"];
  };
  const filesModule = (await import(GOAL_FILES_MODULE)) as {
    parseGoalFile: GoalXStorageFacet["parseGoalFile"];
  };
  return {
    goalStorageRoot: rootModule.goalStorageRoot,
    parseGoalFile: filesModule.parseGoalFile,
  };
}

/** The active-goal file prefix goal-x writes (`active_goal_<ts>_<id>.md`). */
const ACTIVE_GOAL_FILE_PREFIX = "active_goal_";
const GOAL_FILE_SUFFIX = ".md";
/** goal-x's archived subdirectory under the goal storage root. */
const ARCHIVED_GOALS_DIR_NAME = "archived";

/**
 * Read the active goal base as plain summaries. Every failure path (goal-x
 * missing, unreadable root, malformed file) degrades to an empty or partial
 * list — a diagnosis must never take the session down.
 */
export async function readGoalBaseSummaries(
  ctx: GoalStorageContextLike,
  loader: GoalXStorageLoader = defaultGoalXStorageLoader,
): Promise<GoalBaseSummary[]> {
  let facet: GoalXStorageFacet;
  try {
    facet = await loader();
  } catch {
    return [];
  }

  let root: string;
  try {
    root = facet.goalStorageRoot(ctx);
  } catch {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const goals: GoalBaseSummary[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(ACTIVE_GOAL_FILE_PREFIX) ||
      !entry.name.endsWith(GOAL_FILE_SUFFIX)
    ) {
      continue;
    }
    let parsed: ReturnType<GoalXStorageFacet["parseGoalFile"]>;
    try {
      parsed = facet.parseGoalFile(path.join(root, entry.name));
    } catch {
      continue;
    }
    if (parsed) {
      goals.push({
        id: parsed.id,
        status: parsed.status,
        objective: parsed.objective,
      });
    }
  }
  return goals;
}

/** customType of the session-start recovery notice. */
export const RECOVERY_NOTICE_CUSTOM_TYPE = "pi-openspec-x/recovery-notice";

/** One archived goal: its id plus the status goal-x archived it under. */
export interface ArchivedGoalRef {
  id: string;
  /**
   * goal-x archives a completed goal as `complete` and a cleared goal under
   * its live status (e.g. `paused`), so the status tells "this goal finished"
   * apart from "the user ran /goal-clear mid-flow".
   */
  status: string;
}

/**
 * The goals goal-x has archived, with the status each was archived under.
 * Used to tell "this goal finished" (status `complete`) apart from "the user
 * cleared it" (any other status) before the implement flow ends itself.
 */
export async function readArchivedGoals(
  ctx: GoalStorageContextLike,
  loader: GoalXStorageLoader = defaultGoalXStorageLoader,
): Promise<ArchivedGoalRef[]> {
  let facet: GoalXStorageFacet;
  try {
    facet = await loader();
  } catch {
    return [];
  }
  let root: string;
  try {
    root = facet.goalStorageRoot(ctx);
  } catch {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, ARCHIVED_GOALS_DIR_NAME), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const archived: ArchivedGoalRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(GOAL_FILE_SUFFIX)) continue;
    try {
      const parsed = facet.parseGoalFile(
        path.join(root, ARCHIVED_GOALS_DIR_NAME, entry.name),
      );
      if (parsed) archived.push({ id: parsed.id, status: parsed.status });
    } catch {
      continue;
    }
  }
  return archived;
}

/**
 * The goal task tree of one active goal, for the tasks.md reconciliation
 * (design D10: tasks.md is authoritative; the goal tree is base state).
 * `undefined` means the goal could not be found or read — callers must skip
 * the reconciliation instead of misreading it as "no tasks".
 */
export async function readGoalTaskTree(
  ctx: GoalStorageContextLike,
  goalId: string,
  loader: GoalXStorageLoader = defaultGoalXStorageLoader,
): Promise<GoalTaskLike[] | undefined> {
  let facet: GoalXStorageFacet;
  try {
    facet = await loader();
  } catch {
    return undefined;
  }
  let root: string;
  try {
    root = facet.goalStorageRoot(ctx);
  } catch {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(ACTIVE_GOAL_FILE_PREFIX) ||
      !entry.name.endsWith(GOAL_FILE_SUFFIX)
    ) {
      continue;
    }
    let parsed: ReturnType<GoalXStorageFacet["parseGoalFile"]>;
    try {
      parsed = facet.parseGoalFile(path.join(root, entry.name));
    } catch {
      continue;
    }
    if (parsed?.id !== goalId) continue;
    return parsed.taskList?.tasks ?? [];
  }
  return undefined;
}

export interface RecoveryHandlerDeps {
  /** Injectable storage loader (tests); defaults to the real goal-x storage. */
  loadGoalXStorage?: GoalXStorageLoader;
  /** Scope the recovery search to one change id. */
  changeId?: string;
  /**
   * Re-install the per-goal auditor override (S1) for an unfinished opsx goal.
   * The override lives in memory, so a crash/restart loses it and the restored
   * goal would otherwise silently fall back to the default goal-auditor for its
   * completion audit instead of opsx-reviewer.
   */
  installAuditor?: (goalId: string) => void;
}

// One notice per (session, change) pair; module-level so an extension reload
// in the same process does not repeat it.
const recoveryNoticeSent = new Set<string>();

/** Reset the one-time notice state. Test-only. */
export function resetRecoveryStateForTests(): void {
  recoveryNoticeSent.clear();
}

/**
 * Build the `session_start` handler that offers the recovery entry when the
 * goal base holds an unfinished opsx goal. Read-only: it only sends a notice
 * telling the user to run goal-x's `/goal-resume` (or `/goal-clear`), and it
 * never resumes or mutates anything itself.
 */
export function createOpsxRecoverySessionStartHandler(
  pi: Pick<ExtensionAPI, "sendMessage">,
  deps: RecoveryHandlerDeps = {},
): ExtensionHandler<SessionStartEvent> {
  return async (
    _event: SessionStartEvent,
    ctx: ExtensionContext,
  ): Promise<void> => {
    let goals: GoalBaseSummary[];
    try {
      goals = await readGoalBaseSummaries(
        { cwd: ctx.cwd, sessionManager: ctx.sessionManager },
        deps.loadGoalXStorage,
      );
    } catch {
      return;
    }
    // Read-only diagnosis (task 6.4): what the base holds for this change and
    // whether the flow diverged from it (paused/blocked/cleared). Nothing here
    // mutates; the repair options it lists all need the user's explicit action.
    const opsxGoals = findOpsxGoals(goals);
    const only = opsxGoals.length === 1 ? opsxGoals[0] : undefined;
    const active =
      only && isUnfinishedGoalStatus(only.status)
        ? { goalId: only.goalId, changeId: only.changeId }
        : undefined;
    const diagnosis = diagnoseFlow({
      active,
      goals,
      changeId: deps.changeId,
    });
    if (diagnosis.notices.length === 0) return;

    // Best-effort: never break session start.
    if (deps.installAuditor) {
      for (const goal of opsxGoals) {
        if (!isUnfinishedGoalStatus(goal.status)) continue;
        try {
          deps.installAuditor(goal.goalId);
        } catch {
          // Best-effort.
        }
      }
    }

    const key = `${ctx.sessionManager?.getSessionId() ?? "unknown"}:${deps.changeId ?? "*"}`;
    if (recoveryNoticeSent.has(key)) return;
    recoveryNoticeSent.add(key);

    const content = diagnosis.notices.join("\n");
    try {
      pi.sendMessage(
        {
          customType: RECOVERY_NOTICE_CUSTOM_TYPE,
          content,
          display: true,
        },
        { deliverAs: "followUp" },
      );
    } catch {
      // Notification is best-effort; never break session start.
    }
  };
}
