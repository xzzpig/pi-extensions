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
  /**
   * Pre-resolved storage root. goal-x returns it verbatim (no settings I/O, no
   * directory creation), which is what the read-only focus facet passes.
   */
  goalStorageRoot?: string;
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

/**
 * goal-x custom entry types the focus facet reads (design D6).
 *
 * A goal's *focus* is a session-level fact carried by a `pi-goal-focus` entry
 * on the current branch — the active-goal summaries cannot answer it, which is
 * why this facet exists instead of reusing `readGoalBaseSummaries`.
 */
export const GOAL_FOCUS_ENTRY_TYPE = "pi-goal-focus";
export const GOAL_STATE_ENTRY_TYPE = "pi-goal-state";

/** The goal record fields this facet consumes (goal-x owns the real shape). */
export interface GoalRecordLike {
  id: string;
  status: string;
  objective: string;
  updatedAt?: string;
  activePath?: string;
  taskList?: { tasks?: GoalTaskLike[] } | undefined;
  [key: string]: unknown;
}

/** One persisted focus entry (goal-x's `GoalFocusEntry`). */
export interface GoalFocusEntryLike {
  version: 1;
  storageRoot?: string;
  focusedGoalId: string | null;
  reason: string;
}

/**
 * The slice of goal-x's published helpers this facet needs. Everything is
 * resolved through goal-x's own modules so the plugin can never drift from the
 * on-disk format; the live `GoalCore` is deliberately never obtained.
 *
 * "Read-only" here means the goal/focus/task domain state is unchanged. The
 * helpers do maintain their own caches and derived pool snapshots, which is
 * allowed (design D6); this package must not create such maintenance itself or
 * write goal files, the goal ledger, focus entries or tasks.
 */
export interface GoalXFocusFacet {
  goalStorageRoot(ctx: GoalStorageContextLike): string;
  parseGoalFile(filePath: string): GoalRecordLike | null;
  readActiveGoalPoolAsync(
    ctx: GoalStorageContextLike,
  ): Promise<Map<string, GoalRecordLike>>;
  normalizeGoalFocusEntry(value: unknown): GoalFocusEntryLike | null;
  normalizeGoalRecord(value: unknown): GoalRecordLike | null;
  resolveSessionFocus(args: {
    pool: Map<string, GoalRecordLike>;
    focusEntry?: GoalFocusEntryLike | null;
    legacyGoal?: GoalRecordLike | null;
    autoSelectSingleGoal?: boolean;
  }): string | null;
  loadGoalSettings(cwd: string): { autoSelectSingleGoal?: boolean };
}

/** Injectable dynamic-import seam; tests supply a fake focus facet. */
export type GoalXFocusLoader = () => Promise<GoalXFocusFacet>;

const GOAL_RECORD_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-record.ts";
const GOAL_POOL_MODULE: string = "@xzzpig/pi-goal-x/extensions/goal-pool.ts";
const GOAL_SETTINGS_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-settings.ts";

async function defaultGoalXFocusLoader(): Promise<GoalXFocusFacet> {
  const rootModule = (await import(GOAL_ROOT_MODULE)) as {
    goalStorageRoot: GoalXFocusFacet["goalStorageRoot"];
  };
  const filesModule = (await import(GOAL_FILES_MODULE)) as {
    parseGoalFile: GoalXFocusFacet["parseGoalFile"];
    readActiveGoalPoolAsync: GoalXFocusFacet["readActiveGoalPoolAsync"];
  };
  const recordModule = (await import(GOAL_RECORD_MODULE)) as {
    normalizeGoalFocusEntry: GoalXFocusFacet["normalizeGoalFocusEntry"];
    normalizeGoalRecord: GoalXFocusFacet["normalizeGoalRecord"];
  };
  const poolModule = (await import(GOAL_POOL_MODULE)) as {
    resolveSessionFocus: GoalXFocusFacet["resolveSessionFocus"];
  };
  const settingsModule = (await import(GOAL_SETTINGS_MODULE)) as {
    loadGoalSettings: GoalXFocusFacet["loadGoalSettings"];
  };
  return {
    goalStorageRoot: rootModule.goalStorageRoot,
    parseGoalFile: filesModule.parseGoalFile,
    readActiveGoalPoolAsync: filesModule.readActiveGoalPoolAsync,
    normalizeGoalFocusEntry: recordModule.normalizeGoalFocusEntry,
    normalizeGoalRecord: recordModule.normalizeGoalRecord,
    resolveSessionFocus: poolModule.resolveSessionFocus,
    loadGoalSettings: settingsModule.loadGoalSettings,
  };
}

