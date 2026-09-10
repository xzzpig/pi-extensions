import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PI_NOTIFY_PUBLISH_EVENT,
  PI_NOTIFY_UI_SPAN_SILENT_EVENT,
} from "../api.js";
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

    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", {
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "custom",
    });
    runtime.dispatch("ui_prompt_end", {
      type: "ui_prompt_end",
      kind: "custom",
    });
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

  it("preserves the Herdr blocked-state lifecycle for dialog spans", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    const runtime = createRuntime();
    await runtime.start();

    // Labeled events alone never block Herdr: the ask registers context but
    // no dialog has opened yet.
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    expect(blockedEvents(runtime)).toEqual([]);

    // The dialog span blocks with the sanitized ask title; a defensive
    // duplicate start while a span is open is ignored.
    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Choose deployment" },
    ]);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Choose deployment" },
      { active: false },
    ]);

    // A forwarded permission prompt classifies with the requester label.
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
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Choose deployment" },
      { active: false },
      { active: true, label: "Permission required by Worker" },
    ]);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
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

    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Waiting for input" },
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

    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
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
    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://ntfy.sh/perm-topic");
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
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

  it("gates generic dialogs on agent activity", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    // User-initiated dialog while the agent is idle: silent.
    runtime.dispatch("ui_prompt_start", {
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "select",
      title: "Open settings",
    });
    runtime.dispatch("ui_prompt_end", {
      type: "ui_prompt_end",
      kind: "select",
    });
    expect(writtenSequences()).toEqual([]);
    expect(blockedEvents(runtime)).toEqual([]);

    // The same dialog during an agent run notifies and blocks Herdr.
    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", {
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "select",
      title: "Pick a branch",
    });
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi needs your input;pi-notify-project\x1b\\",
    ]);
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Pick a branch" },
    ]);
    runtime.dispatch("ui_prompt_end", {
      type: "ui_prompt_end",
      kind: "select",
    });
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Pick a branch" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("merges nested dialog spans into one notification", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    // A defensive duplicate start while a span is open: ignored.
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });

    expect(writtenSequences()).toHaveLength(1);
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Waiting for input" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("silences a marked dialog during an agent run and never leaks", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    runtime.dispatch("agent_start", {});
    // A monitoring dialog (e.g. the subagents fleet view) claims silence.
    runtime.dispatch(PI_NOTIFY_UI_SPAN_SILENT_EVENT, { reason: "fleet" });
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    expect(writtenSequences()).toEqual([]);
    expect(blockedEvents(runtime)).toEqual([]);

    // A real dialog after the silent span still notifies and blocks.
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi needs your input;pi-notify-project\x1b\\",
    ]);
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Waiting for input" },
    ]);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Waiting for input" },
      { active: false },
    ]);
    await runtime.shutdown();
  });

  it("consumes the silent marker for idle spans so it cannot leak", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    // A marker claimed, dialog opens while the agent is idle: the span is
    // silent anyway and still consumes the one-shot marker.
    runtime.dispatch(PI_NOTIFY_UI_SPAN_SILENT_EVENT, {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    expect(writtenSequences()).toEqual([]);

    // The next dialog, inside an agent run, is not affected.
    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi needs your input;pi-notify-project\x1b\\",
    ]);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    await runtime.shutdown();
  });

  it("lets a silent marker win over pending permission classification", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        {
          id: "phone",
          type: "ntfy",
          events: ["permission-required", "input-required"],
          ntfy: { topic: "perm-topic" },
        },
      ],
    });
    const fetchImpl = mockFetch();
    const runtime = createRuntime();
    await runtime.start({ mode: "json" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: null,
      message: "Allow git status?",
      requestId: "direct-request",
      surface: "bash",
      value: "git status",
    });
    // A marked monitoring dialog wins over the pending permission context.
    runtime.dispatch(PI_NOTIFY_UI_SPAN_SILENT_EVENT, { reason: "admin" });
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(blockedEvents(runtime)).toEqual([]);

    // The pending permission context is untouched: the permission dialog
    // that follows still produces exactly one permission-required.
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const titles = fetchImpl.mock.calls.map(
      ([, init]) => (init as { headers: Record<string, string> }).headers.Title,
    );
    expect(titles).toEqual(["Pi needs permission"]);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    await runtime.shutdown();
  });

  it("ignores invalid silent marker payloads", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch(PI_NOTIFY_UI_SPAN_SILENT_EVENT, { reason: 42 });
    runtime.dispatch(PI_NOTIFY_UI_SPAN_SILENT_EVENT, "nope");
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi needs your input;pi-notify-project\x1b\\",
    ]);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    await runtime.shutdown();
  });

  it("clears an unconsumed silent marker on session reset", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    // A marker is claimed but no dialog ever opens before the session resets.
    runtime.dispatch(PI_NOTIFY_UI_SPAN_SILENT_EVENT, { reason: "fleet" });
    await runtime.shutdown();
    await runtime.start({ mode: "tui" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(writtenSequences()).toEqual([
      "\x1b]777;notify;Pi needs your input;pi-notify-project\x1b\\",
    ]);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    await runtime.shutdown();
  });

  it("classifies permission dialogs and keeps a single notification", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        {
          id: "phone",
          type: "ntfy",
          events: ["permission-required", "input-required"],
          ntfy: { topic: "perm-topic" },
        },
      ],
    });
    const fetchImpl = mockFetch();
    const runtime = createRuntime();
    await runtime.start({ mode: "json" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: null,
      message: "Allow git status?",
      requestId: "direct-request",
      surface: "bash",
      value: "git status",
    });
    // The dialog span fires exactly once, classified permission-required.
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const titles = fetchImpl.mock.calls.map(
      ([, init]) => (init as { headers: Record<string, string> }).headers.Title,
    );
    expect(titles).toEqual(["Pi needs permission"]);

    runtime.dispatch("ui_prompt_end", { kind: "custom" });

    // The interactive decision clears the pending context: the next dialog
    // falls back to input-required.
    runtime.dispatch("permissions:decision", {
      resolution: "user_approved",
      surface: "bash",
      value: "git status",
    });
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const allTitles = fetchImpl.mock.calls.map(
      ([, init]) => (init as { headers: Record<string, string> }).headers.Title,
    );
    expect(allTitles).toEqual(["Pi needs permission", "Pi needs your input"]);
    await runtime.shutdown();
  });

  it("stays silent for headless ask flows and labeled events without dialogs", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
    const write = mockStdout();
    const runtime = createRuntime();
    await runtime.start({ mode: "tui" });

    runtime.dispatch("agent_start", {});
    // A headless pi-ask flow (no dialog ever opens): started/completed only.
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment",
    });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });
    // A permission ui_prompt without its dialog: context only, no output.
    runtime.dispatch("permissions:ui_prompt", {
      agentName: "Worker",
      forwarding: null,
      message: "Allow git push?",
      requestId: "headless-request",
      surface: "bash",
      value: "git push",
    });
    runtime.dispatch("permissions:decision", {
      resolution: "user_approved",
      surface: "bash",
      value: "git push",
    });

    expect(write).not.toHaveBeenCalled();
    expect(blockedEvents(runtime)).toEqual([]);
    await runtime.shutdown();
  });

  it("uses a sanitized ask title for Herdr and never leaks it into the body", async () => {
    const agentDir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeGlobalConfig(agentDir, {
      channels: [
        {
          id: "phone",
          type: "ntfy",
          events: ["input-required"],
          ntfy: { topic: "ask-topic" },
        },
      ],
    });
    const fetchImpl = mockFetch();
    const runtime = createRuntime();
    await runtime.start({ mode: "json" });

    runtime.dispatch("agent_start", {});
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "Choose deployment\ntarget",
    });
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });

    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Choose deployment target" },
      { active: false },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(init.body).toBe("pi-notify-project");
    expect(String(init.body)).not.toContain("Choose deployment");
    await runtime.shutdown();
  });

  it("clears state on shutdown", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
    const runtime = createRuntime();
    await runtime.start();
    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    await runtime.shutdown();
    runtime.dispatch("agent_start", {});
    runtime.dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.dispatch("agent_settled", {});
    expect(blockedEvents(runtime)).toEqual([
      { active: true, label: "Waiting for input" },
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

    // Run 1: an ask dialog, then a completed flow.
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-1",
      title: "First run question",
    });
    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    runtime.dispatch("@eko24ive/pi-ask:completed", { flowId: "ask-1" });

    // Simulate a /reload: second session_start after shutdown (no dupe state).
    await runtime.shutdown();
    await runtime.start({ mode: "json" });
    settle();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // A different flow id in run 2: if run 1's ask context leaked, the herdr
    // label would still be the run-1 title. The channel uses the default
    // subscription (includes input-required), so each dialog span POSTs once.
    runtime.dispatch("@eko24ive/pi-ask:started", {
      flowId: "ask-2",
      title: "Second run question",
    });
    runtime.dispatch("agent_start", {});
    runtime.dispatch("ui_prompt_start", { kind: "custom" });
    runtime.dispatch("ui_prompt_end", { kind: "custom" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const blocked = blockedEvents(runtime);
    expect(blocked.at(-2)).toEqual({
      active: true,
      label: "Second run question",
    });
    expect(blocked.at(-1)).toEqual({ active: false });
    await runtime.shutdown();
  });
});
