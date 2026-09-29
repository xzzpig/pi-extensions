import type {
  AgentEndEvent,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  compactionEntry,
  createHarness,
  messageEntry,
  messageText,
  passVerdict,
  userMessage,
  waitUntil,
  type Harness,
} from "./harness.ts";

function toolResultEvent(toolName: string, text = "output"): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: `c-${toolName}`,
    toolName,
    input: {},
    content: [{ type: "text", text }],
    isError: false,
  } as unknown as ToolResultEvent;
}

function turnEndEvent(turnIndex = 0): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "assistant turn text" }],
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

function agentEndEvent(): AgentEndEvent {
  return {
    type: "agent_end",
    messages: [userMessage("final")],
  } as unknown as AgentEndEvent;
}

/** Let every pending background audit finish so the next trigger is not skipped. */
async function drain(h: Harness, expected: number): Promise<void> {
  await waitUntil(() => h.controls.length === expected);
  for (const control of h.controls) control.verdict(passVerdict);
  await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);
}

describe("tool name filtering", () => {
  test("trigger.tools patterns filter tool_result rules, including mcp__*", async () => {
    const h = createHarness({
      rules: [
        {
          name: "edits",
          trigger: { type: "tool_result", tools: ["edit", "write"] },
        },
        { name: "mcp", trigger: { type: "tool_result", tools: ["mcp__*"] } },
        { name: "all", trigger: { type: "tool_result" } },
      ],
    });

    await h.runtime.handleToolResult(toolResultEvent("edit"), h.ctx);
    await drain(h, 2);

    await h.runtime.handleToolResult(
      toolResultEvent("mcp__fs__read_file"),
      h.ctx,
    );
    await drain(h, 4);

    await h.runtime.handleToolResult(toolResultEvent("read"), h.ctx);
    await drain(h, 5);
  });
});

describe("turn_end and agent_end triggers", () => {
  test("turn_end fires once per turn with the turn scope", async () => {
    const h = createHarness({
      rules: [
        {
          name: "turn-rule",
          trigger: { type: "turn_end" },
          prompt: "{{assistant}}",
        },
      ],
    });

    await h.runtime.handleTurnEnd(turnEndEvent(0), h.ctx);
    await waitUntil(() => h.controls.length === 1);

    const prompt = messageText(h.capturedPrompts[0][0]);
    expect(prompt).toContain("assistant turn text");
    expect(h.controls).toHaveLength(1);
  });

  test("agent_end fires once per agent loop", async () => {
    const h = createHarness({
      rules: [
        {
          name: "end-rule",
          trigger: { type: "agent_end" },
          prompt: "{{messageCount}}",
        },
      ],
    });

    await h.runtime.handleAgentEnd(agentEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);

    expect(messageText(h.capturedPrompts[0][0])).toContain("1");
  });
});

describe("context_tokens watermark", () => {
  function tokenRule() {
    return {
      name: "ctx",
      trigger: { type: "context_tokens" as const, threshold: 100_000 },
      mode: "background" as const,
      prompt: "{{json messages}}",
      cache: false,
    };
  }

  test("fires once per crossed multiple boundary", async () => {
    const h = createHarness({ rules: [tokenRule()] });

    h.setTokens(90_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    expect(h.controls).toHaveLength(0);

    h.setTokens(105_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await drain(h, 1);

    h.setTokens(195_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    expect(h.controls).toHaveLength(1);

    h.setTokens(205_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    expect(h.controls).toHaveLength(2);
  });

  test("a compaction drop re-arms the watermark", async () => {
    const h = createHarness({ rules: [tokenRule()] });

    h.setTokens(105_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await drain(h, 1);

    h.setTokens(60_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    expect(h.controls).toHaveLength(1);

    h.setTokens(115_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);
    expect(h.controls).toHaveLength(2);
  });

  test("an unavailable usage reading skips the check", async () => {
    const h = createHarness({ rules: [tokenRule()] });

    h.setUsage(undefined);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    expect(h.controls).toHaveLength(0);

    h.setTokens(null);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    expect(h.controls).toHaveLength(0);
  });

  test("the increment covers exactly the messages between two firings", async () => {
    const h = createHarness({ rules: [tokenRule()] });

    h.addMessage("e1", userMessage("first message"));
    h.setTokens(105_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 1);

    const firstPrompt = messageText(h.capturedPrompts[0][0]);
    expect(firstPrompt).toContain("first message");
    h.controls[0].verdict(passVerdict);
    await waitUntil(() => h.runtime.getRegistry().runningCount() === 0);

    h.addMessage("e2", userMessage("second message"));
    h.setTokens(205_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);

    const secondPrompt = messageText(h.capturedPrompts[1][0]);
    expect(secondPrompt).toContain("second message");
    expect(secondPrompt).not.toContain("first message");
  });

  test("an invalidated marker restarts after the compaction boundary", async () => {
    const h = createHarness({ rules: [tokenRule()] });

    h.addMessage("e1", userMessage("before compaction"));
    h.setTokens(105_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await drain(h, 1);

    // The marker entry disappears with the compaction; the marker restarts there.
    h.setTokens(60_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    h.setEntries([
      compactionEntry("comp"),
      messageEntry("e3", userMessage("after compaction")),
    ]);
    h.setTokens(115_000);
    await h.runtime.handleTurnEnd(turnEndEvent(), h.ctx);
    await waitUntil(() => h.controls.length === 2);

    const prompt = messageText(h.capturedPrompts[1][0]);
    expect(prompt).toContain("after compaction");
    expect(prompt).not.toContain("before compaction");
  });
});
