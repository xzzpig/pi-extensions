/**
 * `/opsx:implement` mode selection and flow start (design D6/D10; openspec
 * change add-pi-openspec-x, task 8.1).
 *
 * The command picks one of two modes — agent implementation (opsx-agent +
 * opsx-worker dispatches) or direct main-session implementation — from the
 * command arguments or a structured question. Nothing starts until a mode is
 * chosen, and a second flow in the same session is refused with a pointer to
 * resume or end the existing one.
 *
 * Both modes run on a persistent goal-x goal: the assembled objective is handed
 * to `create_goal` (sisyphus in agent mode, regular autoContinue in direct
 * mode) and the task tree to `set_goal_tasks`. Direct mode never switches the
 * role or tightens permissions; agent mode enters the restricted `opsx-agent`
 * sandbox profile first (fail-closed). The final gate is the goal's completion
 * audit (task 8.3), so both paths end at the same review.
 *
 * The plugin cannot call goal tools itself — the main agent owns them — so the
 * command appends the exact `create_goal` / `set_goal_tasks` payloads as an
 * instruction message. Everything else (mode, guard, objective) is computed
 * here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
  TurnEndEvent,
  TurnEndEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

import { canEnterImplementation, type PlanApproval } from "./approval-gate.ts";
import { DEFAULT_AGENT_ALLOW_WRITE } from "./config.ts";
import {
  describeError,
  OpsxDependencyMissingError,
  requireGoalXSupport,
} from "./dependencies.ts";
import { sendNotice, sessionKey } from "./command-util.ts";
import { DispatchReviewTracker, evaluateTickGate } from "./dispatch-gate.ts";
import {
  buildOpsxAuditorOverride,
  renderArchiveGuidance,
} from "./final-gate.ts";
import {
  appendFlowEntry,
  appendStatusSnapshot,
  OPSX_ENTRY_TYPES,
} from "./flow-entries.ts";
import {
  detectFlowDivergence,
  findOpsxGoals,
  type GoalBaseSummary,
} from "./flow-recovery.ts";
import {
  readArchivedGoals as readArchivedGoalsFromBase,
  readGoalBaseSummaries,
  readGoalTaskTree,
  type ArchivedGoalRef,
} from "./goal-base.ts";
import {
  emitSilentUiSpan,
  publishLifecycle,
  publishNotify,
  type EventEmitterLike,
} from "./lifecycle.ts";
import { enterOpsxMode } from "./mode.ts";
import { endPlanFlow } from "./plan-command.ts";
import { computeReviewScope } from "./review-scope.ts";
import {
  planTaskSync,
  type GoalTaskLike,
  type TaskSyncPlan,
} from "./task-sync.ts";
import type { WorkReportLike } from "./worker-dispatch.ts";
import { readPlanApproval } from "./plan-review.ts";
import {
  assembleOpsxObjective,
  type ObjectiveAssembly,
  type OpsxBoundaries,
} from "./objective.ts";

/** customType of the `/opsx:implement` start instruction message. */
export const IMPLEMENT_START_CUSTOM_TYPE = "pi-openspec-x/implement-start";
/** customType of an `/opsx:implement` notice. */
export const IMPLEMENT_NOTICE_CUSTOM_TYPE = "pi-openspec-x/implement-notice";

export type ImplementationMode = "agent" | "direct";

export interface ParsedImplementArgs {
  changeId?: string;
  mode?: ImplementationMode;
  error?: string;
}

/**
 * Parse `/opsx:implement [--agent|--direct] <change-id>`. Bare `agent`/`direct`
 * words are accepted too, so the command reads naturally.
 */
export function parseImplementArgs(args: string): ParsedImplementArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let mode: ImplementationMode | undefined;
  const rest: string[] = [];
  for (const token of tokens) {
    if (token === "--agent" || token === "agent") mode = "agent";
    else if (token === "--direct" || token === "direct") mode = "direct";
    else rest.push(token);
  }
  if (rest.length > 1) {
    return { error: `expected a single change id, got: ${rest.join(" ")}` };
  }
  return {
    ...(rest[0] ? { changeId: rest[0] } : {}),
    ...(mode ? { mode } : {}),
  };
}

interface ImplementFlow {
  changeId: string;
  mode: ImplementationMode;
  /** goal-x goal id once the main agent creates it. */
  goalId?: string;
  phase: "starting" | "implementing" | "reviewing";
}

const flows = new Map<string, ImplementFlow>();

/**
 * Divergences already reported, so a repeated turn does not spam the user.
 * Keyed by session id and divergence kind.
 */
const reportedDivergences = new Set<string>();

/**
 * Sessions whose active flow already had its one tasks.md⇄goal-tree
 * reconciliation warning (task 6.3). At most one warning per flow keeps the
 * check from nagging on every tick; cleared when the flow ends.
 */
const taskSyncWarned = new Set<string>();

/**
 * Consecutive polls in which the flow's goal was missing from the active base.
 * A single miss is treated as a degraded read, not a cleared goal.
 */
const missingGoalPolls = new Map<string, number>();

