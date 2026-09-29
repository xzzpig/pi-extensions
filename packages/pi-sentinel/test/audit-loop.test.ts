import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentLoopConfig,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { SentinelDefaults, SentinelRule } from "../extensions/config.ts";
import {
  startAudit,
  type AuditEventStream,
  type AuditLoopFn,
  type AuditModelRegistry,
} from "../extensions/audit-loop.ts";
import { SCOPE_SEPARATOR } from "../extensions/template.ts";

const model = {
  id: "audit-model",
  name: "Audit Model",
  api: "anthropic-messages",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
} as unknown as Model<Api>;

const registry: AuditModelRegistry = {
  find: (provider, modelId) =>
    provider === "test" && modelId === "audit-model" ? model : undefined,
  getAvailable: () => [model],
  hasConfiguredAuth: () => true,
};

const defaults: SentinelDefaults = { thinking: "off", cache: true };

const streamFnStub = (() => {
  throw new Error("streamFn should not be called by the fake loop");
}) as unknown as StreamFn;

function rule(overrides: Partial<SentinelRule> = {}): SentinelRule {
  return {
    name: "r",
    trigger: { type: "turn_end" },
    mode: "background",
    prompt: "check",
    ...overrides,
  };
}

function textOf(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function fakeStream(
  events: AgentEvent[],
  finalMessages: AgentMessage[] = [],
): AuditEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return finalMessages;
    },
  };
}

function deps(loop: AuditLoopFn) {
  return {
    agentLoop: loop,
    streamFn: streamFnStub,
    registry,
    sessionModel: model,
    defaults,
    cwd: "/tmp",
  };
}

function request(overrides: Partial<SentinelRule> = {}) {
  return {
    ruleName: "r",
    rule: rule(overrides),
    prompt: "检查 {{tool}}",
    scopeText: '{"tool":"bash"}',
    eventData: { tool: "bash" },
  };
}

describe("audit loop", () => {
  test("a verdict tool call is the conclusion", async () => {
    let capturedPrompts: AgentMessage[] = [];
    let capturedContext: AgentContext | undefined;
    const loop: AuditLoopFn = (prompts, context) => {
      capturedPrompts = prompts;
      capturedContext = context;
      return fakeStream([
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "audit_verdict",
          args: { verdict: "fail", message: "rm -rf 太危险" },
        },
        { type: "agent_end", messages: [] },
      ]);
    };

    const handle = startAudit(request(), deps(loop));
    const outcome = await handle.done;

    expect(outcome.status).toBe("verdict");
    expect(outcome.verdict).toEqual({
      verdict: "fail",
      message: "rm -rf 太危险",
    });
    expect(outcome.toolCallCount).toBe(1);
    expect(outcome.model).toBe("test/audit-model");

    // Leading system message + two-part user message, tools declared in context.
    expect(capturedContext?.messages[0]?.role).toBe("system");
    expect(capturedPrompts[0]?.role).toBe("user");
    expect(
      textOf(capturedPrompts[0] ?? { role: "user", content: "", timestamp: 0 }),
    ).toContain(SCOPE_SEPARATOR);
    expect(capturedContext?.tools?.map((tool) => tool.name)).toEqual([
      "audit_verdict",
    ]);
  });

  test("finishing without a verdict is an audit failure", async () => {
    const loop: AuditLoopFn = () =>
      fakeStream([{ type: "agent_end", messages: [] }]);

    const outcome = await startAudit(request(), deps(loop)).done;

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toContain("未产生裁决");
    expect(outcome.verdict).toBeUndefined();
  });

  test("an invalid verdict payload is an audit failure", async () => {
    const loop: AuditLoopFn = () =>
      fakeStream([
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "audit_verdict",
          args: { verdict: "maybe", message: "" },
        },
        { type: "agent_end", messages: [] },
      ]);

    const outcome = await startAudit(request(), deps(loop)).done;

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toContain("未产生裁决");
  });

  test("whitelisted read-only tools are enabled alongside the verdict tool", async () => {
    let capturedContext: AgentContext | undefined;
    const loop: AuditLoopFn = (_prompts, context) => {
      capturedContext = context;
      return fakeStream([
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "audit_verdict",
          args: { verdict: "pass", message: "无问题" },
        },
        { type: "agent_end", messages: [] },
      ]);
    };

    const outcome = await startAudit(
      request({ tools: ["read", "grep"] }),
      deps(loop),
    ).done;

    expect(outcome.status).toBe("verdict");
    expect(capturedContext?.tools?.map((tool) => tool.name)).toEqual([
      "audit_verdict",
      "read",
      "grep",
    ]);
  });

  test("steering messages reach the next turn boundary", async () => {
    let steered: AgentMessage[] = [];
    let config: AgentLoopConfig | undefined;
    const loop: AuditLoopFn = (
      _prompts,
      _context,
      loopConfig,
    ): AuditEventStream => {
      config = loopConfig;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "turn_start" } as AgentEvent;
          const messages = await loopConfig.getSteeringMessages?.();
          steered = messages ?? [];
          yield {
            type: "tool_execution_start",
            toolCallId: "c1",
            toolName: "audit_verdict",
            args: { verdict: "warn", message: "注意路径" },
          } as AgentEvent;
          yield { type: "agent_end", messages: [] } as AgentEvent;
        },
        async result() {
          return [];
        },
      };
    };

    const handle = startAudit(request({ tools: ["read"] }), deps(loop));
    expect(handle.steer("重点核对配置文件的写入路径")).toBe(true);

    const outcome = await handle.done;

    expect(outcome.status).toBe("verdict");
    expect(steered).toHaveLength(1);
    expect(
      textOf(steered[0] ?? { role: "user", content: "", timestamp: 0 }),
    ).toBe("重点核对配置文件的写入路径");
    expect(outcome.live.steeredMessages).toEqual([
      "重点核对配置文件的写入路径",
    ]);
    expect(config?.finishTurn).toBeTypeOf("function");
  });

  test("steering is rejected once the audit has ended", async () => {
    const loop: AuditLoopFn = () =>
      fakeStream([
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "audit_verdict",
          args: { verdict: "pass", message: "无问题" },
        },
        { type: "agent_end", messages: [] },
      ]);

    const handle = startAudit(request(), deps(loop));
    await handle.done;

    expect(handle.steer("too late")).toBe(false);
  });

  test("a hung loop fails on timeout and a cancelled loop is not a failure", async () => {
    const hung: AuditLoopFn = () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
      async result() {
        return [];
      },
    });

    const timedOut = await startAudit(request({ timeoutMs: 10 }), deps(hung))
      .done;
    expect(timedOut.status).toBe("failed");
    expect(timedOut.failureReason).toContain("审计超时");

    const handle = startAudit(request({ timeoutMs: 5000 }), deps(hung));
    handle.abort();
    const cancelled = await handle.done;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failureReason).toBeUndefined();
  });

  test("an unresolvable model fails before the loop starts", async () => {
    let loopCalls = 0;
    const loop: AuditLoopFn = () => {
      loopCalls += 1;
      return fakeStream([]);
    };

    const outcome = await startAudit(
      request({ model: "nope/missing" }),
      deps(loop),
    ).done;

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toContain("模型未找到");
    expect(loopCalls).toBe(0);
  });
});
