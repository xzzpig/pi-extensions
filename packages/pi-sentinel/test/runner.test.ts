import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type {
  AuditLoopFn,
  AuditModelRegistry,
  AuditVerdict,
} from "../extensions/audit-loop.ts";
import { VerdictCache } from "../extensions/cache.ts";
import type { SentinelDefaults, SourcedRule } from "../extensions/config.ts";
import {
  RuleRunner,
  Semaphore,
  type HistoryEntry,
  type RunnerContext,
} from "../extensions/runner.ts";

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
  find: () => model,
  getAvailable: () => [model],
  hasConfiguredAuth: () => true,
};

const defaults: SentinelDefaults = { thinking: "off", cache: true };

const streamFnStub = (() => {
  throw new Error("unused");
}) as unknown as StreamFn;

interface AuditControl {
  verdict(verdict: AuditVerdict): void;
  fail(reason: string): void;
}

interface Harness {
  controls: AuditControl[];
  history: HistoryEntry[];
  findings: AuditVerdict[];
  failures: string[];
  context: RunnerContext;
  runner(rule: SourcedRule): RuleRunner;
}

function makeHarness(maxConcurrent = 3): Harness {
  const controls: AuditControl[] = [];
  const history: HistoryEntry[] = [];
  const findings: AuditVerdict[] = [];
  const failures: string[] = [];

  const loop: AuditLoopFn = () => {
    let settle!: (
      kind: "verdict" | "failed",
      payload: AuditVerdict | string,
    ) => void;
    const gate = new Promise<{
      kind: "verdict" | "failed";
      payload: AuditVerdict | string;
    }>((resolve) => {
      settle = (kind, payload) => resolve({ kind, payload });
    });
    controls.push({
      verdict: (verdict) => settle("verdict", verdict),
      fail: (reason) => settle("failed", reason),
    });
    return {
      async *[Symbol.asyncIterator]() {
        const result = await gate;
        if (result.kind === "verdict") {
          yield {
            type: "tool_execution_start",
            toolCallId: "c",
            toolName: "audit_verdict",
            args: result.payload,
          } as AgentEvent;
        } else {
          yield {
            type: "turn_end",
            message: {
              role: "assistant",
              content: [],
              api: "anthropic-messages",
              provider: "test",
              model: "audit-model",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "error",
              errorMessage: String(result.payload),
              timestamp: 0,
            } satisfies AssistantMessage,
            toolResults: [],
          } as AgentEvent;
        }
        yield { type: "agent_end", messages: [] } as AgentEvent;
      },
      async result() {
        return [];
      },
    };
  };

  const context: RunnerContext = {
    audit: {
      agentLoop: loop,
      streamFn: streamFnStub,
      registry,
      sessionModel: model,
      defaults,
      cwd: "/tmp",
    },
    cache: new VerdictCache(),
    semaphore: new Semaphore(maxConcurrent),
    history: { record: (entry) => history.push(entry) },
    onFinding: (_rule, verdict) => {
      findings.push(verdict);
    },
    onAuditFailure: (_rule, reason) => {
      failures.push(reason);
    },
  };

  return {
    controls,
    history,
    findings,
    failures,
    context,
    runner: (rule) => new RuleRunner(rule, context),
  };
}

function rule(overrides: Partial<SourcedRule> = {}): SourcedRule {
  return {
    name: "r",
    trigger: { type: "tool_call", tools: ["bash"] },
    mode: "background",
    prompt: "check",
    source: "global",
    ...overrides,
  };
}

function request(prompt = "check") {
  return {
    ruleName: "r",
    rule: rule(),
    prompt,
    scopeText: "scope",
    eventData: { tool: "bash" },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const pass: AuditVerdict = { verdict: "pass", message: "ok" };
const fail: AuditVerdict = { verdict: "fail", message: "bad" };

describe("overlap strategies", () => {
  test("ignore drops a new trigger while the rule is busy", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ overlap: "ignore" }));

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    const second = await runner.run(request("two"));

    expect(second.skipped?.reason).toContain("busy");
    expect(h.controls).toHaveLength(1);

    h.controls[0].verdict(pass);
    await first;
    expect(h.history.some((entry) => entry.status === "skipped")).toBe(true);
  });

  test("replace aborts the running background audit without a failure or cooldown", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ overlap: "replace" }));

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    const second = runner.run(request("two"));
    await waitUntil(() => h.controls.length === 2);

    h.controls[1].verdict(pass);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.verdict).toBeUndefined();
    expect(firstResult.failure).toBeUndefined();
    expect(secondResult.verdict).toEqual(pass);
    expect(h.history.some((entry) => entry.status === "cancelled")).toBe(true);
    expect(h.history.some((entry) => entry.status === "failed")).toBe(false);
    expect(runner.isCoolingDown()).toBe(false);
  });

  test("serial queues every trigger and runs them in arrival order", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ overlap: "serial" }));

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    const second = runner.run(request("two"));
    const third = runner.run(request("three"));
    await waitUntil(() => runner.status().queuedCount === 2);

    h.controls[0].verdict({ verdict: "warn", message: "first" });
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict({ verdict: "warn", message: "second" });
    await waitUntil(() => h.controls.length === 3);
    h.controls[2].verdict({ verdict: "warn", message: "third" });

    const results = await Promise.all([first, second, third]);
    expect(results.map((result) => result.verdict?.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(
      h.history.filter((entry) => entry.status === "verdict"),
    ).toHaveLength(3);
  });

  test("blocking replace waits for the running audit instead of aborting it", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ mode: "blocking", overlap: "replace" }));

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    const second = runner.run(request("two"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.controls).toHaveLength(1);

    h.controls[0].verdict(pass);
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(pass);

    await Promise.all([first, second]);
    expect(
      h.history.filter((entry) => entry.status === "cancelled"),
    ).toHaveLength(0);
  });

  test("the saturation matrix follows each rule's overlap under a global limit", async () => {
    const h = makeHarness(1);
    const parallel = h.runner(rule({ name: "parallel", overlap: "parallel" }));
    const serial = h.runner(rule({ name: "serial", overlap: "serial" }));
    const ignore = h.runner(rule({ name: "ignore", overlap: "ignore" }));

    const running = parallel.run({ ...request("p"), ruleName: "parallel" });
    await waitUntil(() => h.controls.length === 1);

    const queued = serial.run({ ...request("s"), ruleName: "serial" });
    const dropped = await ignore.run({ ...request("i"), ruleName: "ignore" });

    expect(dropped.skipped?.reason).toContain("concurrency limit");
    expect(h.controls).toHaveLength(1);
    await waitUntil(() => h.context.semaphore.waitingCount === 1);

    h.controls[0].verdict(pass);
    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(pass);

    await Promise.all([running, queued]);
    expect(h.controls).toHaveLength(2);
  });
});