/**
 * Window-delta cache for the tick gate. The gate runs on the `tool_call` hot
 * path and every evaluation would otherwise pay a dynamic import plus several
 * git subprocesses; a short TTL bounds that while still refreshing within a
 * task. Cleared whenever a flow ends or the test state resets.
 */
const WINDOW_DELTA_TTL_MS = 2_000;
const windowDeltaCache = new Map<
  string,
  { at: number; paths: string[] | undefined }
>();

async function cachedWindowDelta(
  key: string,
  load: () => Promise<string[] | undefined>,
): Promise<string[] | undefined> {
  const hit = windowDeltaCache.get(key);
  if (hit && Date.now() - hit.at < WINDOW_DELTA_TTL_MS) return hit.paths;
  const paths = await load();
  windowDeltaCache.set(key, { at: Date.now(), paths });
  return paths;
}

/**
 * Per-session dispatch bookkeeping for the enforced tick gate (task 8.2).
 */
const trackers = new Map<string, DispatchReviewTracker>();

function trackerFor(sessionId: string): DispatchReviewTracker {
  let tracker = trackers.get(sessionId);
  if (!tracker) {
    tracker = new DispatchReviewTracker();
    trackers.set(sessionId, tracker);
  }
  return tracker;
}

/** Reset the per-session flow registry. Test-only. */
export function resetImplementFlowsForTests(): void {
  flows.clear();
  reportedDivergences.clear();
  missingGoalPolls.clear();
  trackers.clear();
  windowDeltaCache.clear();
  taskSyncWarned.clear();
}

export function activeImplementFlow(
  sessionId: string,
): ImplementFlow | undefined {
  return flows.get(sessionId);
}

/**
 * Register a new flow. Refuses when one is already active for the session:
 * two concurrent implementation flows would fight over tasks.md and the goal
 * tree, so the caller must resume or end the existing flow first.
 */
export function startImplementFlow(
  sessionId: string,
  flow: ImplementFlow,
): { ok: true } | { ok: false; reason: string } {
  const existing = flows.get(sessionId);
  if (existing) {
    return {
      ok: false,
      reason: `An opsx implementation flow for change "${existing.changeId}" (${existing.mode}) is already active in this session. Resume it or end it before starting another.`,
    };
  }
  flows.set(sessionId, flow);
  return { ok: true };
}

function updateImplementFlow(
  sessionId: string,
  patch: Partial<ImplementFlow>,
): void {
  const existing = flows.get(sessionId);
  if (existing) flows.set(sessionId, { ...existing, ...patch });
}

export function endImplementFlow(sessionId: string): void {
  flows.delete(sessionId);
  missingGoalPolls.delete(sessionId);
  trackers.delete(sessionId);
  for (const key of [...windowDeltaCache.keys()]) {
    if (key.startsWith(`${sessionId}:`)) windowDeltaCache.delete(key);
  }
  for (const key of [...reportedDivergences]) {
    if (key.startsWith(`${sessionId}:`)) reportedDivergences.delete(key);
  }
  for (const key of [...taskSyncWarned]) {
    if (key.startsWith(`${sessionId}:`)) taskSyncWarned.delete(key);
  }
}

/** Absolute path of a change's tasks.md. */
function tasksMdPath(cwd: string, changeId: string): string {
  return path.join(cwd, "openspec", "changes", changeId, "tasks.md");
}

/** Absolute path of a change directory. */
export function changeDirPath(cwd: string, changeId: string): string {
  return path.join(cwd, "openspec", "changes", changeId);
}

function readTasksMarkdown(cwd: string, changeId: string): string | undefined {
  try {
    return fs.readFileSync(tasksMdPath(cwd, changeId), "utf-8");
  } catch {
    return undefined;
  }
}

const MODE_OPTIONS: Array<{ value: ImplementationMode; label: string }> = [
  {
    value: "agent",
    label: "Agent implementation (opsx-agent role, opsx-worker dispatches)",
  },
  {
    value: "direct",
    label: "Direct main-session implementation (no role switch)",
  },
];

/**
 * Ask for the mode when the command did not carry one. Without a UI nothing is
 * selected (undefined) and the caller must not start anything.
 */
export async function selectImplementationMode(
  ctx: ExtensionContext,
  events?: EventEmitterLike,
): Promise<ImplementationMode | undefined> {
  if (!ctx.hasUI) return undefined;
  // pi-notify (task 9.4): the mode question is a blocking UI that is not an
  // agent-waiting prompt, so claim the next UI span as silent first. Done
  // before `hasUI`-gated dialogs so the span is claimed for this dialog.
  if (events) {
    emitSilentUiSpan(events, "implementation mode dialog");
  }
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(
      "How should /opsx:implement run this change?",
      MODE_OPTIONS.map((option) => option.label),
    );
  } catch {
    return undefined;
  }
  return MODE_OPTIONS.find((option) => option.label === choice)?.value;
}

/** The boundaries the objective encodes for each mode. */
export function boundariesForMode(
  mode: ImplementationMode,
  agentAllowWrite: readonly string[],
): OpsxBoundaries {
  return { mode, writable: [...agentAllowWrite] };
}

