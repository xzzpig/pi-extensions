import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  createHarness,
  failVerdict,
  messageText,
  passVerdict,
  waitUntil,
} from "./harness.ts";

function commandCtx(
  h: ReturnType<typeof createHarness>,
): ExtensionCommandContext {
  return h.ctx as ExtensionCommandContext;
}

describe("/sentinel:test dry run", () => {
  test("shows the verdict and produces no dispatch side effects", async () => {
    const h = createHarness({
      rules: [
        {
          name: "bash-safety",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
          prompt: "检查 {{input.command}}",
        },
      ],
    });

    const first = h.runtime.handleTestCommand(
      "bash-safety rm -rf /tmp/build",
      commandCtx(h),
    );
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict({ verdict: "fail", message: "危险命令" });
    await first;

    const output = h.notified.map((entry) => entry.message).join("\n");
    expect(output).toContain("试运行");
    expect(output).toContain("fail");
    expect(output).toContain("危险命令");

    // No injection, no tool blocking, no cache, no cooldown.
    expect(h.sent).toHaveLength(0);
    expect(h.runtime.getRunners().get("bash-safety")?.isCoolingDown()).toBe(
      false,
    );
    expect(
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.kind === "test"),
    ).toBe(true);

    // A second identical dry run runs a fresh audit (nothing was cached).
    const second = h.runtime.handleTestCommand(
      "bash-safety rm -rf /tmp/build",
      commandCtx(h),
    );
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(passVerdict);
    await second;
    expect(h.controls).toHaveLength(2);
  });

  test("an unknown rule name reports an error", async () => {
    const h = createHarness({ rules: [] });
    await h.runtime.handleTestCommand("ghost content", commandCtx(h));

    expect(h.notified.some((entry) => entry.message.includes("不存在"))).toBe(
      true,
    );
    expect(h.controls).toHaveLength(0);
  });

  test("disabled rules can still be dry-run", async () => {
    const h = createHarness({
      rules: [
        {
          name: "r",
          trigger: { type: "turn_end" },
          prompt: "检查",
        },
      ],
    });
    h.runtime.setRuleEnabled("r", false, h.ctx);

    const pending = h.runtime.handleTestCommand("r 模拟内容", commandCtx(h));
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(passVerdict);
    await pending;

    expect(h.notified.some((entry) => entry.message.includes("试运行"))).toBe(
      true,
    );
  });

  test("a missing usage line and empty args are handled", async () => {
    const h = createHarness({ rules: [] });
    await h.runtime.handleTestCommand("", commandCtx(h));
    expect(h.notified.some((entry) => entry.message.includes("用法"))).toBe(
      true,
    );
  });

  test("dry running an event rule simulates the configured payload without side effects", async () => {
    const h = createHarness({
      rules: [
        {
          name: "compact-watch",
          trigger: { type: "event", event: "core:session_compact" },
          mode: "background",
          prompt: "检查 {{name}} {{event.reason}}",
        },
      ],
    });

    const pending = h.runtime.handleTestCommand(
      'compact-watch {"reason":"手动压缩"}',
      commandCtx(h),
    );
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict({ verdict: "warn", message: "注意压缩时机" });
    await pending;

    const output = h.notified.map((entry) => entry.message).join("\n");
    expect(output).toContain("试运行");
    expect(output).toContain("warn");
    expect(output).toContain("注意压缩时机");
    expect(output).toContain("audit-model");
    expect(output).toMatch(/耗时：\d+ms/);

    // The simulated event data reaches the audit as the template root and the
    // payload-JSON scope block.
    const auditText = h.capturedPrompts[0].map(messageText).join("\n");
    expect(auditText).toContain("检查 core:session_compact 手动压缩");
    expect(auditText).toContain(
      JSON.stringify({
        name: "core:session_compact",
        event: { reason: "手动压缩" },
      }),
    );

    // No injection, no cache, no cooldown.
    expect(h.sent).toHaveLength(0);
    expect(h.runtime.getRunners().get("compact-watch")?.isCoolingDown()).toBe(
      false,
    );
    expect(
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.kind === "test"),
    ).toBe(true);
  });

  test("a failed dry run reports the failure without entering the cooldown", async () => {
    const h = createHarness({
      rules: [
        {
          name: "r",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
          prompt: "检查",
        },
      ],
    });

    const pending = h.runtime.handleTestCommand("r ls", commandCtx(h));
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].fail("模型超时");
    await pending;

    expect(h.notified.some((entry) => entry.message.includes("审计失败"))).toBe(
      true,
    );
    expect(h.runtime.getRunners().get("r")?.isCoolingDown()).toBe(false);
    expect(
      h.runtime
        .getRegistry()
        .getHistory()
        .some((entry) => entry.kind === "test" && entry.status === "failed"),
    ).toBe(true);
  });
});
