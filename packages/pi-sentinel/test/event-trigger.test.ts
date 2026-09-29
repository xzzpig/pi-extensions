import { describe, expect, test } from "vitest";
import type { SourcedRule } from "../extensions/config.ts";
import { createHarness, messageText, waitUntil } from "./harness.ts";

function eventRule(
  name: string,
  event: string,
  extra: Partial<SourcedRule> = {},
): Partial<SourcedRule> & { name: string } {
  return {
    name,
    trigger: { type: "event", event },
    mode: "background",
    prompt: "{{name}}|{{json event}}",
    ...extra,
  };
}

describe("event trigger dispatch", () => {
  test("a bus event triggers an audit carrying the event data", async () => {
    const h = createHarness({
      register: true,
      rules: [
        eventRule("bus-rule", "pi-subagents:done", {
          prompt: "{{name}}|{{event.summary}}",
          cache: false,
        }),
      ],
    });
    expect(h.runtime.getEventSubscriptionRegistry()?.subscribedNames()).toEqual(
      ["pi-subagents:done"],
    );

    h.busHandlers.get("pi-subagents:done")?.({ summary: "任务完成" });
    await waitUntil(() => h.controls.length === 1);

    const prompt = messageText(h.capturedPrompts[0][0]);
    expect(prompt).toContain("pi-subagents:done");
    expect(prompt).toContain("任务完成");
  });

  test("a core event triggers an audit with the configured name", async () => {
    const h = createHarness({
      register: true,
      rules: [eventRule("core-rule", "core:session_compact", { cache: false })],
    });

    // The registry subscribes to the host under the bare name.
    h.handlers.get("session_compact")?.({ reason: "手动压缩" }, h.ctx);
    await waitUntil(() => h.controls.length === 1);

    const prompt = messageText(h.capturedPrompts[0][0]);
    expect(prompt).toContain("core:session_compact");
    expect(prompt).toContain("手动压缩");
  });

  test("a disabled event rule does not fire", async () => {
    const h = createHarness({
      register: true,
      rules: [eventRule("off", "pi-subagents:done", { enabled: false })],
    });

    h.busHandlers.get("pi-subagents:done")?.({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.controls).toHaveLength(0);
    expect(h.runtime.getRegistry().getHistory()).toHaveLength(0);
  });

  test("two rules on the same event each fire once", async () => {
    const h = createHarness({
      register: true,
      rules: [
        eventRule("a", "core:session_compact", {
          prompt: "rule a",
          cache: false,
        }),
        eventRule("b", "core:session_compact", {
          prompt: "rule b",
          cache: false,
        }),
      ],
    });
    expect(h.runtime.getEventSubscriptionRegistry()?.subscribedNames()).toEqual(
      ["core:session_compact"],
    );

    h.handlers.get("session_compact")?.({ reason: "x" }, h.ctx);
    await waitUntil(() => h.controls.length === 2);

    expect(h.controls).toHaveLength(2);
    const prompts = h.capturedPrompts.map((entry) => messageText(entry[0]));
    expect(prompts.some((prompt) => prompt.includes("rule a"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("rule b"))).toBe(true);
  });

  test("a bus event with no runtime ctx is skipped", async () => {
    const h = createHarness({
      register: true,
      rules: [eventRule("bus", "pi-subagents:done")],
    });
    // White-box: simulate a runtime that has not seen a session yet.
    (h.runtime as unknown as { ctx: unknown }).ctx = null;

    h.busHandlers.get("pi-subagents:done")?.({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.controls).toHaveLength(0);
    expect(h.runtime.getRegistry().getHistory()).toHaveLength(0);
  });

  test("a dispatch failure warns without disturbing the host", async () => {
    const h = createHarness({
      register: true,
      rules: [eventRule("boom", "pi-subagents:done")],
    });
    (
      h.ctx.sessionManager as unknown as { buildContextEntries: () => never }
    ).buildContextEntries = () => {
      throw new Error("boom");
    };

    expect(() =>
      h.busHandlers.get("pi-subagents:done")?.({ ok: true }),
    ).not.toThrow();
    await waitUntil(() =>
      h.notified.some((entry) => entry.message.includes("事件分发失败")),
    );
    expect(
      h.notified.find((entry) => entry.message.includes("事件分发失败"))?.type,
    ).toBe("warning");
  });

  test("one rule's failure does not starve sibling rules", async () => {
    const h = createHarness({
      register: true,
      rules: [
        eventRule("broken", "pi-subagents:done", {
          // Uncompilable Handlebars: renderTemplate throws inside buildRequest.
          prompt: "{{#if unclosed}}",
        }),
        eventRule("healthy", "pi-subagents:done", { prompt: "{{name}}|ok" }),
      ],
    });

    h.busHandlers.get("pi-subagents:done")?.({ summary: "x" });
    await waitUntil(() => h.controls.length === 1);

    expect(
      h.notified.find((entry) => entry.message.includes('规则 "broken"'))?.type,
    ).toBe("warning");
    expect(messageText(h.capturedPrompts[0][0])).toContain("|ok");
  });
});