/**
 * Render the instruction message the main agent follows to start the goal:
 * the exact `create_goal` payload, the `set_goal_tasks` mirror, and the mode's
 * dispatch discipline.
 */
export function renderImplementStart(
  assembly: Extract<ObjectiveAssembly, { ok: true }>,
  mode: ImplementationMode,
): string {
  const lines = [
    `[OPSX IMPLEMENT START change=${assembly.goalStart.objective.match(/change "([^"]+)"/)?.[1] ?? "?"} mode=${mode}]`,
    "Start the implementation goal now:",
    "",
    "1. Call `create_goal` with:",
    "```json",
    JSON.stringify(assembly.goalStart, null, 2),
    "```",
    "2. Call `set_goal_tasks` with:",
    "```json",
    JSON.stringify({ tasks: assembly.goalTasks }, null, 2),
    "```",
    "",
  ];
  if (mode === "agent") {
    lines.push(
      "Agent mode: you are sandboxed to openspec/ and the build-output allowlist; the source tree is read-only. Dispatch opsx-worker for every source change and review its full diff plus verification before ticking a task in tasks.md. Keep the goal task tree in sync with tasks.md.",
    );
  } else {
    lines.push(
      "Direct mode: implement tasks.md yourself in order, verify each task, and tick tasks.md only after its verification passes. Keep the goal task tree in sync with tasks.md.",
    );
  }
  lines.push(
    "",
    "Completion is the goal's completion audit: ticking every task is not completion. When all tasks are done, request completion; a disapproved audit keeps the goal active and you fix and re-review.",
  );
  return lines.join("\n");
}

export interface ImplementFlowDeps {
  /** Write allowlist for the agent objective (defaults to the D4 list). */
  agentAllowWrite?: string[];
  /** Injectable restricted-mode entry; defaults to the agent sandbox mode. */
  enterMode?: (pi: ExtensionAPI, ctx: ExtensionCommandContext) => Promise<void>;
  /** Injectable goal-base reader; defaults to goal-x's active goal files. */
  readGoals?: (ctx: ExtensionContext) => Promise<GoalBaseSummary[]>;
  /** Injectable archived-goal reader; defaults to goal-x's archived files. */
  readArchivedGoals?: (ctx: ExtensionContext) => Promise<ArchivedGoalRef[]>;
  /**
   * Injectable goal task-tree reader for the tasks.md reconciliation
   * (task 6.3); defaults to goal-x's active goal files. `undefined` in the
   * returned promise means the tree could not be read and the check is
   * skipped.
   */
  readGoalTasks?: (
    ctx: ExtensionContext,
    goalId: string,
  ) => Promise<GoalTaskLike[] | undefined>;
  /** Injectable final-audit installer; defaults to the S1 override. */
  installAuditor?: (goalId: string) => void;
  /** Injectable plan-approval reader; defaults to the change's plan ledger. */
  readApproval?: (cwd: string, changeId: string) => PlanApproval | undefined;
  /** Lifecycle bus; defaults to `pi.events` at call time. */
  events?: EventEmitterLike;
  /**
   * Injectable window-delta reader for the tick gate; defaults to goal-x's
   * baseline plus change delta. Undefined means the file-set reconciliation
   * is skipped and only the dispatch/review structure is enforced.
   */
  readWindowDelta?: (
    ctx: ExtensionContext,
    goalId: string,
  ) => Promise<string[] | undefined>;
}

/**
 * goal-x's goal-creation tools. The goal id only exists after one of these has
 * run, and the agent may request completion in the same turn, so the S1
 * override must be installed as soon as either result arrives.
 */
const CREATE_GOAL_TOOL_NAME = "create_goal";
const SET_GOAL_TASKS_TOOL_NAME = "set_goal_tasks";

type OpsxGoalRefLike = ReturnType<typeof findOpsxGoals>[number];

/**
 * Install the S1 per-goal auditor override and move the flow to the reviewing
 * phase. Shared by the `turn_end` poll and the `create_goal`/`set_goal_tasks`
 * tool-result hook: installing only at turn end would let a goal that is
 * created and completed inside one turn run its audit with the default
 * goal-auditor instead of opsx-reviewer.
 */
async function ensureAuditorInstalled(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
  sessionId: string,
  goal: OpsxGoalRefLike,
  flow: ImplementFlow,
  deps: Required<Pick<ImplementFlowDeps, "installAuditor">>,
): Promise<void> {
  try {
    deps.installAuditor(goal.goalId);
  } catch (error) {
    sendNotice(
      pi,
      IMPLEMENT_NOTICE_CUSTOM_TYPE,
      `Could not point the completion audit at opsx-reviewer for goal ${goal.goalId}: ${describeError(error)}`,
    );
    return;
  }
  updateImplementFlow(sessionId, { goalId: goal.goalId, phase: "reviewing" });
  appendFlowEntry(pi, OPSX_ENTRY_TYPES.phaseChanged, {
    changeId: flow.changeId,
    phase: "reviewing",
  });
  publishLifecycle(pi.events, {
    type: "phase_changed",
    change: flow.changeId,
    mode: flow.mode,
    phase: "reviewing",
  });
  sendNotice(
    pi,
    IMPLEMENT_NOTICE_CUSTOM_TYPE,
    `Goal ${goal.goalId} created; its completion audit now runs the read-only opsx-reviewer (plan conformance, code quality, verification evidence, scope fidelity). Complete the goal when every task is ticked; a disapproved audit keeps it active for a fix round.`,
  );
}

