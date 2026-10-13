/**
 * Child report ingestion (design D3, task 4.1).
 *
 * The three `report_*` tools are registered only in their own child processes
 * (design D1), so the parent session never sees the tool call itself. This
 * module reconstructs the delivery from the run evidence the parent does own:
 * the launch receipt it recorded for its own native subagent call, the native
 * start/complete events, and — for the report payload itself — the child's
 * canonical Pi session record read through `child-report-reader.ts`.
 *
 * Two invariants shape everything here:
 *
 *  1. A report observed while the child is still running is only a candidate.
 *     It becomes `ready` only once the native step reached a successful
 *     terminal state (design D3).
 *  2. Nothing is inferred from free text, previews, or redacted task strings.
 *     Task association comes from the encoded dispatch marker carried in the
 *     real user dispatch, cross-checked against the report's own `taskId`.
 *
 * This module deliberately declares the v3 shapes it understands instead of
 * importing them: `AsyncStatus` and the lifecycle version constant are not part
 * of `@xzzpig/pi-subagents`' public surface, and this change must not reach
 * into a peer's private modules or add a peer export (design D3).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CHILD_REPORT_TOOL_BY_AGENT,
  DISPATCH_TASK_MARKER_PREFIX,
  DISPATCH_TASK_MARKER_SUFFIX,
  MAX_ACTIVE_CHILDREN,
  readChildReportSession,
  scanDispatchMarkers,
  type ChildReportAttempt,
  type ChildSessionExpectation,
  type ChildSessionOutcome,
} from "./child-report-reader.ts";

/** Lifecycle artifact version this build understands (design D3). */
export const SUPPORTED_LIFECYCLE_VERSION = 3;

/** Entry type for a launch record (the durable half lives in task 4.2). */
export const CHILD_REPORT_DISPATCH_ENTRY =
  "pi-openspec-x/child-report-dispatch";

/** Durable run entry: the run this flow is currently waiting on (design D5). */
export const CHILD_REPORT_RUN_ENTRY = "pi-openspec-x/child-report-run";

/** Durable receipt entry: a report that was accepted as gate evidence. */
export const CHILD_REPORT_RECEIPT_ENTRY = "pi-openspec-x/child-report-receipt";

/**
 * Payload versions. As with the attempt entry, the version lives in the
 * payload rather than in the customType suffix, so a reader keys on the type
 * string and validates the version it finds.
 */
export const CHILD_REPORT_RUN_VERSION = 1;
export const CHILD_REPORT_RECEIPT_VERSION = 1;

/** How long a completion refresh may spend reading evidence (design D4). */
export const COMPLETION_REFRESH_BUDGET_MS = 1000;

// ---------------------------------------------------------------------------
// Minimal v3 status structure, validated at runtime
// ---------------------------------------------------------------------------

/** The subset of a native v3 step this module relies on. */
export interface LifecycleStepLike {
  index: number;
  agent?: string;
  runId?: string;
  sessionFile?: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  exitCode?: number;
  timedOut?: boolean;
  stopped?: boolean;
}

/** The subset of a native v3 status document this module relies on. */
export interface LifecycleStatusLike {
  lifecycleArtifactVersion: number;
  runId: string;
  sessionId?: string;
  state?: string;
  startedAt?: string;
  sessionRoot?: string;
  asyncDir?: string;
  completionOwnerId?: string;
  steps: LifecycleStepLike[];
}

/** Read a UTF-8 text file, or undefined when it cannot be read. */
function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The native states that mean a child finished successfully. */
const SUCCESSFUL_STATES = new Set(["complete", "completed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Validate a parsed `status.json` against the v3 shape this build supports.
 *
 * Every field is checked rather than asserted: a missing field means the fact
 * it would have proven is unknown, and an unknown fact must never let a task
 * complete (design D3).
 */
export function parseLifecycleStatus(
  value: unknown,
): { ok: true; status: LifecycleStatusLike } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "the native status document is not an object" };
  }
  const version = value.lifecycleArtifactVersion;
  if (typeof version !== "number") {
    return {
      ok: false,
      reason:
        "the native status document carries no lifecycle artifact version",
    };
  }
  if (version !== SUPPORTED_LIFECYCLE_VERSION) {
    return {
      ok: false,
      reason: `the native lifecycle artifact version ${version} is not the supported version ${SUPPORTED_LIFECYCLE_VERSION}`,
    };
  }
  const runId = asString(value.runId);
  if (!runId) {
    return {
      ok: false,
      reason: "the native status document carries no run id",
    };
  }
  if (!Array.isArray(value.steps)) {
    return { ok: false, reason: "the native status document carries no steps" };
  }

  const steps: LifecycleStepLike[] = [];
  for (const [position, raw] of value.steps.entries()) {
    if (!isRecord(raw)) {
      return {
        ok: false,
        reason: `native step ${position} is not an object`,
      };
    }
    // The producer defines step identity by array position; a model-visible or
    // display ordering must never be used to guess it (design D2/D3).
    const index = typeof raw.index === "number" ? raw.index : position;
    const status = asString(raw.status);
    if (status !== undefined && !isKnownStepState(status)) {
      return {
        ok: false,
        reason: `native step ${index} reports an unknown state ${status}`,
      };
    }
    steps.push({
      index,
      agent: asString(raw.agent),
      runId: asString(raw.runId),
      sessionFile: asString(raw.sessionFile),
      startedAt: asString(raw.startedAt),
      endedAt: asString(raw.endedAt),
      status,
      exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
      timedOut: raw.timedOut === true,
      stopped: raw.stopped === true,
    });
  }

  return {
    ok: true,
    status: {
      lifecycleArtifactVersion: version,
      runId,
      sessionId: asString(value.sessionId),
      state: asString(value.state),
      startedAt: asString(value.startedAt),
      sessionRoot: asString(value.sessionRoot),
      asyncDir: asString(value.asyncDir),
      completionOwnerId: asString(value.completionOwnerId),
      steps,
    },
  };
}

