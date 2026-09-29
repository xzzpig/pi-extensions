import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  createHarness,
  failVerdict,
  passVerdict,
  waitUntil,
  warnVerdict,
  type Harness,
} from "./harness.ts";

function toolCall(toolCallId = "c1", command = "rm -rf /"): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "bash",
    input: { command },
  } as unknown as ToolCallEvent;
}

function toolResult(
  toolCallId = "c1",
  text = "original output",
): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId,
    toolName: "bash",
    input: { command: "rm -rf /" },
    content: [{ type: "text", text }],
    isError: false,
  } as unknown as ToolResultEvent;
}

async function runGate(h: Harness, toolCallId = "c1") {
  return h.runtime.handleToolCall(toolCall(toolCallId), h.ctx);
}

describe("blocking tool_call gate", () => {
  test("a fail verdict blocks the call with a merged reason", async () => {
    const h = createHarness({
      rules: [
        {
          name: "bash-safety",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
      ],
    });

    const pending = runGate(h);
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict({ verdict: "fail", message: "rm -rf 太危险" });
    const result = await pending;

    expect(result).toEqual({
      block: true,
      reason: '[pi-sentinel] 规则 "bash-safety" 拦截本次调用：rm -rf 太危险',
    });
  });

  test("a non-matching tool name does not trigger the rule", async () => {
    const h = createHarness({
      rules: [
        {
          name: "bash-safety",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
      ],
    });

    const result = await h.runtime.handleToolCall(
      {
        type: "tool_call",
        toolCallId: "c9",
        toolName: "read",
        input: { path: "a" },
      } as unknown as ToolCallEvent,
      h.ctx,
    );

    expect(result).toBeUndefined();
    expect(h.controls).toHaveLength(0);
  });

  test("an audit failure allows the call by default and starts the negative cooldown", async () => {
    const h = createHarness({
      rules: [
        {
          name: "bash-safety",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
      ],
    });

    const first = runGate(h, "c1");
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].fail("模型超时");
    expect(await first).toBeUndefined();
    expect(h.notified.some((entry) => entry.message.includes("审计失败"))).toBe(
      true,
    );

    // Inside the cooldown no new audit is started and the call is still allowed.
    expect(await runGate(h, "c2")).toBeUndefined();
    expect(h.controls).toHaveLength(1);
  });

  test("fail-closed blocks on failure and during the cooldown", async () => {
    const h = createHarness({
      rules: [
        {
          name: "strict",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
          onFailure: "closed",
        },
      ],
    });

    const first = runGate(h, "c1");
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].fail("模型超时");
    const firstResult = await first;
    expect(firstResult?.block).toBe(true);
    expect(firstResult?.reason).toContain("fail-closed");
    expect(firstResult?.reason).toContain("模型超时");

    const second = await runGate(h, "c2");
    expect(second?.block).toBe(true);
    expect(second?.reason).toContain("审计持续失败（负冷却中）");
    expect(h.controls).toHaveLength(1);
  });

  test("any failing rule blocks, and pass rules do not", async () => {
    const h = createHarness({
      rules: [
        {
          name: "rule-a",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
        {
          name: "rule-b",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
      ],
    });

    const pending = runGate(h);
    await waitUntil(() => h.controls.length === 2);
    h.controls[0].verdict(passVerdict);
    h.controls[1].verdict({ verdict: "fail", message: "规则 B 拒绝" });
    const result = await pending;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("规则 B 拒绝");
    expect(result?.reason).not.toContain("rule-a");
  });

  test("a warn verdict is prepended to the tool result with the original content kept", async () => {
    const h = createHarness({
      rules: [
        {
          name: "z-warn",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
        {
          name: "a-warn",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
      ],
    });

    const pending = runGate(h);
    await waitUntil(() => h.controls.length === 2);
    h.controls[0].verdict({ verdict: "warn", message: "z 提醒" });
    h.controls[1].verdict({ verdict: "warn", message: "a 提醒" });
    expect(await pending).toBeUndefined();

    const original = toolResult();
    const result = await h.runtime.handleToolResult(original, h.ctx);

    expect(result?.content).toHaveLength(2);
    const prefix = result?.content?.[0];
    expect(prefix?.type).toBe("text");
    const prefixText = prefix && prefix.type === "text" ? prefix.text : "";
    expect(prefixText).toContain("[pi-sentinel][warn] a-warn: a 提醒");
    expect(prefixText).toContain("[pi-sentinel][warn] z-warn: z 提醒");
    expect(prefixText.indexOf("a-warn")).toBeLessThan(
      prefixText.indexOf("z-warn"),
    );
    expect(result?.content?.[1]).toEqual({
      type: "text",
      text: "original output",
    });

    // The entry is consumed: a second result for the same call has no prefix.
    expect(await h.runtime.handleToolResult(original, h.ctx)).toBeUndefined();
  });

  test("a blocked call drops its pending warn entry (fail wins)", async () => {
    const h = createHarness({
      rules: [
        {
          name: "warner",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
        {
          name: "blocker",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
        },
      ],
    });

    const pending = runGate(h);
    await waitUntil(() => h.controls.length === 2);
    h.controls[0].verdict(warnVerdict);
    h.controls[1].verdict(failVerdict);
    const result = await pending;
    expect(result?.block).toBe(true);

    // The blocked call never produces a tool_result, and no warn entry leaked.
    expect(
      await h.runtime.handleToolResult(toolResult(), h.ctx),
    ).toBeUndefined();
    expect(
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.status === "skipped"),
    ).toBe(false);
  });
});