/**
 * Build the `tool_result` handler that installs the S1 override the moment
 * goal-x reports a goal creation, closing the same-turn completion race.
 */
function createImplementGoalToolResultHandler(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
  deps: Required<Pick<ImplementFlowDeps, "readGoals" | "installAuditor">>,
): ExtensionHandler<ToolResultEvent, ToolResultEventResult> {
  return async (
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (
      event.toolName !== CREATE_GOAL_TOOL_NAME &&
      event.toolName !== SET_GOAL_TASKS_TOOL_NAME
    ) {
      return;
    }
    const sessionId = sessionKey(ctx);
    const flow = flows.get(sessionId);
    if (!flow || flow.goalId) return;
    let goals: GoalBaseSummary[];
    try {
      goals = await deps.readGoals(ctx);
    } catch {
      return;
    }
    const goal = findOpsxGoals(goals).find(
      (candidate) => candidate.changeId === flow.changeId,
    );
    if (!goal) return;
    await ensureAuditorInstalled(pi, sessionId, goal, flow, deps);
  };
}

/**
 * Tool traffic that carries flow facts the plugin cannot observe from inside
 * goal-x: a worker dispatch, a task tick, and the goal's final audit verdict.
 */
const SUBAGENT_TOOL_NAME = "subagent";
const UPDATE_GOAL_TOOL_NAME = "update_goal";
const UPDATE_GOAL_TASK_TOOL_NAME = "update_goal_task";
const OPSX_WORKER_AGENT = "opsx-worker";
const REPORT_WORK_TOOL_NAME = "report_work";
const WORKER_DISPATCH_TASK_RE = /\[OPSX WORKER DISPATCH task=([^\]]+)\]/;
const DISPATCH_TASK_RE = /\btask\s*[=:]?\s*(\d+(?:\.\d+)*)\b/i;

/** Collect every string inside a tool payload, bounded by depth. */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value))
      collectStrings(item, out, depth + 1);
  }
}

/**
 * Read the task id out of a worker dispatch. The `subagent` tool accepts a
 * free-form `prompt` or structured `args`/`task` sections, so the id is looked
 * for in every string of the payload. `undefined` means the payload never
 * named the task; the gate still counts the dispatch.
 */
function extractDispatchTaskId(
  input: Record<string, unknown>,
): string | undefined {
  const strings: string[] = [];
  collectStrings(input, strings);
  for (const text of strings) {
    const marked = WORKER_DISPATCH_TASK_RE.exec(text)?.[1]?.trim();
    if (marked) return marked;
  }
  for (const text of strings) {
    const plain = DISPATCH_TASK_RE.exec(text)?.[1];
    if (plain) return plain;
  }
  return undefined;
}

function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Render the re-mirror instruction for a tasks.md⇄goal-tree divergence
 * (design D10: tasks.md is authoritative). The plugin cannot call goal tools
 * itself, so the message carries the exact `set_goal_tasks` mirror payload and
 * the ordered `update_goal_task` follow-ups, like the start instruction does.
 */
function renderTaskSyncNotice(changeId: string, plan: TaskSyncPlan): string {
  const lines = [
    `[OPSX TASK SYNC change=${changeId}] tasks.md and the goal task tree diverged; tasks.md is authoritative, so re-mirror the goal tree from tasks.md now:`,
    "",
    "1. Call `set_goal_tasks` with:",
    "```json",
    JSON.stringify({ tasks: plan.mirror }, null, 2),
    "```",
  ];
  if (plan.updates.length > 0) {
    lines.push(
      "2. Follow with `update_goal_task` for each status realignment:",
    );
    for (const update of plan.updates) {
      lines.push(
        `   - task ${update.taskId} → ${update.status}${update.requiresEvidence ? " (attach verification evidence)" : ""}`,
      );
    }
  }
  for (const warning of plan.warnings) lines.push(`- ${warning}`);
  return lines.join("\n");
}

/**
 * The lightweight tasks.md⇄goal-tree reconciliation (task 6.3, design D10),
 * run after a successful tick is written back. Consistent trees do nothing;
 * a divergence re-mirrors from tasks.md (the exact payloads go to the main
 * agent, which owns the goal tools) and appends one warning entry. At most
 * one warning per flow keeps this from nagging on every tick, and an
 * unreadable goal tree is skipped rather than misread as "no tasks".
 */
