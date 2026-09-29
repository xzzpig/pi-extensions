import type {
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { SourcedRule } from "../extensions/config.ts";
import {
  createHarness,
  failVerdict,
  messageEntry,
  messageText,
  passVerdict,
  userMessage,
  waitUntil,
} from "./harness.ts";

function turnEndEvent(): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex: 0,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "turn text" }],
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

function toolCallEvent(): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "rm -rf /" },
  } as unknown as ToolCallEvent;
}

function sessionRule(name: string, prompt = "session check"): SourcedRule {
  return {
    name,
    trigger: { type: "turn_end" },
    mode: "background",
    prompt,
    source: "session",
  };
}

describe("lifecycle resets", () => {
  test("a session switch aborts running audits and clears runtime state", async () => {
    const h = createHarness({
      rules: [{ name: "r", trigger: { type: "turn_end" } }],
    });

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);

    h.runtime.handleSessionBeforeSwitch({
      type: "session_before_switch",
      reason: "resume",
    } as SessionBeforeSwitchEvent);

    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);
    expect(
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.status === "cancelled"),
    ).toBe(true);
  });

  test("the global concurrency limit drops excess default-overlap triggers", async () => {
    const h = createHarness({
      maxConcurrent: 1,
      rules: [
        { name: "a", trigger: { type: "turn_end" } },
        { name: "b", trigger: { type: "turn_end" } },
        { name: "c", trigger: { type: "turn_end" } },
      ],
    });

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(
      () =>
        h.runtime
          .getRegistry()
          .getHistory()
          .filter((e) => e.status === "skipped").length === 2,
    );

    expect(h.controls).toHaveLength(1);
    expect(
      h.runtime
        .getRegistry()
        .getHistory()
        .filter((e) => e.status === "skipped"),
    ).toHaveLength(2);
  });

  test("tree navigation replays the op-log along the new branch", () => {
    const h = createHarness({
      rules: [{ name: "file", trigger: { type: "turn_end" } }],
    });

    h.runtime.addSessionRule(sessionRule("sess"), h.ctx);
    expect(h.runtime.getRunners().has("sess")).toBe(true);

    // Navigate to a branch that never saw the session op.
    h.setEntries([messageEntry("e9", userMessage("other branch"))]);
    h.runtime.handleSessionTree(
      {
        type: "session_tree",
        newLeafId: "e9",
        oldLeafId: "op-1",
      } as SessionTreeEvent,
      h.ctx,
    );

    expect(h.runtime.getRunners().has("sess")).toBe(false);
  });

  test("tree navigation resets the incremental marker to the new branch tail", async () => {
    const h = createHarness({
      rules: [
        {
          name: "ctx",
          trigger: { type: "context_tokens", threshold: 100_000 },
          prompt: "{{json messages}}",
          cache: false,
        },
      ],
    });

    h.addMessage("e1", userMessage("pre-navigation message"));
    h.setTokens(105_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    expect(messageText(h.capturedPrompts[0][0])).toContain(
      "pre-navigation message",
    );
    h.controls[0].verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);

    h.setEntries([messageEntry("e9", userMessage("branch tail"))]);
    h.runtime.handleSessionTree(
      {
        type: "session_tree",
        newLeafId: "e9",
        oldLeafId: "e1",
      } as SessionTreeEvent,
      h.ctx,
    );

    // The marker restarts at the new branch tail, so only later messages count.
    h.addMessage("e10", userMessage("post-navigation message"));
    h.setTokens(205_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    const prompt = messageText(h.capturedPrompts[1][0]);
    expect(prompt).toContain("post-navigation message");
    expect(prompt).not.toContain("pre-navigation message");
  });
});