/** Generation token: re-reading after any of these change invalidates a decision. */
export interface GoalFocusToken {
  sessionId: string | null;
  branchGeneration: string | null;
  storageRoot: string | null;
  focusEntryId: string | null;
  goalId: string | null;
}

/** One real goal tool result observed on this branch (v3 details). */
export interface RecentGoalToolRecord {
  goalId: string;
  record: GoalRecordLike;
  observedAt: string;
  toolCallId: string;
}

/** The authoritative answer to "which goal is focused, and what is its state". */
export interface FocusedGoalSnapshot {
  state: "known-focused" | "known-unfocused" | "unknown";
  goalId?: string;
  record?: GoalRecordLike;
  activePath?: string;
  token: GoalFocusToken;
  reason?: string;
}

/** Session shape this facet reads (a read-only subset of the host manager). */
export interface FocusSessionLike {
  getSessionId(): string | undefined;
  getBranch(): readonly unknown[];
  getLeafId(): string | null;
}

export interface FocusReadContext extends GoalStorageContextLike {
  sessionManager?: FocusSessionLike;
}

function tokenOf(
  ctx: FocusReadContext,
  storageRoot: string | null,
  focusEntryId: string | null,
  goalId: string | null,
): GoalFocusToken {
  return {
    sessionId: ctx.sessionManager?.getSessionId() ?? null,
    branchGeneration: ctx.sessionManager?.getLeafId() ?? null,
    storageRoot,
    focusEntryId,
    goalId,
  };
}

function unknownSnapshot(
  ctx: FocusReadContext,
  reason: string,
  storageRoot: string | null = null,
): FocusedGoalSnapshot {
  return {
    state: "unknown",
    token: tokenOf(ctx, storageRoot, null, null),
    reason,
  };
}

/**
 * Resolve a goal's recorded `activePath` to a real file path under the
 * configured storage root. goal-x records the logical `.pi/goals/<file>` form,
 * so a bare absolute parse would miss the file. Paths that escape the root are
 * refused rather than followed.
 */
function resolveActivePath(
  storageRoot: string,
  activePath: string,
): string | undefined {
  if (path.isAbsolute(activePath)) {
    return isPathWithinRootSync(activePath, storageRoot)
      ? activePath
      : undefined;
  }
  const logical = activePath.replace(/\\/g, "/");
  const suffix = logical.startsWith(".pi/goals/")
    ? logical.slice(".pi/goals/".length)
    : logical;
  const resolved = path.resolve(storageRoot, suffix);
  return isPathWithinRootSync(resolved, storageRoot) ? resolved : undefined;
}

