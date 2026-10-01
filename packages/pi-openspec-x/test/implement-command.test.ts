/**
 * Tests for `/opsx:implement` mode selection and flow start (task 8.1).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  probeGoalXDependency,
  resetDependencyStateForTests,
  type GoalXModuleFacet,
} from "../src/dependencies.ts";
import {
  activeImplementFlow,
  boundariesForMode,
  endImplementFlow,
  IMPLEMENT_NOTICE_CUSTOM_TYPE,
  IMPLEMENT_START_CUSTOM_TYPE,
  parseImplementArgs,
  registerImplementFlow,
  renderImplementStart,
  resetImplementFlowsForTests,
  selectImplementationMode,
  startImplementFlow,
} from "../src/implement-command.ts";
import { assembleOpsxObjective } from "../src/objective.ts";
import type { GoalTaskLike } from "../src/task-sync.ts";

const roots: string[] = [];

/**
 * A complete goal-x facet so `probeGoalXDependency` records the dependency as
 * available: the command-level flow-start tests exercise the flow, not the
 * fail-closed gate. The gate's own refusal is covered in its dedicated test
 * (and at the unit level in dependencies.test.ts).
 */
function fakeGoalXFacet(): GoalXModuleFacet {
  return {
    setGoalAuditorOverride() {},
    clearGoalAuditorOverride() {},
    registerAuditorAgentResolver: () => () => {},
    readChangeBaseline: () => undefined,
    computeChangeDelta: async () => ({
      goalId: "goal-1",
      repos: [],
      empty: true,
      truncated: false,
      diagnostics: [],
    }),
  };
}

