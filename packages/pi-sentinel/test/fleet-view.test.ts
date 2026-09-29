import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { SourcedRule } from "../extensions/config.ts";
import { describeTrigger } from "../extensions/commands.ts";
import {
  buildFleetRows,
  openFleetInspector,
  renderFleetLines,
  steerAudit,
  updateSentinelStatus,
  type FleetRow,
} from "../extensions/fleet-view.ts";
import type { RunnerStatus } from "../extensions/runner.ts";
import { createHarness, passVerdict, waitUntil } from "./harness.ts";

function rule(name: string, overrides: Partial<SourcedRule> = {}): SourcedRule {
  return {
    name,
    trigger: { type: "turn_end" },
    mode: "background",
    prompt: "check",
    source: "global",
    ...overrides,
  };
}

function status(
  ruleName: string,
  overrides: Partial<RunnerStatus> = {},
): RunnerStatus {
  return {
    ruleName,
    state: "idle",
    activeCount: 0,
    queuedCount: 0,
    cooldownUntil: 0,
    live: [],
    ...overrides,
  };
}

describe("fleet row assembly", () => {
  test("rows combine rules, live status, disabled masks, and dialogs", () => {
    const rows = buildFleetRows({
      rules: [
        rule("a", {
          trigger: { type: "tool_call", tools: ["bash", "edit"] },
          mode: "blocking",
        }),
        rule("b", { trigger: { type: "context_tokens", threshold: 1000 } }),
        rule("c", { enabled: false }),
      ],
      statuses: [
        status("a", {
          state: "running",
          activeCount: 1,
          live: [
            {
              ruleName: "a",
              startedAt: 0,
              model: "test/m",
              promptSummary: "检查命令",
              scopeSummary: "{}",
              unresolvedPaths: [],
              toolCallCount: 2,
              streamTail: "partial",
              steeredMessages: [],
              status: "running",
            },
          ],
        }),
        status("b", { state: "queued", queuedCount: 1 }),
      ],
      dialogs: [
        {
          id: "d1",
          startedAt: 0,
          turnCount: 1,
          status: "running",
          transcript: [],
        },
      ],
      isDisabled: (name) => name === "b",
    });

    expect(rows.map((row) => row.name)).toEqual(["a", "b", "c", "d1"]);
    expect(rows[0]).toMatchObject({
      state: "running",
      trigger: "tool_call[bash|edit]",
      mode: "blocking",
    });
    expect(rows[1]).toMatchObject({
      state: "disabled",
      queuedCount: 1,
      trigger: "ctx@1000",
    });
    expect(rows[2]?.state).toBe("disabled");
    expect(rows[3]).toMatchObject({ kind: "configure", state: "running" });
    expect(rows[0]?.live?.toolCallCount).toBe(2);
  });

  test("renderFleetLines marks the selection and shows live detail", () => {
    const rows = buildFleetRows({
      rules: [rule("a"), rule("b")],
      statuses: [
        status("a", {
          state: "running",
          activeCount: 1,
          live: [
            {
              ruleName: "a",
              startedAt: Date.now(),
              model: "test/m",
              promptSummary: "检查命令",
              scopeSummary: "scope",
              unresolvedPaths: ["input.nope"],
              toolCallCount: 3,
              streamTail: "tail line",
              steeredMessages: [],
              status: "running",
            },
          ],
        }),
      ],
      dialogs: [],
    });

    const lines = renderFleetLines(rows, 0, 120, "已送达");
    expect(lines[1]?.startsWith(">")).toBe(true);
    expect(lines[2]?.startsWith(">")).toBe(false);
    expect(lines.join("\n")).toContain("test/m");
    expect(lines.join("\n")).toContain("input.nope");
    expect(lines.join("\n")).toContain("tail line");
    expect(lines.join("\n")).toContain("steer：已送达");

    expect(renderFleetLines([], 0, 80).join("\n")).toContain(
      "没有已加载的哨兵",
    );
  });
});

describe("event trigger display", () => {
  test("event rules show event:<configured name> verbatim, prefixes included", () => {
    const bus = rule("bus", {
      trigger: { type: "event", event: "pi-subagents:done" },
    });
    const core = rule("core", {
      trigger: { type: "event", event: "core:session_compact" },
    });

    expect(describeTrigger(bus)).toBe("event:pi-subagents:done");
    expect(describeTrigger(core)).toBe("event:core:session_compact");

    const rows = buildFleetRows({
      rules: [bus, core],
      statuses: [],
      dialogs: [],
    });
    expect(rows[0]?.trigger).toBe("event:pi-subagents:done");
    expect(rows[1]?.trigger).toBe("event:core:session_compact");
  });
});

describe("steering", () => {
  test("a running audit accepts a steer and a finished one reports ended", async () => {
    const h = createHarness({
      rules: [{ name: "r", trigger: { type: "turn_end" } }],
    });

    await h.runtime.handleTurnEnd(
      {
        type: "turn_end",
        turnIndex: 0,
        message: {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: 0,
        },
        toolResults: [],
      } as never,
      h.ctx,
    );
    await waitUntil(() => h.controls.length === 1);

    expect(steerAudit(h.runtime.getRegistry(), "r", "重点核对配置文件")).toBe(
      "delivered",
    );
    expect(h.controls[0]).toBeDefined();

    h.controls[0].verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);

    expect(steerAudit(h.runtime.getRegistry(), "r", "too late")).toBe("ended");
    expect(steerAudit(h.runtime.getRegistry(), "missing", "no rule")).toBe(
      "ended",
    );
  });
});

describe("status bar and mode guard", () => {
  test("running audits drive the footer status and widget", () => {
    const calls: Array<{ kind: string; key: string; value: unknown }> = [];
    const ui = {
      setStatus: (key: string, value: unknown) =>
        calls.push({ kind: "status", key, value }),
      setWidget: (key: string, value: unknown) =>
        calls.push({ kind: "widget", key, value }),
    } as unknown as ExtensionContext["ui"];

    const running: FleetRow[] = [
      {
        name: "a",
        kind: "rule",
        trigger: "turn_end",
        mode: "background",
        state: "running",
        queuedCount: 1,
      },
      {
        name: "b",
        kind: "rule",
        trigger: "turn_end",
        mode: "background",
        state: "idle",
        queuedCount: 0,
      },
    ];
    updateSentinelStatus(ui, running);
    expect(calls).toEqual([
      { kind: "status", key: "sentinel", value: "▶1" },
      { kind: "widget", key: "sentinel", value: ["a(+1)"] },
    ]);

    calls.length = 0;
    updateSentinelStatus(ui, [running[1]]);
    expect(calls).toEqual([
      { kind: "status", key: "sentinel", value: undefined },
      { kind: "widget", key: "sentinel", value: undefined },
    ]);
  });

  test("non-TUI modes are pointed at /sentinel:list instead of opening the overlay", async () => {
    const notifications: string[] = [];
    let customCalls = 0;
    const ctx = {
      mode: "print",
      hasUI: false,
      ui: {
        notify: (message: string) => notifications.push(message),
        custom: async () => {
          customCalls += 1;
          return undefined;
        },
      },
    } as unknown as ExtensionContext;

    await openFleetInspector(ctx, {
      registry: createHarness({ rules: [] }).runtime.getRegistry(),
      buildRows: () => [],
      keybindings: {
        selectUp: ["up"],
        selectDown: ["down"],
        steer: ["s"],
        refresh: ["r"],
        close: ["q"],
      },
      promptSteer: async () => undefined,
    });

    expect(customCalls).toBe(0);
    expect(notifications[0]).toContain("/sentinel:list");
  });
});
