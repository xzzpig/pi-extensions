/**
 * Deterministic peer-boundary integration (design D8, task 6.2).
 *
 * The whole chain runs through the real wiring with no model, no network and no
 * manual confirmation: a real canonical session record drives the real native
 * completion event, which produces a ready receipt that the real tick gate
 * consumes before it authorizes a completion. Nothing here re-implements the
 * production path — the point is that the seams actually meet.
 *
 * Ordering matters and mirrors reality: the dispatch happens first (creating the
 * parent's launch record and its start boundary), and only then does the child
 * session exist, so the report's attempt falls inside that window.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import {
  childRunsForFlow,
  childReportFlowId,
  registerChildReportIngestion,
  resetChildReportIngestionForTests,
  rebuildChildReportFlow,
} from "../src/child-report-ingestion.ts";
import { CHILD_REPORT_ATTEMPT_ENTRY } from "../src/child-report-reader.ts";
import {
  registerImplementFlow,
  resetImplementFlowsForTests,
  startImplementFlow,
} from "../src/implement-command.ts";

const SESSION = "s1";
const CHANGE = "change-a";
const GOAL = "goal-1";
const FLOW_ID = childReportFlowId(SESSION, CHANGE);
const ATTEMPT = "attempt-1";
const WORK = "report_work";
const DISPATCH = {
  toolName: "subagent",
  toolCallId: "call-1",
  // The real `subagent` tool carries the brief in `task`, not `prompt`.
  // Using `prompt` here masked the defect that made every live dispatch
  // `taskUnknown`, so the run could never become ready.
  input: {
    agent: "opsx-worker",
    task: "## 1. Task\nTask 1.1\n\n[OPSX WORKER DISPATCH task=1.1]",
  },
};

const WORK_REPORT = {
  taskId: "1.1",
  changedFiles: ["src/a.ts"],
  claims: "done",
  selfVerification: { command: "node check.cjs", result: "exit 0" },
  verificationPassed: true,
};

const TICK = {
  toolName: "update_goal_task",
  toolCallId: "tick-1",
  input: { task_id: "1.1", status: "complete" },
  isError: false,
  details: {
    version: 3,
    goal: {
      id: GOAL,
      taskList: {
        tasks: [
          {
            id: "1.1",
            status: "complete",
            completedAt: "2026-01-02T00:06:00.000Z",
          },
        ],
      },
    },
  },
};

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const channels = new Map<string, Handler[]>();
  const sent: Array<{ customType: string; content: string }> = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
    sendMessage(message: { customType: string; content: string }) {
      sent.push(message);
    },
    events: {
      on(channel: string, handler: Handler) {
        const list = channels.get(channel) ?? [];
        list.push(handler);
        channels.set(channel, list);
        return () => {};
      },
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };
  return { pi, handlers, channels, sent, emitted };
}

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

const result = (id: string, attemptId = ATTEMPT) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: WORK,
    content: [{ type: "text", text: "Work report recorded for task 1.1." }],
    details: {
      version: 1,
      attemptId,
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

/**
 * A real canonical session holding one worker report (design D2). The attempt
 * starts now, i.e. after the dispatch that created the parent's start boundary.
 */
function buildSession(options: { attemptId?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-gate-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage(user());
  manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, {
    version: 1,
    attemptId: ATTEMPT,
    agent: "opsx-worker",
    sessionId: "sess-1",
    startedAt: new Date().toISOString(),
    promptSha256: "abc",
    taskMarker: "1.1",
  });
  manager.appendMessage(call("c1"));
  manager.appendMessage(result("c1", options.attemptId ?? ATTEMPT));
  manager.appendMessage(stop());
  const file = manager.getSessionFile();
  if (!file) throw new Error("no session file");
  return { dir, file };
}

/** The parent branch the fake pi appends to, so durable confirms can land. */
const branch: Array<{
  id?: string;
  type: string;
  customType?: string;
  data?: unknown;
}> = [];

const ctx = {
  cwd: "/tmp",
  sessionManager: {
    getSessionId: () => SESSION,
    getLeafId: () => "l1",
    getBranch: () => branch,
  },
};