async function runTaskSyncCheck(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
  sessionId: string,
  flow: ImplementFlow,
  ctx: ExtensionContext,
  deps: { readGoalTasks?: ImplementFlowDeps["readGoalTasks"] },
): Promise<void> {
  const goalId = flow.goalId;
  const readGoalTasks = deps.readGoalTasks;
  if (!goalId || !readGoalTasks) return;
  const key = `${sessionId}:${flow.changeId}`;
  if (taskSyncWarned.has(key)) return;
  let goalTasks: GoalTaskLike[] | undefined;
  try {
    goalTasks = await readGoalTasks(ctx, goalId);
  } catch {
    return;
  }
  if (goalTasks === undefined) return;
  const plan = planTaskSync({
    tasksMarkdown: readTasksMarkdown(ctx.cwd, flow.changeId),
    goalTasks,
  });
  if (plan.consistent) return;
  taskSyncWarned.add(key);
  appendFlowEntry(pi, OPSX_ENTRY_TYPES.progress, {
    changeId: flow.changeId,
    note: `task sync: re-mirroring from tasks.md (${plan.warnings.join(" ")})`,
  });
  sendNotice(
    pi,
    IMPLEMENT_NOTICE_CUSTOM_TYPE,
    renderTaskSyncNotice(flow.changeId, plan),
  );
}

/**
 * Publish the lifecycle events whose source is the main agent's own tool
 * traffic (task 9.3): `task_dispatched` for an opsx-worker dispatch,
 * `task_completed` for a completed goal task, and `final_verdict` for the
 * goal's completion audit result. All three are best-effort observations; a
 * payload without a task id still publishes the event.
 */
function createImplementLifecycleToolHandler(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
  deps: {
    events?: EventEmitterLike;
    readGoalTasks?: ImplementFlowDeps["readGoalTasks"];
  } = {},
): ExtensionHandler<ToolResultEvent, ToolResultEventResult> {
  return async (event, ctx) => {
    const sessionId = sessionKey(ctx);
    const flow = flows.get(sessionId);
    if (!flow) return;
    const events = deps.events ?? pi.events;

    if (event.toolName === SUBAGENT_TOOL_NAME) {
      if (stringField(event.input, "agent") !== OPSX_WORKER_AGENT) return;
      const taskId = extractDispatchTaskId(event.input);
      // The tick gate needs to know a dispatch happened before it can demand
      // a review for it (task 8.2).
      trackerFor(sessionId).noteDispatch(taskId);
      publishLifecycle(events, {
        type: "task_dispatched",
        change: flow.changeId,
        mode: flow.mode,
        ...(taskId ? { taskId } : {}),
      });
      return;
    }

    if (event.toolName === REPORT_WORK_TOOL_NAME) {
      const report = workReportFrom(event.input);
      if (report) trackerFor(sessionId).rememberReport(report);
      return;
    }

    if (event.toolName === UPDATE_GOAL_TASK_TOOL_NAME) {
      if (event.isError) return;
      if (stringField(event.input, "status") !== "complete") return;
      const taskId = stringField(event.input, "task_id");
      if (taskId) trackerFor(sessionId).noteTick(taskId);
      appendFlowEntry(pi, OPSX_ENTRY_TYPES.taskTicked, {
        changeId: flow.changeId,
        ...(taskId ? { taskId } : {}),
      });
      publishLifecycle(events, {
        type: "task_completed",
        change: flow.changeId,
        mode: flow.mode,
        ...(taskId ? { taskId } : {}),
      });
      // The tick was written back; reconcile the goal tree against tasks.md
      // once per flow (task 6.3: tasks.md wins, divergence warns).
      await runTaskSyncCheck(pi, sessionId, flow, ctx, deps);
      return;
    }

    if (event.toolName === UPDATE_GOAL_TOOL_NAME) {
      if (stringField(event.input, "status") !== "complete") return;
      publishLifecycle(events, {
        type: "final_verdict",
        change: flow.changeId,
        mode: flow.mode,
        verdict: event.isError ? "disapproved" : "approved",
      });
    }
  };
}

/** Structural read of a `report_work` payload; undefined when malformed. */
function workReportFrom(
  input: Record<string, unknown>,
): WorkReportLike | undefined {
  const taskId = stringField(input, "taskId");
  const changedFiles = input.changedFiles;
  if (!taskId || !Array.isArray(changedFiles)) return undefined;
  const files = changedFiles.filter(
    (entry): entry is string => typeof entry === "string",
  );
  const verification = input.selfVerification;
  const selfVerification =
    typeof verification === "object" && verification !== null
      ? (verification as { command?: string; result?: string })
      : {};
  return {
    taskId,
    changedFiles: files,
    claims: stringField(input, "claims") ?? "",
    selfVerification,
    ...(typeof input.verificationPassed === "boolean"
      ? { verificationPassed: input.verificationPassed }
      : {}),
  };
}

/**
 * The enforced tick gate (task 8.2; spec MUST "未审查不得勾选"). Blocks an
 * `update_goal_task` completion in agent mode until the task's worker dispatch
 * has been reviewed with `report_work` and the review reconciles with the
 * window delta. Direct mode is ungated: it has no dispatch to review.
 */
