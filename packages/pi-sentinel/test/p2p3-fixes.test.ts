import type {
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionTreeEvent,
  ToolCallEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { guardedStreamFn, type AuditLoopFn } from "../extensions/audit-loop.ts";
import type { SourcedRule } from "../extensions/config.ts";
import {
  createHarness,
  failVerdict,
  passVerdict,
  waitUntil,
  warnVerdict,
} from "./harness.ts";

function rule(name: string, overrides: Partial<SourcedRule> = {}): SourcedRule {
  return {
    name,
    trigger: { type: "tool_call", tools: ["bash"] },
    mode: "blocking",
    prompt: "check",
    source: "global",
    ...overrides,
  };
}

function call(
  toolCallId: string,
  toolName = "bash",
  command = "echo hi",
): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName,
    input: { command },
  } as unknown as ToolCallEvent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnEndEvent(turnIndex = 0): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex,
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

function backgroundRule(
  name: string,
  overrides: Partial<SourcedRule> = {},
): SourcedRule {
  return rule(name, {
    trigger: { type: "turn_end" },
    mode: "background",
    prompt: "check",
    cache: false,
    ...overrides,
  });
}

describe("P2-1 global concurrency budget", () => {
  test("a maxConcurrent change applies immediately to already-loaded rules", async () => {
    const h = createHarness({
      rules: [rule("a")],
      maxConcurrent: 1,
    });

    const first = h.runtime.handleToolCall(call("c1"), h.ctx);
    const second = h.runtime.handleToolCall(call("c2"), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    await sleep(40);
    // Saturated: the second audit is still waiting for the single slot.
    expect(h.controls).toHaveLength(1);

    // Raising the limit must take effect without dropping slot accounting.
    h.runtime.applyConfig(
      {
        ...h.config,
        defaults: { ...h.config.defaults, maxConcurrent: 2 },
      },
      h.ctx,
    );
    await waitUntil(() => h.controls.length === 2);

    for (const control of h.controls) control.verdict(passVerdict);
    await Promise.all([first, second]);
  });

  test("a rule added mid-flight cannot bypass the shared cap", async () => {
    const h = createHarness({
      rules: [rule("a")],
      maxConcurrent: 1,
    });

    const first = h.runtime.handleToolCall(call("c1"), h.ctx);
    await waitUntil(() => h.controls.length === 1);

    // A new runner used to receive a brand-new semaphore, splitting the budget.
    h.runtime.addSessionRule(
      rule("b", { trigger: { type: "tool_call", tools: ["edit"] } }),
      h.ctx,
    );
    const second = h.runtime.handleToolCall(call("c2", "edit"), h.ctx);
    await sleep(40);
    expect(h.controls).toHaveLength(1);

    h.controls[0].verdict(passVerdict);
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);
    await Promise.all([first, second]);
  });
});

describe("P2-2 dedupe cooldowns", () => {
  test("an unrelated config change keeps an unchanged rule's cooldown", async () => {
    const h = createHarness({
      rules: [
        backgroundRule("bgA"),
        rule("other", {
          trigger: { type: "tool_call", tools: ["edit"] },
          mode: "background",
          prompt: "other",
          cache: false,
        }),
      ],
    });

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(warnVerdict);
    await waitUntil(() => h.sent.length === 1);

    // Identical finding again: deduped inside the cooldown window.
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(warnVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);
    expect(h.sent).toHaveLength(1);

    // Unrelated change: disabling another rule used to clear every cooldown.
    h.runtime.setRuleEnabled("other", false, h.ctx);

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 3);
    h.controls[2].verdict(warnVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);
    expect(h.sent).toHaveLength(1);
  });

  test("replacing a rule expires only that rule's cooldown", async () => {
    const h = createHarness({ rules: [backgroundRule("bgA")] });

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(warnVerdict);
    await waitUntil(() => h.sent.length === 1);

    // Same name, different definition -> hash changes -> cooldown invalidated.
    h.runtime.addSessionRule(
      backgroundRule("bgA", { prompt: "check differently" }),
      h.ctx,
    );

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(warnVerdict);
    await waitUntil(() => h.sent.length === 2);
    expect(h.sent).toHaveLength(2);
  });
});