describe("session-level configuration", () => {
  test("a session rule survives a restart through op-log replay", async () => {
    const fileRules = [
      { name: "file-rule", trigger: { type: "turn_end" as const } },
    ];
    const h = createHarness({ rules: fileRules });
    h.runtime.addSessionRule(sessionRule("sess-rule"), h.ctx);
    expect(h.runtime.getRunners().has("sess-rule")).toBe(true);

    const restarted = createHarness({
      rules: fileRules,
      configLoader: () => h.config,
    });
    restarted.setEntries(h.entries);
    await restarted.runtime.handleSessionStart(
      { type: "session_start", reason: "resume" } as SessionStartEvent,
      restarted.ctx,
    );

    expect(restarted.runtime.getRunners().has("sess-rule")).toBe(true);
    expect(
      restarted.runtime
        .listEntries()
        .find((entry) => entry.name === "sess-rule")?.source,
    ).toBe("session");
  });

  test("a forked session inherits session-level configuration", async () => {
    const fileRules = [
      { name: "file-rule", trigger: { type: "turn_end" as const } },
    ];
    const h = createHarness({ rules: fileRules });
    h.runtime.addSessionRule(sessionRule("forked-rule"), h.ctx);

    const forked = createHarness({
      rules: fileRules,
      configLoader: () => h.config,
    });
    forked.setEntries(h.entries);
    await forked.runtime.handleSessionStart(
      { type: "session_start", reason: "fork" } as SessionStartEvent,
      forked.ctx,
    );

    expect(forked.runtime.getRunners().has("forked-rule")).toBe(true);
  });

  test("disabling masks an inherited rule and enabling restores it", async () => {
    const h = createHarness({
      rules: [
        {
          name: "bash-safety",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
      ],
    });

    h.runtime.setRuleEnabled("bash-safety", false, h.ctx);
    expect(
      await h.runtime.handleToolCall(toolCallEvent(), h.ctx),
    ).toBeUndefined();
    expect(h.controls).toHaveLength(0);
    expect(h.runtime.listEntries()[0]?.enabled).toBe(false);

    h.runtime.setRuleEnabled("bash-safety", true, h.ctx);
    const pending = h.runtime.handleToolCall(toolCallEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(passVerdict);
    expect(await pending).toBeUndefined();
  });

  test("remove is limited to session-level rules, and unshadowing restores the file rule", () => {
    const h = createHarness({
      rules: [
        { name: "dup", trigger: { type: "turn_end" }, prompt: "file prompt" },
      ],
    });

    const rejected = h.runtime.removeSessionRule("dup", h.ctx);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("会话级");

    h.runtime.addSessionRule(
      { ...sessionRule("dup"), prompt: "session prompt" },
      h.ctx,
    );
    expect(
      h.runtime.getResolvedConfig()?.rules.find((rule) => rule.name === "dup")
        ?.prompt,
    ).toBe("session prompt");

    expect(h.runtime.removeSessionRule("dup", h.ctx).ok).toBe(true);
    const restored = h.runtime
      .getResolvedConfig()
      ?.rules.find((rule) => rule.name === "dup");
    expect(restored?.prompt).toBe("file prompt");
    expect(restored?.source).toBe("global");
  });

  test("disable/enable invalidates the cached verdict", async () => {
    const h = createHarness({
      rules: [
        { name: "dup", trigger: { type: "turn_end" }, prompt: "same prompt" },
      ],
    });

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);

    // A second identical trigger is served from the cache.
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() =>
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.cached === true),
    );
    expect(h.controls).toHaveLength(1);

    // Disabling and re-enabling invalidates the rule's cached verdicts.
    h.runtime.setRuleEnabled("dup", false, h.ctx);
    h.runtime.setRuleEnabled("dup", true, h.ctx);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    expect(h.controls).toHaveLength(2);
  });

  test("an in-flight audit finishes under its captured definition after replacement", async () => {
    const h = createHarness({
      rules: [
        {
          name: "dup",
          trigger: { type: "turn_end" },
          prompt: "old prompt",
          cache: false,
        },
      ],
    });

    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);

    h.runtime.addSessionRule(
      { ...sessionRule("dup"), prompt: "new prompt" },
      h.ctx,
    );
    expect(
      h.runtime.getResolvedConfig()?.rules.find((rule) => rule.name === "dup")
        ?.prompt,
    ).toBe("new prompt");

    // The already-running audit still dispatches its verdict under the old rule.
    h.controls[0].verdict(failVerdict);
    await waitUntil(() =>
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.status === "verdict"),
    );
    expect(
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.status === "verdict"),
    ).toBe(true);
  });
});

describe("event trigger subscriptions", () => {
  test("a session switch keeps event subscriptions alive", async () => {
    const h = createHarness({
      register: true,
      rules: [
        {
          name: "bus",
          trigger: { type: "event", event: "pi-subagents:done" },
          prompt: "bus",
          cache: false,
        },
        {
          name: "core",
          trigger: { type: "event", event: "core:session_compact" },
          prompt: "core",
          cache: false,
        },
      ],
    });

    h.runtime.handleSessionBeforeSwitch({
      type: "session_before_switch",
      reason: "resume",
    } as SessionBeforeSwitchEvent);

    // Subscriptions are config-level wiring: the switch resets runtime state
    // but must not touch them.
    expect(h.runtime.getEventSubscriptionRegistry()?.subscribedNames()).toEqual(
      ["pi-subagents:done", "core:session_compact"],
    );
    expect(h.busHandlers.has("pi-subagents:done")).toBe(true);
    expect(h.handlers.has("session_compact")).toBe(true);

    h.busHandlers.get("pi-subagents:done")?.({ ok: 1 });
    h.handlers.get("session_compact")?.({ reason: "later" }, h.ctx);
    await waitUntil(() => h.controls.length === 2);
    expect(h.controls).toHaveLength(2);
  });

  test("removing the last rule referencing an event unsubscribes it", async () => {
    const h = createHarness({
      register: true,
      rules: [
        {
          name: "solo",
          trigger: { type: "event", event: "core:session_compact" },
          prompt: "{{name}}",
          cache: false,
        },
      ],
    });
    expect(h.handlers.has("session_compact")).toBe(true);

    // Hot reload with the event rule removed.
    h.runtime.applyConfig({ ...h.config, rules: [] }, h.ctx);

    expect(h.runtime.getEventSubscriptionRegistry()?.subscribedNames()).toEqual(
      [],
    );
    expect(h.handlers.has("session_compact")).toBe(false);

    // The host dispatching the event again reaches nothing: no audit, no history.
    h.handlers.get("session_compact")?.({ reason: "late" }, h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.controls).toHaveLength(0);
    expect(h.runtime.getRegistry().getHistory()).toHaveLength(0);
  });

  test("session shutdown tears down event subscriptions", () => {
    const h = createHarness({
      register: true,
      rules: [
        {
          name: "bus",
          trigger: { type: "event", event: "pi-subagents:done" },
        },
      ],
    });

    h.runtime.handleSessionShutdown({
      type: "session_shutdown",
    } as SessionShutdownEvent);

    expect(h.runtime.getEventSubscriptionRegistry()?.subscribedNames()).toEqual(
      [],
    );
    expect(h.busHandlers.has("pi-subagents:done")).toBe(false);
  });
});
