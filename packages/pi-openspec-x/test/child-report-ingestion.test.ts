/**
 * Child report ingestion tests (design D3, task 4.1).
 *
 * The parent session never sees the `report_*` tool call — it runs inside the
 * child process. These tests pin the reconstruction: identity comes only from
 * the parent's own launch record plus the native lifecycle events, the payload
 * only from the child's canonical session record, and nothing becomes `ready`
 * before the child reached a successful terminal state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  attributeDispatchTask,
  childReportReadyForTask,
  COMPLETION_REFRESH_BUDGET_MS,
  childRunsForFlow,
  ingestRun,
  isSuccessfulTerminal,
  latestRunForTask,
  locateStep,
  noteChildRunCompleted,
  noteChildRunLaunch,
  noteChildRunStarted,
  parseLifecycleStatus,
  refreshForCompletion,
  registerChildReportIngestion,
  resetChildReportIngestionForTests,
  SUPPORTED_LIFECYCLE_VERSION,
} from "../src/child-report-ingestion.ts";
import { CHILD_REPORT_ATTEMPT_ENTRY } from "../src/child-report-reader.ts";
import { MAX_ACTIVE_CHILDREN } from "../src/child-report-reader.ts";
import {
  appendAndConfirm,
  buildReceiptPayload,
  buildRunPayload,
  CHILD_REPORT_RECEIPT_ENTRY,
  CHILD_REPORT_RECEIPT_VERSION,
  CHILD_REPORT_RUN_ENTRY,
  CHILD_REPORT_RUN_VERSION,
  parseDurableReceipt,
  parseDurableRun,
  persistChildReportRun,
  rebuildChildReportFlow,
  releaseChildReportIngestion,
  type ChildReportRun,
} from "../src/child-report-ingestion.ts";

const FLOW = "flow-1";
const WORK = "report_work";
const ATTEMPT = "attempt-1";
const STEP_START = "2026-01-02T00:00:00.000Z";
const STEP_END = "2026-01-02T00:05:00.000Z";

beforeEach(() => {
  resetChildReportIngestionForTests();
});

// ---------------------------------------------------------------------------
// v3 shapes: declared here, validated at runtime
// ---------------------------------------------------------------------------

describe("v3 lifecycle status validation", () => {
  const valid = {
    lifecycleArtifactVersion: SUPPORTED_LIFECYCLE_VERSION,
    runId: "run-1",
    state: "complete",
    steps: [{ index: 0, agent: "opsx-worker", status: "complete" }],
  };

  test("accepts a minimal v3 document", () => {
    const parsed = parseLifecycleStatus(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.status.runId).toBe("run-1");
      expect(parsed.status.steps).toHaveLength(1);
    }
  });

  test("rejects a document with no lifecycle version", () => {
    const { lifecycleArtifactVersion: _omitted, ...rest } = valid;
    const parsed = parseLifecycleStatus(rest);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.reason).toContain("lifecycle artifact version");
  });

  test("rejects an unknown lifecycle version", () => {
    const parsed = parseLifecycleStatus({
      ...valid,
      lifecycleArtifactVersion: 2,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.reason).toContain("not the supported version");
  });

  test("rejects a document with no run id or no steps", () => {
    expect(parseLifecycleStatus({ ...valid, runId: undefined }).ok).toBe(false);
    expect(parseLifecycleStatus({ ...valid, steps: undefined }).ok).toBe(false);
  });

  test("rejects an unknown step state instead of guessing", () => {
    const parsed = parseLifecycleStatus({
      ...valid,
      steps: [{ index: 0, status: "finished" }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("unknown state");
  });

  test("falls back to array position when a step carries no index", () => {
    const parsed = parseLifecycleStatus({
      ...valid,
      steps: [{ status: "complete" }, { status: "complete" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.status.steps.map((step) => step.index)).toEqual([0, 1]);
    }
  });

  test("non-objects are refused rather than coerced", () => {
    expect(parseLifecycleStatus(null).ok).toBe(false);
    expect(parseLifecycleStatus("complete").ok).toBe(false);
    expect(parseLifecycleStatus([]).ok).toBe(false);
  });
});

describe("successful terminal detection", () => {
  test("both real spellings count", () => {
    expect(isSuccessfulTerminal("complete")).toBe(true);
    expect(isSuccessfulTerminal("completed")).toBe(true);
    expect(isSuccessfulTerminal("failed")).toBe(false);
    expect(isSuccessfulTerminal(undefined)).toBe(false);
  });
});

describe("step location", () => {
  test("refuses when the agent has no step in the run", () => {
    const located = locateStep([{ index: 0, agent: "opsx-gap-analysis" }], {
      agent: "opsx-worker",
    });
    expect(located.ok).toBe(false);
    if (!located.ok) expect(located.reason).toContain("no step for agent");
  });

  test("a named run id must match, not be ignored", () => {
    const located = locateStep(
      [{ index: 0, agent: "opsx-worker", runId: "other" }],
      { agent: "opsx-worker", expectedRunId: "run-1" },
    );
    expect(located.ok).toBe(false);
    if (!located.ok) expect(located.reason).toContain("run-1");
  });

  test("without per-step run ids the newest step wins, not the successful one", () => {
    // This is the shape that lets a resumed run's older success shadow a newer
    // failure if selection ever preferred success.
    const located = locateStep(
      [
        { index: 0, agent: "opsx-worker", status: "complete" },
        { index: 1, agent: "opsx-worker", status: "failed" },
      ],
      { agent: "opsx-worker" },
    );
    expect(located.ok).toBe(true);
    if (located.ok) expect(located.step.index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task attribution
// ---------------------------------------------------------------------------

describe("dispatch task attribution", () => {
  test("a single marker names the task", () => {
    expect(
      attributeDispatchTask("## Task\n[OPSX WORKER DISPATCH task=1.1]\nfix it"),
    ).toEqual({ taskId: "1.1", taskUnknown: false });
  });

  test("a URI-encoded id is decoded", () => {
    expect(attributeDispatchTask("[OPSX WORKER DISPATCH task=a%2Fb]")).toEqual({
      taskId: "a/b",
      taskUnknown: false,
    });
  });

  test("no marker and conflicting markers are both unknown", () => {
    expect(attributeDispatchTask("just do the task").taskUnknown).toBe(true);
    expect(
      attributeDispatchTask(
        "[OPSX WORKER DISPATCH task=1.1] and [OPSX WORKER DISPATCH task=1.2]",
      ).taskUnknown,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Candidate vs ready
// ---------------------------------------------------------------------------

describe("candidate versus ready", () => {
  test("a launch alone is pending and cannot authorize a task", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    expect(latestRunForTask(FLOW, "1.1")?.status).toBe("pending");
    const gate = childReportReadyForTask(FLOW, "1.1");
    expect(gate.ready).toBe(false);
  });

  test("a completed run without an attributed session stays blocking", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    const run = noteChildRunCompleted(
      FLOW,
      { runId: "run-1", state: "complete" },
      () => undefined,
    );
    expect(run?.status).toBe("failed");
    expect(run?.reason).toContain("no attributed canonical session file");
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });

  test("a failed run invalidates the task instead of falling back", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    const run = noteChildRunCompleted(
      FLOW,
      { runId: "run-1", state: "failed" },
      () => undefined,
    );
    expect(run?.status).toBe("failed");
    expect(run?.reason).toContain("did not finish successfully");
  });

  test("an unknown association forms a barrier rather than a guess", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskUnknown: true,
    });
    noteChildRunStarted(FLOW, { runId: "run-1", sessionRoot: "/tmp" });
    const run = noteChildRunCompleted(
      FLOW,
      { runId: "run-1", state: "complete", sessionFile: "/tmp/s.jsonl" },
      () => undefined,
    );
    expect(run?.status).toBe("candidate");
    expect(run?.reason).toContain("did not name exactly one task");
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });

  test("a still-running run is only a candidate, never ready", () => {
    const run = noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    run.sessionRoot = "/tmp";
    run.sessionFile = "/tmp/s.jsonl";
    run.attemptId = ATTEMPT;
    const ingested = ingestRun(run, () => undefined);
    expect(ingested.status).toBe("candidate");
    expect(ingested.reason).toContain("successful terminal state");
  });

  test("a task with no dispatch at all reports why it is blocked", () => {
    const gate = childReportReadyForTask(FLOW, "9.9");
    expect(gate.ready).toBe(false);
    if (!gate.ready) expect(gate.reason).toContain("no opsx-worker dispatch");
  });
});

// ---------------------------------------------------------------------------
// Canonical session evidence
// ---------------------------------------------------------------------------

const WORK_REPORT = {
  taskId: "1.1",
  changedFiles: ["src/a.ts"],
  claims: "done",
  selfVerification: { command: "node check.cjs", result: "exit 0" },
  verificationPassed: true,
};

const user = () =>
  ({
    role: "user",
    content: "## Task\n[OPSX WORKER DISPATCH task=1.1]",
    timestamp: 1,
  }) as never;
const call = (id: string) =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: WORK, arguments: WORK_REPORT }],
    api: "a",
    provider: "p",
    model: "m",
    usage: {},
    stopReason: "toolUse",
    timestamp: 2,
  }) as never;
const result = (id: string) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: WORK,
    content: [{ type: "text", text: "Work report recorded for task 1.1." }],
    details: {
      version: 1,
      attemptId: ATTEMPT,
      agent: "opsx-worker",
      report: WORK_REPORT,
    },
    isError: false,
    timestamp: 3,
  }) as never;
const stop = () =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "a",
    provider: "p",
    model: "m",
    usage: {},
    stopReason: "endTurn",
    timestamp: 4,
  }) as never;

function buildSession(build: (manager: SessionManager) => void): {
  dir: string;
  file: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-ingest-"));
  const manager = SessionManager.create(dir, dir);
  build(manager);
  const file = manager.getSessionFile();
  if (!file) throw new Error("the session manager produced no session file");
  return { dir, file };
}

describe("canonical session ingestion", () => {
  test("a successful terminal run with a complete turn becomes ready", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, {
        version: 1,
        attemptId: ATTEMPT,
        agent: "opsx-worker",
        sessionId: "sess-1",
        startedAt: STEP_START,
        promptSha256: "abc",
        taskMarker: "1.1",
      });
      manager.appendMessage(call("c1"));
      manager.appendMessage(result("c1"));
      manager.appendMessage(stop());
    });

    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
      startedAt: STEP_START,
    });
    noteChildRunStarted(FLOW, { runId: "run-1", sessionRoot: dir });
    const run = noteChildRunCompleted(
      FLOW,
      {
        runId: "run-1",
        state: "complete",
        sessionFile: file,
        endedAt: STEP_END,
      },
      () => undefined,
    );

    expect(run?.status).toBe("ready");
    expect(run?.report).toMatchObject({ taskId: "1.1" });
    expect(run?.toolCallId).toBe("c1");
    const gate = childReportReadyForTask(FLOW, "1.1");
    expect(gate.ready).toBe(true);
  });

  test("a session file outside the attributed root is refused", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, {
        version: 1,
        attemptId: ATTEMPT,
        agent: "opsx-worker",
        sessionId: "sess-1",
        startedAt: STEP_START,
        promptSha256: "abc",
      });
      manager.appendMessage(call("c1"));
      manager.appendMessage(result("c1"));
      manager.appendMessage(stop());
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-ingest-out-"));

    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
      startedAt: STEP_START,
    });
    const run = noteChildRunCompleted(
      FLOW,
      {
        runId: "run-1",
        state: "complete",
        sessionFile: file,
        endedAt: STEP_END,
      },
      () => undefined,
    );
    // The root is the other directory, so the file must not be trusted.
    expect(run?.status).toBe("failed");
    expect(dir).not.toBe(outside);
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });

  test("an older attempt in a reused session file does not authorize this run", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      // A previous run's attempt and its successful report stay in the file.
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, {
        version: 1,
        attemptId: "old-attempt",
        agent: "opsx-worker",
        sessionId: "sess-1",
        startedAt: STEP_START,
        promptSha256: "old",
      });
      manager.appendMessage(call("old-call"));
      manager.appendMessage(result("old-call"));
      manager.appendMessage(stop());
    });

    noteChildRunLaunch(FLOW, {
      runId: "run-2",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
      startedAt: STEP_START,
    });
    noteChildRunStarted(FLOW, { runId: "run-2", sessionRoot: dir });
    const run = noteChildRunCompleted(
      FLOW,
      {
        runId: "run-2",
        state: "complete",
        sessionFile: file,
        endedAt: STEP_END,
      },
      () => undefined,
    );
    expect(run?.status).toBe("failed");
    // The file's only attempt belongs to a previous run, so it can never
    // authorize this one: the report is rejected on the attempt binding
    // whichever way that binding is checked.
    expect(run?.reason).toContain("attempt");
  });
});

// ---------------------------------------------------------------------------
// Completion refresh and protocol declaration
// ---------------------------------------------------------------------------

describe("completion refresh", () => {
  test("refresh re-reads runs rather than waiting for the completion event", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    noteChildRunStarted(FLOW, { runId: "run-1", sessionRoot: "/tmp" });
    // The session file appears only after the completion notification woke the
    // session, which is exactly the ordering refresh exists for.
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, {
        version: 1,
        attemptId: ATTEMPT,
        agent: "opsx-worker",
        sessionId: "sess-1",
        startedAt: STEP_START,
        promptSha256: "abc",
      });
      manager.appendMessage(call("c1"));
      manager.appendMessage(result("c1"));
      manager.appendMessage(stop());
    });
    const run = childRunsForFlow(FLOW)[0]!;
    run.sessionRoot = dir;
    run.sessionFile = file;
    run.attemptId = ATTEMPT;
    run.endedAt = STEP_END;
    run.stepTerminal = true;

    const touched = refreshForCompletion(FLOW);
    expect(touched).toHaveLength(1);
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(true);
  });

  test("the refresh deadline stops the sweep instead of overrunning it", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    noteChildRunLaunch(FLOW, {
      runId: "run-2",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.2",
    });
    // One completion may only spend a bounded time reading evidence: the first
    // run is handled inside the budget, the second is past the deadline so the
    // sweep stops rather than overrunning the caller (design D4).
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls <= 2 ? 0 : COMPLETION_REFRESH_BUDGET_MS + 1;
    };
    const touched = refreshForCompletion(FLOW, { now });
    expect(touched).toHaveLength(1);
  });

  test("a late refresh does not write into a switched context", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    // The caller started under a generation that no longer matches, so its
    // result must not land in the current context (design D4/D6).
    expect(refreshForCompletion(FLOW, { generation: 999_999 })).toHaveLength(0);
  });

  test("releasing the session drops all ingested state", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    expect(childRunsForFlow(FLOW)).toHaveLength(1);
    releaseChildReportIngestion();
    expect(childRunsForFlow(FLOW)).toHaveLength(0);
  });

  test("refresh is idempotent and never revives a failed run", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    noteChildRunCompleted(
      FLOW,
      { runId: "run-1", state: "failed" },
      () => undefined,
    );
    refreshForCompletion(FLOW);
    refreshForCompletion(FLOW);
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });
});

describe("ingestion wiring", () => {
  function fakePi() {
    const handlers = new Map<
      string,
      Array<(event: unknown, ctx: unknown) => unknown>
    >();
    const events = new Map<string, Array<(event: unknown) => unknown>>();
    const pi = {
      on(event: string, handler: (e: unknown, c: unknown) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
      events: {
        on(event: string, handler: (e: unknown) => unknown) {
          const list = events.get(event) ?? [];
          list.push(handler);
          events.set(event, list);
          return () => {};
        },
      },
    };
    return { pi, handlers, events };
  }

  test("it subscribes to the native lifecycle channels, not to report tools", () => {
    const { pi, handlers, events } = fakePi();
    registerChildReportIngestion(pi as unknown as ExtensionAPI, {
      activeFlow: () => ({ flowId: FLOW }),
    });
    expect([...events.keys()].sort()).toEqual([
      "subagent:async-complete",
      "subagent:async-started",
      "subagent:foreground-complete",
    ]);
    expect([...handlers.keys()].sort()).toEqual([
      "session_shutdown",
      "session_start",
      "session_tree",
      "tool_call",
      // The live foreground completion event carries no sessionFile, so the
      // canonical session is captured from the subagent tool result instead.
      "tool_result",
    ]);
  });

  test("a real worker dispatch is attributed from the encoded marker", () => {
    const { pi, handlers } = fakePi();
    registerChildReportIngestion(pi as unknown as ExtensionAPI, {
      activeFlow: () => ({ flowId: FLOW }),
      sessionId: () => "s1",
    });
    const toolCall = handlers.get("tool_call")![0]!;
    toolCall(
      {
        toolName: "subagent",
        toolCallId: "call-1",
        input: {
          agent: "opsx-worker",
          prompt: "## Task\n[OPSX WORKER DISPATCH task=1.1]",
        },
      },
      { sessionManager: { getSessionId: () => "s1" } },
    );
    expect(latestRunForTask(FLOW, "1.1")?.runId).toBe("call-1");
  });

  test("a dispatch for another reporting role keeps its own tool identity", () => {
    const { pi, handlers } = fakePi();
    registerChildReportIngestion(pi as unknown as ExtensionAPI, {
      activeFlow: () => ({ flowId: FLOW }),
      sessionId: () => "s1",
    });
    handlers.get("tool_call")![0]!(
      {
        toolName: "subagent",
        toolCallId: "call-1",
        input: { agent: "opsx-gap-analysis", prompt: "analyse" },
      },
      { sessionManager: { getSessionId: () => "s1" } },
    );
    const runs = childRunsForFlow(FLOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agent).toBe("opsx-gap-analysis");
    expect(runs[0]!.toolName).toBe("report_gap_analysis");
    // It is not a worker run, so it cannot authorize a task.
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });

  test("a dispatch for an unrelated role is not recorded at all", () => {
    const { pi, handlers } = fakePi();
    registerChildReportIngestion(pi as unknown as ExtensionAPI, {
      activeFlow: () => ({ flowId: FLOW }),
      sessionId: () => "s1",
    });
    handlers.get("tool_call")![0]!(
      {
        toolName: "subagent",
        toolCallId: "call-1",
        input: { agent: "oracle", prompt: "think about it" },
      },
      { sessionManager: { getSessionId: () => "s1" } },
    );
    expect(childRunsForFlow(FLOW)).toHaveLength(0);
  });

  test("a dispatch with no active flow is ignored", () => {
    const { pi, handlers } = fakePi();
    registerChildReportIngestion(pi as unknown as ExtensionAPI, {
      activeFlow: () => undefined,
      sessionId: () => "s1",
    });
    handlers.get("tool_call")![0]!(
      {
        toolName: "subagent",
        toolCallId: "call-1",
        input: {
          agent: "opsx-worker",
          prompt: "[OPSX WORKER DISPATCH task=1.1]",
        },
      },
      { sessionManager: { getSessionId: () => "s1" } },
    );
    expect(childRunsForFlow(FLOW)).toHaveLength(0);
  });

  test("a session boundary drops stale runs so they cannot authorize", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    expect(childRunsForFlow(FLOW)).toHaveLength(1);
    const { pi, handlers } = fakePi();
    registerChildReportIngestion(pi as unknown as ExtensionAPI, {
      activeFlow: () => ({ flowId: FLOW }),
    });
    handlers.get("session_start")![0]!({}, {});
    expect(childRunsForFlow(FLOW)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Durable run and receipt entries (design D5, task 4.2)
// ---------------------------------------------------------------------------

describe("durable run and receipt entries", () => {
  function sessionCtx(branch: unknown[] = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-durable-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, "", "utf8");
    return {
      file,
      ctx: {
        sessionManager: {
          getBranch: () => branch,
          getSessionFile: () => file,
        },
      },
    };
  }

  /** A pi whose append lands on both the branch and the session record. */
  function durablePi(branch: Array<Record<string, unknown>>, file?: string) {
    let counter = 0;
    return {
      appendEntry(customType: string, data?: unknown) {
        counter += 1;
        const entry = { id: `e${counter}`, customType, data };
        branch.push(entry);
        if (file) {
          fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
        }
      },
    };
  }

  function makeRun(overrides: Partial<ChildReportRun> = {}): ChildReportRun {
    return {
      flowId: FLOW,
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      toolName: WORK,
      taskId: "1.1",
      taskUnknown: false,
      stepTerminal: true,
      status: "ready",
      toolCallId: "c1",
      attemptId: ATTEMPT,
      report: {
        taskId: "1.1",
        changedFiles: ["src/a.ts"],
        claims: "done",
        verificationPassed: true,
        selfVerification: { command: "node check.cjs", result: "exit 0" },
      },
      ...overrides,
    };
  }

  test("an append that reaches the record is confirmed", () => {
    const branch: Array<Record<string, unknown>> = [];
    const { file, ctx } = sessionCtx(branch);
    const result = appendAndConfirm(
      durablePi(branch, file) as never,
      ctx as never,
      CHILD_REPORT_RUN_ENTRY,
      { version: CHILD_REPORT_RUN_VERSION, runId: "run-1" },
    );
    expect(result).toEqual({ ok: true, confirmedBy: "disk" });
  });

  test("a thrown append is refused rather than assumed", () => {
    const { ctx } = sessionCtx([]);
    const result = appendAndConfirm(
      {
        appendEntry() {
          throw new Error("read-only session");
        },
      } as never,
      ctx as never,
      CHILD_REPORT_RECEIPT_ENTRY,
      { version: CHILD_REPORT_RECEIPT_VERSION, runId: "run-1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("read-only session");
  });

  test("an entry that never reaches the record is refused", () => {
    // The classic trap: the branch (memory) has it, the session record does
    // not. Treating the in-memory copy as evidence would authorize a task on
    // a receipt that does not survive a restart.
    const branch: Array<Record<string, unknown>> = [];
    const { ctx } = sessionCtx(branch);
    const result = appendAndConfirm(
      durablePi(branch) as never,
      ctx as never,
      CHILD_REPORT_RECEIPT_ENTRY,
      { version: CHILD_REPORT_RECEIPT_VERSION, runId: "run-1" },
    );
    expect(branch).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("not present in the session record");
  });

  test("a ready run persists both a run and its receipt", () => {
    const branch: Array<Record<string, unknown>> = [];
    const { file, ctx } = sessionCtx(branch);
    const result = persistChildReportRun(
      durablePi(branch, file) as never,
      ctx as never,
      makeRun(),
      { changeId: "change-a", goalId: "g1" },
    );
    expect(result.ok).toBe(true);
    expect(branch.map((entry) => entry.customType)).toEqual([
      CHILD_REPORT_RUN_ENTRY,
      CHILD_REPORT_RECEIPT_ENTRY,
    ]);
    const receipt = branch[1]!.data as Record<string, unknown>;
    expect(receipt.taskId).toBe("1.1");
    expect(receipt.verificationPassed).toBe(true);
  });

  test("a run that is not ready persists only the run", () => {
    const branch: Array<Record<string, unknown>> = [];
    const { file, ctx } = sessionCtx(branch);
    const result = persistChildReportRun(
      durablePi(branch, file) as never,
      ctx as never,
      makeRun({ status: "candidate" }),
    );
    expect(result.ok).toBe(true);
    expect(branch.map((entry) => entry.customType)).toEqual([
      CHILD_REPORT_RUN_ENTRY,
    ]);
  });

  test("a ready run without an attributable task cannot produce a receipt", () => {
    expect(buildReceiptPayload(makeRun({ taskId: undefined }))).toBeUndefined();
    const branch: Array<Record<string, unknown>> = [];
    const { file, ctx } = sessionCtx(branch);
    const result = persistChildReportRun(
      durablePi(branch, file) as never,
      ctx as never,
      makeRun({ taskId: undefined }),
    );
    expect(result.ok).toBe(false);
  });

  test("rebuild restores the run and its receipt", () => {
    const run = buildRunPayload(makeRun(), { changeId: "change-a" });
    const receipt = buildReceiptPayload(makeRun(), { goalId: "g1" })!;
    resetChildReportIngestionForTests();
    const rebuilt = rebuildChildReportFlow(FLOW, [
      { customType: CHILD_REPORT_RUN_ENTRY, data: run },
      { customType: CHILD_REPORT_RECEIPT_ENTRY, data: receipt },
    ]);
    expect(rebuilt.runs).toHaveLength(1);
    expect(rebuilt.runs[0]!.status).toBe("ready");
    expect(rebuilt.receipts).toHaveLength(1);
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(true);
  });

  test("a later dispatch for the same task invalidates the earlier receipt", () => {
    const receipt = buildReceiptPayload(makeRun(), { goalId: "g1" })!;
    const laterRun = buildRunPayload(
      makeRun({ runId: "run-2", status: "pending" }),
      { changeId: "change-a" },
    );
    resetChildReportIngestionForTests();
    rebuildChildReportFlow(FLOW, [
      { customType: CHILD_REPORT_RUN_ENTRY, data: buildRunPayload(makeRun()) },
      { customType: CHILD_REPORT_RECEIPT_ENTRY, data: receipt },
      { customType: CHILD_REPORT_RUN_ENTRY, data: laterRun },
    ]);
    // The old success must not authorize the new dispatch.
    const gate = childReportReadyForTask(FLOW, "1.1");
    expect(gate.ready).toBe(false);
    if (!gate.ready) expect(gate.reason).toContain("pending");
  });

  test("rebuild is idempotent and replaces rather than appends", () => {
    const branch = [
      { customType: CHILD_REPORT_RUN_ENTRY, data: buildRunPayload(makeRun()) },
      {
        customType: CHILD_REPORT_RECEIPT_ENTRY,
        data: buildReceiptPayload(makeRun(), { goalId: "g1" })!,
      },
    ];
    resetChildReportIngestionForTests();
    rebuildChildReportFlow(FLOW, branch);
    rebuildChildReportFlow(FLOW, branch);
    rebuildChildReportFlow(FLOW, branch);
    expect(childRunsForFlow(FLOW)).toHaveLength(1);
  });

  test("a branch without the entries restores nothing", () => {
    // Compression or a tree switch can leave a branch that no longer carries
    // the flow's entries; that must mean "unknown", never "still authorized".
    resetChildReportIngestionForTests();
    const rebuilt = rebuildChildReportFlow(FLOW, []);
    expect(rebuilt.runs).toHaveLength(0);
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });

  test("entries of unknown version or another flow are ignored", () => {
    resetChildReportIngestionForTests();
    const rebuilt = rebuildChildReportFlow(FLOW, [
      {
        customType: CHILD_REPORT_RUN_ENTRY,
        data: { ...buildRunPayload(makeRun()), version: 99 },
      },
      {
        customType: CHILD_REPORT_RUN_ENTRY,
        data: { ...buildRunPayload(makeRun()), flowId: "other-flow" },
      },
      { customType: CHILD_REPORT_RUN_ENTRY, data: "not an object" },
    ]);
    expect(rebuilt.runs).toHaveLength(0);
  });

  test("the durable payload parsers refuse malformed shapes", () => {
    expect(parseDurableRun(null)).toBeUndefined();
    expect(parseDurableRun({ version: 1 })).toBeUndefined();
    expect(parseDurableReceipt({ version: 1, runId: "r" })).toBeUndefined();
    expect(
      parseDurableReceipt({
        version: CHILD_REPORT_RECEIPT_VERSION,
        flowId: FLOW,
        runId: "run-1",
        agent: "opsx-worker",
        taskId: "1.1",
      })?.taskId,
    ).toBe("1.1");
  });
});

