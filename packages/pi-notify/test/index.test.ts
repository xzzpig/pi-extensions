import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PI_NOTIFY_PUBLISH_EVENT } from "../api.js";
import piNotify from "../extensions/index.js";

type LifecycleHandler = (event: unknown, context?: unknown) => unknown;
type EventHandler = (event: unknown) => unknown;

interface Runtime {
  dispatch(channel: string, event: unknown): void;
  emitted: Array<{ channel: string; data: unknown }>;
  notify: ReturnType<typeof vi.fn>;
  shutdown(): Promise<void>;
  start(options?: StartOptions): Promise<void>;
}

interface StartOptions {
  mode?: string;
  cwd?: string;
  sessionName?: string;
  trusted?: boolean;
}

const tempDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-notify-it-"));
  tempDirectories.push(directory);
  return directory;
}

function writeGlobalConfig(agentDir: string, config: unknown): void {
  const path = join(agentDir, "extensions", "pi-notify", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config), "utf8");
}

function writeProjectConfig(cwd: string, config: unknown): void {
  const path = join(cwd, ".pi", "pi-notify.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config), "utf8");
}

function createRuntime(): Runtime {
  const lifecycleHandlers = new Map<string, LifecycleHandler>();
  const eventHandlers = new Map<string, EventHandler[]>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const notify = vi.fn();
  let sessionName: string | undefined;
  let sessionContext: Record<string, unknown> | undefined;

  const events = {
    emit: (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    },
    on: (channel: string, handler: EventHandler) => {
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
    },
  };

  piNotify({
    events,
    on: (channel: string, handler: LifecycleHandler) => {
      lifecycleHandlers.set(channel, handler);
    },
    getSessionName: () => sessionName,
  } as never);

  return {
    dispatch(channel, event) {
      for (const handler of eventHandlers.get(channel) ?? []) {
        handler(event);
      }
      const lifecycleHandler = lifecycleHandlers.get(channel);
      if (lifecycleHandler) {
        void lifecycleHandler(event, sessionContext);
      }
    },
    emitted,
    notify,
    async shutdown() {
      await lifecycleHandlers.get("session_shutdown")?.({});
    },
    async start({
      mode = "json",
      cwd = "/tmp/pi-notify-project",
      sessionName: name,
      trusted = false,
    } = {}) {
      sessionName = name;
      sessionContext = {
        mode,
        cwd,
        isProjectTrusted: () => trusted,
        ui: { notify },
      };
      await lifecycleHandlers.get("session_start")?.({}, sessionContext);
    },
  };
}

function blockedEvents(runtime: Runtime): unknown[] {
  return runtime.emitted
    .filter(({ channel }) => channel === "herdr:blocked")
    .map(({ data }) => data);
}

function writtenSequences(): string[] {
  const write = (process.stdout.write as ReturnType<typeof vi.fn>).mock;
  return write.calls.map((call) => call[0] as string);
}

function mockFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue({ ok: true, status: 200 } as never);
}

function mockStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