/** Wire the real ingestion and the real implement flow over one fake pi. */
function wire() {
  const { pi, handlers, channels, sent, emitted } = fakePi();
  // Register the implement flow first so its tick gate stays `tool_call[0]`;
  // ingestion registers a `tool_call` handler of its own for dispatch
  // attribution and would otherwise take that slot.
  registerImplementFlow(pi as never, {
    enterMode: async () => {},
    installAuditor: () => {},
    readGoals: async () => [
      {
        id: GOAL,
        status: "active",
        objective: `Implement the OpenSpec change "${CHANGE}".`,
      },
    ],
    readGoalTasks: async () => [{ id: "1.1", status: "pending" }],
    readWindowDelta: async () => ["src/a.ts"],
    readFocus: async () => ({
      state: "known-focused",
      goalId: GOAL,
      token: {
        sessionId: SESSION,
        branchGeneration: null,
        storageRoot: null,
        focusEntryId: null,
        goalId: GOAL,
      },
    }),
  });
  // Deliberately the same wiring as `src/index.ts`: no `sessionId` dep. The
  // native completion events carry no ctx, so the ingestion has to fall back to
  // the session it captured at dispatch. Supplying `sessionId` here masked a
  // real defect that only the live E2E exposed.
  registerChildReportIngestion(pi as never, {
    activeFlow: () => ({ flowId: FLOW_ID, changeId: CHANGE, goalId: GOAL }),
  });
  startImplementFlow(SESSION, {
    changeId: CHANGE,
    mode: "agent",
    phase: "implementing",
  });
  return { pi, handlers, channels, sent, emitted };
}

async function drive(
  handlers: Handler[] | undefined,
  event: unknown,
): Promise<void> {
  for (const handler of handlers ?? []) {
    await handler(event, ctx as never);
  }
}

/**
 * Run the real chain: dispatch, then the child session, then the native
 * completion. Returns the child's canonical session file.
 */
async function runChain(
  wired: ReturnType<typeof wire>,
  build: () => { dir: string; file: string },
  state = "complete",
  completionRunId = "call-1",
): Promise<string> {
  // 1. The parent observes its own dispatch on `tool_call` (ingestion
  //    attributes the task from the encoded marker) ...
  await drive(wired.handlers.get("tool_call"), DISPATCH);
  // 2. ... and on `tool_result` (the lifecycle handler records the dispatch).
  await drive(wired.handlers.get("tool_result"), {
    ...DISPATCH,
    isError: false,
  });
  // 3. The child runs now, so its session is created after the dispatch.
  const { file } = build();
  // 4. Bind the flow to its goal.
  await drive(wired.handlers.get("tool_result"), {
    toolName: "create_goal",
    input: {},
    isError: false,
  });
  // 5. The child completes natively; ingestion must pick the report up.
  await drive(wired.channels.get("subagent:foreground-complete"), {
    results: [{ index: 0, runId: completionRunId, state, sessionFile: file }],
  });
  return file;
}

/** Ask the real tick gate whether the completion may proceed. */
async function tick(wired: ReturnType<typeof wire>) {
  const gate = wired.handlers.get("tool_call")![0]!;
  return (await gate(TICK as never, ctx as never)) as {
    block?: boolean;
    reason?: string;
  };
}

/** Drive the gate with an explicit update_goal_task payload. */
async function tickToolCall(
  wired: ReturnType<typeof wire>,
  input: Record<string, unknown>,
) {
  const gate = wired.handlers.get("tool_call")![0]!;
  return (await gate({ ...TICK, input } as never, ctx as never)) as {
    block?: boolean;
    reason?: string;
  };
}

beforeEach(() => {
  resetImplementFlowsForTests();
  resetChildReportIngestionForTests();
  branch.length = 0;
});