describe("P3 single failure notification", () => {
  test("a fail-open blocking failure notifies exactly once", async () => {
    const h = createHarness({ rules: [rule("gate")] });

    const pending = h.runtime.handleToolCall(call("c1"), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].fail("boom");
    await pending;

    const failures = h.notified.filter((entry) =>
      entry.message.includes("审计失败"),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("gate");
  });

  test("fail-closed still blocks and notifies only once, including the cooldown path", async () => {
    const h = createHarness({ rules: [rule("gate", { onFailure: "closed" })] });

    const first = (await (async () => {
      const pending = h.runtime.handleToolCall(call("c1"), h.ctx);
      await waitUntil(() => h.controls.length === 1);
      h.controls[0].fail("boom");
      return pending;
    })()) as { block?: boolean; reason?: string } | undefined;

    expect(first?.block).toBe(true);
    expect(String(first?.reason)).toContain("fail-closed");

    // Inside the negative cooldown: blocks with the cooldown reason, no new notify.
    const second = (await h.runtime.handleToolCall(call("c2"), h.ctx)) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(second?.block).toBe(true);
    expect(String(second?.reason)).toContain("负冷却");

    expect(
      h.notified.filter((entry) => entry.message.includes("审计失败")),
    ).toHaveLength(1);
  });
});

describe("P3 session lifecycle semantics", () => {
  test("session_tree keeps running audits alive (no abort, no cache clear)", async () => {
    const h = createHarness({ rules: [rule("gate")] });

    const pending = h.runtime.handleToolCall(call("c1"), h.ctx);
    await waitUntil(() => h.controls.length === 1);

    h.runtime.handleSessionTree(
      {
        type: "session_tree",
        newLeafId: "new-leaf",
        oldLeafId: "old-leaf",
      } as unknown as SessionTreeEvent,
      h.ctx,
    );

    // The in-flight audit was not aborted, so its fail verdict still blocks.
    h.controls[0].verdict(failVerdict);
    const result = (await pending) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(result?.block).toBe(true);
  });

  test("session_tree preserves the negative cooldown (it is not a session switch)", async () => {
    const h = createHarness({
      rules: [rule("gate", { onFailure: "closed" })],
    });

    const first = (await (async () => {
      const pending = h.runtime.handleToolCall(call("c1"), h.ctx);
      await waitUntil(() => h.controls.length === 1);
      h.controls[0].fail("boom");
      return pending;
    })()) as { reason?: string } | undefined;
    expect(String(first?.reason)).toContain("fail-closed");

    h.runtime.handleSessionTree(
      {
        type: "session_tree",
        newLeafId: "new-leaf",
        oldLeafId: "old-leaf",
      } as unknown as SessionTreeEvent,
      h.ctx,
    );

    // Still cooling down: the trigger is short-circuited, no second audit.
    const second = (await h.runtime.handleToolCall(call("c2"), h.ctx)) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(second?.block).toBe(true);
    expect(String(second?.reason)).toContain("负冷却");
    expect(h.controls).toHaveLength(1);
  });

  test("a session switch clears the negative cooldown", async () => {
    const h = createHarness({
      rules: [rule("gate", { onFailure: "closed" })],
    });

    const first = (await (async () => {
      const pending = h.runtime.handleToolCall(call("c1"), h.ctx);
      await waitUntil(() => h.controls.length === 1);
      h.controls[0].fail("boom");
      return pending;
    })()) as { reason?: string } | undefined;
    expect(String(first?.reason)).toContain("fail-closed");

    h.runtime.handleSessionBeforeSwitch({
      type: "session_before_switch",
      reason: "new",
    } as unknown as SessionBeforeSwitchEvent);

    // Without the fix the stale cooldown short-circuits this call.
    const pending = h.runtime.handleToolCall(call("c2"), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(passVerdict);
    const second = (await pending) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(second?.block).toBeUndefined();
    expect(h.controls).toHaveLength(2);
  });

  test("a re-anchored context_tokens rule does not fire a catch-up audit", async () => {
    const h = createHarness({
      rules: [
        backgroundRule("ctx", {
          trigger: { type: "context_tokens", threshold: 100_000 },
        }),
      ],
    });

    h.setTokens(250_000);
    // Same name, new definition: hot reload re-anchors marker and watermark.
    h.runtime.addSessionRule(
      backgroundRule("ctx", {
        trigger: { type: "context_tokens", threshold: 100_000 },
        prompt: "check differently",
      }),
      h.ctx,
    );

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    expect(h.controls).toHaveLength(0);

    h.setTokens(305_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
  });
});

describe("P3 disabled mask does not outlive its rule", () => {
  test("removing a disabled session rule restores the inherited namesake", async () => {
    const h = createHarness({ rules: [rule("bash-safety")] });

    // Session rule shadows the inherited namesake, then gets disabled.
    h.runtime.addSessionRule(
      rule("bash-safety", { prompt: "session check" }),
      h.ctx,
    );
    h.runtime.setRuleEnabled("bash-safety", false, h.ctx);
    const removed = h.runtime.removeSessionRule("bash-safety", h.ctx);
    expect(removed.ok).toBe(true);

    // The inherited rule must be active again, so a bash call audits.
    const pending = h.runtime.handleToolCall(call("c1"), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(passVerdict);
    await pending;
  });
});

describe("P3 configure dialog cleanup", () => {
  function configureCommand(h: ReturnType<typeof createHarness>) {
    return h.commands.get("sentinel:configure") as {
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    };
  }

  test("a finished dialog leaves the fleet registry, and a switch clears the rest", async () => {
    const h = createHarness({ rules: [] });
    h.runtime.register();
    (h.ctx as unknown as { mode: string }).mode = "tui";
    const ui = h.ctx.ui as unknown as Record<string, unknown>;
    ui.select = async () => undefined;
    ui.input = async () => undefined;

    const configure = configureCommand(h);

    // First dialog: resolve its fake agent loop so it finishes.
    await configure.handler("", h.ctx);
    expect(h.runtime.getRegistry().dialogsView()).toHaveLength(1);
    h.controls[0].verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().dialogsView().length === 0);

    // Second dialog stays running, then a session switch clears it.
    await configure.handler("", h.ctx);
    expect(h.runtime.getRegistry().dialogsView()).toHaveLength(1);
    h.runtime.handleSessionBeforeSwitch({
      type: "session_before_switch",
      reason: "new",
    } as unknown as SessionBeforeSwitchEvent);
    expect(h.runtime.getRegistry().dialogsView()).toHaveLength(0);
  });
});

describe("P3 streamFn guard", () => {
  test("a synchronous streamSimple throw becomes a terminal error stream", async () => {
    const model = {
      id: "m",
      api: "anthropic-messages",
      provider: "test",
      maxTokens: 100,
    } as unknown as Model<Api>;
    const guarded = guardedStreamFn(() => {
      throw new Error("boom");
    });

    const stream = (await guarded(
      model,
      { messages: [] } as unknown as Parameters<StreamFn>[1],
      undefined,
    )) as AssistantMessageEventStream;

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    expect(events).toContain("error");

    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("boom");
  });
});

describe("P2-3 shadow notice end-to-end wiring", () => {
  function drivingLoop(collected: string[]): AuditLoopFn {
    return (_prompts, context) => ({
      async *[Symbol.asyncIterator]() {
        const tool = context.tools?.find(
          (candidate) => candidate.name === "submit_config",
        );
        if (tool) {
          const result = await tool.execute(
            "c",
            {
              changeType: "add",
              ruleJson: JSON.stringify({
                name: "bash-safety",
                trigger: { type: "turn_end" },
                mode: "background",
                prompt: "session check",
              }),
            },
            undefined,
            undefined,
          );
          collected.push(
            result.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
          );
        }
        yield { type: "agent_end", messages: [] } as AgentEvent;
      },
      async result() {
        return [];
      },
    });
  }

  async function runSessionWrite(
    fileRuleName: string,
  ): Promise<{ collected: string[]; h: ReturnType<typeof createHarness> }> {
    const collected: string[] = [];
    const h = createHarness({
      rules: [backgroundRule(fileRuleName)],
      agentLoop: drivingLoop(collected),
    });
    h.runtime.register();
    (h.ctx as unknown as { mode: string }).mode = "tui";
    const ui = h.ctx.ui as unknown as Record<string, unknown>;
    const selects = ["写入", "session"];
    ui.select = async () => selects.shift();
    ui.input = async () => undefined;

    const configure = h.commands.get("sentinel:configure") as {
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    };
    await configure.handler("", h.ctx);
    await waitUntil(() => collected.length === 1);
    return { collected, h };
  }

  test("a session write over a real file rule reports shadowing", async () => {
    const { collected, h } = await runSessionWrite("bash-safety");
    expect(collected[0]).toContain("遮蔽");
    expect(collected[0]).toContain("bash-safety");
    // The write really landed in the session scope (only session-added rules
    // can be removed), which is what makes the shadowing real.
    expect(h.runtime.removeSessionRule("bash-safety", h.ctx).ok).toBe(true);
  });

  test("without a file namesake no shadow notice is produced", async () => {
    const { collected } = await runSessionWrite("unrelated-file-rule");
    expect(collected[0]).not.toContain("遮蔽");
  });
});