function createImplementTickGateHandler(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
  deps: {
    readWindowDelta?: (
      ctx: ExtensionContext,
      goalId: string,
    ) => Promise<string[] | undefined>;
  } = {},
): ExtensionHandler<ToolCallEvent, ToolCallEventResult> {
  return async (event, ctx) => {
    if (event.toolName !== UPDATE_GOAL_TASK_TOOL_NAME) return {};
    if (stringField(event.input, "status") !== "complete") return {};
    const sessionId = sessionKey(ctx);
    const flow = flows.get(sessionId);
    if (!flow || flow.mode !== "agent") return {};
    const taskId = stringField(event.input, "task_id");
    if (!taskId) return {};

    const goalId = flow.goalId;
    const readDelta = deps.readWindowDelta;
    const observedChangedFiles =
      goalId && readDelta
        ? await cachedWindowDelta(`${sessionId}:${goalId}`, () =>
            readDelta(ctx, goalId),
          )
        : undefined;
    const decision = evaluateTickGate(trackerFor(sessionId), {
      taskId,
      ...(observedChangedFiles ? { observedChangedFiles } : {}),
    });
    if (decision.allow) {
      for (const warning of decision.warnings) {
        sendNotice(
          pi,
          IMPLEMENT_NOTICE_CUSTOM_TYPE,
          `[OPSX TICK GATE] ${warning}`,
        );
      }
      return {};
    }

    sendNotice(
      pi,
      IMPLEMENT_NOTICE_CUSTOM_TYPE,
      `[OPSX TICK GATE] ${decision.reason}`,
    );
    return { block: true, reason: decision.reason };
  };
}

/**
 * Build the turn_end handler that attaches the final-audit configuration once
 * the main agent has created the goal. The goal id is only known after the
 * agent calls `create_goal`, so this polls the goal base each turn until the
 * opsx goal for the active change appears, then installs the per-goal override
 * (the S2 resolver was registered at extension init).
 */
export function createImplementTurnEndHandler(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
  deps: Required<
    Pick<
      ImplementFlowDeps,
      "readGoals" | "installAuditor" | "readArchivedGoals"
    >
  >,
): ExtensionHandler<TurnEndEvent, TurnEndEventResult> {
  return async (_event: TurnEndEvent, ctx: ExtensionContext): Promise<void> => {
    const sessionId = sessionKey(ctx);
    const flow = flows.get(sessionId);
    if (!flow) return;

    let goals: GoalBaseSummary[];
    try {
      goals = await deps.readGoals(ctx);
    } catch {
      return;
    }
    const goal = findOpsxGoals(goals).find(
      (candidate) => candidate.changeId === flow.changeId,
    );

    if (flow.goalId) {
      // The goal left the active base. Only end the flow when goal-x archived
      // it (completed or cleared): a transient active-read failure returns an
      // empty list too, and must not tear down a live flow.
      if (!goal) {
        const archived = await deps.readArchivedGoals(ctx);
        const archivedEntry = archived.find(
          (entry) => entry.id === flow.goalId,
        );
        if (archivedEntry) {
          endImplementFlow(sessionId);
          // Mark the persisted snapshot as ended so a restarted process does
          // not render a finished flow as if it were still running.
          appendStatusSnapshot(pi, { changeId: flow.changeId, ended: true });
          appendFlowEntry(pi, OPSX_ENTRY_TYPES.modeExited, {
            changeId: flow.changeId,
            mode: flow.mode,
          });
          publishLifecycle(pi.events, {
            type: "mode_exited",
            change: flow.changeId,
            mode: flow.mode,
          });
          if (archivedEntry.status === "complete") {
            // The goal went through its completion audit and finished: report
            // completion and guide the user to the openspec archive step
            // (spec: the plugin never archives for them).
            publishLifecycle(pi.events, {
              type: "flow_completed",
              change: flow.changeId,
              mode: flow.mode,
            });
            publishNotify(pi.events, {
              eventId: "task-completed",
              label: `Opsx implementation of ${flow.changeId} completed`,
            });
            sendNotice(
              pi,
              IMPLEMENT_NOTICE_CUSTOM_TYPE,
              renderArchiveGuidance(flow.changeId),
            );
          } else {
            // A manual /goal-clear archives a non-complete goal under its live
            // status (e.g. paused), so this is not a completion: the flow and
            // the base have diverged. Report it with the recovery options
            // (flow-recovery divergence semantics, spec R14) instead of
            // claiming the flow completed.
            const divergence = detectFlowDivergence(
              { goalId: flow.goalId, changeId: flow.changeId },
              [],
            );
            if (divergence) {
              sendNotice(
                pi,
                IMPLEMENT_NOTICE_CUSTOM_TYPE,
                `[OPSX FLOW DIVERGENCE: ${divergence.kind}] ${divergence.message} Options: ${divergence.options.join(" / ")}`,
              );
            }
          }
        }
      }
      // Lifecycle divergence (task 6.4): the base goal was cleared, paused or
      // blocked, or completed out from under a still-active flow. Reported
      // once per session and kind; the flow is never repaired automatically.
      // An absent goal is only reported after it stays absent for two
      // consecutive polls, because a degraded goal-base read also returns an
      // empty list and must not raise a false divergence.
      let divergenceRef: { goalId: string; changeId: string } | undefined;
      if (goal) {
        missingGoalPolls.delete(sessionId);
        divergenceRef = { goalId: flow.goalId, changeId: flow.changeId };
      } else {
        const polls = (missingGoalPolls.get(sessionId) ?? 0) + 1;
        missingGoalPolls.set(sessionId, polls);
        if (polls >= 2) {
          divergenceRef = { goalId: flow.goalId, changeId: flow.changeId };
        }
      }
      const divergence = divergenceRef
        ? detectFlowDivergence(
            divergenceRef,
            goals.filter((candidate) => candidate.id === flow.goalId),
          )
        : undefined;
      if (divergence) {
        const key = `${sessionId}:${divergence.kind}`;
        if (!reportedDivergences.has(key)) {
          reportedDivergences.add(key);
          sendNotice(
            pi,
            IMPLEMENT_NOTICE_CUSTOM_TYPE,
            `[OPSX FLOW DIVERGENCE: ${divergence.kind}] ${divergence.message} Options: ${divergence.options.join(" / ")}`,
          );
        }
      }
      // Stall detection (task 8.2 "不空转"): a task dispatched repeatedly with
      // no reported work and no tick is spinning, not progressing.
      const stalled = trackerFor(sessionId).stalled();
      if (stalled.length > 0) {
        const stallKey = `${sessionId}:stalled:${stalled.join(",")}`;
        if (!reportedDivergences.has(stallKey)) {
          reportedDivergences.add(stallKey);
          sendNotice(
            pi,
            IMPLEMENT_NOTICE_CUSTOM_TYPE,
            `[OPSX STALLED] Task(s) ${stalled.join(", ")} were dispatched repeatedly without a reviewed report or a tick. Re-dispatch with a tighter scope, or report the blocker instead of retrying.`,
          );
        }
      }
      return;
    }

    if (!goal) return;
    await ensureAuditorInstalled(pi, sessionId, goal, flow, deps);
  };
}