/** Step states the native producer can emit (both spellings are real). */
function isKnownStepState(state: string): boolean {
  return new Set([
    "pending",
    "running",
    "complete",
    "completed",
    "failed",
    "partial",
    "paused",
    "stopped",
    "rejected",
  ]).has(state);
}

/** Whether a native state counts as a successful terminal state. */
export function isSuccessfulTerminal(state: string | undefined): boolean {
  return state !== undefined && SUCCESSFUL_STATES.has(state);
}

/**
 * Locate the native step for an agent.
 *
 * A resumed run can reuse the previous run's session directory, so a single
 * session file may hold an older attempt's report. Selecting by identity — and
 * never "prefer a successful step" — is what keeps a stale success from
 * shadowing a newer failure (design D2).
 */
export function locateStep(
  steps: readonly LifecycleStepLike[],
  options: { agent: string; expectedRunId?: string | undefined },
): { ok: true; step: LifecycleStepLike } | { ok: false; reason: string } {
  const candidates = steps.filter((step) => step.agent === options.agent);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `no step for agent ${options.agent} in the attributed run`,
    };
  }
  const identified = candidates.filter((step) => step.runId !== undefined);
  if (options.expectedRunId !== undefined && identified.length > 0) {
    const match = candidates.find(
      (step) => step.runId === options.expectedRunId,
    );
    if (!match) {
      return {
        ok: false,
        reason: `no step for agent ${options.agent} matches run ${options.expectedRunId}`,
      };
    }
    return { ok: true, step: match };
  }
  // Without per-step run ids (the common pi-subagents shape) the newest step
  // wins; deliberately NOT "the successful one".
  const sorted = [...candidates].sort((a, b) => a.index - b.index);
  return { ok: true, step: sorted[sorted.length - 1]! };
}

// ---------------------------------------------------------------------------
// Protocol compatibility (design D3, revised: no preflight on the hot path)
// ---------------------------------------------------------------------------

export interface ProtocolCheckInput {
  cwd: string;
}

export interface ProtocolCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify that the peer's declared lifecycle artifact version matches what this
 * build reads. Injectable so tests can drive both branches without a peer, and
 * cached per flow so it never runs on a hot path (design D3).
 */
export type ProtocolChecker = (
  input: ProtocolCheckInput,
) => ProtocolCheckResult;

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

export type ChildReportRunStatus = "pending" | "candidate" | "ready" | "failed";

export interface ChildReportRun {
  flowId: string;
  runId: string;
  stepIndex: number;
  agent: string;
  toolName: string;
  /** The task this run is attributed to, from the encoded dispatch marker. */
  taskId?: string | undefined;
  /** The attempt nonce the child extension recorded for its current prompt. */
  attemptId?: string | undefined;
  /** True when the dispatch marker could not name exactly one task. */
  taskUnknown: boolean;
  /** True when the run exceeded the active-child budget and is unusable. */
  overBudget?: boolean | undefined;
  /**
   * Why the durable record could not be confirmed. A receipt that cannot be
   * written will not survive a restart, so this is surfaced rather than
   * swallowed (design D5).
   */
  persistenceError?: string | undefined;
  sessionRoot?: string | undefined;
  sessionFile?: string | undefined;
  asyncDir?: string | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  stepTerminal: boolean;
  status: ChildReportRunStatus;
  reason?: string | undefined;
  report?: Record<string, unknown> | undefined;
  attempt?: ChildReportAttempt | undefined;
  toolCallId?: string | undefined;
}

interface FlowRuns {
  flowId: string;
  /** The owning session, captured from the first event that carries it. */
  sessionId?: string | undefined;
  /** Bumped whenever the flow's context switches (design D4/D6). */
  generation: number;
  runs: Map<string, ChildReportRun>;
  /** Insertion order, so "latest" is deterministic. */
  order: string[];
}

const flows = new Map<string, FlowRuns>();

/** Bumped when a flow is created, so late reads can detect a context switch. */
let generationCounter = 0;

/** Reset all ingestion state. Test-only. */
export function resetChildReportIngestionForTests(): void {
  flows.clear();
}

function runKey(runId: string, stepIndex: number): string {
  return `${runId}#${stepIndex}`;
}

function flowFor(flowId: string): FlowRuns {
  const existing = flows.get(flowId);
  if (existing) return existing;
  generationCounter += 1;
  const created: FlowRuns = {
    flowId,
    generation: generationCounter,
    runs: new Map(),
    order: [],
  };
  flows.set(flowId, created);
  return created;
}

/**
 * The ingestion flow id for a session and change.
 *
 * Defined here so the main entry and the tick gate cannot drift apart on the
 * format: the gate resolves a task's receipt by the same id the entry bound.
 */
export function childReportFlowId(sessionId: string, changeId: string): string {
  return `${sessionId}:${changeId}`;
}

/**
 * Record the parent's own launch of a native child, before any event arrives.
 *
 * This is the only trusted source of run identity: the events that follow are
 * matched against it rather than being believed on their own.
 */
export function noteChildRunLaunch(
  flowId: string,
  launch: {
    runId: string;
    stepIndex: number;
    agent: string;
    taskId?: string | undefined;
    taskUnknown?: boolean;
    startedAt?: string | undefined;
  },
): ChildReportRun {
  const flow = flowFor(flowId);
  const key = runKey(launch.runId, launch.stepIndex);
  const run: ChildReportRun = {
    flowId,
    runId: launch.runId,
    stepIndex: launch.stepIndex,
    agent: launch.agent,
    toolName: CHILD_REPORT_TOOL_BY_AGENT[launch.agent] ?? "",
    taskId: launch.taskId,
    taskUnknown: launch.taskUnknown ?? launch.taskId === undefined,
    startedAt: launch.startedAt,
    stepTerminal: false,
    status: "pending",
  };
  // Over budget means "unusable", never "silently dropped": a run that is not
  // tracked could never be gated, so it must stay visibly blocking (design D4).
  if (!flow.runs.has(key) && flow.runs.size >= MAX_ACTIVE_CHILDREN) {
    run.status = "failed";
    run.overBudget = true;
    run.reason = `the flow already tracks ${MAX_ACTIVE_CHILDREN} child runs, so this one exceeds the active-child budget and cannot be used as evidence`;
  }
  if (!flow.runs.has(key)) flow.order.push(key);
  flow.runs.set(key, run);
  return run;
}

