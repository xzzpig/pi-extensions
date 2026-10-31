import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEventBus,
  type EventBus,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";
import {
  GOAL_EVENT_ENTRY,
  GOAL_STATE_EVENT_ENTRY,
} from "../../extensions/goal-format.ts";
import type { GoalCore } from "../../extensions/goal-state.ts";
import { GoalRuntime } from "../../extensions/goal-runtime.ts";
import {
  GOAL_AUTO_CONTINUE_GATE_EVENT,
  type GoalAutoContinueGateRequest,
  shouldDeferGoalAutoContinue,
} from "../../extensions/goal-auto-continue-gate.ts";
import { registerGoalAutoContinueGate } from "../../../pi-subagents/src/goal-auto-continue-gate.ts";
import { createResultDeliveryOwnership } from "../../../pi-subagents/src/runs/background/result-delivery-ownership.ts";
import registerSubagentNotify from "../../../pi-subagents/src/runs/background/notify.ts";
import { createParentWake } from "../../../pi-subagents/src/shared/parent-wake.ts";
import { SUBAGENT_CHILD_ENV } from "../../../pi-subagents/src/runs/shared/child-runtime-config.ts";
import { createMockPi } from "../../../pi-subagents/test/support/mock-pi.ts";
import {
  INTERCOM_DETACH_REQUEST_EVENT,
  INTERCOM_DETACH_RESPONSE_EVENT,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type AsyncJobState,
  type ForegroundRunControl,
  type SubagentState,
} from "../../../pi-subagents/src/shared/types.ts";

const identity = { sessionId: "session-1", goalId: "goal-1" };
const deferral = {
  owner: "pi-subagents",
  reason: "Parent-owned async work can wake this session.",
};

test("real Pi EventBus leaves continuation allowed when no listener defers", () => {
  const events = createEventBus();
  assert.equal(shouldDeferGoalAutoContinue(events, identity), false);
});

test("real Pi EventBus exposes a frozen, versioned request with session identity", () => {
  const events = createEventBus();
  let observed: unknown;
  events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, (raw) => {
    observed = raw;
  });

  assert.equal(shouldDeferGoalAutoContinue(events, identity), false);
  assert.deepEqual(
    (({ version, sessionId, goalId }: GoalAutoContinueGateRequest) => ({
      version,
      sessionId,
      goalId,
    }))(observed as GoalAutoContinueGateRequest),
    { version: 1, ...identity },
  );
  assert.equal(Object.isFrozen(observed), true);
});

test("any listener vetoes regardless of listener registration order", () => {
  const run = (blockerFirst: boolean): boolean => {
    const events = createEventBus();
    const blocker = (raw: unknown) =>
      (raw as GoalAutoContinueGateRequest).defer(deferral);
    const observer = () => ({ allow: true });
    if (blockerFirst) {
      events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, blocker);
      events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, observer);
    } else {
      events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, observer);
      events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, blocker);
    }
    return shouldDeferGoalAutoContinue(events, identity);
  };

  assert.equal(run(true), true);
  assert.equal(run(false), true);
});

test("listener return values do not authorize or veto continuation", () => {
  const events = createEventBus();
  let called = false;
  events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, () => {
    called = true;
    return { defer: true };
  });

  assert.equal(shouldDeferGoalAutoContinue(events, identity), false);
  assert.equal(called, true);
});

test("deferral after synchronous dispatch has returned is ignored", async () => {
  const events = createEventBus();
  let request: GoalAutoContinueGateRequest | undefined;
  events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, (raw) => {
    request = raw as GoalAutoContinueGateRequest;
    void Promise.resolve().then(() => request!.defer(deferral));
  });

  assert.equal(shouldDeferGoalAutoContinue(events, identity), false);
  await Promise.resolve();
  // A later event is a new decision; an old callback cannot poison it.
  const nextEvents = createEventBus();
  assert.equal(shouldDeferGoalAutoContinue(nextEvents, identity), false);
});

