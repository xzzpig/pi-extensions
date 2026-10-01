/**
 * Wiring tests for `/opsx:plan` (task 7.1): the mode contract is appended via
 * sendMessage, each phase block is appended exactly once through the turn_end
 * BoundaryResult `entries` channel, and the degraded path still injects a
 * skeleton plus a notice. Nothing rewrites the system prompt or touches skills.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { OpenspecArtifactInstructions } from "../src/cli.ts";
import {
  PLAN_MODE_CONTRACT_CUSTOM_TYPE,
  PLAN_NOTICE_CUSTOM_TYPE,
  PLAN_PHASE_CUSTOM_TYPE,
  registerPlanFlow,
  resetPlanFlowStateForTests,
} from "../src/plan-command.ts";
import type { PlanStatus } from "../src/plan-flow.ts";

interface SentMessage {
  message: { customType: string; content: string };
  options?: { deliverAs?: string };
}

function createPlanPi() {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => unknown>
  >();
  const sent: SentMessage[] = [];
  const appended: Array<{ customType: string; data?: unknown }> = [];
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
    sendMessage(
      message: SentMessage["message"],
      options?: SentMessage["options"],
    ) {
      sent.push({ message, options });
    },
    appendEntry(customType: string, data?: unknown) {
      appended.push({ customType, data });
    },
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };
  return { pi, commands, handlers, sent, appended, emitted };
}

function makeCtx(sessionId = "s1") {
  return { cwd: "/p", sessionManager: { getSessionId: () => sessionId } };
}

const STATUS_READY: PlanStatus = {
  artifacts: [
    { id: "proposal", status: "done" },
    { id: "specs", status: "ready" },
  ],
};

const LIVE: OpenspecArtifactInstructions = {
  artifactId: "specs",
  changeName: "change-a",
  instruction: "Write the spec deltas.",
  resolvedOutputPath: "/p/openspec/changes/change-a/specs/cap/spec.md",
};

beforeEach(() => {
  resetPlanFlowStateForTests();
});

describe("registerPlanFlow", () => {
  it("enters planner mode and appends the mode contract, then one block per phase", async () => {
    const { pi, commands, handlers, sent } = createPlanPi();
    let entered = 0;
    registerPlanFlow(pi as never, {
      enterMode: async () => {
        entered += 1;
      },
      fetchStatus: () => STATUS_READY,
      fetchInstructions: () => LIVE,
    });

    const command = commands.get("opsx:plan");
    expect(command).toBeDefined();
    await command!.handler("change-a", makeCtx() as never);

    expect(entered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.customType).toBe(PLAN_MODE_CONTRACT_CUSTOM_TYPE);
    expect(sent[0]?.message.content).toContain("change-a");
    expect(sent[0]?.options?.deliverAs).toBe("steer");

    const turnEnd = handlers.get("turn_end")?.[0];
    expect(turnEnd).toBeDefined();
    const result = turnEnd!({}, makeCtx()) as {
      entries: Array<{ customType: string; content: string }>;
      continue: boolean;
    };
    expect(result.continue).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.customType).toBe(PLAN_PHASE_CUSTOM_TYPE);
    expect(result.entries[0]?.content).toContain("Write the spec deltas.");

    // The same phase is never injected twice.
    expect(turnEnd!({}, makeCtx())).toBeUndefined();
  });

  it("degrades to the built-in skeleton and notifies when the CLI answers nothing", async () => {
    const { pi, commands, handlers, sent } = createPlanPi();
    registerPlanFlow(pi as never, {
      enterMode: async () => {},
      fetchStatus: () => STATUS_READY,
      fetchInstructions: () => undefined,
    });
    await commands.get("opsx:plan")!.handler("change-a", makeCtx() as never);
    sent.length = 0;

    const result = handlers.get("turn_end")![0]!({}, makeCtx()) as {
      entries: Array<{ content: string }>;
    };
    expect(result.entries[0]?.content).toContain("built-in skeleton");
    expect(
      sent.some(
        (entry) => entry.message.customType === PLAN_NOTICE_CUSTOM_TYPE,
      ),
    ).toBe(true);
  });

  it("announces the review gate once every artifact is done", async () => {
    const { pi, commands, handlers, sent } = createPlanPi();
    registerPlanFlow(pi as never, {
      enterMode: async () => {},
      fetchStatus: () => ({
        artifacts: [{ id: "proposal", status: "done" }],
      }),
      fetchInstructions: () => LIVE,
    });
    await commands.get("opsx:plan")!.handler("change-a", makeCtx() as never);
    sent.length = 0;

    const turnEnd = handlers.get("turn_end")![0]!;
    expect(turnEnd({}, makeCtx())).toBeUndefined();
    expect(
      sent.filter(
        (entry) => entry.message.customType === PLAN_NOTICE_CUSTOM_TYPE,
      ),
    ).toHaveLength(1);
    expect(sent[0]?.message.content).toContain("opsx-plan-review");

    // Once only.
    turnEnd({}, makeCtx());
    expect(
      sent.filter(
        (entry) => entry.message.customType === PLAN_NOTICE_CUSTOM_TYPE,
      ),
    ).toHaveLength(1);
  });

  it("asks for a change id and refuses to enter mode when the sandbox refuses", async () => {
    const { pi, commands, sent } = createPlanPi();
    registerPlanFlow(pi as never, {
      enterMode: async () => {
        throw new Error("pi-sandbox is not available");
      },
      fetchStatus: () => STATUS_READY,
      fetchInstructions: () => LIVE,
    });
    const command = commands.get("opsx:plan")!;

    await command.handler("   ", makeCtx() as never);
    expect(sent.at(-1)?.message.content).toContain("Usage: /opsx:plan");

    await command.handler("change-a", makeCtx() as never);
    expect(sent.at(-1)?.message.content).toContain("Cannot enter plan mode");
    expect(sent.at(-1)?.message.content).toContain("pi-sandbox");
  });

  it("publishes the lifecycle events and appends flow entries", async () => {
    const { pi, commands, handlers, appended, emitted } = createPlanPi();
    registerPlanFlow(pi as never, {
      enterMode: async () => {},
      fetchStatus: () => STATUS_READY,
      fetchInstructions: () => LIVE,
    });
    await commands.get("opsx:plan")!.handler("change-a", makeCtx() as never);
    expect(
      appended.some((entry) => entry.customType.includes("mode-entered")),
    ).toBe(true);
    expect(emitted[0]?.channel).toBe("pi-openspec-x:lifecycle:v1");
    expect(emitted[0]?.data).toMatchObject({
      type: "plan_started",
      change: "change-a",
      mode: "plan",
    });

    await handlers.get("turn_end")![0]!({}, makeCtx());
    expect(
      appended.some((entry) => entry.customType.includes("phase-changed")),
    ).toBe(true);
    expect(emitted.at(-1)?.data).toMatchObject({
      type: "phase_changed",
      phase: "specs",
    });
  });

  it("does nothing on turn_end outside an active plan flow", () => {
    const { pi, handlers } = createPlanPi();
    registerPlanFlow(pi as never, {
      enterMode: async () => {},
      fetchStatus: () => STATUS_READY,
      fetchInstructions: () => LIVE,
    });
    expect(handlers.get("turn_end")![0]!({}, makeCtx("other"))).toBeUndefined();
  });
});