beforeEach(async () => {
  resetImplementFlowsForTests();
  await probeGoalXDependency(async () => fakeGoalXFacet());
});

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeProject(
  changeId = "change-a",
  options: { approved?: boolean } = {},
): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-openspec-x-implement-"),
  );
  roots.push(root);
  const changeDir = path.join(root, "openspec", "changes", changeId);
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(
    path.join(changeDir, "tasks.md"),
    "# Tasks\n\n- [ ] 1.1 First task; 验证：the test passes\n- [ ] 1.2 Second task\n",
    "utf-8",
  );
  // The approval gate reads the change's plan ledger; a project is approved
  // unless a test opts out to exercise the refusal path.
  if (options.approved !== false) {
    fs.writeFileSync(
      path.join(changeDir, ".opsx-plan-review.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        type: "plan_approval",
        decision: "approved",
        via: "select",
      })}\n`,
      "utf-8",
    );
  }
  return root;
}

function createPi() {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => unknown>
  >();
  const sent: Array<{ customType: string; content: string }> = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, options);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    sendMessage(message: { customType: string; content: string }) {
      sent.push(message);
    },
    appendEntry() {},
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };
  return { pi, commands, handlers, sent, emitted };
}

function ctx(
  cwd: string,
  options: { hasUI?: boolean; select?: () => Promise<string | undefined> } = {},
) {
  return {
    cwd,
    hasUI: options.hasUI ?? false,
    sessionManager: { getSessionId: () => "s1" },
    ui: { select: options.select ?? (async () => undefined) },
  };
}

describe("parseImplementArgs", () => {
  it("reads the change id and an optional mode", () => {
    expect(parseImplementArgs("add-pi-openspec-x")).toEqual({
      changeId: "add-pi-openspec-x",
    });
    expect(parseImplementArgs("--agent add-pi-openspec-x")).toEqual({
      changeId: "add-pi-openspec-x",
      mode: "agent",
    });
    expect(parseImplementArgs("add-pi-openspec-x direct")).toEqual({
      changeId: "add-pi-openspec-x",
      mode: "direct",
    });
  });

  it("rejects more than one change id", () => {
    expect(parseImplementArgs("a b").error).toContain("single change id");
  });
});

describe("flow registry", () => {
  it("refuses a second flow in the same session and guides resume/end", () => {
    expect(
      startImplementFlow("s1", {
        changeId: "change-a",
        mode: "agent",
        phase: "starting",
      }),
    ).toEqual({ ok: true });
    const second = startImplementFlow("s1", {
      changeId: "change-b",
      mode: "direct",
      phase: "starting",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain("change-a");
    expect(second.reason).toMatch(/Resume it or end it/);
    expect(activeImplementFlow("s1")?.changeId).toBe("change-a");

    endImplementFlow("s1");
    expect(activeImplementFlow("s1")).toBeUndefined();
    expect(
      startImplementFlow("s1", {
        changeId: "change-b",
        mode: "direct",
        phase: "starting",
      }).ok,
    ).toBe(true);
  });
});

describe("selectImplementationMode", () => {
  it("returns undefined without a UI or when dismissed", async () => {
    expect(await selectImplementationMode(ctx("/p") as never)).toBeUndefined();
    expect(
      await selectImplementationMode(
        ctx("/p", { hasUI: true, select: async () => undefined }) as never,
      ),
    ).toBeUndefined();
  });

  it("maps the selector labels to a mode", async () => {
    expect(
      await selectImplementationMode(
        ctx("/p", {
          hasUI: true,
          select: async () =>
            "Agent implementation (opsx-agent role, opsx-worker dispatches)",
        }) as never,
      ),
    ).toBe("agent");
    expect(
      await selectImplementationMode(
        ctx("/p", {
          hasUI: true,
          select: async () =>
            "Direct main-session implementation (no role switch)",
        }) as never,
      ),
    ).toBe("direct");
  });
});

describe("renderImplementStart", () => {
  const tasksMarkdown =
    "# Tasks\n\n- [ ] 1.1 First task; 验证：the test passes\n";

  function assembly(mode: "agent" | "direct") {
    const result = assembleOpsxObjective({
      changeId: "change-a",
      tasksMarkdown,
      boundaries: boundariesForMode(mode, ["openspec/**", "dist/**"]),
    });
    if (!result.ok) throw new Error("assembly must succeed");
    return result;
  }

  it("embeds the create_goal and set_goal_tasks payloads", () => {
    const text = renderImplementStart(assembly("agent"), "agent");
    expect(text).toContain("[OPSX IMPLEMENT START change=change-a mode=agent]");
    expect(text).toContain('"mode": "sisyphus"');
    expect(text).toContain('"tasks": [');
    expect(text).toContain("opsx-worker");
    expect(text).toContain("completion audit");
  });

  it("uses a regular goal and no worker dispatch in direct mode", () => {
    const text = renderImplementStart(assembly("direct"), "direct");
    expect(text).toContain('"mode": "regular"');
    expect(text).toContain("Direct mode");
    expect(text).not.toContain("Dispatch opsx-worker");
  });
});

describe("registerImplementFlow command", () => {
  it("starts the direct flow without entering a restricted mode", async () => {
    const project = makeProject();
    const { pi, commands, sent } = createPi();
    let entered = 0;
    registerImplementFlow(pi as never, {
      enterMode: async () => {
        entered += 1;
      },
    });

    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    expect(entered).toBe(0);
    expect(sent.at(-1)?.customType).toBe(IMPLEMENT_START_CUSTOM_TYPE);
    expect(sent.at(-1)?.content).toContain('"mode": "regular"');
    expect(activeImplementFlow("s1")?.mode).toBe("direct");
  });

  it("refuses to start until the plan is approved", async () => {
    const project = makeProject("change-a", { approved: false });
    const { pi, commands, sent } = createPi();
    registerImplementFlow(pi as never, { enterMode: async () => {} });

    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    expect(sent.at(-1)?.customType).toBe(IMPLEMENT_NOTICE_CUSTOM_TYPE);
    expect(sent.at(-1)?.content).toContain("is not approved yet");
    expect(activeImplementFlow("s1")).toBeUndefined();
  });

  it("treats a revise decision as locked", async () => {
    const project = makeProject("change-a", { approved: false });
    const changeDir = path.join(project, "openspec", "changes", "change-a");
    fs.writeFileSync(
      path.join(changeDir, ".opsx-plan-review.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        type: "plan_approval",
        decision: "revise",
        via: "select",
      })}\n`,
      "utf-8",
    );
    const { pi, commands, sent } = createPi();
    registerImplementFlow(pi as never, { enterMode: async () => {} });

    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    expect(sent.at(-1)?.content).toContain("is not approved yet");
    expect(activeImplementFlow("s1")).toBeUndefined();
  });

  it("refuses the command when pi-goal-x is missing and starts nothing (spec R15)", async () => {
    // Restore the unprobed state: the fail-closed gate must then refuse the
    // command before the mode dialog or any start instruction.
    resetDependencyStateForTests();
    const project = makeProject();
    const { pi, commands, sent } = createPi();
    registerImplementFlow(pi as never, { enterMode: async () => {} });

    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    expect(sent.at(-1)?.customType).toBe(IMPLEMENT_NOTICE_CUSTOM_TYPE);
    expect(sent.at(-1)?.content).toContain("@xzzpig/pi-goal-x");
    expect(sent.at(-1)?.content).toContain("/opsx:implement is refused");
    expect(sent.at(-1)?.content).toContain("/opsx:plan are unaffected");
    // Nothing started: no flow registered, no create_goal instruction.
    expect(activeImplementFlow("s1")).toBeUndefined();
    expect(
      sent.some(
        (message) => message.customType === IMPLEMENT_START_CUSTOM_TYPE,
      ),
    ).toBe(false);
  });

  it("enters the agent restricted mode before starting", async () => {
    const project = makeProject();
    const { pi, commands, sent } = createPi();
    let entered = 0;
    registerImplementFlow(pi as never, {
      enterMode: async () => {
        entered += 1;
      },
    });

    await commands
      .get("opsx:implement")!
      .handler("--agent change-a", ctx(project) as never);
    expect(entered).toBe(1);
    expect(sent.at(-1)?.content).toContain('"mode": "sisyphus"');
  });

  it("does nothing when no mode is selected", async () => {
    const project = makeProject();
    const { pi, commands, sent } = createPi();
    registerImplementFlow(pi as never, { enterMode: async () => {} });

    await commands
      .get("opsx:implement")!
      .handler("change-a", ctx(project) as never);
    expect(sent.at(-1)?.customType).toBe(IMPLEMENT_NOTICE_CUSTOM_TYPE);
    expect(sent.at(-1)?.content).toContain(
      "No implementation mode was selected",
    );
    expect(activeImplementFlow("s1")).toBeUndefined();
  });

  it("refuses a second flow and reports a missing tasks.md", async () => {
    const project = makeProject();
    const { pi, commands, sent } = createPi();
    registerImplementFlow(pi as never, { enterMode: async () => {} });
    const command = commands.get("opsx:implement")!;

    await command.handler("--direct change-a", ctx(project) as never);
    await command.handler("--direct change-a", ctx(project) as never);
    expect(sent.at(-1)?.content).toContain("already active");

    // A different session with no tasks.md gets the /opsx:plan guidance.
    const emptyRoot = makeProject("change-b");
    fs.rmSync(
      path.join(emptyRoot, "openspec", "changes", "change-b", "tasks.md"),
    );
    await command.handler("--direct change-b", {
      ...ctx(emptyRoot),
      sessionManager: { getSessionId: () => "s2" },
    } as never);
    expect(sent.at(-1)?.content).toContain("/opsx:plan");
  });

  it("publishes implement_started and the reviewing phase change", async () => {
    const project = makeProject();
    const { pi, commands, handlers, emitted } = createPi();
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => [
        {
          id: "goal-1",
          status: "active",
          objective: 'Implement the OpenSpec change "change-a".',
        },
      ],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    expect(emitted[0]?.channel).toBe("pi-openspec-x:lifecycle:v1");
    expect(emitted[0]?.data).toMatchObject({
      type: "implement_started",
      change: "change-a",
      mode: "direct",
    });

    await handlers.get("turn_end")![0]!({}, ctx(project) as never);
    expect(emitted.at(-1)?.data).toMatchObject({
      type: "phase_changed",
      phase: "reviewing",
      mode: "direct",
    });
  });

  it("refuses to start when the restricted mode entry fails", async () => {
    const project = makeProject();
    const { pi, commands, sent } = createPi();
    registerImplementFlow(pi as never, {
      enterMode: async () => {
        throw new Error("pi-sandbox is unavailable");
      },
    });
    await commands
      .get("opsx:implement")!
      .handler("--agent change-a", ctx(project) as never);
    expect(sent.at(-1)?.content).toContain("Cannot enter the opsx-agent");
    expect(activeImplementFlow("s1")).toBeUndefined();
  });

  it("asks for a change id", async () => {
    const { pi, commands, sent } = createPi();
    registerImplementFlow(pi as never, { enterMode: async () => {} });
    await commands.get("opsx:implement")!.handler("   ", ctx("/p") as never);
    expect(sent.at(-1)?.content).toContain("Usage: /opsx:implement");
  });

  it("installs the final-audit override once the goal appears", async () => {
    const project = makeProject();
    const { pi, commands, handlers, sent } = createPi();
    const installed: string[] = [];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: (goalId) => {
        installed.push(goalId);
      },
      readGoals: async () => [
        {
          id: "goal-1",
          status: "active",
          objective: 'Implement the OpenSpec change "change-a".',
        },
      ],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    sent.length = 0;

    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);
    expect(installed).toEqual(["goal-1"]);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");
    expect(sent.at(-1)?.content).toContain("opsx-reviewer");

    // Already installed: the handler is a no-op afterwards.
    sent.length = 0;
    await turnEnd({}, ctx(project) as never);
    expect(installed).toEqual(["goal-1"]);
    expect(sent).toEqual([]);
  });

  it("ends the flow once the goal is archived complete", async () => {
    const project = makeProject();
    const { pi, commands, handlers, emitted, sent } = createPi();
    let goals: Array<{ id: string; status: string; objective: string }> = [
      {
        id: "goal-1",
        status: "active",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ];
    let archived: Array<{ id: string; status: string }> = [];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => goals,
      readArchivedGoals: async () => archived,
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");

    goals = [];
    archived = [{ id: "goal-1", status: "complete" }];
    sent.length = 0;
    await turnEnd({}, ctx(project) as never);
    expect(activeImplementFlow("s1")).toBeUndefined();
    expect(
      emitted.some(
        (entry) => (entry.data as { type?: string })?.type === "flow_completed",
      ),
    ).toBe(true);
    // Archive guidance accompanies the completion (P1-1): the user is pointed
    // at the openspec archive step, which the plugin never runs for them.
    expect(sent.at(-1)?.content).toContain("OPSX FINAL AUDIT APPROVED");
    expect(sent.at(-1)?.content).toContain(`openspec archive "${"change-a"}"`);
  });

  it("reports a divergence instead of completion when a cleared goal was archived non-complete", async () => {
    // A manual /goal-clear archives the goal under its live status (paused):
    // the flow ends, but this is not a completion — it is the spec R14
    // divergence and must offer recovery/termination instead of a
    // flow_completed event.
    const project = makeProject();
    const { pi, commands, handlers, emitted, sent } = createPi();
    let goals: Array<{ id: string; status: string; objective: string }> = [
      {
        id: "goal-1",
        status: "active",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => goals,
      readArchivedGoals: async () => [{ id: "goal-1", status: "paused" }],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");

    goals = [];
    sent.length = 0;
    emitted.length = 0;
    await turnEnd({}, ctx(project) as never);
    expect(activeImplementFlow("s1")).toBeUndefined();
    // No completion is claimed for a cleared goal.
    expect(
      emitted.some(
        (entry) => (entry.data as { type?: string })?.type === "flow_completed",
      ),
    ).toBe(false);
    const divergence = sent.find((message) =>
      message.content.includes("OPSX FLOW DIVERGENCE"),
    );
    expect(divergence?.content).toContain("goal_cleared");
    expect(divergence?.content).toContain("Recreate the goal");
    expect(divergence?.content).toContain("Terminate the flow");
    expect(
      sent.some(
        (message) =>
          message.content.includes("task-completed") ||
          message.content.includes("openspec archive"),
      ),
    ).toBe(false);
  });

  it("keeps the flow when the active read is empty but the goal is not archived", async () => {
    const project = makeProject();
    const { pi, commands, handlers } = createPi();
    let goals: Array<{ id: string; status: string; objective: string }> = [
      {
        id: "goal-1",
        status: "active",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => goals,
      readArchivedGoals: async () => [],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);

    // A transient empty active read must not tear down a live flow.
    goals = [];
    await turnEnd({}, ctx(project) as never);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");
  });

  it("installs the override on the create_goal result, before the same-turn completion", async () => {
    const project = makeProject();
    const { pi, commands, handlers } = createPi();
    const installed: string[] = [];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: (goalId) => installed.push(goalId),
      readGoals: async () => [
        {
          id: "goal-1",
          status: "active",
          objective: 'Implement the OpenSpec change "change-a".',
        },
      ],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);

    const onToolResult = handlers.get("tool_result")![0]!;
    // Unrelated tools are ignored.
    await onToolResult({ toolName: "read" }, ctx(project) as never);
    expect(installed).toEqual([]);

    await onToolResult({ toolName: "create_goal" }, ctx(project) as never);
    expect(installed).toEqual(["goal-1"]);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");
  });

  it("reports an install failure without dropping the flow", async () => {
    const project = makeProject();
    const { pi, commands, handlers, sent } = createPi();
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {
        throw new Error("goal-x rejected the override");
      },
      readGoals: async () => [
        {
          id: "goal-1",
          status: "active",
          objective: 'Implement the OpenSpec change "change-a".',
        },
      ],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    await handlers.get("turn_end")![0]!({}, ctx(project) as never);
    expect(sent.at(-1)?.content).toContain(
      "Could not point the completion audit",
    );
    expect(activeImplementFlow("s1")?.goalId).toBeUndefined();
  });
});

describe("implement lifecycle observers (tasks 9.3/9.4)", () => {
  const LIFECYCLE = "pi-openspec-x:lifecycle:v1";
  const NOTIFY = "pi-notify:publish";
  const SILENT = "pi-notify:ui_span_silent";

  function startedFlow(pi: unknown) {
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      readGoals: async () => [],
    });
    startImplementFlow("s1", {
      changeId: "change-a",
      mode: "agent",
      phase: "implementing",
    });
  }

  function lastToolResult(handlers: Map<string, unknown[]>) {
    return (
      handlers.get("tool_result") as Array<(...a: never[]) => unknown>
    ).at(-1)!;
  }

  it("publishes task_dispatched for an opsx-worker dispatch", async () => {
    const { pi, handlers, emitted } = createPi();
    startedFlow(pi);
    await lastToolResult(handlers)(
      {
        toolName: "subagent",
        input: {
          agent: "opsx-worker",
          prompt: "[OPSX WORKER DISPATCH task=1.2]\n## Task\n1.2: x",
        },
      } as never,
      ctx("/tmp") as never,
    );
    expect(emitted.at(-1)?.channel).toBe(LIFECYCLE);
    expect(emitted.at(-1)?.data).toMatchObject({
      type: "task_dispatched",
      change: "change-a",
      mode: "agent",
      taskId: "1.2",
    });
  });

  it("ignores a dispatch of a non-worker agent", async () => {
    const { pi, handlers, emitted } = createPi();
    startedFlow(pi);
    await lastToolResult(handlers)(
      {
        toolName: "subagent",
        input: { agent: "opsx-gap-analysis", prompt: "x" },
      } as never,
      ctx("/tmp") as never,
    );
    expect(emitted).toEqual([]);
  });

  it("publishes task_completed for a completed goal task", async () => {
    const { pi, handlers, emitted } = createPi();
    startedFlow(pi);
    await lastToolResult(handlers)(
      {
        toolName: "update_goal_task",
        input: { task_id: "1.2", status: "complete" },
        isError: false,
      } as never,
      ctx("/tmp") as never,
    );
    expect(emitted.at(-1)?.data).toMatchObject({
      type: "task_completed",
      taskId: "1.2",
    });
  });

  it("ignores a failed or non-completing goal-task update", async () => {
    const { pi, handlers, emitted } = createPi();
    startedFlow(pi);
    const handler = lastToolResult(handlers);
    await handler(
      {
        toolName: "update_goal_task",
        input: { task_id: "1.2", status: "complete" },
        isError: true,
      } as never,
      ctx("/tmp") as never,
    );
    await handler(
      {
        toolName: "update_goal_task",
        input: { task_id: "1.2", status: "start" },
        isError: false,
      } as never,
      ctx("/tmp") as never,
    );
    expect(emitted).toEqual([]);
  });

  it("publishes final_verdict approved or disapproved from the completion audit", async () => {
    const { pi, handlers, emitted } = createPi();
    startedFlow(pi);
    const handler = lastToolResult(handlers);
    await handler(
      {
        toolName: "update_goal",
        input: { status: "complete" },
        isError: false,
      } as never,
      ctx("/tmp") as never,
    );
    expect(emitted.at(-1)?.data).toMatchObject({
      type: "final_verdict",
      verdict: "approved",
    });
    await handler(
      {
        toolName: "update_goal",
        input: { status: "complete" },
        isError: true,
      } as never,
      ctx("/tmp") as never,
    );
    expect(emitted.at(-1)?.data).toMatchObject({
      type: "final_verdict",
      verdict: "disapproved",
    });
  });

  it("emits nothing without an active flow", async () => {
    const { pi, handlers, emitted } = createPi();
    registerImplementFlow(pi as never, { enterMode: async () => {} });
    await lastToolResult(handlers)(
      {
        toolName: "update_goal",
        input: { status: "complete" },
        isError: false,
      } as never,
      ctx("/tmp") as never,
    );
    expect(emitted).toEqual([]);
  });

  it("claims a silent UI span before the mode dialog", async () => {
    const { pi, emitted } = createPi();
    const mode = await selectImplementationMode(
      ctx("/tmp", {
        hasUI: true,
        select: async () =>
          "Direct main-session implementation (no role switch)",
      }) as never,
      pi.events as never,
    );
    expect(mode).toBe("direct");
    expect(emitted[0]?.channel).toBe(SILENT);
  });

  it("publishes mode_exited, flow_completed and a task-completed notification when the goal is archived", async () => {
    const { pi, commands, handlers, emitted } = createPi();
    const project = makeProject();
    let goals = [
      {
        id: "goal-1",
        status: "active",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => goals,
      readArchivedGoals: async () => [{ id: "goal-1", status: "complete" }],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");

    goals = [];
    emitted.length = 0;
    await turnEnd({}, ctx(project) as never);

    expect(
      emitted
        .filter((entry) => entry.channel === LIFECYCLE)
        .map((entry) => (entry.data as { type: string }).type),
    ).toEqual(["mode_exited", "flow_completed"]);
    expect(
      emitted.some(
        (entry) =>
          entry.channel === NOTIFY &&
          (entry.data as { eventId: string }).eventId === "task-completed",
      ),
    ).toBe(true);
    expect(activeImplementFlow("s1")).toBeUndefined();
  });

  it("publishes an integration-error notification when the objective cannot be assembled", async () => {
    const { pi, commands, emitted } = createPi();
    const project = makeProject();
    fs.rmSync(
      path.join(project, "openspec", "changes", "change-a", "tasks.md"),
    );
    registerImplementFlow(pi as never, { enterMode: async () => {} });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    expect(
      emitted.some(
        (entry) =>
          entry.channel === NOTIFY &&
          (entry.data as { eventId: string }).eventId === "integration-error",
      ),
    ).toBe(true);
  });
});

describe("tasks.md reconciliation after a tick (task 6.3)", () => {
  const opsxGoal = {
    id: "goal-1",
    status: "active",
    objective: 'Implement the OpenSpec change "change-a".',
  };

  function tickEvent() {
    return {
      toolName: "update_goal_task",
      input: { task_id: "1.1", status: "complete" },
      isError: false,
    } as never;
  }

  async function startedFlow(
    pi: unknown,
    commands: Map<
      string,
      { handler: (a: string, c: unknown) => Promise<void> }
    >,
    handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>,
    readGoalTasks: (
      ctx: unknown,
      goalId: string,
    ) => Promise<GoalTaskLike[] | undefined>,
    project: string,
  ) {
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => [opsxGoal],
      readGoalTasks,
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    // The goal id is only known after the base poll installs the auditor.
    await handlers.get("turn_end")![0]!({}, ctx(project) as never);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");
  }

  function lastToolResult(
    handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>,
  ) {
    return handlers.get("tool_result")!.at(-1)!;
  }

  it("stays silent when the goal tree matches tasks.md", async () => {
    const { pi, commands, handlers, sent } = createPi();
    const project = makeProject();
    await startedFlow(
      pi,
      commands,
      handlers,
      async () => [
        { id: "1.1", title: "First task", status: "pending" },
        { id: "1.2", title: "Second task", status: "pending" },
      ],
      project,
    );
    sent.length = 0;
    await lastToolResult(handlers)(tickEvent(), ctx(project) as never);
    expect(sent.filter((m) => m.content.includes("OPSX TASK SYNC"))).toEqual(
      [],
    );
  });

  it("re-mirrors from tasks.md with a warning when the tree diverged, at most once per flow", async () => {
    const { pi, commands, handlers, sent } = createPi();
    const project = makeProject();
    await startedFlow(
      pi,
      commands,
      handlers,
      // A dashboard-only task exists in the goal tree only; tasks.md wins.
      async () => [
        { id: "1.1", title: "First task", status: "pending" },
        { id: "1.2", title: "Second task", status: "pending" },
        { id: "9.9", title: "Dashboard-only task", status: "pending" },
      ],
      project,
    );

    await lastToolResult(handlers)(tickEvent(), ctx(project) as never);
    const notices = sent.filter((m) => m.content.includes("OPSX TASK SYNC"));
    expect(notices).toHaveLength(1);
    const notice = notices[0]!.content;
    expect(notice).toContain("tasks.md is authoritative");
    expect(notice).toContain("set_goal_tasks");
    // The mirror carries the tasks.md tasks (with the verification contract),
    // not the goal-only id.
    expect(notice).toContain('"verification_contract": "the test passes"');
    expect(notice).not.toContain('"9.9"');
    expect(notice).toContain("9.9");

    // Idempotent: the divergence is reported once per flow, not on every tick.
    sent.length = 0;
    await lastToolResult(handlers)(
      {
        toolName: "update_goal_task",
        input: { task_id: "1.2", status: "complete" },
        isError: false,
      } as never,
      ctx(project) as never,
    );
    expect(sent.filter((m) => m.content.includes("OPSX TASK SYNC"))).toEqual(
      [],
    );
  });

  it("skips the check when the goal tree cannot be read", async () => {
    const { pi, commands, handlers, sent } = createPi();
    const project = makeProject();
    await startedFlow(pi, commands, handlers, async () => undefined, project);
    sent.length = 0;
    await lastToolResult(handlers)(tickEvent(), ctx(project) as never);
    expect(sent.filter((m) => m.content.includes("OPSX TASK SYNC"))).toEqual(
      [],
    );
  });
});

describe("implement flow divergence detection (task 6.4)", () => {
  function setup(project: string, pi: unknown) {
    let goals = [
      {
        id: "goal-1",
        status: "active",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ];
    let archived: Array<{ id: string; status: string }> = [];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => goals,
      readArchivedGoals: async () => archived,
    });
    return {
      setGoals(next: typeof goals) {
        goals = next;
      },
      setArchived(next: Array<{ id: string; status: string }>) {
        archived = next;
      },
      async start(
        commands: Map<
          string,
          { handler: (a: string, c: unknown) => Promise<void> }
        >,
      ) {
        await commands
          .get("opsx:implement")!
          .handler("--direct change-a", ctx(project) as never);
      },
    };
  }

  it("reports goal_paused once and never repairs the flow automatically", async () => {
    const { pi, commands, handlers, sent } = createPi();
    const project = makeProject();
    const control = setup(project, pi);
    await control.start(commands);
    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");

    control.setGoals([
      {
        id: "goal-1",
        status: "paused",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ]);
    sent.length = 0;
    await turnEnd({}, ctx(project) as never);
    await turnEnd({}, ctx(project) as never);

    const notices = sent.filter((m) =>
      m.content.includes("OPSX FLOW DIVERGENCE"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain("goal_paused");
    expect(notices[0]!.content).toContain("/goal-resume");
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");
  });

  it("reports goal_cleared when the goal vanished without being archived", async () => {
    const { pi, commands, handlers, sent } = createPi();
    const project = makeProject();
    const control = setup(project, pi);
    await control.start(commands);
    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);

    control.setGoals([]);
    control.setArchived([]);
    sent.length = 0;
    // One missing poll is treated as a degraded read, not a cleared goal.
    await turnEnd({}, ctx(project) as never);
    expect(sent.some((m) => m.content.includes("OPSX FLOW DIVERGENCE"))).toBe(
      false,
    );
    await turnEnd({}, ctx(project) as never);

    const notice = sent.find((m) => m.content.includes("OPSX FLOW DIVERGENCE"));
    expect(notice?.content).toContain("goal_cleared");
    // Not archived, so the flow survives for a repair round.
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");
  });
});

describe("enforced tick gate wiring (task 8.2)", () => {
  const TICK = {
    toolName: "update_goal_task",
    input: { task_id: "1.1", status: "complete" },
  };

  async function setupAgent(
    pi: unknown,
    commands: Map<
      string,
      { handler: (a: string, c: unknown) => Promise<void> }
    >,
    project: string,
  ) {
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => [],
      readWindowDelta: async () => ["src/a.ts"],
    });
    await commands
      .get("opsx:implement")!
      .handler("--agent change-a", ctx(project) as never);
  }

  it("blocks an agent tick with no dispatch, then with no review, then allows it", async () => {
    const { pi, commands, handlers } = createPi();
    const project = makeProject();
    await setupAgent(pi, commands, project);
    const toolCall = handlers.get("tool_call")![0]!;
    const toolResult = handlers.get("tool_result")!.at(-1)!;

    const noDispatch = (await toolCall(TICK, ctx(project) as never)) as {
      block?: boolean;
      reason?: string;
    };
    expect(noDispatch.block).toBe(true);
    expect(noDispatch.reason).toContain("no observed opsx-worker dispatch");

    await toolResult(
      {
        toolName: "subagent",
        input: {
          agent: "opsx-worker",
          prompt: "[OPSX WORKER DISPATCH task=1.1]\n## Task\n1.1: x",
        },
      } as never,
      ctx(project) as never,
    );
    const noReview = (await toolCall(TICK, ctx(project) as never)) as {
      block?: boolean;
      reason?: string;
    };
    expect(noReview.block).toBe(true);
    expect(noReview.reason).toContain("has not been reviewed");

    await toolResult(
      {
        toolName: "report_work",
        input: {
          taskId: "1.1",
          changedFiles: ["src/a.ts"],
          claims: "did it",
          selfVerification: { command: "npm test", result: "12 passed" },
        },
      } as never,
      ctx(project) as never,
    );
    expect(await toolCall(TICK, ctx(project) as never)).toEqual({});
  });

  it("holds a reviewed tick when the window delta has unclaimed files", async () => {
    const { pi, commands, handlers } = createPi();
    const project = makeProject();
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => [
        {
          id: "goal-1",
          status: "active",
          objective: 'Implement the OpenSpec change "change-a".',
        },
      ],
      readWindowDelta: async () => ["src/a.ts", "src/sneaky.ts"],
    });
    await commands
      .get("opsx:implement")!
      .handler("--agent change-a", ctx(project) as never);
    // The window delta is only read once the flow knows its goal.
    await handlers.get("turn_end")![0]!({}, ctx(project) as never);
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");
    const toolCall = handlers.get("tool_call")![0]!;
    const toolResult = handlers.get("tool_result")!.at(-1)!;

    await toolResult(
      {
        toolName: "subagent",
        input: {
          agent: "opsx-worker",
          prompt: "[OPSX WORKER DISPATCH task=1.1]",
        },
      } as never,
      ctx(project) as never,
    );
    await toolResult(
      {
        toolName: "report_work",
        input: {
          taskId: "1.1",
          changedFiles: ["src/a.ts"],
          claims: "did it",
          selfVerification: { command: "npm test", result: "ok" },
        },
      } as never,
      ctx(project) as never,
    );

    // An omitted file is a warning, not a block: the delta also carries
    // tool-runtime noise that no report can declare.
    expect(await toolCall(TICK, ctx(project) as never)).toEqual({});
  });

  it("reads the task id from a structured subagent payload", async () => {
    const { pi, commands, handlers } = createPi();
    const project = makeProject();
    await setupAgent(pi, commands, project);
    const toolCall = handlers.get("tool_call")![0]!;
    const toolResult = handlers.get("tool_result")!.at(-1)!;

    // pi-subagents accepts `args.sections` instead of a `prompt` string; the
    // dispatch must still be recognised or the gate deadlocks.
    await toolResult(
      {
        toolName: "subagent",
        input: {
          agent: "opsx-worker",
          args: {
            sections: [
              { name: "Task", content: "Task 1.1: Ensure src/a.ts exports a" },
            ],
          },
        },
      } as never,
      ctx(project) as never,
    );
    await toolResult(
      {
        toolName: "report_work",
        input: {
          taskId: "1.1",
          changedFiles: ["src/a.ts"],
          claims: "did it",
          selfVerification: { command: "npm test", result: "ok" },
        },
      } as never,
      ctx(project) as never,
    );
    expect(await toolCall(TICK, ctx(project) as never)).toEqual({});
  });

  it("still counts a dispatch whose payload never names the task", async () => {
    const { pi, commands, handlers } = createPi();
    const project = makeProject();
    await setupAgent(pi, commands, project);
    const toolCall = handlers.get("tool_call")![0]!;
    const toolResult = handlers.get("tool_result")!.at(-1)!;

    await toolResult(
      {
        toolName: "subagent",
        input: { agent: "opsx-worker", task: "go" },
      } as never,
      ctx(project) as never,
    );
    await toolResult(
      {
        toolName: "report_work",
        input: {
          taskId: "1.1",
          changedFiles: ["src/a.ts"],
          claims: "did it",
          selfVerification: { command: "npm test", result: "ok" },
        },
      } as never,
      ctx(project) as never,
    );
    expect(await toolCall(TICK, ctx(project) as never)).toEqual({});
  });

  it("does not gate direct mode", async () => {
    const { pi, commands, handlers } = createPi();
    const project = makeProject();
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => [],
    });
    await commands
      .get("opsx:implement")!
      .handler("--direct change-a", ctx(project) as never);
    const toolCall = handlers.get("tool_call")![0]!;
    expect(await toolCall(TICK, ctx(project) as never)).toEqual({});
  });

  it("warns once when a task is dispatched repeatedly without progress", async () => {
    const { pi, commands, handlers, sent } = createPi();
    const project = makeProject();
    let goals = [
      {
        id: "goal-1",
        status: "active",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ];
    registerImplementFlow(pi as never, {
      enterMode: async () => {},
      installAuditor: () => {},
      readGoals: async () => goals,
    });
    await commands
      .get("opsx:implement")!
      .handler("--agent change-a", ctx(project) as never);
    const turnEnd = handlers.get("turn_end")![0]!;
    await turnEnd({}, ctx(project) as never);
    goals = [
      {
        id: "goal-1",
        status: "active",
        objective: 'Implement the OpenSpec change "change-a".',
      },
    ];
    expect(activeImplementFlow("s1")?.goalId).toBe("goal-1");

    const toolResult = handlers.get("tool_result")!.at(-1)!;
    for (let index = 0; index < 2; index += 1) {
      await toolResult(
        {
          toolName: "subagent",
          input: {
            agent: "opsx-worker",
            prompt: "[OPSX WORKER DISPATCH task=1.1]",
          },
        } as never,
        ctx(project) as never,
      );
    }
    sent.length = 0;
    await turnEnd({}, ctx(project) as never);
    await turnEnd({}, ctx(project) as never);
    const stalls = sent.filter((m) => m.content.includes("[OPSX STALLED]"));
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.content).toContain("1.1");
  });
});