test("a failed event dispatch fails closed without leaking its exception", () => {
  const events: Pick<EventBus, "emit"> = {
    emit() {
      throw new Error("event dispatch failed");
    },
  };
  assert.equal(shouldDeferGoalAutoContinue(events, identity), true);
});

test("real EventBus veto reaches GoalRuntime and a later result-woken attempt can continue", async () => {
  const events = createEventBus();
  const sessionId = "goal-runtime-real-eventbus-session";
  const ownerId = "goal-runtime-real-eventbus-owner";
  const sentMessages: Array<{
    customType?: string;
    content?: unknown;
    details?: { runs?: Array<{ runId?: string }> };
  }> = [];
  const parentWake = createParentWake(
    {
      sendMessage(message: { customType?: string; content?: unknown }) {
        sentMessages.push(message);
      },
    } as never,
    () => 1_000,
  );
  parentWake.bindSession({
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId },
  } as never);
  const job = {
    asyncId: "runtime-child",
    asyncDir: "/unused/runtime-child",
    mode: "single",
    status: "running",
    sessionId,
    completionOwnerId: ownerId,
  } as AsyncJobState;
  const state = {
    currentSessionId: sessionId,
    supervisorOwnerSessionId: sessionId,
    completionOwnerId: ownerId,
    asyncJobs: new Map([[job.asyncId, job]]),
    foregroundControls: new Map(),
  } as unknown as SubagentState;
  const ownership = createResultDeliveryOwnership(state);
  const notifier = registerSubagentNotify(
    {
      events,
      sendMessage: (...args: Parameters<typeof parentWake.sendMessage>) =>
        parentWake.sendMessage(...args),
      isHeld: parentWake.isHeld,
      on: () => () => {},
    } as never,
    state,
    { ownership, batchConfig: { enabled: false }, now: () => 1_000 },
  );
  notifier.bindSession({ getSessionId: () => sessionId });
  const owedResultRunIds = new Set<string>();
  const gateRequests: Array<{
    version?: number;
    sessionId?: string;
    goalId?: string;
  }> = [];
  events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, (raw) => {
    const {
      version,
      sessionId: requestSessionId,
      goalId,
    } = raw as GoalAutoContinueGateRequest;
    gateRequests.push({ version, sessionId: requestSessionId, goalId });
  });
  const disposeGate = registerGoalAutoContinueGate({ events } as never, {
    state,
    ownership,
    notifier,
    parentWake,
    isHeld: parentWake.isHeld,
    owedResultRunIds,
  });
  let authorizationCalls = 0;
  const snapshots: number[] = [];
  const followUps: unknown[] = [];
  let gateCalls = 0;
  const goal = {
    id: "goal-1",
    status: "active",
    autoContinue: true,
    revision: 1,
  } as never;
  const runtime = new GoalRuntime({
    authorize: () => {
      authorizationCalls++;
      return {
        generation: "integration-generation",
        dispatchId: "integration-dispatch",
      };
    },
    shouldDeferAutoContinue: () => {
      gateCalls++;
      return shouldDeferGoalAutoContinue(events, {
        sessionId,
        goalId: "goal-1",
      });
    },
    sendFollowUp: (_content, details) => followUps.push(details),
    sendStateSnapshot: (_ctx, _goal, checkpointSeq) =>
      snapshots.push(checkpointSeq),
    getGoal: () => goal,
    isActionable: () => true,
  });
  const ctx = {
    cwd: "/tmp/goal-gate-real-eventbus",
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as never;

  try {
    runtime.queueContinuation(ctx, goal, true);
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(gateCalls, 1, "the real veto is not polled or retried");
    assert.deepEqual(
      gateRequests,
      [{ version: 1, sessionId, goalId: "goal-1" }],
      "the parent request carries the live session and goal identity",
    );
    assert.equal(
      authorizationCalls,
      0,
      "veto happens before the allowance claim",
    );
    assert.deepEqual(snapshots, [], "the blocked attempt writes no snapshot");
    assert.deepEqual(
      followUps,
      [],
      "the blocked attempt sends no checkpoint/model request",
    );

    job.status = "complete";
    owedResultRunIds.add(job.asyncId);
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: job.asyncId,
      runId: job.asyncId,
      source: "async",
      agent: "worker",
      success: true,
      state: "complete",
      summary: "runtime result",
      sessionId,
      completionOwnerId: ownerId,
      timestamp: 1_001,
    });
    assert.equal(
      parentWake.isPending(),
      true,
      "the native result wake is accepted before goal retry is rescheduled",
    );
    assert.equal(
      sentMessages[0]?.details?.runs?.[0]?.runId,
      job.asyncId,
      "the delivered handoff retains the original child identity",
    );
    job.status = "complete";
    owedResultRunIds.delete(job.asyncId);
    const sentMessage = {
      role: "custom",
      customType: "subagent-notify",
      content: sentMessages[0]?.content,
    } as never;
    notifier.messageStarted(sentMessage);
    parentWake.agentStarted();
    runtime.queueContinuation(ctx, goal, true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      gateCalls,
      2,
      "the native-result path permits a fresh legal scheduler attempt",
    );
    assert.equal(authorizationCalls, 1);
    assert.deepEqual(snapshots, [1]);
    assert.equal(followUps.length, 1);
  } finally {
    runtime.clearContinuationState();
    disposeGate();
    notifier.dispose();
    parentWake.sessionShutdown("quit");
  }
});