function isPathWithinRootSync(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * The record with the newest `updatedAt`; on a tie the branch's newer real tool
 * result wins, because it covers task changes the file has not flushed yet.
 */
function mergeGoalRecords(
  fileRecord: GoalRecordLike | null,
  toolRecord: RecentGoalToolRecord | undefined,
): GoalRecordLike | null {
  if (!toolRecord) return fileRecord;
  if (!fileRecord) return toolRecord.record;
  if (toolRecord.goalId !== fileRecord.id) return fileRecord;
  const fileAt = fileRecord.updatedAt ?? "";
  const toolAt = toolRecord.record.updatedAt ?? "";
  return toolAt >= fileAt ? toolRecord.record : fileRecord;
}

/**
 * Read the authoritative focus snapshot (design D6).
 *
 * Mirrors `goal-state.ts::loadState`: the latest valid focus entry and legacy
 * state entry on the current branch, a storage-root check against the
 * configured root, and single-goal auto-selection only when the setting is
 * explicitly true. An explicit `null` focus never falls back to another goal.
 *
 * Returns `unknown` — never a guess — when the capability is missing, the
 * format is unrecognized, or the record cannot be read.
 */
export async function readFocusedGoalSnapshot(
  ctx: FocusReadContext,
  options: {
    loader?: GoalXFocusLoader;
    recentToolRecord?: RecentGoalToolRecord | undefined;
  } = {},
): Promise<FocusedGoalSnapshot> {
  const loader = options.loader ?? defaultGoalXFocusLoader;
  let facet: GoalXFocusFacet;
  try {
    facet = await loader();
  } catch (error) {
    return unknownSnapshot(
      ctx,
      `goal-x focus support is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let storageRoot: string;
  try {
    storageRoot = facet.goalStorageRoot(ctx);
  } catch (error) {
    return unknownSnapshot(
      ctx,
      `the goal storage root could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Latest valid focus entry and legacy state entry on the current branch.
  let focusEntryId: string | null = null;
  let focusEntry: GoalFocusEntryLike | null = null;
  let legacyGoal: GoalRecordLike | null = null;
  let legacySeen = false;
  const branch = ctx.sessionManager?.getBranch() ?? [];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as {
      type?: string;
      id?: string;
      customType?: string;
      data?: unknown;
    };
    if (!entry || entry.type !== "custom") continue;
    if (!focusEntry && entry.customType === GOAL_FOCUS_ENTRY_TYPE) {
      const normalized = facet.normalizeGoalFocusEntry(entry.data);
      if (normalized) {
        focusEntry = normalized;
        focusEntryId = typeof entry.id === "string" ? entry.id : null;
      }
    }
    if (!legacySeen && entry.customType === GOAL_STATE_ENTRY_TYPE) {
      const data = entry.data as { goal?: unknown } | undefined;
      legacyGoal = facet.normalizeGoalRecord(data?.goal);
      legacySeen = true;
    }
    if (focusEntry && legacySeen) break;
  }

  const defaultRoot = path.resolve(ctx.cwd, ".pi/goals");
  if (focusEntry && (focusEntry.storageRoot ?? defaultRoot) !== storageRoot) {
    // A focus entry recorded against a different storage root never applies
    // here; it does not silently re-target another goal either.
    focusEntry = { ...focusEntry, focusedGoalId: null };
    legacyGoal = null;
  }
  if (storageRoot !== defaultRoot) legacyGoal = null;

  let pool: Map<string, GoalRecordLike>;
  try {
    pool = await facet.readActiveGoalPoolAsync(ctx);
  } catch (error) {
    return unknownSnapshot(
      ctx,
      `the active goal pool could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      storageRoot,
    );
  }

  let autoSelectSingleGoal = false;
  try {
    autoSelectSingleGoal =
      facet.loadGoalSettings(ctx.cwd).autoSelectSingleGoal === true;
  } catch {
    // A settings failure must not widen the search; keep the strict default.
    autoSelectSingleGoal = false;
  }

  let goalId: string | null;
  try {
    goalId = facet.resolveSessionFocus({
      pool,
      focusEntry,
      legacyGoal,
      autoSelectSingleGoal,
    });
  } catch (error) {
    return unknownSnapshot(
      ctx,
      `the focused goal could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      storageRoot,
    );
  }

  if (!goalId) {
    return {
      state: "known-unfocused",
      token: tokenOf(ctx, storageRoot, focusEntryId, null),
    };
  }

  // The record itself comes from the canonical goal file, located by the known
  // path — not from a summary and not by scanning the directory.
  const poolRecord = pool.get(goalId) ?? null;
  let fileRecord: GoalRecordLike | null = poolRecord;
  let canonicalPath: string | undefined;
  if (poolRecord?.activePath) {
    canonicalPath = resolveActivePath(storageRoot, poolRecord.activePath);
  }
  if (canonicalPath) {
    try {
      fileRecord = facet.parseGoalFile(canonicalPath) ?? poolRecord;
    } catch {
      fileRecord = poolRecord;
    }
  }
  const record = mergeGoalRecords(fileRecord, options.recentToolRecord);
  if (!record) {
    return unknownSnapshot(
      ctx,
      `the focused goal ${goalId} has no readable record`,
      storageRoot,
    );
  }

  const activePath = canonicalPath ?? record.activePath;
  return {
    state: "known-focused",
    goalId,
    record,
    ...(activePath ? { activePath } : {}),
    token: tokenOf(ctx, storageRoot, focusEntryId, goalId),
  };
}

/**
 * Refresh one focused goal's record by its known path, without scanning the
 * storage root. `undefined` means the record is no longer readable, which the
 * caller must treat as "cannot prove the state" rather than "unchanged".
 */
export function refreshGoalRecordByPath(
  activePath: string,
  loader: GoalXFocusLoader = defaultGoalXFocusLoader,
): Promise<GoalRecordLike | undefined> {
  return loader().then(
    (facet) => {
      try {
        return facet.parseGoalFile(activePath) ?? undefined;
      } catch {
        return undefined;
      }
    },
    () => undefined,
  );
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