/**
 * Record a native start event. It only supplies ownership (sessionRoot /
 * asyncDir); the report itself is never read from an event payload.
 */
export function noteChildRunStarted(
  flowId: string,
  started: {
    runId: string;
    stepIndex?: number | undefined;
    sessionRoot?: string | undefined;
    asyncDir?: string | undefined;
    cwd?: string | undefined;
  },
): void {
  const flow = flowFor(flowId);
  // Resolved through `findRun` so a native run id that differs from the
  // parent's tool-call id still attributes ownership to the right run.
  const run = findRun(flow, started.runId, started.stepIndex);
  if (run) {
    run.sessionRoot = started.sessionRoot ?? run.sessionRoot;
    run.asyncDir = started.asyncDir ?? run.asyncDir;
  }
}

/**
 * Locate the child's canonical session file from the run's native status
 * document.
 *
 * The async completion payload carries no `sessionFile`, so the background path
 * has to read `<asyncDir>/status.json` and take it from the matching native
 * step (design D2). Nothing is trusted unless the document parses as the v3
 * shape this build supports, and the step is selected by identity rather than
 * by "prefer a successful step".
 */
export function resolveStepSessionFile(
  run: ChildReportRun,
  readFile: (path: string) => string | undefined,
): string | undefined {
  if (run.sessionFile) return run.sessionFile;
  if (!run.asyncDir) return undefined;
  const raw = readFile(path.join(run.asyncDir, "status.json"));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const status = parseLifecycleStatus(parsed);
  if (!status.ok) return undefined;
  // Deliberately no `expectedRunId`: the dispatch records the parent's
  // tool-call id while a step carries the child's own run id, so requiring a
  // match here would reject every real run.
  const located = locateStep(status.status.steps, { agent: run.agent });
  if (!located.ok) return undefined;
  return located.step.sessionFile;
}

/**
 * Record that the native step reached a terminal state, then attempt the
 * report read. Only a successful terminal state can produce `ready`.
 */
export function noteChildRunCompleted(
  flowId: string,
  completed: {
    runId: string;
    stepIndex?: number | undefined;
    state?: string | undefined;
    sessionFile?: string | undefined;
    endedAt?: string | undefined;
    success?: boolean | undefined;
  },
  readFile: (path: string) => string | undefined,
): ChildReportRun | undefined {
  const flow = flowFor(flowId);
  const target = findRun(flow, completed.runId, completed.stepIndex);
  if (!target) return undefined;

  const succeeded =
    completed.success ??
    (completed.state !== undefined && isSuccessfulTerminal(completed.state));
  target.stepTerminal = succeeded;
  target.endedAt = completed.endedAt ?? target.endedAt;
  target.sessionFile = completed.sessionFile ?? target.sessionFile;

  if (!succeeded) {
    target.status = "failed";
    target.reason = `the child run did not finish successfully (state ${completed.state ?? "unknown"})`;
    return target;
  }
  // The async completion payload carries no sessionFile, so locate it from the
  // native status document before giving up on the run.
  if (!target.sessionFile) {
    const resolved = resolveStepSessionFile(target, readFile);
    if (resolved) {
      target.sessionFile = resolved;
      target.sessionRoot ??= path.dirname(resolved);
    }
  }
  return ingestRun(target, readFile);
}

function findRun(
  flow: FlowRuns,
  runId: string,
  stepIndex?: number | undefined,
): ChildReportRun | undefined {
  if (stepIndex !== undefined) {
    const exact = flow.runs.get(runKey(runId, stepIndex));
    if (exact) return exact;
  }
  const matches = flow.order
    .map((key) => flow.runs.get(key))
    .filter((run): run is ChildReportRun => run?.runId === runId);
  if (matches.length > 0) return matches[matches.length - 1];
  // The native completion carries the child's own run id, while the parent
  // recorded the dispatch under its tool-call id. When exactly one run for that
  // step is still awaiting completion, that is the run being reported on; an
  // ambiguous set is left unmatched rather than guessed (design D2/D3).
  const pending = flow.order
    .map((key) => flow.runs.get(key))
    .filter(
      (run): run is ChildReportRun =>
        run !== undefined &&
        (stepIndex === undefined || run.stepIndex === stepIndex) &&
        !run.stepTerminal,
    );
  if (pending.length === 1) return pending[0];
  return undefined;
}

/**
 * Read a run's canonical session evidence and move it to `ready` when every
 * condition holds.
 *
 * A failure here is not silent: the run keeps an explicit reason so the gate
 * can explain why a task cannot complete (design D2/D3).
 */