test("real Pi EventBus joins goal vetoes to native subagent results and supervisor wakes", async () => {
  const events = createEventBus();
  const sessionId = "goal-gate-real-eventbus-session";
  const ownerId = "goal-gate-real-eventbus-owner";
  let idle = true;
  const sessionManager = { getSessionId: () => sessionId };
  const sent: Array<{
    message: {
      customType?: string;
      content?: unknown;
      details?: { runs?: Array<{ runId?: string }> };
    };
    options?: { triggerTurn?: boolean };
  }> = [];
  const parentWake = createParentWake(
    {
      sendMessage(
        message: { customType?: string; content?: unknown },
        options?: { triggerTurn?: boolean },
      ) {
        sent.push({ message, options });
      },
    } as never,
    () => 1_000,
  );
  parentWake.bindSession({ isIdle: () => idle, sessionManager } as never);

  const asyncJobs = new Map<string, AsyncJobState>();
  const foregroundControls = new Map<string, ForegroundRunControl>();
  const state = {
    currentSessionId: sessionId,
    supervisorOwnerSessionId: sessionId,
    completionOwnerId: ownerId,
    asyncJobs,
    foregroundControls,
  } as unknown as SubagentState;
  const ownership = createResultDeliveryOwnership(state);
  const owedResultRunIds = new Set<string>();
  const notifier = registerSubagentNotify(
    {
      events,
      sendMessage: (...args: Parameters<typeof parentWake.sendMessage>) =>
        parentWake.sendMessage(...args),
      isHeld: parentWake.isHeld,
      on: () => () => {},
    } as never,
    state,
    { ownership, batchConfig: { enabled: false }, now: () => 1_000 },
  );
  notifier.bindSession(sessionManager);
  const disposeGate = registerGoalAutoContinueGate({ events } as never, {
    state,
    ownership,
    notifier,
    parentWake,
    isHeld: parentWake.isHeld,
    owedResultRunIds,
  });
  const deferForGoal = (requestSessionId = sessionId) =>
    shouldDeferGoalAutoContinue(events, {
      sessionId: requestSessionId,
      goalId: "goal-1",
    });

  try {
    const childOne = {
      asyncId: "child-one",
      asyncDir: "/unused/child-one",
      mode: "single",
      status: "running",
      sessionId,
      completionOwnerId: ownerId,
    } as AsyncJobState;
    const childTwo = {
      asyncId: "child-two",
      asyncDir: "/unused/child-two",
      mode: "single",
      status: "running",
      sessionId,
      completionOwnerId: ownerId,
    } as AsyncJobState;
    const workflowRoot = {
      asyncId: "workflow-root",
      asyncDir: "/unused/workflow-root",
      mode: "workflow",
      status: "running",
      sessionId,
      completionOwnerId: ownerId,
    } as AsyncJobState;
    asyncJobs.set(childOne.asyncId, childOne);
    asyncJobs.set(childTwo.asyncId, childTwo);
    asyncJobs.set(workflowRoot.asyncId, workflowRoot);
    assert.equal(
      deferForGoal(),
      true,
      "parallel children and a workflow root owned by this parent defer the fallback continuation",
    );
    childOne.status = "complete";
    assert.equal(
      deferForGoal(),
      true,
      "one completed child does not release other running work",
    );
    childTwo.status = "complete";
    workflowRoot.status = "complete";
    assert.equal(
      deferForGoal(),
      false,
      "terminal jobs with no owed result or native wake no longer block",
    );

    asyncJobs.clear();
    foregroundControls.set("detached-foreground", {
      runId: "detached-foreground",
      mode: "single",
      sessionId,
    } as ForegroundRunControl);
    assert.equal(
      deferForGoal(),
      true,
      "a live detached foreground control remains part of the parent-owned wake work",
    );
    foregroundControls.clear();
    asyncJobs.set("foreign-child", {
      asyncId: "foreign-child",
      asyncDir: "/unused/foreign",
      mode: "single",
      status: "running",
      sessionId: "another-session",
      completionOwnerId: "another-owner",
    } as AsyncJobState);
    assert.equal(
      deferForGoal(),
      false,
      "foreign-session async work does not veto this parent's continuation",
    );
    asyncJobs.clear();

    const resultJob = {
      asyncId: "result-child",
      asyncDir: "/unused/result-child",
      mode: "single",
      status: "running",
      sessionId,
      completionOwnerId: ownerId,
    } as AsyncJobState;
    asyncJobs.set(resultJob.asyncId, resultJob);
    assert.equal(
      deferForGoal(),
      true,
      "a child without an explicit wait is still visible as native async work",
    );
    resultJob.status = "complete";
    owedResultRunIds.add(resultJob.asyncId);
    assert.equal(
      deferForGoal(),
      true,
      "terminal-but-not-yet-handed-off result blocks the next goal checkpoint",
    );
    asyncJobs.clear();

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: resultJob.asyncId,
      runId: resultJob.asyncId,
      source: "async",
      agent: "worker",
      success: true,
      state: "complete",
      summary: "child result available",
      sessionId,
      completionOwnerId: ownerId,
      timestamp: 1_000,
    });
    assert.equal(
      sent.length,
      1,
      "the real completion listener delivers the result through ParentWake",
    );
    assert.equal(sent[0]?.message.customType, "subagent-notify");
    assert.equal(
      sent[0]?.message.details?.runs?.[0]?.runId,
      resultJob.asyncId,
      "the native notice is still associated with its child run",
    );
    assert.equal(
      sent[0]?.options?.triggerTurn,
      true,
      "result delivery still promises its native parent turn",
    );
    owedResultRunIds.delete(resultJob.asyncId);
    assert.equal(
      deferForGoal(),
      true,
      "accepted result wake stays ahead of goal fallback while it starts",
    );

    notifier.messageStarted({
      role: "custom",
      customType: "subagent-notify",
      content: sent[0]?.message.content,
    } as never);
    assert.equal(
      notifier.hasPendingWake(),
      false,
      "message_start releases the notifier's unstarted notice",
    );
    assert.equal(
      parentWake.isPending(),
      true,
      "ParentWake covers the accepted-but-agent_start window",
    );
    assert.equal(deferForGoal(), true);
    parentWake.agentStarted();
    idle = false;
    assert.equal(parentWake.isPending(), false);
    idle = true;
    assert.equal(
      deferForGoal(),
      false,
      "after the result turn settles, the original goal route is eligible again",
    );

    sent.length = 0;
    parentWake.sendMessage(
      {
        customType: "native-supervisor-request",
        content: "supervisor attention",
        display: false,
      },
      { triggerTurn: true },
    );
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0]?.options?.triggerTurn,
      true,
      "native supervisor wake is not intercepted or rewritten by the goal event",
    );
    assert.equal(
      deferForGoal(),
      true,
      "the already-reserved supervisor wake stays ahead of a fallback checkpoint",
    );
    parentWake.agentStarted();
    idle = false;
    idle = true;
    assert.equal(deferForGoal(), false);
  } finally {
    disposeGate();
    notifier.dispose();
    parentWake.sessionShutdown("quit");
  }
});

