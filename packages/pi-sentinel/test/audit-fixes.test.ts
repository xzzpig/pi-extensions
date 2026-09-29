import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { AuditLoopFn } from "../extensions/audit-loop.ts";
import { formatListOption } from "../extensions/commands.ts";
import type { SourcedRule } from "../extensions/config.ts";
import { buildFleetRows, renderFleetLines } from "../extensions/fleet-view.ts";
import type { RunnerStatus } from "../extensions/runner.ts";
import {
  createHarness,
  failVerdict,
  passVerdict,
  waitUntil,
} from "./harness.ts";

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

function status(ruleName: string): RunnerStatus {
  return {
    ruleName,
    state: "idle",
    activeCount: 0,
    queuedCount: 0,
    cooldownUntil: 0,
    live: [],
  };
}

function turnEndEvent(): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex: 0,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "turn" }],
      api: "anthropic-messages",
      provider: "test",
      model: "audit-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
    toolResults: [],
    messageEntryId: "e-turn",
    toolResultEntryIds: [],
  } as unknown as TurnEndEvent;
}

describe("fleet inspector surfaces the last verdict, cache flag and dialog progress", () => {
  test("rows and rendering carry last verdict, cache hit and configure progress", () => {
    const rows = buildFleetRows({
      rules: [rule("a")],
      statuses: [status("a")],
      dialogs: [
        {
          id: "d1",
          startedAt: 0,
          turnCount: 3,
          status: "running",
          transcript: [{ role: "user", text: "让 bash 更安全", at: 1 }],
          draftSummary: "bash-safety",
        },
      ],
      history: [
        {
          at: 5,
          ruleName: "a",
          kind: "audit",
          status: "verdict",
          verdict: { verdict: "warn", message: "注意" },
          cached: true,
        },
      ],
    });

    const rowA = rows.find((row) => row.name === "a");
    expect(rowA?.lastVerdict).toBe("warn: 注意");
    expect(rowA?.lastCached).toBe(true);
    const dialogRow = rows.find((row) => row.kind === "configure");
    expect(dialogRow?.detail).toContain("第 3 轮");
    expect(dialogRow?.detail).toContain("bash-safety");
    expect(dialogRow?.detail).toContain("让 bash 更安全");

    const lines = renderFleetLines(rows, 0, 120).join("\n");
    expect(lines).toContain("最近=warn: 注意");
    expect(lines).toContain("最近裁决：warn: 注意（缓存：命中）");
  });
});

describe("interactive rule list options", () => {
  test("include model, last verdict and cooldown", () => {
    const text = formatListOption({
      name: "a",
      trigger: "tool_call [bash]",
      mode: "blocking",
      model: "test/m",
      enabled: true,
      source: "global",
      state: "idle",
      activeCount: 0,
      queuedCount: 0,
      coolingDown: true,
      lastVerdict: { verdict: "fail", message: "x" },
      lastCached: false,
    });
    expect(text).toContain("model=test/m");
    expect(text).toContain("最近=fail");
    expect(text).toContain("cooldown");
  });
});

describe("background findings", () => {
  test("carry the audit duration into the injected details", async () => {
    const h = createHarness({ rules: [rule("bg")] });
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(failVerdict);
    await waitUntil(() => h.sent.length === 1);
    expect(typeof h.sent[0].message.details?.durationMs).toBe("number");
  });
});

describe("verdict cache key", () => {
  test("uses the rendered prompt so {{tokens}} changes are distinct audits", async () => {
    const h = createHarness({
      rules: [
        rule("ctx", {
          trigger: { type: "context_tokens", threshold: 100_000 },
          prompt: "用量 {{tokens}}",
          cache: true,
        }),
      ],
    });

    h.setTokens(105_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);

    h.setTokens(205_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    expect(h.controls).toHaveLength(2);
  });
});

describe("hot reload marker continuity", () => {
  test("an unrelated config change does not re-arm an unchanged context_tokens rule", async () => {
    const h = createHarness({
      rules: [
        rule("ctx", {
          trigger: { type: "context_tokens", threshold: 100_000 },
          prompt: "用量 {{tokens}}",
          cache: false,
        }),
        rule("other", { prompt: "other", cache: false }),
      ],
    });

    h.setTokens(105_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length >= 1);
    for (const control of h.controls) control.verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);
    const baseline = h.controls.length;

    h.runtime.setRuleEnabled("other", false, h.ctx);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    expect(h.controls).toHaveLength(baseline);
  });
});

describe("fleet overlay lifecycle", () => {
  test("submitting a configuration change closes the open overlay", async () => {
    const drivingLoop: AuditLoopFn = (_prompts, context) => ({
      async *[Symbol.asyncIterator]() {
        const tool = context.tools?.find(
          (candidate) => candidate.name === "submit_config",
        );
        if (tool) {
          await tool.execute(
            "c",
            {
              changeType: "add",
              ruleJson: JSON.stringify({
                name: "drafted",
                trigger: { type: "turn_end" },
                mode: "background",
                prompt: "p",
              }),
            },
            undefined,
            undefined,
          );
        }
        yield { type: "agent_end", messages: [] } as AgentEvent;
      },
      async result() {
        return [];
      },
    });

    const h = createHarness({ rules: [], agentLoop: drivingLoop });
    h.runtime.register();
    (h.ctx as unknown as { mode: string }).mode = "tui";
    let doneCalled = false;
    let factory:
      | ((
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (value: unknown) => void,
        ) => unknown)
      | undefined;
    const ui = h.ctx.ui as unknown as Record<string, unknown>;
    ui.custom = async (candidate: unknown) => {
      factory = candidate as typeof factory;
      return undefined;
    };
    ui.select = async () => "放弃";

    const fleet = h.commands.get("sentinel:fleet") as {
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    };
    await fleet.handler("", h.ctx);
    expect(factory).toBeDefined();
    factory!(
      { requestRender: () => {}, terminal: { rows: 40, columns: 100 } },
      {},
      {},
      () => {
        doneCalled = true;
      },
    );

    const configure = h.commands.get("sentinel:configure") as {
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    };
    await configure.handler("", h.ctx);
    await waitUntil(() => doneCalled);
    expect(doneCalled).toBe(true);
  });
});