// ---------------------------------------------------------------------------
// Foreground failure: no obtainable details must never read as success
// ---------------------------------------------------------------------------

describe("foreground failure boundary", () => {
  test("a failed root workflow yields no ready receipt for its worker", () => {
    // pi-subagents' tool boundary converts an isError result into a thrown
    // Error, discarding `details`. A successful sibling inside that failed
    // workflow is therefore unreachable, and must NOT be reconstructed: the
    // task stays blocked until a new, valid dispatch arrives.
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "1.1",
    });
    const run = noteChildRunCompleted(
      FLOW,
      { runId: "run-1", state: "failed" },
      () => undefined,
    );
    expect(run?.status).toBe("failed");
    expect(run?.report).toBeUndefined();
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });

  test("a sibling's success never fills in for an unattributed run", () => {
    noteChildRunLaunch(FLOW, {
      runId: "run-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskUnknown: true,
    });
    noteChildRunCompleted(
      FLOW,
      { runId: "run-1", state: "complete" },
      () => undefined,
    );
    // Nothing in the registry may be reported as ready for any task.
    for (const taskId of ["1.1", "1.2"]) {
      expect(childReportReadyForTask(FLOW, taskId).ready).toBe(false);
    }
  });

  test("a background child is judged on its own evidence", () => {
    // A background run that never produced an attributed session stays
    // blocking, and its failure does not disturb an unrelated task.
    noteChildRunLaunch(FLOW, {
      runId: "bg-1",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "2.1",
    });
    const run = noteChildRunCompleted(
      FLOW,
      { runId: "bg-1", state: "complete" },
      () => undefined,
    );
    expect(run?.status).toBe("failed");
    expect(childReportReadyForTask(FLOW, "2.1").ready).toBe(false);
    expect(childReportReadyForTask(FLOW, "1.1").ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Active-child budget (design D4)
// ---------------------------------------------------------------------------

describe("active-child budget", () => {
  test("only 32 child runs are tracked, and the excess stays visibly blocking", () => {
    for (let index = 0; index < MAX_ACTIVE_CHILDREN; index += 1) {
      noteChildRunLaunch(FLOW, {
        runId: `run-${index}`,
        stepIndex: 0,
        agent: "opsx-worker",
        taskId: `1.${index}`,
      });
    }
    expect(childRunsForFlow(FLOW)).toHaveLength(MAX_ACTIVE_CHILDREN);

    const overflow = noteChildRunLaunch(FLOW, {
      runId: "run-overflow",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "9.9",
    });
    // "Unusable", never "silently dropped": the overflow run cannot become
    // evidence even if it later finishes successfully.
    expect(overflow.status).toBe("failed");
    expect(overflow.reason).toContain("active-child budget");
    expect(childReportReadyForTask(FLOW, "9.9").ready).toBe(false);
  });

  test("a budget-refused run cannot be redeemed by a later success", () => {
    for (let index = 0; index < MAX_ACTIVE_CHILDREN; index += 1) {
      noteChildRunLaunch(FLOW, {
        runId: `run-${index}`,
        stepIndex: 0,
        agent: "opsx-worker",
        taskId: `1.${index}`,
      });
    }
    noteChildRunLaunch(FLOW, {
      runId: "run-overflow",
      stepIndex: 0,
      agent: "opsx-worker",
      taskId: "9.9",
    });
    noteChildRunCompleted(
      FLOW,
      { runId: "run-overflow", state: "complete" },
      () => undefined,
    );
    const gate = childReportReadyForTask(FLOW, "9.9");
    expect(gate.ready).toBe(false);
    if (!gate.ready) expect(gate.reason).toContain("active-child budget");
  });
});

// ---------------------------------------------------------------------------
// Shared watchers, serialized reads, generations, release (design D4)
// ---------------------------------------------------------------------------

describe("progress projection from ingestion", () => {
  function wired() {
    const handlers = new Map<string, Array<(event: unknown) => unknown>>();
    const progress: Array<{ sessionId: string; toolName: string }> = [];
    const pi = {
      on(event: string, handler: (event: unknown) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
      events: {
        on(event: string, handler: (event: unknown) => unknown) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
          return () => {};
        },
      },
    };
    registerChildReportIngestion(pi as unknown as ExtensionAPI, {
      activeFlow: () => ({ flowId: FLOW }),
      sessionId: () => "s1",
      onProgress: ({ sessionId, toolName }) => {
        progress.push({ sessionId, toolName });
      },
    });
    const toolCall = handlers.get("tool_call")![0]!;
    const foreground = handlers.get("subagent:foreground-complete")![0]!;
    return { toolCall, foreground, progress };
  }

  function dispatch(toolCall: (e: unknown, c: unknown) => unknown) {
    toolCall(
      {
        toolName: "subagent",
        toolCallId: "call-1",
        input: {
          agent: "opsx-worker",
          prompt: "## Task\n[OPSX WORKER DISPATCH task=1.1]",
        },
      },
      { sessionManager: { getSessionId: () => "s1" } },
    );
  }

  test("a failed child run is never projected", () => {
    const { toolCall, foreground, progress } = wired();
    dispatch(toolCall);
    foreground({ results: [{ index: 0, runId: "call-1", state: "failed" }] });
    expect(progress).toEqual([]);
  });

  test("a run with no attributable session is never projected", () => {
    const { toolCall, foreground, progress } = wired();
    dispatch(toolCall);
    // "complete" but the run carries no canonical session, so it cannot become
    // ready and must not reach the board.
    foreground({ results: [{ index: 0, runId: "call-1", state: "complete" }] });
    expect(progress).toEqual([]);
  });

  test("a stale attempt nonce is never projected", () => {
    const { toolCall, foreground, progress } = wired();
    dispatch(toolCall);
    // A successful terminal state alone is not enough: without a matching
    // attempt the run stays a candidate, so nothing is projected.
    foreground({ results: [{ index: 0, runId: "call-1", state: "complete" }] });
    expect(progress).toEqual([]);
  });

  test("a ready report is projected once per accepted report", () => {
    const { toolCall, foreground, progress } = wired();
    dispatch(toolCall);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-progress-"));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({
      role: "user",
      content: "## Task\n[OPSX WORKER DISPATCH task=1.1]",
      timestamp: 1,
    } as never);
    manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, {
      version: 1,
      attemptId: ATTEMPT,
      agent: "opsx-worker",
      sessionId: "sess-1",
      startedAt: STEP_START,
      promptSha256: "abc",
      taskMarker: "1.1",
    });
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: WORK,
          arguments: {
            taskId: "1.1",
            changedFiles: ["src/a.ts"],
            claims: "done",
            selfVerification: { command: "node check.cjs", result: "exit 0" },
            verificationPassed: true,
            progress: { phase: "verifying", percentage: 80 },
          },
        },
      ],
      api: "a",
      provider: "p",
      model: "m",
      usage: {},
      stopReason: "toolUse",
      timestamp: 2,
    } as never);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "c1",
      toolName: WORK,
      content: [{ type: "text", text: "ok" }],
      details: {
        version: 1,
        attemptId: ATTEMPT,
        agent: "opsx-worker",
        report: {
          taskId: "1.1",
          changedFiles: ["src/a.ts"],
          claims: "done",
          selfVerification: { command: "node check.cjs", result: "exit 0" },
          verificationPassed: true,
          progress: { phase: "verifying", percentage: 80 },
        },
      },
      isError: false,
      timestamp: 3,
    } as never);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "a",
      provider: "p",
      model: "m",
      usage: {},
      stopReason: "endTurn",
      timestamp: 4,
    } as never);
    const file = manager.getSessionFile()!;
    noteChildRunStarted(FLOW, { runId: "call-1", sessionRoot: dir });
    foreground({
      results: [
        { index: 0, runId: "call-1", state: "complete", sessionFile: file },
      ],
    });
    // A ready report reaches the board exactly once.
    expect(progress).toEqual([{ sessionId: "s1", toolName: WORK }]);
  });
});