test("actual goal and subagents lifecycles gate workflow and detached foreground results without spending scheduler budgets", async () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  type Sent = {
    message: {
      customType?: string;
      content?: unknown;
      details?: Record<string, unknown>;
    };
    options?: { triggerTurn?: boolean };
  };
  type Surface = {
    pi: Record<string, unknown>;
    handlers: Map<string, Handler[]>;
    tools: Map<string, Record<string, unknown>>;
    commands: Map<string, Record<string, unknown>>;
  };
  const root = mkdtempSync(
    join(tmpdir(), "pi-goal-subagents-real-extensions-"),
  );
  const agentDir = join(root, "agent");
  const sessionsDir = join(root, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = randomUUID();
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", id: sessionId, cwd: root, timestamp: new Date().toISOString() })}\n`,
  );
  const events = createEventBus();
  const sent: Sent[] = [];
  let idle = true;
  let pendingMessages = false;
  const entries: unknown[] = [];
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getCwd: () => root,
    getRoot: () => root,
    getBranch: () => entries,
    getEntries: () => entries,
    append: (entry: unknown) => {
      entries.push(entry);
      return undefined;
    },
  };
  const ctx = {
    cwd: root,
    hasUI: false,
    mode: "interactive",
    model: { provider: "test", id: "test-model" },
    modelRegistry: { getAvailable: () => [] },
    sessionManager,
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    getSystemPrompt: () => "",
    abort: () => {},
    signal: new AbortController().signal,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      onTerminalInput: () => () => {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      custom: async () => undefined,
    },
  } as unknown as ExtensionContext;
  const makeSurface = (): Surface => {
    const handlers = new Map<string, Handler[]>();
    const tools = new Map<string, Record<string, unknown>>();
    const commands = new Map<string, Record<string, unknown>>();
    const base = {
      events,
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () =>
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter(
              (candidate) => candidate !== handler,
            ),
          );
      },
      registerTool(tool: Record<string, unknown>) {
        tools.set(String(tool.name), tool);
      },
      registerCommand(name: string, command: Record<string, unknown>) {
        commands.set(name, command);
      },
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      registerShortcut() {},
      appendEntry(entry: unknown) {
        entries.push(entry);
      },
      sendMessage(message: Sent["message"], options?: Sent["options"]) {
        sent.push({ message, options });
      },
      getActiveTools: () => ["read", "bash", "edit", "write"],
      setActiveTools: () => {},
      getSessionName: () => undefined,
      hasUI: false,
    };
    const pi = new Proxy(base, {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : () => undefined,
    });
    return {
      pi: pi as unknown as Record<string, unknown>,
      handlers,
      tools,
      commands,
    };
  };
  const goal = makeSurface();
  const subagents = makeSurface();
  const mockPi = createMockPi();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousChildEnv = process.env[SUBAGENT_CHILD_ENV];
  const previousChildFlag = process.env.PI_SUBAGENT_CHILD;
  let core: GoalCore | undefined;
  let started = false;
  let releaseWorkflowChildren: string | undefined;
  let releaseForeground: string | undefined;
  let foregroundRunId: string | undefined;
  let foregroundExecution: Promise<unknown> | undefined;
  const invoke = async (
    surface: Surface,
    name: string,
    event: unknown,
  ): Promise<void> => {
    for (const handler of surface.handlers.get(name) ?? [])
      await handler(event, ctx);
  };
  const checkpointBudget = () => ({
    used: core!.state.goal!.scheduler!.used,
    remainingChecks: core!.state.goal!.scheduler!.wait!.remainingChecks,
    checkpointSeq: (core!.runtime as unknown as { checkpointSeq: number })
      .checkpointSeq,
  });

  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env[SUBAGENT_CHILD_ENV];
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    mockPi.install();
    // Invoke both shipped package entrypoints against the same real SDK EventBus.
    goalExtension(goal.pi as never);
    const { default: registerSubagentExtension } = await import(
      "../../../pi-subagents/index.ts"
    );
    registerSubagentExtension(subagents.pi as never);
    core = (goal.pi as unknown as { _goalCore: GoalCore })._goalCore;
    assert.ok(core, "goal.ts factory creates its real GoalCore");
    await invoke(goal, "session_start", { reason: "startup" });
    await invoke(subagents, "session_start", { reason: "startup" });
    started = true;

    const settingsDir = join(root, ".pi");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "pi-goal-x-settings.json"),
      JSON.stringify({ strictExecutionContract: true, maxAutonomousRuns: 8 }),
    );
    core.replaceGoal(
      {
        objective: "Exercise the real extension gate",
        autoContinue: true,
        sisyphus: false,
      } as never,
      ctx,
      false,
    );
    const deadline = new Date(Date.now() + 60_000).toISOString();
    core.scheduler.declare(ctx, {
      kind: "wait",
      reason: "Test the real scheduler accounting around a gated check.",
      deadline,
      polling: { interval_seconds: 1, max_checks: 2 },
    });
    const goalRecord = core.state.goal!;
    assert.ok(
      goalRecord.scheduler?.wait,
      "the real scheduler persisted its bounded wait state",
    );

    const subagentTool = subagents.tools.get("subagent") as unknown as {
      execute(
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (update: unknown) => void,
        ctx: unknown,
      ): Promise<unknown>;
    };
    assert.ok(subagentTool, "the real extension registered its subagent tool");
    releaseWorkflowChildren = join(root, "release-workflow-children");
    mockPi.onCall({
      matchArgIncludes: "workflow child one",
      waitForPath: releaseWorkflowChildren,
      output: "workflow child one completed",
    });
    mockPi.onCall({
      matchArgIncludes: "workflow child two",
      waitForPath: releaseWorkflowChildren,
      output: "workflow child two completed",
    });
    const workflowPath = join(root, "parallel-workflow.js");
    writeFileSync(
      workflowPath,
      `return await runs.all([\n  { key: "one", agent: "worker", task: "workflow child one" },\n  { key: "two", agent: "worker", task: "workflow child two" }\n]);\n`,
    );
    const workflowLaunch = await subagentTool.execute(
      "parallel-workflow-integration",
      {
        workflow: workflowPath,
        async: true,
        cwd: root,
        output: false,
        options: { mission: false },
      },
      new AbortController().signal,
      () => {},
      ctx,
    );
    const workflowDetails = workflowLaunch as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
      details?: { asyncId?: string; runId?: string };
    };
    assert.notEqual(
      workflowDetails.isError,
      true,
      workflowDetails.content?.map((part) => part.text ?? "").join("\\n"),
    );
    const workflowRunId =
      workflowDetails.details?.runId ?? workflowDetails.details?.asyncId;
    assert.ok(
      workflowRunId,
      "the real async workflow launch returns its root run id",
    );
    const workflowChildrenDeadline = Date.now() + 5_000;
    while (mockPi.callCount() < 2 && Date.now() < workflowChildrenDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      mockPi.callCount(),
      2,
      "the real workflow script launched both parallel children through the isolated child-session boundary",
    );
    releaseForeground = join(root, "release-foreground-child");
    mockPi.onCall({
      steps: [
        {
          waitForPath: releaseForeground,
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "foreground child completed" }],
                model: "mock/test-model",
                stopReason: "stop",
                usage: {
                  input: 100,
                  output: 50,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0.001 },
                },
              },
            },
          ],
        },
      ],
    });
    let foregroundError: unknown;
    foregroundExecution = subagentTool
      .execute(
        "foreground-integration-run",
        {
          agent: "worker",
          task: "Remain active until the integration test releases this child.",
          async: false,
        },
        new AbortController().signal,
        (update) => {
          const details = (update as { details?: { runId?: unknown } }).details;
          if (typeof details?.runId === "string")
            foregroundRunId = details.runId;
        },
        ctx,
      )
      .catch((error: unknown) => {
        foregroundError = error;
        throw error;
      });
    void foregroundExecution.catch(() => {});
    const foregroundStartDeadline = Date.now() + 3_000;
    while (
      (!foregroundRunId || mockPi.sessions.length === 0) &&
      Date.now() < foregroundStartDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      foregroundRunId,
      `real subagent executor started its foreground control${foregroundError ? `: ${String(foregroundError)}` : ""}`,
    );
    assert.ok(
      mockPi.sessions.length > 0,
      "the real foreground launch reached the isolated fake child-session boundary",
    );
    const detachResponses: Array<{ accepted?: boolean; runId?: string }> = [];
    const disposeDetachResponses = events.on(
      INTERCOM_DETACH_RESPONSE_EVENT,
      (raw) => {
        detachResponses.push(raw as { accepted?: boolean; runId?: string });
      },
    );
    try {
      events.emit(INTERCOM_DETACH_REQUEST_EVENT, {
        requestId: randomUUID(),
        runId: foregroundRunId,
        agent: "worker",
        childIndex: 0,
      });
      assert.ok(
        detachResponses.some(
          (response) =>
            response.accepted === true && response.runId === foregroundRunId,
        ),
        "the actual foreground execution accepts the native detach request and retains its control while the child runs",
      );
    } finally {
      disposeDetachResponses();
    }

    const wait = goalRecord.scheduler!.wait!;
    wait.nextCheckAt = Date.now() - 1;
    core.persist(ctx as never);
    const budgetBeforeVeto = checkpointBudget();
    const sentBeforeVeto = sent.length;
    const gateRequests: Array<{
      version?: number;
      sessionId?: string;
      goalId?: string;
    }> = [];
    const disposeObserver = events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, (raw) => {
      const request = raw as GoalAutoContinueGateRequest;
      gateRequests.push({
        version: request.version,
        sessionId: request.sessionId,
        goalId: request.goalId,
      });
    });
    try {
      core.scheduler.schedule(ctx);
      await new Promise((resolve) => setTimeout(resolve, 130));
      assert.deepEqual(
        gateRequests,
        [{ version: 1, sessionId, goalId: goalRecord.id }],
        "the real final-send path dispatches the shared SDK event",
      );
      assert.deepEqual(
        checkpointBudget(),
        budgetBeforeVeto,
        "veto leaves actual scheduler used, remainingChecks, and checkpointSeq unchanged",
      );
      const blockedGoalMessages = sent
        .slice(sentBeforeVeto)
        .filter(
          ({ message }) =>
            message.customType === GOAL_EVENT_ENTRY ||
            message.customType === GOAL_STATE_EVENT_ENTRY,
        );
      assert.deepEqual(
        blockedGoalMessages,
        [],
        "the real GoalCore sends no snapshot or checkpoint on veto",
      );

      writeFileSync(releaseWorkflowChildren!, "release");
      const workflowNoticeDeadline = Date.now() + 5_000;
      let nativeNotice = sent.find(({ message }) => {
        const runs = (
          message.details as { runs?: Array<{ runId?: string }> } | undefined
        )?.runs;
        return (
          message.customType === "subagent-notify" &&
          runs?.some((run) => run.runId === workflowRunId)
        );
      });
      while (!nativeNotice && Date.now() < workflowNoticeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        nativeNotice = sent.find(({ message }) => {
          const runs = (
            message.details as { runs?: Array<{ runId?: string }> } | undefined
          )?.runs;
          return (
            message.customType === "subagent-notify" &&
            runs?.some((run) => run.runId === workflowRunId)
          );
        });
      }
      assert.ok(
        nativeNotice,
        "the actual workflow root result returns through the native parent wake path",
      );
      assert.equal(
        nativeNotice.options?.triggerTurn,
        true,
        "the result's native parent wake remains enabled",
      );
      assert.equal(
        shouldDeferGoalAutoContinue(events, {
          sessionId,
          goalId: goalRecord.id,
        }),
        true,
        "the accepted native result remains ahead of a fallback continuation",
      );

      await invoke(subagents, "message_start", {
        message: { ...nativeNotice.message, role: "custom" },
      });
      idle = false;
      await invoke(subagents, "agent_start", {});
      idle = true;
      pendingMessages = false;
      assert.equal(
        shouldDeferGoalAutoContinue(events, {
          sessionId,
          goalId: goalRecord.id,
        }),
        true,
        "the actual detached foreground control continues to defer after the workflow result turn starts",
      );

      writeFileSync(releaseForeground!, "release");
      await foregroundExecution;
      const foregroundNoticeDeadline = Date.now() + 2_000;
      let foregroundNotice = sent.find(({ message }) => {
        const runs = (
          message.details as { runs?: Array<{ runId?: string }> } | undefined
        )?.runs;
        return (
          message.customType === "subagent-notify" &&
          runs?.some((run) => run.runId === foregroundRunId)
        );
      });
      while (!foregroundNotice && Date.now() < foregroundNoticeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        foregroundNotice = sent.find(({ message }) => {
          const runs = (
            message.details as { runs?: Array<{ runId?: string }> } | undefined
          )?.runs;
          return (
            message.customType === "subagent-notify" &&
            runs?.some((run) => run.runId === foregroundRunId)
          );
        });
      }
      assert.ok(
        foregroundNotice,
        "the detached foreground terminal result is returned through its native parent notification",
      );
      await invoke(subagents, "message_start", {
        message: { ...foregroundNotice.message, role: "custom" },
      });
      idle = false;
      await invoke(subagents, "agent_start", {});
      idle = true;
      assert.equal(
        shouldDeferGoalAutoContinue(events, {
          sessionId,
          goalId: goalRecord.id,
        }),
        false,
        "after the detached foreground result starts, no native work or handoff blocks the goal",
      );

      const sendsBeforeAllowed = sent.length;
      core.scheduler.schedule(ctx);
      await new Promise((resolve) => setTimeout(resolve, 130));
      assert.deepEqual(
        checkpointBudget(),
        {
          used: budgetBeforeVeto.used + 1,
          remainingChecks: (budgetBeforeVeto.remainingChecks ?? 0) - 1,
          checkpointSeq: budgetBeforeVeto.checkpointSeq + 1,
        },
        "the result-woken legal attempt advances the real scheduler and checkpoint exactly once",
      );
      const allowedGoalMessages = sent
        .slice(sendsBeforeAllowed)
        .filter(
          ({ message }) =>
            message.customType === GOAL_EVENT_ENTRY ||
            message.customType === GOAL_STATE_EVENT_ENTRY,
        );
      assert.equal(
        allowedGoalMessages.length,
        2,
        "the allowed attempt sends its paired real GoalCore snapshot and checkpoint",
      );
    } finally {
      disposeObserver();
    }
  } finally {
    if (releaseWorkflowChildren)
      writeFileSync(releaseWorkflowChildren, "release");
    if (releaseForeground) writeFileSync(releaseForeground, "release");
    if (started) {
      await Promise.all([
        invoke(goal, "session_shutdown", { reason: "quit" }),
        invoke(subagents, "session_shutdown", { reason: "quit" }),
      ]);
    }
    await foregroundExecution?.catch(() => {});
    mockPi.uninstall();
    core?.runtime.clearContinuationState();
    core?.scheduler.shutdown();
    rmSync(root, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousChildEnv === undefined) delete process.env[SUBAGENT_CHILD_ENV];
    else process.env[SUBAGENT_CHILD_ENV] = previousChildEnv;
    if (previousChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChildFlag;
  }
});