describe("pi-notify extension", () => {
  it("writes OSC 777 notifications in TUI mode for the default terminal channel", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui", cwd: "/home/dev/awesome-project" });

    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});

    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi needs your input;awesome-project\x1b\\",
      "\x1b]777;notify;Pi finished the task;awesome-project\x1b\\",
    ]);
    await runtime.shutdown();
  });

  it("classifies the final agent result and stays silent on abort", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    const write = mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    // No active run: settled produces nothing.
    runtime.dispatch("agent_settled", {});
    expect(write).not.toHaveBeenCalled();

    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi encountered an error;pi-notify-project\x1b\\",
    ]);

    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(write).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  it("does not write terminal sequences outside TUI mode", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    const write = mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "json" });
    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(write).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("preserves the Herdr blocked-state lifecycle", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    const runtime = createRuntime();
    await runtime.start();

    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });

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
      { active: true, label: "Choose deployment" },
      { active: false },
      { active: true, label: "Permission required by Worker" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("keeps Herdr independent of the notification switch", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      enabled: false,
      herdr: { enabled: true },
    });
    const runtime = createRuntime();
    await runtime.start();

    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Question",
    });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Question" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("stops publishing herdr:blocked when herdr.enabled is false", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, { herdr: { enabled: false } });
    const runtime = createRuntime();
    await runtime.start();

    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Question",
    });
    expect(blockedEvents(runtime)).toEqual([]);
    await runtime.shutdown();
  });

  it("routes to a ntfy channel with resolved priority and token", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        {
          id: "phone",
          type: "ntfy",
          events: ["agent-error", "permission-required"],
          ntfy: {
            topic: "my-topic",
            token: "tok123",
            eventOptions: { "agent-error": { priority: 5 } },
          },
        },
      ],
    });
    const fetchImpl = mockFetch();
    const runtime = createRuntime();
    await runtime.start({ mode: "json" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    runtime.dispatch("agent_settled", {});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe("https://ntfy.sh/my-topic");
    expect(init.headers).toMatchObject({
      Title: "Pi encountered an error",
      Priority: "5",
      Authorization: "Bearer tok123",
    });
    expect(init.body).toBe("pi-notify-project");
    await runtime.shutdown();
  });

  it("fans out per-channel subscriptions", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    writeGlobalConfig(agentDir, {
      channels: [
        { id: "terminal", type: "osc", events: ["agent-completed"] },
        {
          id: "phone",
          type: "ntfy",
          events: ["permission-required"],
          ntfy: { topic: "perm-topic" },
        },
      ],
    });
    const fetchImpl = mockFetch();
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(fetchImpl).not.toHaveBeenCalled();

    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: null,
      message: "Allow git status?",
      requestId: "direct-request",
      surface: "bash",
      value: "git status",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://ntfy.sh/perm-topic");
    await runtime.shutdown();
  });

  it("routes context-compacted only when a channel subscribes to it", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    writeGlobalConfig(agentDir, {
      channels: [
        {
          id: "terminal",
          type: "osc",
          events: ["agent-completed", "context-compacted"],
        },
      ],
    });
    const write = mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });
    runtime.dispatch("session_compact", { summary: "wrapped up" });
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi compacted the context;pi-notify-project\x1b\\",
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  it("routes valid publish payloads and ignores invalid ones", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        {
          id: "phone",
          type: "ntfy",
          events: ["input-required", "task-completed"],
          ntfy: { topic: "pub-topic" },
        },
      ],
    });
    const fetchImpl = mockFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createRuntime();
    await runtime.start({ mode: "json" });

    runtime.dispatch(PI_NOTIFY_PUBLISH_EVENT, {
      eventId: "task-completed",
      source: "my-plugin",
      label: "Deploy finished\nwith details",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(init.body).toBe("Deploy finished with details\npi-notify-project");

    runtime.dispatch(PI_NOTIFY_PUBLISH_EVENT, {
      eventId: "tool-failed",
      source: "my-plugin",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      warn.mock.calls.some(([text]) => String(text).includes("publish")),
    ).toBe(true);
    await runtime.shutdown();
  });

  it("maps pi-subagents completions to task and integration events", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        {
          id: "phone",
          type: "ntfy",
          events: ["task-completed", "integration-error"],
          ntfy: { topic: "sub-topic" },
        },
      ],
    });
    const fetchImpl = mockFetch();
    const runtime = createRuntime();
    await runtime.start();

    runtime.dispatch("subagent:async-complete", {
      status: "completed",
      agent: "reviewer",
    });
    runtime.dispatch("subagent:async-complete", {
      status: "failed",
      agent: "worker",
    });
    runtime.dispatch("subagent:async-complete", { status: "cancelled" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const titles = fetchImpl.mock.calls.map(
      ([, init]) => (init as { headers: Record<string, string> }).headers.Title,
    );
    expect(titles).toEqual([
      "Pi completed a task",
      "Pi encountered an integration error",
    ]);
    await runtime.shutdown();
  });

  it("applies the trusted project overlay and ignores it when untrusted", async () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        { id: "phone", type: "ntfy", ntfy: { topic: "global-topic" } },
      ],
    });
    writeProjectConfig(cwd, {
      channels: [{ id: "phone", ntfy: { topic: "project-topic" } }],
    });
    const fetchImpl = mockFetch();
    const runtime = createRuntime();

    await runtime.start({ cwd, trusted: false });
    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(fetchImpl.mock.calls[0][0]).toBe("https://ntfy.sh/global-topic");

    await runtime.shutdown();
    await runtime.start({ cwd, trusted: true });
    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(fetchImpl.mock.calls[1][0]).toBe("https://ntfy.sh/project-topic");
    await runtime.shutdown();
  });

  it("reports one failure warning and one recovery notice", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        { id: "phone", type: "ntfy", ntfy: { topic: "health-topic" } },
      ],
    });
    const failingFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 500 } as never)
      .mockResolvedValueOnce({ ok: false, status: 500 } as never)
      .mockResolvedValue({ ok: true, status: 200 } as never);
    void failingFetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    const settle = () => {
      runtime.dispatch("agent_start", {});
      runtime.dispatch("agent_end", {
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      runtime.dispatch("agent_settled", {});
    };

    settle();
    settle();
    await vi.waitFor(() => {
      expect(
        warn.mock.calls.filter(([text]) => String(text).includes("failed")),
      ).toHaveLength(1);
    });
    settle();
    await vi.waitFor(() => {
      expect(
        warn.mock.calls.some(([text]) => String(text).includes("recovered")),
      ).toBe(true);
    });
    await runtime.shutdown();
  });

  it("includes the session display name when set", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({
      mode: "tui",
      cwd: "/tmp/repo",
      sessionName: "release-2024",
    });
    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi finished the task;repo · release-2024\x1b\\",
    ]);
    await runtime.shutdown();
  });

  it("clears state on shutdown", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    const runtime = createRuntime();
    await runtime.start();
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Question",
    });
    await runtime.shutdown();
    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Question" },
      { active: false },
    ]);
  });

  it("reloads cleanly: a second session_start resets state and avoids duplicate delivery", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        { id: "phone", type: "ntfy", ntfy: { topic: "reload-topic" } },
      ],
    });
    const fetchImpl = mockFetch();
    const runtime = createRuntime();

    const settle = () => {
      runtime.dispatch("agent_start", {});
      runtime.dispatch("agent_end", {
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      runtime.dispatch("agent_settled", {});
    };

    await runtime.start({ mode: "json" });
    settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Simulate a /reload: second session_start after shutdown (no dupe state).
    await runtime.shutdown();
    await runtime.start({ mode: "json" });
    settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // State from the first run must not survive reload: a completed ask in
    // run 1 must not suppress a fresh ask's notification in run 2. The
    // channel uses the default subscription (includes input-required), so
    // each ask-start POSTs once: 2 settles + 2 asks = 4 total.
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "First run question",
    });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Second run question",
    });
    // A leaked dedupe state from run 1 would drop the second ask's POST.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await runtime.shutdown();
  });
});