/**
 * Register the `/opsx:implement` command. Mode selection, the duplicate-flow
 * guard, objective assembly, and the restricted-mode entry all happen here;
 * the actual goal/task tool calls are the main agent's.
 */
export function registerImplementFlow(
  pi: ExtensionAPI,
  deps: ImplementFlowDeps = {},
): void {
  // One source of truth for the agent write boundary: config.ts. The same
  // list feeds the sandbox profile's allowWrite and the objective's
  // "Writable:" line, so the agent can never be told it may write somewhere
  // the sandbox denies.
  const agentAllowWrite = deps.agentAllowWrite ?? DEFAULT_AGENT_ALLOW_WRITE;
  const enterMode =
    deps.enterMode ??
    ((target: ExtensionAPI, ctx: ExtensionCommandContext) =>
      enterOpsxMode(target, "agent", {
        sessionId: () => ctx.sessionManager.getSessionId(),
      }).then(() => undefined));
  const readGoals =
    deps.readGoals ??
    ((ctx: ExtensionContext) =>
      readGoalBaseSummaries({
        cwd: ctx.cwd,
        sessionManager: ctx.sessionManager,
      }));
  const readArchivedGoals =
    deps.readArchivedGoals ??
    ((ctx: ExtensionContext) =>
      readArchivedGoalsFromBase({
        cwd: ctx.cwd,
        sessionManager: ctx.sessionManager,
      }));
  const readGoalTasks =
    deps.readGoalTasks ??
    ((ctx: ExtensionContext, goalId: string) =>
      readGoalTaskTree(
        { cwd: ctx.cwd, sessionManager: ctx.sessionManager },
        goalId,
      ));
  const installAuditor =
    deps.installAuditor ??
    ((goalId: string) => {
      requireGoalXSupport().setGoalAuditorOverride(goalId, {
        ...buildOpsxAuditorOverride(),
      });
    });
  const readApproval =
    deps.readApproval ??
    ((cwd: string, changeId: string): PlanApproval | undefined => {
      const recorded = readPlanApproval(changeDirPath(cwd, changeId));
      return recorded ? { changeId, ...recorded } : undefined;
    });

  const readWindowDelta =
    deps.readWindowDelta ??
    (async (ctx: ExtensionContext, goalId: string) => {
      const scope = await computeReviewScope(
        { cwd: ctx.cwd, sessionManager: ctx.sessionManager },
        goalId,
      );
      return scope.degraded ? undefined : scope.paths;
    });

  pi.registerCommand("opsx:implement", {
    description:
      "Implement an OpenSpec change: agent mode (opsx-agent profile + worker dispatches) or direct main-session mode, gated by the goal completion audit.",
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parsed = parseImplementArgs(args);
      if (parsed.error) {
        sendNotice(
          pi,
          IMPLEMENT_NOTICE_CUSTOM_TYPE,
          `Usage: /opsx:implement [--agent|--direct] <change-id> (${parsed.error})`,
        );
        return;
      }
      if (!parsed.changeId) {
        sendNotice(
          pi,
          IMPLEMENT_NOTICE_CUSTOM_TYPE,
          "Usage: /opsx:implement [--agent|--direct] <change-id>",
        );
        return;
      }

      // Fail-closed approval gate (task 7.3): implementation is refused until
      // the user approved this exact change's plan. The decision lives in the
      // change's append-only plan ledger, so it survives a restart.
      if (
        !canEnterImplementation(
          readApproval(ctx.cwd, parsed.changeId),
          parsed.changeId,
        )
      ) {
        sendNotice(
          pi,
          IMPLEMENT_NOTICE_CUSTOM_TYPE,
          `The plan for "${parsed.changeId}" is not approved yet. Run /opsx:plan ${parsed.changeId}, finish the plan artifacts, and approve the plan in the approval dialog before implementing.`,
        );
        return;
      }

      const sessionId = sessionKey(ctx);
      const guard = startImplementFlow(sessionId, {
        changeId: parsed.changeId,
        mode: parsed.mode ?? "direct",
        phase: "starting",
      });
      if (!guard.ok) {
        sendNotice(pi, IMPLEMENT_NOTICE_CUSTOM_TYPE, guard.reason);
        return;
      }

      // Fail-closed goal-x gate (spec R15): the whole implementation flow runs
      // on a goal-x goal, so a missing pi-goal-x refuses the command before
      // anything starts — no mode dialog, no start instruction, no create_goal
      // payload. The official track and /opsx:plan never reach this gate.
      try {
        requireGoalXSupport();
      } catch (error) {
        endImplementFlow(sessionId);
        sendNotice(
          pi,
          IMPLEMENT_NOTICE_CUSTOM_TYPE,
          error instanceof OpsxDependencyMissingError
            ? error.message
            : `Cannot start the implementation flow: ${describeError(error)}`,
        );
        return;
      }

      const mode =
        parsed.mode ??
        (await selectImplementationMode(ctx, deps.events ?? pi.events));
      if (!mode) {
        endImplementFlow(sessionId);
        sendNotice(
          pi,
          IMPLEMENT_NOTICE_CUSTOM_TYPE,
          "No implementation mode was selected; nothing was started. Re-run /opsx:implement with --agent or --direct.",
        );
        return;
      }
      updateImplementFlow(sessionId, { mode });

      const tasksMarkdown = readTasksMarkdown(ctx.cwd, parsed.changeId);
      const assembly = assembleOpsxObjective({
        changeId: parsed.changeId,
        tasksMarkdown,
        boundaries: boundariesForMode(mode, agentAllowWrite),
      });
      if (!assembly.ok) {
        endImplementFlow(sessionId);
        sendNotice(
          pi,
          IMPLEMENT_NOTICE_CUSTOM_TYPE,
          `${assembly.message} ${assembly.guidance}`,
        );
        publishNotify(deps.events ?? pi.events, {
          eventId: "integration-error",
          label: `Cannot assemble the opsx objective for ${parsed.changeId}`,
        });
        return;
      }

      if (mode === "agent") {
        try {
          await enterMode(pi, ctx);
        } catch (error) {
          endImplementFlow(sessionId);
          sendNotice(
            pi,
            IMPLEMENT_NOTICE_CUSTOM_TYPE,
            `Cannot enter the opsx-agent restricted mode: ${describeError(error)}`,
          );
          publishNotify(deps.events ?? pi.events, {
            eventId: "integration-error",
            label: `Cannot enter the opsx-agent restricted mode for ${parsed.changeId}`,
          });
          return;
        }
      }

      // The implementation flow takes over, so the plan mode is over.
      const endedPlan = endPlanFlow(sessionId);
      if (endedPlan) {
        publishLifecycle(deps.events ?? pi.events, {
          type: "mode_exited",
          change: endedPlan,
          mode: "plan",
        });
      }
      updateImplementFlow(sessionId, { phase: "implementing" });
      pi.sendMessage(
        {
          customType: IMPLEMENT_START_CUSTOM_TYPE,
          content: renderImplementStart(assembly, mode),
          display: true,
        },
        { deliverAs: "steer" },
      );
      appendFlowEntry(pi, OPSX_ENTRY_TYPES.modeEntered, {
        changeId: parsed.changeId,
        mode,
      });
      publishLifecycle(deps.events ?? pi.events, {
        type: "implement_started",
        change: parsed.changeId,
        mode,
      });
    },
  });

  pi.on(
    "turn_end",
    createImplementTurnEndHandler(pi, {
      readGoals,
      installAuditor,
      readArchivedGoals,
    }),
  );
  // Install early so a same-turn completion still gets the override.
  pi.on(
    "tool_result",
    createImplementGoalToolResultHandler(pi, { readGoals, installAuditor }),
  );
  // Lifecycle events sourced from the agent's own goal/subagent tool traffic
  // (task 9.3: task_dispatched, task_completed, final_verdict) plus the
  // tasks.md reconciliation after a tick (task 6.3).
  pi.on(
    "tool_result",
    createImplementLifecycleToolHandler(pi, {
      events: deps.events,
      readGoalTasks,
    }),
  );
  // The enforced "review before tick" gate (task 8.2).
  pi.on("tool_call", createImplementTickGateHandler(pi, { readWindowDelta }));
}
