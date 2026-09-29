import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
  buildAgentEndEventData,
  buildContextTokensEventData,
  buildScopeText,
  buildToolCallEventData,
  buildToolResultEventData,
  buildTranscriptText,
  buildTurnEndEventData,
  capScopeTokens,
  DEFAULT_SERIALIZE_OPTIONS,
  estimateTokens,
  serializeMessage,
  sliceByTokens,
} from "../extensions/event-data.ts";

function userMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
    ...overrides,
  };
}

function toolResultMessage(
  toolName: string,
  content: ToolResultMessage["content"],
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName,
    content,
    isError,
    timestamp: 3,
  };
}

describe("event data field tables", () => {
  test("tool_call builds tool/toolCallId/input and uses the event JSON as scope", () => {
    const data = buildToolCallEventData({
      toolName: "bash",
      toolCallId: "call-9",
      input: { command: "rm -rf /tmp/x" },
    });

    expect(data).toEqual({
      tool: "bash",
      toolCallId: "call-9",
      input: { command: "rm -rf /tmp/x" },
    });
    expect(
      buildScopeText({
        triggerType: "tool_call",
        eventData: data,
        allMessages: [],
        maxWindowTokens: 20_000,
      }),
    ).toBe(JSON.stringify(data));
  });

  test("tool_result builds tool/toolCallId/input/content/isError", () => {
    const data = buildToolResultEventData({
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "ls" },
      content: [
        { type: "text", text: "a\nb" },
        { type: "image", data: "x", mimeType: "image/png" },
      ],
      isError: true,
    });

    expect(data.tool).toBe("bash");
    expect(data.toolCallId).toBe("call-1");
    expect(data.input).toEqual({ command: "ls" });
    expect(data.content).toBe("a\nb\n[图片 1 项]");
    expect(data.isError).toBe(true);
  });

  test("turn_end builds turnIndex/assistant/toolResults", () => {
    const data = buildTurnEndEventData({
      turnIndex: 2,
      assistant: assistantMessage([{ type: "text", text: "done" }]),
      toolResults: [toolResultMessage("bash", [{ type: "text", text: "ok" }])],
    });

    expect(data).toEqual({
      turnIndex: 2,
      assistant: "done",
      toolResults: [{ tool: "bash", content: "ok", isError: false }],
    });
  });

  test("agent_end builds messageCount", () => {
    expect(buildAgentEndEventData(7)).toEqual({ messageCount: 7 });
  });

  test("context_tokens builds tokens/threshold/level/messages", () => {
    const data = buildContextTokensEventData({
      tokens: 105_000,
      threshold: 100_000,
      level: 1,
      messages: [
        userMessage("hi"),
        assistantMessage([{ type: "text", text: "hello" }]),
      ],
    });

    expect(data.tokens).toBe(105_000);
    expect(data.threshold).toBe(100_000);
    expect(data.level).toBe(1);
    expect(data.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });
});

describe("default scope per trigger", () => {
  const assistant = assistantMessage([{ type: "text", text: "did the thing" }]);
  const toolResult = toolResultMessage("bash", [
    { type: "text", text: "output" },
  ]);

  test("turn_end defaults to the turn's assistant text and tool results", () => {
    const scope = buildScopeText({
      triggerType: "turn_end",
      eventData: {},
      defaultMessages: [assistant, toolResult],
      allMessages: [userMessage("older"), assistant, toolResult],
      maxWindowTokens: 20_000,
    });

    expect(scope).toBe("[assistant] did the thing\n[toolResult:bash] output");
  });

  test("agent_end defaults to the whole agent-loop message range", () => {
    const messages: AgentMessage[] = [userMessage("start"), assistant];
    const scope = buildScopeText({
      triggerType: "agent_end",
      eventData: {},
      defaultMessages: messages,
      allMessages: messages,
      maxWindowTokens: 20_000,
    });

    expect(scope).toBe("[user] start\n[assistant] did the thing");
  });

  test("context_tokens defaults to the incremental messages only", () => {
    const scope = buildScopeText({
      triggerType: "context_tokens",
      eventData: {},
      defaultMessages: [assistant],
      allMessages: [userMessage("old"), assistant],
      maxWindowTokens: 20_000,
    });

    expect(scope).toBe("[assistant] did the thing");
    expect(scope).not.toContain("old");
  });
});

