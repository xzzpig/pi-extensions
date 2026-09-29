import { describe, expect, test } from "vitest";
import type { AuditOutcome } from "../extensions/audit-loop.ts";
import {
  cacheKey,
  hashRuleDefinition,
  VerdictCache,
} from "../extensions/cache.ts";
import type { SentinelRule } from "../extensions/config.ts";

function rule(overrides: Partial<SentinelRule> = {}): SentinelRule {
  return {
    name: "bash-safety",
    trigger: { type: "tool_call", tools: ["bash"] },
    mode: "blocking",
    prompt: "检查 {{input.command}}",
    ...overrides,
  };
}

function outcome(status: AuditOutcome["status"], message = "ok"): AuditOutcome {
  return {
    status,
    verdict: status === "verdict" ? { verdict: "pass", message } : undefined,
    durationMs: 5,
    unresolvedPaths: [],
    toolCallCount: 1,
    live: {
      ruleName: "bash-safety",
      startedAt: 0,
      model: "test/m",
      promptSummary: "",
      scopeSummary: "",
      unresolvedPaths: [],
      toolCallCount: 1,
      streamTail: "",
      steeredMessages: [],
      status: "done",
    },
  };
}

describe("verdict cache", () => {
  test("a verdict is reused within its TTL", () => {
    let now = 1000;
    const cache = new VerdictCache(() => now);
    const key = cacheKey("bash-safety", rule(), "rendered", "scope");

    expect(cache.put(key, "bash-safety", outcome("verdict", "safe"))).toBe(
      true,
    );
    now += 500;
    expect(cache.get(key, 1000)).toEqual({ verdict: "pass", message: "safe" });
  });

  test("an entry expires after its TTL and triggers a fresh audit", () => {
    let now = 0;
    const cache = new VerdictCache(() => now);
    const key = cacheKey("bash-safety", rule(), "rendered", "scope");
    cache.put(key, "bash-safety", outcome("verdict"));

    now = 1000;
    expect(cache.get(key, 1000)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test("failed audits are never cached", () => {
    const cache = new VerdictCache();
    const key = cacheKey("bash-safety", rule(), "rendered", "scope");

    expect(cache.put(key, "bash-safety", outcome("failed"))).toBe(false);
    expect(cache.put(key, "bash-safety", outcome("cancelled"))).toBe(false);
    expect(cache.get(key, 10_000)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test("a same-name rule with a different definition does not hit the old entry", () => {
    const cache = new VerdictCache();
    const original = rule();
    const changed = rule({ prompt: "不同的检查 {{input.command}}" });
    const key = cacheKey("bash-safety", original, "rendered", "scope");
    cache.put(key, "bash-safety", outcome("verdict"));

    expect(hashRuleDefinition(original)).not.toBe(hashRuleDefinition(changed));
    const changedKey = cacheKey("bash-safety", changed, "rendered", "scope");
    expect(changedKey).not.toBe(key);
    expect(cache.get(changedKey, 10_000)).toBeUndefined();
  });

  test("invalidateRule drops only that rule's entries and clear() empties everything", () => {
    const cache = new VerdictCache();
    const other: SentinelRule = { ...rule(), name: "edit-style" };
    cache.put(
      cacheKey("bash-safety", rule(), "p", "s"),
      "bash-safety",
      outcome("verdict"),
    );
    cache.put(
      cacheKey("edit-style", other, "p", "s"),
      "edit-style",
      outcome("verdict"),
    );

    expect(cache.invalidateRule("bash-safety")).toBe(1);
    expect(
      cache.get(cacheKey("bash-safety", rule(), "p", "s"), 10_000),
    ).toBeUndefined();
    expect(
      cache.get(cacheKey("edit-style", other, "p", "s"), 10_000),
    ).toBeDefined();

    cache.clear();
    expect(cache.size()).toBe(0);
  });

  test("the key is stable across key order and sensitive to every input", () => {
    const a: SentinelRule = rule({ timeoutMs: 1000, enabled: true });
    const b: SentinelRule = rule({ enabled: true, timeoutMs: 1000 });
    expect(hashRuleDefinition(a)).toBe(hashRuleDefinition(b));
    expect(cacheKey("bash-safety", a, "p", "s")).not.toBe(
      cacheKey("bash-safety", a, "p2", "s"),
    );
    expect(cacheKey("bash-safety", a, "p", "s")).not.toBe(
      cacheKey("bash-safety", a, "p", "s2"),
    );
    expect(cacheKey("bash-safety", a, "p", "s")).not.toBe(
      cacheKey("other", a, "p", "s"),
    );
  });
});