describe("child report to tick gate integration", () => {
  /**
   * The real chain end to end: dispatch, child session, native completion,
   * ingestion, and the gate authorizing the tick. Two wiring defects had to be
   * fixed before this could pass — the foreground path never set `sessionRoot`,
   * and the attempt nonce was never resolved (the parent cannot know it before
   * reading the child's session, so the reader adopts the newest attempt on the
   * branch). This test is what surfaced both.
   */
  test("a real canonical report authorizes the tick", async () => {
    const wired = wire();
    await runChain(wired, () => buildSession());
    const runs = childRunsForFlow(FLOW_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agent: "opsx-worker",
      toolName: "report_work",
      taskId: "1.1",
      stepTerminal: true,
      status: "ready",
    });
    expect(runs[0]?.sessionRoot).toBeTruthy();
    // The adopted attempt nonce is the one the child actually wrote.
    expect(runs[0]?.attemptId).toBe(ATTEMPT);
    const decision = await tick(wired);
    expect(decision.reason).toBeUndefined();
    expect(decision).toEqual({});
  });

  test("a restored receipt still authorizes a tick after a restart", async () => {
    // The flow Map and the dispatch tracker are both process state, so a
    // restart leaves the tracker empty while the branch still holds the
    // receipt. The gate checks the tracker *before* it looks at a receipt, so
    // unless the tracker is seeded from the restored runs every completion is
    // refused after a restart (design D5).
    const wired = wire();
    branch.push({
      id: "m1",
      type: "custom",
      customType: "pi-openspec-x/mode-entered",
      data: { changeId: CHANGE, mode: "agent" },
    });
    await runChain(wired, () => buildSession(), "complete");
    expect(
      branch.some(
        (entry) => entry.customType === "pi-openspec-x/child-report-receipt",
      ),
    ).toBe(true);

    resetImplementFlowsForTests();
    resetChildReportIngestionForTests();
    expect(childRunsForFlow(FLOW_ID)).toHaveLength(0);

    await drive(wired.handlers.get("session_start"), {});
    const decision = await tick(wired);
    expect(decision.reason).toBeUndefined();
    expect(decision).toEqual({});
  });

  test("a cached flow still ticks from a receipt rebuilt after a restart", async () => {
    // After a restart the implement flow can already be cached (src/index.ts
    // rebinds it on session_start, before the ingestion layer rebuilds the
    // child-report runs). The gate then skips its own rebind -- the only place
    // that seeded the tracker -- so without a lazy seed it refuses every
    // completion even though the branch holds a valid receipt (design D5).
    const wired = wire();
    await runChain(wired, () => buildSession(), "complete");
    expect(
      branch.some(
        (entry) => entry.customType === "pi-openspec-x/child-report-receipt",
      ),
    ).toBe(true);

    resetImplementFlowsForTests();
    resetChildReportIngestionForTests();
    // Restart state: flow cached, runs not yet rebuilt, tracker empty.
    startImplementFlow(SESSION, {
      changeId: CHANGE,
      mode: "agent",
      goalId: GOAL,
      phase: "reviewing",
    });

    // Control: a task with no dispatch at all must be refused. Without this the
    // assertion below could pass vacuously if the gate returned early.
    const control = await tickToolCall(wired, {
      task_id: "9.9",
      status: "complete",
    });
    expect(control.block).toBe(true);

    rebuildChildReportFlow(FLOW_ID, branch);

    const decision = await tickToolCall(wired, {
      task_id: "1.1",
      status: "complete",
    });
    expect(decision.reason).toBeUndefined();
    expect(decision).toEqual({});
  });

  test("a stale attempt nonce never authorizes the tick", async () => {
    const wired = wire();
    await runChain(wired, () => buildSession({ attemptId: "attempt-old" }));
    const decision = await tick(wired);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("no accepted worker report");
  });

  test("a failed child run never authorizes the tick", async () => {
    const wired = wire();
    await runChain(wired, () => buildSession(), "failed");
    const decision = await tick(wired);
    expect(decision.block).toBe(true);
  });

  test("no dispatch at all never authorizes the tick", async () => {
    const wired = wire();
    expect((await tick(wired)).block).toBe(true);
  });

  test("ingesting a report does not complete the task by itself", async () => {
    const wired = wire();
    await runChain(wired, () => buildSession());
    // The report is accepted, but nothing publishes a completion until the
    // main session actually asks to complete the task.
    const completed = wired.emitted.filter(
      (entry) => (entry.data as { type?: string }).type === "task_completed",
    );
    expect(completed).toEqual([]);
  });

  test("the durable chain is recorded in dispatch -> run -> receipt order", async () => {
    const wired = wire();
    await runChain(wired, () => buildSession());
    const order = branch
      .map((entry) => entry.customType)
      .filter((customType) =>
        [
          "pi-openspec-x/child-report-dispatch",
          "pi-openspec-x/child-report-run",
          "pi-openspec-x/child-report-receipt",
        ].includes(customType ?? ""),
      );
    // The live E2E asserts exactly this ordering in the session JSONL; before
    // the wiring these three entry types were never written at all.
    expect(order[0]).toBe("pi-openspec-x/child-report-dispatch");
    expect(order).toContain("pi-openspec-x/child-report-run");
    expect(order[order.length - 1]).toBe("pi-openspec-x/child-report-receipt");
    const receipt = branch.find(
      (entry) => entry.customType === "pi-openspec-x/child-report-receipt",
    );
    expect(receipt?.data).toMatchObject({
      taskId: "1.1",
      attemptId: ATTEMPT,
      verificationPassed: true,
    });
  });

  test("a completion whose native run id differs from the tool-call id is still attributed", async () => {
    const wired = wire();
    // Live, the dispatch is recorded under the parent's tool-call id while the
    // native completion carries the child's own run id. They never match, so
    // before the fallback the chain recorded a dispatch and nothing else.
    await runChain(wired, () => buildSession(), "complete", "native-run-9f2c");
    const runs = childRunsForFlow(FLOW_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ready");
    expect(runs[0]?.taskId).toBe("1.1");
    const receipt = branch.find(
      (entry) => entry.customType === "pi-openspec-x/child-report-receipt",
    );
    expect(receipt?.data).toMatchObject({
      taskId: "1.1",
      verificationPassed: true,
    });
  });

  test("the canonical session file is captured from the subagent tool result", async () => {
    // Live, the foreground completion event carries no sessionFile, so the
    // parent cannot locate the child's canonical session from it. The tool
    // result carries it and can arrive afterwards, so the run must be able to
    // become ready from the result alone. The payload mirrors the real shape:
    // the result entry has `index` and `sessionFile` but no `runId`, and the
    // details object carries no tool-call id.
    const wired = wire();
    await drive(wired.handlers.get("tool_call"), DISPATCH);
    const { file } = buildSession();
    await drive(wired.handlers.get("tool_result"), {
      toolName: "subagent",
      toolCallId: DISPATCH.toolCallId,
      input: DISPATCH.input,
      details: { results: [{ index: 0, sessionFile: file }] },
    });
    const runs = childRunsForFlow(FLOW_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ready");
    expect(runs[0]?.taskId).toBe("1.1");
    expect(
      branch.some(
        (entry) => entry.customType === "pi-openspec-x/child-report-receipt",
      ),
    ).toBe(true);
  });

  test("the async path locates the canonical session from the native status document", async () => {
    // pi-subagents defaults to async, and the async completion payload carries
    // no sessionFile (unlike the foreground tool result). The background path
    // must therefore read <asyncDir>/status.json and take the session file from
    // the matching native step (design D2).
    const wired = wire();
    await drive(wired.handlers.get("tool_call"), DISPATCH);
    const { file } = buildSession();
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-async-"));
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        lifecycleArtifactVersion: 3,
        runId: "native-run-1",
        steps: [
          {
            index: 0,
            agent: "opsx-worker",
            status: "complete",
            sessionFile: file,
          },
        ],
      }),
      "utf8",
    );
    await drive(wired.channels.get("subagent:async-started"), {
      // The real start event names the run `id`, not `runId`.
      id: "native-run-1",
      asyncDir,
      sessionRoot: path.dirname(file),
    });
    await drive(wired.channels.get("subagent:async-complete"), {
      runId: "native-run-1",
      results: [{ index: 0, runId: "native-run-1", state: "complete" }],
    });
    const runs = childRunsForFlow(FLOW_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ready");
    expect(runs[0]?.taskId).toBe("1.1");
    expect(
      branch.some(
        (entry) => entry.customType === "pi-openspec-x/child-report-receipt",
      ),
    ).toBe(true);
  });

  test("a receipt survives a cold start by being rebuilt from the branch", async () => {
    // Design D5: a restart has no in-memory state, so the flow has to be
    // rebuilt from the durable branch entries. Without this the gate would
    // block forever on work that was already verified before the restart.
    const wired = wire();
    await runChain(wired, () => buildSession(), "complete");
    expect(
      branch.some(
        (entry) => entry.customType === "pi-openspec-x/child-report-receipt",
      ),
    ).toBe(true);

    resetChildReportIngestionForTests();
    expect(childRunsForFlow(FLOW_ID)).toHaveLength(0);

    await drive(wired.handlers.get("session_start"), {});

    const runs = childRunsForFlow(FLOW_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ready");
    expect(runs[0]?.taskId).toBe("1.1");
  });

  test("the parent never files a report of its own", async () => {
    const wired = wire();
    await runChain(wired, () => buildSession());
    // Ingestion reads the child's own canonical record; the parent is never
    // told to submit or transcribe a report (design D1/D8).
    const notices = wired.sent.map((m) => m.content).join("\n");
    expect(notices).not.toContain("call report_work");
    expect(notices).not.toContain("has not been reviewed");
  });
});