describe("window overrides", () => {
  const messages: AgentMessage[] = [
    userMessage("m1"),
    userMessage("m2"),
    userMessage("m3"),
  ];

  test("{ messages: N } keeps the last N messages instead of the default", () => {
    const scope = buildScopeText({
      triggerType: "turn_end",
      eventData: {},
      defaultMessages: [messages[2]],
      allMessages: messages,
      window: { messages: 2 },
      maxWindowTokens: 20_000,
    });

    expect(scope).toBe("[user] m2\n[user] m3");
  });

  test("{ full: true } keeps every message", () => {
    const scope = buildScopeText({
      triggerType: "turn_end",
      eventData: {},
      defaultMessages: [messages[2]],
      allMessages: messages,
      window: { full: true },
      maxWindowTokens: 20_000,
    });

    expect(scope).toBe("[user] m1\n[user] m2\n[user] m3");
  });

  test("{ tokens: N } keeps the tail that fits the character/4 estimate", () => {
    const long = userMessage("x".repeat(400));
    const scope = buildScopeText({
      triggerType: "turn_end",
      eventData: {},
      defaultMessages: [],
      allMessages: [userMessage("tiny"), long],
      window: { tokens: 100 },
      maxWindowTokens: 20_000,
    });

    expect(scope).toContain("x".repeat(400));
    expect(scope).not.toContain("tiny");
    expect(sliceByTokens([userMessage("tiny"), long], 100)).toEqual([long]);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  test("tool_call rules with a window switch the scope to a conversation slice", () => {
    const scope = buildScopeText({
      triggerType: "tool_call",
      eventData: { tool: "bash", toolCallId: "c", input: { command: "ls" } },
      allMessages: messages,
      window: { messages: 1 },
      maxWindowTokens: 20_000,
    });

    expect(scope).toBe("[user] m3");
  });
});

describe("truncation and serialization", () => {
  test("string fields over 8000 characters are truncated with a marker", () => {
    const long = "y".repeat(8100);
    const data = buildToolCallEventData({
      toolName: "bash",
      toolCallId: "c",
      input: { command: long },
    });

    expect(typeof data.input).toBe("object");
    const command = (data.input as { command: string }).command;
    expect(command.length).toBeLessThan(long.length);
    expect(command).toContain("...[截断 100 字符]");
  });

  test("scope text over maxWindowTokens is trimmed from the head", () => {
    const long = userMessage("z".repeat(4000));
    const scope = buildScopeText({
      triggerType: "agent_end",
      eventData: {},
      defaultMessages: [long],
      allMessages: [long],
      maxWindowTokens: 100,
    });

    expect(scope.startsWith("...[范围截断 ")).toBe(true);
    expect(scope.endsWith("z".repeat(400))).toBe(true);
    expect(capScopeTokens("short", 100)).toBe("short");
  });

  test("thinking is inlined, redacted thinking is always omitted, toolCall is a placeholder", () => {
    const message = assistantMessage([
      { type: "thinking", thinking: "先检查配置文件" },
      { type: "thinking", thinking: "secret", redacted: true },
      {
        type: "toolCall",
        id: "c1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]);

    const text = serializeMessage(message, DEFAULT_SERIALIZE_OPTIONS);
    expect(text).toContain("[thinking: 先检查配置文件]");
    expect(text).not.toContain("secret");
    expect(text).toContain('[bash({"command":"ls"})]');
  });

  test("include switches remove thinking, tool inputs and tool outputs", () => {
    const options = {
      includeThinking: false,
      includeToolInputs: false,
      includeToolOutputs: false,
    };
    const assistant = assistantMessage([
      { type: "thinking", thinking: "hidden" },
      {
        type: "toolCall",
        id: "c1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]);
    const result = toolResultMessage("bash", [
      { type: "text", text: "output" },
    ]);

    expect(serializeMessage(assistant, options)).toBe("[bash]");
    expect(serializeMessage(result, options)).toBe("");
    expect(
      buildToolResultEventData(
        {
          toolName: "bash",
          toolCallId: "c1",
          input: { command: "ls" },
          content: [{ type: "text", text: "output" }],
          isError: false,
        },
        options,
      ),
    ).toEqual({
      tool: "bash",
      toolCallId: "c1",
      input: {},
      content: "",
      isError: false,
    });

    // On-state keeps everything for the same inputs.
    expect(serializeMessage(assistant, DEFAULT_SERIALIZE_OPTIONS)).toBe(
      '[thinking: hidden]\n[bash({"command":"ls"})]',
    );
    expect(serializeMessage(result, DEFAULT_SERIALIZE_OPTIONS)).toBe("output");
  });

  test("buildTranscriptText labels tool results with their tool name", () => {
    expect(
      buildTranscriptText([
        userMessage("hi"),
        toolResultMessage("grep", [{ type: "text", text: "match" }], true),
      ]),
    ).toBe("[user] hi\n[toolResult:grep] match");
  });
});