export function ingestRun(
  run: ChildReportRun,
  readFile: (path: string) => string | undefined,
): ChildReportRun {
  if (run.overBudget === true) {
    run.status = "failed";
    run.reason =
      "the run exceeded the active-child budget, so it can never become evidence";
    return run;
  }
  if (!run.stepTerminal) {
    run.status = "candidate";
    run.reason = "the child run has not reached a successful terminal state";
    return run;
  }
  if (run.taskUnknown) {
    run.status = "candidate";
    run.reason =
      "the dispatch did not name exactly one task, so this report cannot be attributed";
    return run;
  }
  if (!run.sessionFile || !run.sessionRoot) {
    run.status = "failed";
    run.reason =
      "the successful child run has no attributed canonical session file";
    return run;
  }
  const expected: ChildSessionExpectation = {
    agent: run.agent,
    toolName: run.toolName,
    attemptId: run.attemptId,
    taskId: run.taskId,
    runId: run.runId,
    stepIndex: run.stepIndex,
    sessionRoot: run.sessionRoot,
    sessionFile: run.sessionFile,
    stepStartedAt: run.startedAt,
    stepEndedAt: run.endedAt,
    stepTerminal: run.stepTerminal,
  };
  void readFile; // The canonical reader owns file access; kept for symmetry.

  let outcome: ChildSessionOutcome;
  try {
    outcome = readChildReportSession(expected);
  } catch (error) {
    run.status = "failed";
    run.reason = `reading the child session failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return run;
  }

  if (outcome.status === "ready") {
    run.status = "ready";
    run.report = outcome.report;
    run.attempt = outcome.attempt;
    // Record the nonce the reader adopted, so the receipt and any durable
    // replay carry the same binding the report was validated against.
    run.attemptId = outcome.attempt.attemptId;
    run.toolCallId = outcome.toolCallId;
    run.reason = undefined;
    return run;
  }
  run.status = outcome.status === "pending" ? "candidate" : "failed";
  run.reason = outcome.reason;
  return run;
}

/**
 * Attribute a worker dispatch to a task.
 *
 * The marker is required to be unique: two different task ids in one dispatch
 * means the report cannot be attributed to either, which becomes an unresolved
 * barrier rather than a guess (design D3).
 */
export function attributeDispatchTask(prompt: string): {
  taskId?: string | undefined;
  taskUnknown: boolean;
} {
  const markers = scanDispatchMarkers(prompt);
  if (markers.length !== 1) {
    return { taskId: undefined, taskUnknown: true };
  }
  return { taskId: markers[0], taskUnknown: false };
}

/** Every run recorded for a flow, newest last. */
export function childRunsForFlow(flowId: string): ChildReportRun[] {
  const flow = flows.get(flowId);
  if (!flow) return [];
  return flow.order
    .map((key) => flow.runs.get(key))
    .filter((run): run is ChildReportRun => run !== undefined);
}

/** The newest run for a task, or undefined when none was recorded. */
export function latestRunForTask(
  flowId: string,
  taskId: string,
): ChildReportRun | undefined {
  const matches = childRunsForFlow(flowId).filter(
    (run) => run.taskId === taskId,
  );
  return matches[matches.length - 1];
}

/**
 * Whether a task has a ready receipt from its latest run.
 *
 * A newer non-ready run for the same task invalidates the older success rather
 * than being shadowed by it (design D3).
 */
export function childReportReadyForTask(
  flowId: string,
  taskId: string,
): { ready: true; run: ChildReportRun } | { ready: false; reason: string } {
  const latest = latestRunForTask(flowId, taskId);
  if (!latest) {
    return {
      ready: false,
      reason: `no opsx-worker dispatch is recorded for task ${taskId}`,
    };
  }
  if (latest.status === "ready") return { ready: true, run: latest };
  return {
    ready: false,
    reason:
      latest.reason ??
      `the latest worker run for task ${taskId} is ${latest.status}`,
  };
}

/**
 * Refresh every non-terminal run of a flow before a completion is decided.
 *
 * A completion application may arrive before the native completion event has
 * been delivered (the notifier can wake the session first), so the gate cannot
 * simply wait for events. One bounded round is performed here — no polling, no
 * sleeping — and whatever is still unresolved stays explicitly blocking.
 */
export function refreshForCompletion(
  flowId: string,
  deps: {
    readFile?: (path: string) => string | undefined;
    now?: () => number;
    /** The generation the caller started under; a mismatch refuses. */
    generation?: number | undefined;
  } = {},
): ChildReportRun[] {
  const flow = flows.get(flowId);
  if (!flow) return [];
  // A late refresh must never write a receipt into a context that has since
  // switched (design D4/D6).
  if (deps.generation !== undefined && flow.generation !== deps.generation) {
    return [];
  }
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + COMPLETION_REFRESH_BUDGET_MS;
  const touched: ChildReportRun[] = [];
  for (const key of flow.order) {
    if (now() > deadline) break;
    const run = flow.runs.get(key);
    if (!run) continue;
    if (run.status === "ready") continue;
    touched.push(ingestRun(run, deps.readFile ?? readTextFile));
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface ChildReportIngestionDeps {
  /**
   * The active opsx flow for this session, when one is bound (design D5). The
   * gate passes the flow id it is gating, so this is only used for events that
   * arrive without a flow context.
   */
  activeFlow?: (
    sessionId: string,
  ) => { flowId: string; changeId?: string; goalId?: string } | undefined;
  /** Session id accessor; defaults to the host session manager. */
  sessionId?: (ctx: unknown) => string | undefined;
  /**
   * Called when a report becomes ready, so display-only progress can be
   * projected. It must never gate anything (design D4).
   */
  /**
   * Surfaced when a durable record cannot be confirmed. The live E2E is the
   * only thing that exercises persistence, so a silent failure here is
   * expensive: it looks identical to persistence never being wired.
   */
  onDiagnostic?: (message: string) => void;
  onProgress?: (input: {
    sessionId: string;
    toolName: string;
    report: Record<string, unknown>;
  }) => void;
}

/**
 * Wire ingestion into the running extension.
 *
 * Only the main session is observed. Child tool calls happen inside child
 * sessions the parent cannot see, which is exactly why the report is read from
 * the child's canonical record instead of from an event.
 */
export function registerChildReportIngestion(
  pi: ExtensionAPI,
  deps: ChildReportIngestionDeps = {},
): void {
  const sessionIdOf = (ctx: unknown): string | undefined => {
    if (deps.sessionId) return deps.sessionId(ctx);
    const manager = (ctx as { sessionManager?: { getSessionId?(): string } })
      ?.sessionManager;
    try {
      const fromContext = manager?.getSessionId?.();
      if (fromContext) return fromContext;
    } catch {
      // Fall through to the captured identity below.
    }
    // The native completion events carry no `ctx`, so without this the handlers
    // resolve no flow and silently record nothing. The owning session was
    // captured when the parent's own dispatch was observed (design D3).
    for (const flow of flows.values()) {
      if (flow.sessionId) return flow.sessionId;
    }
    return undefined;
  };

  const flowIdFor = (ctx: unknown): string | undefined => {
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return undefined;
    return deps.activeFlow?.(sessionId)?.flowId;
  };

  // The parent's own launch of a native child is the only trusted identity
  // source, so it is captured before any completion event can arrive. The
  // context is kept too: the native completion events below carry no `ctx`, and
  // a durable append has to be confirmed against the real session file.
  let persistenceCtx: unknown;
  pi.on("tool_call", (event, ctx) => {
    persistenceCtx = ctx;
    const toolName = (event as { toolName?: string }).toolName;
    if (toolName !== "subagent") return;
    const flowId = flowIdFor(ctx);
    if (!flowId) return;
    const sessionId = sessionIdOf(ctx);
    if (sessionId) flowFor(flowId).sessionId = sessionId;
    const input = (event as { input?: unknown }).input as
      | { agent?: unknown; prompt?: unknown; task?: unknown }
      | undefined;
    const agent = typeof input?.agent === "string" ? input.agent : undefined;
    if (!agent || !(agent in CHILD_REPORT_TOOL_BY_AGENT)) return;
    // pi-subagents carries the brief in `task`; `prompt` is kept as the
    // documented alias. Reading only `prompt` left every live dispatch with an
    // empty brief, so no marker was ever found and every run was `taskUnknown`.
    const rawBrief = input?.task ?? input?.prompt;
    const brief = typeof rawBrief === "string" ? rawBrief : "";
    const attribution = attributeDispatchTask(brief);
    const toolCallId = (event as { toolCallId?: string }).toolCallId;
    const runId = toolCallId ?? `${agent}-${Date.now()}`;
    noteChildRunLaunch(flowId, {
      runId,
      stepIndex: 0,
      agent,
      taskId: attribution.taskId,
      taskUnknown: attribution.taskUnknown,
    });
    // Durable dispatch record (design D3): identity comes from the parent's own
    // launch, so it is written before any completion event can arrive.
    appendAndConfirm(pi, ctx as never, CHILD_REPORT_DISPATCH_ENTRY, {
      version: CHILD_REPORT_RUN_VERSION,
      flowId,
      runId,
      stepIndex: 0,
      agent,
      ...(attribution.taskId ? { taskId: attribution.taskId } : {}),
      taskUnknown: attribution.taskUnknown,
      startedAt: new Date().toISOString(),
    });
  });

  /**
   * Persist a run and, once it is ready, its receipt. Persistence is evidence,
   * not control flow: a failure must not break the run, and the in-memory
   * receipt stays authoritative for the gate (design D5).
   */
  const persistRun = (run: ChildReportRun | undefined): void => {
    if (!run) return;
    if (run.status !== "ready") {
      // A completed run that never becomes ready is the difference between a
      // blocked task and a working chain, and it is otherwise invisible: the
      // run entry records no status. Say why (design D2/D3).
      deps.onDiagnostic?.(
        `The child run for task ${run.taskId ?? "<unknown>"} produced no usable report (status ${run.status}${run.reason ? `: ${run.reason}` : ""}).`,
      );
    }
    let outcome: { ok: true } | { ok: false; reason: string };
    try {
      outcome = persistChildReportRun(
        pi,
        (persistenceCtx ?? {}) as never,
        run,
        {},
      );
    } catch (error) {
      outcome = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!outcome.ok) {
      run.persistenceError = outcome.reason;
      deps.onDiagnostic?.(
        `The child report for task ${run.taskId ?? "<unknown>"} could not be recorded durably (${outcome.reason}), so it will not survive a restart.`,
      );
    }
  };

  /**
   * Project display-only progress for a report that just became ready.
   *
   * Only a `ready` run is announced: a failed run, a candidate still waiting
   * on its child, or a report whose attempt nonce did not match never reaches
   * the board (design D3/D4).
   */
  const announceProgress = (
    flowId: string,
    run: ChildReportRun | undefined,
  ): void => {
    if (!run || run.status !== "ready" || !run.report) return;
    const sessionId = flows.get(flowId)?.sessionId;
    if (!sessionId) return;
    deps.onProgress?.({
      sessionId,
      toolName: run.toolName,
      report: run.report,
    });
  };

  const events = pi.events;
  events.on("subagent:async-started", (event) => {
    const payload = event as {
      // The native start event names the run `id`; `runId` is accepted too
      // because other lifecycle events use that spelling. Reading only `runId`
      // made this handler return immediately, so the asyncDir was never
      // captured and the background path could never locate the child session.
      id?: string;
      runId?: string;
      asyncDir?: string;
      sessionRoot?: string;
      cwd?: string;
    };
    const startedId = payload.id ?? payload.runId;
    if (!startedId) return;
    const flowId = flowIdFor(undefined);
    if (!flowId) return;
    noteChildRunStarted(flowId, {
      runId: startedId,
      sessionRoot: payload.sessionRoot,
      asyncDir: payload.asyncDir,
      cwd: payload.cwd,
    });
  });

  events.on("subagent:async-complete", (event) => {
    const payload = event as {
      runId?: string;
      results?: Array<{
        index?: number;
        runId?: string;
        agent?: string;
        status?: string;
        state?: string;
        success?: boolean;
        sessionFile?: string;
        endedAt?: string;
        structuredOutput?: unknown;
      }>;
    };
    const flowId = flowIdFor(undefined);
    if (!flowId) return;
    for (const result of payload.results ?? []) {
      const runId = result.runId ?? payload.runId;
      if (!runId) continue;
      const state = result.state ?? result.status;
      const run = noteChildRunCompleted(
        flowId,
        {
          runId,
          stepIndex: result.index,
          state,
          success: result.success,
          sessionFile: result.sessionFile,
          // A terminal step needs an end boundary; when the event omits one,
          // the moment the parent observed the completion is what it knows.
          endedAt: result.endedAt ?? new Date().toISOString(),
        },
        readTextFile,
      );
      if (!run) {
        deps.onDiagnostic?.(
          `A child completion event arrived for run ${runId}, but no dispatched run matched it, so its report cannot be attributed.`,
        );
      }
      persistRun(run);
      announceProgress(flowId, run);
    }
  });

  events.on("subagent:foreground-complete", (event) => {
    const payload = event as {
      runId?: string;
      results?: Array<{
        index?: number;
        runId?: string;
        status?: string;
        state?: string;
        success?: boolean;
        sessionFile?: string;
        endedAt?: string;
      }>;
    };
    const flowId = flowIdFor(undefined);
    if (!flowId) return;
    for (const result of payload.results ?? []) {
      const runId = result.runId ?? payload.runId;
      if (!runId) continue;
      // The parent receives the child's canonical session file in its own
      // foreground result, so that path's directory is the trusted root for
      // this run. Without it the run has no attributed session and can never
      // become ready, which would silently disable foreground ingestion.
      if (result.sessionFile) {
        noteChildRunStarted(flowId, {
          runId,
          stepIndex: result.index,
          sessionRoot: path.dirname(result.sessionFile),
        });
      }
      const run = noteChildRunCompleted(
        flowId,
        {
          runId,
          stepIndex: result.index,
          state: result.state ?? result.status,
          success: result.success,
          sessionFile: result.sessionFile,
          endedAt: result.endedAt ?? new Date().toISOString(),
        },
        readTextFile,
      );
      if (!run) {
        deps.onDiagnostic?.(
          `A child completion event arrived for run ${runId}, but no dispatched run matched it, so its report cannot be attributed.`,
        );
      }
      persistRun(run);
      announceProgress(flowId, run);
    }
  });

  // A fresh session or a branch switch starts a new generation: stale run
  // records from the previous branch must not authorize anything, and any
  // in-flight read must not land in the new context.
  // The live foreground completion event carries no sessionFile, so the parent
  // cannot locate the child's canonical session from it alone. The subagent
  // tool *result* does carry it, and it can arrive after the completion event,
  // so capture it here and re-ingest a run that already finished without one.
  pi.on("tool_result", (event, ctx) => {
    if ((event as { toolName?: unknown }).toolName !== "subagent") return;
    persistenceCtx = ctx;
    const details = (event as { details?: unknown }).details as
      | { results?: unknown; toolCallId?: unknown }
      | undefined;
    const results = Array.isArray(details?.results) ? details.results : [];
    if (results.length === 0) return;
    // A result entry carries `index` and `sessionFile` but no `runId`, and the
    // details object does not reliably carry a tool-call id either. The
    // tool_result event's own toolCallId is the same key the dispatch used.
    const eventRunId = (event as { toolCallId?: unknown }).toolCallId;
    const detailsRunId =
      (typeof eventRunId === "string" ? eventRunId : undefined) ??
      (typeof details?.toolCallId === "string"
        ? details.toolCallId
        : undefined);
    const flowId = flowIdFor(ctx);
    if (!flowId) return;
    const flow = flowFor(flowId);
    for (const entry of results) {
      const result = entry as {
        runId?: unknown;
        index?: unknown;
        sessionFile?: unknown;
      };
      const runId =
        (typeof result.runId === "string" ? result.runId : undefined) ??
        detailsRunId;
      const sessionFile =
        typeof result.sessionFile === "string" ? result.sessionFile : undefined;
      if (!runId || !sessionFile) continue;
      // Deliberately not `findRun`: that only resolves runs still awaiting a
      // completion, and this result arrives after the run has finished.
      const stepIndex =
        typeof result.index === "number" ? result.index : undefined;
      const run = flow.order
        .map((key) => flow.runs.get(key))
        .find(
          (candidate): candidate is ChildReportRun =>
            candidate !== undefined &&
            candidate.runId === runId &&
            (stepIndex === undefined || candidate.stepIndex === stepIndex),
        );
      if (!run) continue;
      run.sessionRoot = path.dirname(sessionFile);
      run.sessionFile = sessionFile;
      // The subagent tool result returning *is* the foreground completion
      // signal: the call is over, so the run is terminal and the child session
      // is closed. Marking it here makes this path self-sufficient rather than
      // depending on which native event happens to arrive first.
      run.stepTerminal = true;
      run.endedAt ??= new Date().toISOString();
      ingestRun(run, readTextFile);
      persistRun(run);
    }
  });

  /**
   * Rebuild this flow's runs and receipts from the current branch (design D5).
   *
   * A cold start has no in-memory state, so without this a receipt recorded
   * before the restart cannot authorize a completion afterwards and the gate
   * would block forever on work that was already verified.
   */
  const restoreChildReportFlow = (ctx: unknown): void => {
    try {
      const flowId = flowIdFor(ctx as never);
      if (!flowId) return;
      const branch = readIngestionBranch(ctx as never);
      if (branch.length === 0) return;
      rebuildChildReportFlow(flowId, branch);
    } catch {
      // Restoring is best-effort: a failure leaves the flow unrebuilt, which
      // keeps the gate closed rather than opening it on unverified state.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    resetChildReportIngestionForTests();
    restoreChildReportFlow(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    resetChildReportIngestionForTests();
    restoreChildReportFlow(ctx);
  });
  // Nothing outlives the session it observed: watchers, handles and buffers
  // are released on shutdown (design D4).
  pi.on("session_shutdown", () => {
    releaseChildReportIngestion();
  });
}

// ---------------------------------------------------------------------------
// Durable run and receipt entries (design D5, task 4.2)
// ---------------------------------------------------------------------------

/** The durable shape of a run, written to the owning branch. */
export interface DurableRunPayload {
  version: number;
  flowId: string;
  changeId?: string | undefined;
  goalId?: string | undefined;
  runId: string;
  stepIndex: number;
  agent: string;
  taskId?: string | undefined;
  taskUnknown: boolean;
  startedAt?: string | undefined;
}

/** The durable shape of an accepted report. */
export interface DurableReceiptPayload {
  version: number;
  flowId: string;
  goalId?: string | undefined;
  runId: string;
  stepIndex: number;
  agent: string;
  taskId: string;
  toolCallId: string;
  attemptId: string;
  changedFiles: string[];
  claims?: string | undefined;
  verificationPassed?: boolean | undefined;
  selfVerification?: { command?: string; result?: string } | undefined;
  recordedAt: string;
}

/** Minimal branch-entry view; the host owns the real type. */
export interface BranchEntryLike {
  id?: string;
  customType?: string;
  data?: unknown;
}

/** Read the current branch, tolerating hosts that expose no manager. */
export function readIngestionBranch(ctx: {
  sessionManager?: { getBranch?(): readonly unknown[] };
}): BranchEntryLike[] {
  try {
    return (ctx.sessionManager?.getBranch?.() ?? []) as BranchEntryLike[];
  } catch {
    return [];
  }
}

/**
 * The persisted session file, when the host has one.
 *
 * Confirmation reads this rather than the in-memory branch: an entry can be
 * appended to the branch and still fail to reach the record, and a receipt
 * that only exists in memory must never authorize a completion (design D5).
 */
function sessionFileOf(ctx: {
  sessionManager?: { getSessionFile?(): string | null };
}): string | undefined {
  try {
    return ctx.sessionManager?.getSessionFile?.() ?? undefined;
  } catch {
    return undefined;
  }
}

function entryMatches(
  entry: BranchEntryLike,
  customType: string,
  runId: string,
): boolean {
  if (entry.customType !== customType) return false;
  const data = entry.data as { runId?: unknown } | undefined;
  return data?.runId === runId;
}

/**
 * Append a durable entry and confirm it actually landed.
 *
 * A thrown append and a silently missing entry are both failures; neither may
 * be treated as success, because the gate would then rely on evidence that
 * does not exist (design D5).
 */
export function appendAndConfirm<T extends { runId: string }>(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: {
    sessionManager?: {
      getBranch?(): readonly unknown[];
      getSessionFile?(): string | null;
    };
  },
  customType: string,
  payload: T,
):
  | { ok: true; confirmedBy: "disk" | "branch" }
  | { ok: false; reason: string } {
  try {
    pi.appendEntry(customType, payload);
  } catch (error) {
    return {
      ok: false,
      reason: `writing the ${customType} entry failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const file = sessionFileOf(ctx);
  if (file) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (error) {
      return {
        ok: false,
        reason: `the session record could not be read to confirm the ${customType} entry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (entryMatches(parsed as BranchEntryLike, customType, payload.runId)) {
        return { ok: true, confirmedBy: "disk" };
      }
    }
    return {
      ok: false,
      reason: `the ${customType} entry is not present in the session record, so it was not durably recorded`,
    };
  }

  // No persisted record to check against (in-memory sessions): the branch is
  // the best available witness, and that is recorded rather than hidden.
  const branch = readIngestionBranch(ctx);
  if (branch.some((entry) => entryMatches(entry, customType, payload.runId))) {
    return { ok: true, confirmedBy: "branch" };
  }
  return {
    ok: false,
    reason: `the ${customType} entry did not appear on the branch after it was appended`,
  };
}

/** Build the durable run payload for a recorded run. */
export function buildRunPayload(
  run: ChildReportRun,
  binding: { changeId?: string | undefined; goalId?: string | undefined } = {},
): DurableRunPayload {
  return {
    version: CHILD_REPORT_RUN_VERSION,
    flowId: run.flowId,
    changeId: binding.changeId,
    goalId: binding.goalId,
    runId: run.runId,
    stepIndex: run.stepIndex,
    agent: run.agent,
    taskId: run.taskId,
    taskUnknown: run.taskUnknown,
    startedAt: run.startedAt,
  };
}

/** Build the durable receipt payload for a ready run. */
export function buildReceiptPayload(
  run: ChildReportRun,
  binding: { goalId?: string | undefined } = {},
  recordedAt: string = new Date().toISOString(),
): DurableReceiptPayload | undefined {
  if (run.status !== "ready" || !run.taskId) return undefined;
  const report = run.report ?? {};
  const changedFiles = Array.isArray(report.changedFiles)
    ? report.changedFiles.filter(
        (file): file is string => typeof file === "string",
      )
    : [];
  const selfVerification = isRecord(report.selfVerification)
    ? {
        command: asString(report.selfVerification.command),
        result: asString(report.selfVerification.result),
      }
    : undefined;
  return {
    version: CHILD_REPORT_RECEIPT_VERSION,
    flowId: run.flowId,
    goalId: binding.goalId,
    runId: run.runId,
    stepIndex: run.stepIndex,
    agent: run.agent,
    taskId: run.taskId,
    toolCallId: run.toolCallId ?? "",
    attemptId: run.attemptId ?? "",
    changedFiles,
    claims: asString(report.claims),
    verificationPassed:
      typeof report.verificationPassed === "boolean"
        ? report.verificationPassed
        : undefined,
    selfVerification,
    recordedAt,
  };
}

/** Validate a durable run payload read back from a branch. */
export function parseDurableRun(value: unknown): DurableRunPayload | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== CHILD_REPORT_RUN_VERSION) return undefined;
  const runId = asString(value.runId);
  const flowId = asString(value.flowId);
  const agent = asString(value.agent);
  if (!runId || !flowId || !agent) return undefined;
  return {
    version: CHILD_REPORT_RUN_VERSION,
    flowId,
    changeId: asString(value.changeId),
    goalId: asString(value.goalId),
    runId,
    stepIndex: typeof value.stepIndex === "number" ? value.stepIndex : 0,
    agent,
    taskId: asString(value.taskId),
    taskUnknown: value.taskUnknown === true,
    startedAt: asString(value.startedAt),
  };
}

/** Validate a durable receipt payload read back from a branch. */
export function parseDurableReceipt(
  value: unknown,
): DurableReceiptPayload | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== CHILD_REPORT_RECEIPT_VERSION) return undefined;
  const runId = asString(value.runId);
  const flowId = asString(value.flowId);
  const taskId = asString(value.taskId);
  const agent = asString(value.agent);
  if (!runId || !flowId || !taskId || !agent) return undefined;
  return {
    version: CHILD_REPORT_RECEIPT_VERSION,
    flowId,
    goalId: asString(value.goalId),
    runId,
    stepIndex: typeof value.stepIndex === "number" ? value.stepIndex : 0,
    agent,
    taskId,
    toolCallId: asString(value.toolCallId) ?? "",
    attemptId: asString(value.attemptId) ?? "",
    changedFiles: Array.isArray(value.changedFiles)
      ? value.changedFiles.filter(
          (file): file is string => typeof file === "string",
        )
      : [],
    claims: asString(value.claims),
    verificationPassed:
      typeof value.verificationPassed === "boolean"
        ? value.verificationPassed
        : undefined,
    selfVerification: isRecord(value.selfVerification)
      ? {
          command: asString(value.selfVerification.command),
          result: asString(value.selfVerification.result),
        }
      : undefined,
    recordedAt: asString(value.recordedAt) ?? "",
  };
}

/**
 * Rebuild a flow's runs and receipts from the owning branch.
 *
 * Replay is ordered, so a later dispatch for the same task invalidates an
 * earlier receipt instead of leaving it available to authorize a completion
 * (design D3/D5). Rebuilding is idempotent: it replaces the flow's state rather
 * than appending to it.
 */
export function rebuildChildReportFlow(
  flowId: string,
  branch: readonly BranchEntryLike[],
): { runs: ChildReportRun[]; receipts: DurableReceiptPayload[] } {
  const runs: DurableRunPayload[] = [];
  const receipts: DurableReceiptPayload[] = [];
  for (const entry of branch) {
    if (entry.customType === CHILD_REPORT_RUN_ENTRY) {
      const parsed = parseDurableRun(entry.data);
      if (parsed && parsed.flowId === flowId) runs.push(parsed);
      continue;
    }
    if (entry.customType === CHILD_REPORT_RECEIPT_ENTRY) {
      const parsed = parseDurableReceipt(entry.data);
      if (parsed && parsed.flowId === flowId) receipts.push(parsed);
    }
  }

  const flow = flowFor(flowId);
  flow.runs.clear();
  flow.order = [];

  // A receipt is only still authoritative while no later run was dispatched
  // for the same task; that is what "the latest dispatch invalidates the old
  // receipt" means in durable terms.
  const latestDispatchIndex = new Map<string, number>();
  runs.forEach((run, index) => {
    if (run.taskId) latestDispatchIndex.set(run.taskId, index);
  });
  const receiptIndex = new Map<string, number>();
  receipts.forEach((receipt, index) => {
    if (receipt.taskId) receiptIndex.set(receipt.taskId, index);
  });

  const effectiveReceipts = receipts.filter((receipt) => {
    const dispatchIndex = latestDispatchIndex.get(receipt.taskId);
    const index = receiptIndex.get(receipt.taskId);
    if (dispatchIndex === undefined || index === undefined) return false;
    return dispatchIndex <= index;
  });

  for (const payload of runs) {
    const key = runKey(payload.runId, payload.stepIndex);
    const restored: ChildReportRun = {
      flowId,
      runId: payload.runId,
      stepIndex: payload.stepIndex,
      agent: payload.agent,
      toolName: CHILD_REPORT_TOOL_BY_AGENT[payload.agent] ?? "",
      taskId: payload.taskId,
      taskUnknown: payload.taskUnknown,
      startedAt: payload.startedAt,
      stepTerminal: false,
      status: "pending",
    };
    const receipt = effectiveReceipts.find(
      (candidate) =>
        candidate.runId === payload.runId &&
        candidate.stepIndex === payload.stepIndex,
    );
    if (receipt) {
      restored.status = "ready";
      restored.taskId = receipt.taskId;
      restored.toolCallId = receipt.toolCallId;
      restored.attemptId = receipt.attemptId;
      restored.report = {
        taskId: receipt.taskId,
        changedFiles: receipt.changedFiles,
        claims: receipt.claims,
        verificationPassed: receipt.verificationPassed,
        selfVerification: receipt.selfVerification,
      };
    }
    if (!flow.runs.has(key)) flow.order.push(key);
    flow.runs.set(key, restored);
  }

  return { runs: childRunsForFlow(flowId), receipts: effectiveReceipts };
}

/**
 * Persist a run and, when it is ready, its receipt — each confirmed before it
 * is treated as evidence.
 */
export function persistChildReportRun(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: {
    sessionManager?: {
      getBranch?(): readonly unknown[];
      getSessionFile?(): string | null;
    };
  },
  run: ChildReportRun,
  binding: { changeId?: string | undefined; goalId?: string | undefined } = {},
): { ok: true } | { ok: false; reason: string } {
  const runResult = appendAndConfirm(
    pi,
    ctx,
    CHILD_REPORT_RUN_ENTRY,
    buildRunPayload(run, binding),
  );
  if (!runResult.ok) return runResult;

  if (run.status !== "ready") return { ok: true };
  const receipt = buildReceiptPayload(run, binding);
  if (!receipt) {
    return {
      ok: false,
      reason:
        "the run is ready but carries no attributable task, so no receipt can be recorded",
    };
  }
  const receiptResult = appendAndConfirm(
    pi,
    ctx,
    CHILD_REPORT_RECEIPT_ENTRY,
    receipt,
  );
  if (!receiptResult.ok) return receiptResult;
  return { ok: true };
}

// ---------------------------------------------------------------------------
/**
 * Release everything this session observed.
 *
 * Called on session_shutdown so nothing outlives the runs it observed.
 */
export function releaseChildReportIngestion(): void {
  resetChildReportIngestionForTests();
}