describe("failure policy and cooldown", () => {
  test("fail-open returns the failure with policy open and enters the negative cooldown", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ mode: "blocking" }));

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].fail("模型超时");
    const result = await first;

    expect(result.failure?.reason).toContain("模型超时");
    expect(result.failure?.policy).toBe("open");
    expect(runner.isCoolingDown()).toBe(true);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toContain("模型超时");

    const duringCooldown = await runner.run(request("two"));
    expect(duringCooldown.failure?.reason).toContain("负冷却");
    expect(h.controls).toHaveLength(1);
  });

  test("fail-closed reports policy closed during and after a failure", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ mode: "blocking", onFailure: "closed" }));

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].fail("模型超时");
    const result = await first;

    expect(result.failure?.reason).toContain("模型超时");
    expect(result.failure?.policy).toBe("closed");

    const duringCooldown = await runner.run(request("two"));
    expect(duringCooldown.failure).toEqual({
      reason: "审计持续失败（负冷却中）",
      policy: "closed",
    });
  });

  test("audits already queued when a failure happens still execute", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ overlap: "serial" }));

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    const second = runner.run(request("two"));
    await waitUntil(() => runner.status().queuedCount === 1);

    h.controls[0].fail("boom");
    await first;
    expect(runner.isCoolingDown()).toBe(true);

    await waitUntil(() => h.controls.length === 2);
    h.controls[1].verdict(pass);
    const secondResult = await second;

    expect(secondResult.verdict).toEqual(pass);
    expect(h.controls).toHaveLength(2);
  });
});

describe("cache dispatch", () => {
  test("a cache hit reuses the verdict and still dispatches the finding", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ overlap: "parallel", cache: true }));

    const first = runner.run(request("same"));
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(fail);
    await first;

    const second = await runner.run(request("same"));

    expect(second.cached).toBe(true);
    expect(second.verdict).toEqual(fail);
    expect(h.controls).toHaveLength(1);
    expect(h.findings).toHaveLength(2);
    expect(h.history.some((entry) => entry.cached === true)).toBe(true);
  });

  test("pass verdicts are silent for background rules", async () => {
    const h = makeHarness();
    const runner = h.runner(rule());

    const first = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    h.controls[0].verdict(pass);
    await first;

    expect(h.findings).toHaveLength(0);
  });
});

describe("hot reload and lifecycle", () => {
  test("setRule drops queued audits, invalidates cache, and running audits keep the old rule", async () => {
    const h = makeHarness();
    const oldRule = rule({ overlap: "serial", prompt: "old prompt" });
    const runner = h.runner(oldRule);

    const running = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    const queued = runner.run(request("two"));
    await waitUntil(() => runner.status().queuedCount === 1);

    runner.setRule({ ...oldRule, prompt: "new prompt" });

    const queuedResult = await queued;
    expect(queuedResult.skipped?.reason).toContain("dropped");

    h.controls[0].verdict(fail);
    const runningResult = await running;
    expect(runningResult.verdict).toEqual(fail);
    // Running audit dispatched under the captured (old) rule identity.
    expect(h.findings).toEqual([fail]);
  });

  test("abortAll cancels in-flight audits and drops queued ones", async () => {
    const h = makeHarness();
    const runner = h.runner(rule({ overlap: "serial" }));

    const running = runner.run(request("one"));
    await waitUntil(() => h.controls.length === 1);
    const queued = runner.run(request("two"));

    runner.abortAll();

    const [runningResult, queuedResult] = await Promise.all([running, queued]);
    expect(runningResult.verdict).toBeUndefined();
    expect(queuedResult.skipped).toBeDefined();
    expect(h.history.some((entry) => entry.status === "cancelled")).toBe(true);
  });
});
