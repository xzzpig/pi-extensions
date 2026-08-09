import { afterEach, describe, expect, it, vi } from "vitest";

import piTerminalNotifications from "../extensions/index.js";

type LifecycleHandler = (event: unknown, context?: unknown) => unknown;
type EventHandler = (event: unknown) => unknown;

interface Runtime {
  dispatch(channel: string, event: unknown): void;
  emitted: Array<{ channel: string; data: unknown }>;
  shutdown(): Promise<void>;
  start(sessionId: string, mode?: string): Promise<void>;
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

function createRuntime(): Runtime {
  const lifecycleHandlers = new Map<string, LifecycleHandler>();
  const eventHandlers = new Map<string, EventHandler[]>();
  const emitted: Array<{ channel: string; data: unknown }> = [];

  const events = {
    emit: vi.fn((channel: string, data: unknown) => {
      emitted.push({ channel, data });
    }),
    on: vi.fn((channel: string, handler: EventHandler) => {
      const handlers = eventHandlers.get(channel) ?? [];
      handlers.push(handler);
      eventHandlers.set(channel, handlers);
      return () => {
        eventHandlers.set(
          channel,
          (eventHandlers.get(channel) ?? []).filter(
            (entry) => entry !== handler,
          ),
        );
      };
    }),
  };

  piTerminalNotifications({
    events,
    on: vi.fn((channel: string, handler: LifecycleHandler) => {
      lifecycleHandlers.set(channel, handler);
    }),
  } as never);

  return {
    dispatch(channel, event) {
      for (const handler of eventHandlers.get(channel) ?? []) {
        handler(event);
      }
    },
    emitted,
    async shutdown() {
      await lifecycleHandlers.get("session_shutdown")?.({});
    },
    async start(sessionId, mode = "json") {
      await lifecycleHandlers.get("session_start")?.(
        {},
        {
          mode,
          sessionManager: { getSessionId: () => sessionId },
        },
      );
    },
  };
}

function blockedEvents(runtime: Runtime): unknown[] {
  return runtime.emitted
    .filter(({ channel }) => channel === "herdr:blocked")
    .map(({ data }) => data);
}

describe("pi-terminal-notifications extension", () => {
  it("preserves pi-ask blocked-state lifecycle behavior", async () => {
    const runtime = createRuntime();
    await runtime.start("parent-session");

    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Choose deployment" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("clears a direct permission ask from the same session decision event", async () => {
    const runtime = createRuntime();
    await runtime.start("parent-session");

    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: null,
      message: "Allow git status?",
      requestId: "direct-request",
      surface: "bash",
      value: "git status",
    });
    runtime.dispatch("permissions:decision", {
      agentName: "Worker",
      resolution: "user_approved",
      surface: "bash",
      value: "git status",
    });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("clears a forwarded child permission ask from the parent decision event", async () => {
    const runtime = createRuntime();
    await runtime.start("parent-session");

    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      message: "Allow git status?",
      requestId: "forwarded-request",
      surface: "bash",
      value: "git status",
    });
    runtime.dispatch("permissions:forwarded_decision", {
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      requestId: "forwarded-request",
      responderSessionId: "parent-session",
      respondedAt: 1_700_000_000_000,
      resolution: "user_approved",
      result: "allow",
    });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required by Worker" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("keeps Herdr blocked across concurrent direct and forwarded permissions", async () => {
    const runtime = createRuntime();
    await runtime.start("parent-session");

    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: null,
      message: "Allow git status?",
      requestId: "direct-request",
      surface: "bash",
      value: "git status",
    });
    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      message: "Allow git push?",
      requestId: "forwarded-request",
      surface: "bash",
      value: "git push",
    });
    runtime.dispatch("permissions:decision", {
      agentName: "Worker",
      resolution: "user_approved",
      surface: "bash",
      value: "git status",
    });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required" },
      { active: true, label: "Permission required by Worker" },
    ]);

    runtime.dispatch("permissions:forwarded_decision", {
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      requestId: "forwarded-request",
      responderSessionId: "parent-session",
      respondedAt: 1_700_000_000_000,
      resolution: "user_approved",
      result: "allow",
    });
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required" },
      { active: true, label: "Permission required by Worker" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("keeps Herdr blocked until concurrent permission requests all resolve", async () => {
    const runtime = createRuntime();
    await runtime.start("parent-session");

    const prompt = (requestId: string) => ({
      agentName: "Worker",
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      message: "Allow git status?",
      requestId,
      surface: "bash",
      value: "git status",
    });
    const response = (requestId: string) => ({
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      requestId,
      responderSessionId: "parent-session",
      respondedAt: 1_700_000_000_000,
      resolution: "user_approved",
      result: "allow",
    });

    runtime.dispatch("permissions:ui_prompt", prompt("forwarded-a"));
    runtime.dispatch("permissions:ui_prompt", prompt("forwarded-b"));
    runtime.dispatch("permissions:forwarded_decision", response("forwarded-a"));
    runtime.dispatch("permissions:forwarded_decision", response("forwarded-a"));

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required by Worker" },
      { active: true, label: "Permission required by Worker" },
    ]);

    runtime.dispatch("permissions:forwarded_decision", response("forwarded-b"));
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required by Worker" },
      { active: true, label: "Permission required by Worker" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("deduplicates a repeated forwarded prompt by request id", async () => {
    const runtime = createRuntime();
    await runtime.start("parent-session");
    const prompt = {
      agentName: "Worker",
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      message: "Allow git status?",
      requestId: "forwarded-duplicate",
      surface: "bash",
      value: "git status",
    };

    runtime.dispatch("permissions:ui_prompt", prompt);
    runtime.dispatch("permissions:ui_prompt", prompt);
    runtime.dispatch("permissions:forwarded_decision", {
      forwarding: prompt.forwarding,
      requestId: prompt.requestId,
      responderSessionId: "parent-session",
      respondedAt: 1_700_000_000_000,
      resolution: "user_approved",
      result: "allow",
    });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required by Worker" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("clears state on shutdown and ignores a late forwarded decision", async () => {
    const runtime = createRuntime();
    await runtime.start("parent-session");
    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      message: "Allow git status?",
      requestId: "forwarded-shutdown",
      surface: "bash",
      value: "git status",
    });
    await runtime.shutdown();
    runtime.dispatch("permissions:forwarded_decision", {
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      requestId: "forwarded-shutdown",
      responderSessionId: "parent-session",
      respondedAt: 1_700_000_000_000,
      resolution: "user_approved",
      result: "allow",
    });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Permission required by Worker" },
      { active: false },
    ]);
  });

  it("does not write terminal control sequences outside TUI mode", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const runtime = createRuntime();
    await runtime.start("json-session", "json");
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-json",
      title: "Choose deployment",
    });
    expect(write).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("selects OSC 777 for WarpTerminal in TUI mode", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-terminal-notifications-test");
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const runtime = createRuntime();
    await runtime.start("tui-session", "tui");
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-tui",
      title: "Choose deployment",
    });

    expect(write).toHaveBeenCalledWith(
      "\u001b]777;notify;Pi ask;Pi ask is waiting for your response: Choose deployment\u001b\\",
    );
    await runtime.shutdown();
  });
});
