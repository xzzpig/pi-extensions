import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type {
  AuditLoopFn,
  AuditModelRegistry,
} from "../extensions/audit-loop.ts";
import { VerdictCache } from "../extensions/cache.ts";
import type { SourcedRule } from "../extensions/config.ts";
import { SentinelRegistry, MAX_HISTORY } from "../extensions/registry.ts";
import {
  RuleRunner,
  Semaphore,
  type HistoryEntry,
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

const registryModels: AuditModelRegistry = {
  find: () => model,
  getAvailable: () => [model],
  hasConfiguredAuth: () => true,
};

const streamFnStub = (() => {
  throw new Error("unused");
}) as unknown as StreamFn;

function entry(index: number): HistoryEntry {
  return {
    at: index,
    ruleName: `rule-${index}`,
    kind: "audit",
    status: "skipped",
  };
}

describe("sentinel registry", () => {
  test("history rolls over after 20 records", () => {
    const registry = new SentinelRegistry();
    for (let index = 0; index < 25; index += 1) registry.record(entry(index));

    const history = registry.getHistory();
    expect(history).toHaveLength(MAX_HISTORY);
    expect(history[0]?.ruleName).toBe("rule-5");
    expect(history.at(-1)?.ruleName).toBe("rule-24");

    registry.clearHistory();
    expect(registry.getHistory()).toEqual([]);
  });

  test("dialog views are registered, updated, appended to, and removed", () => {
    const registry = new SentinelRegistry();
    registry.registerDialog({
      id: "d1",
      startedAt: 1,
      turnCount: 0,
      status: "running",
      transcript: [],
    });
    registry.appendDialogEntry("d1", { role: "user", text: "hi", at: 2 });
    registry.updateDialog("d1", { turnCount: 3, status: "done" });

    const [view] = registry.dialogsView();
    expect(view?.turnCount).toBe(3);
    expect(view?.status).toBe("done");
    expect(view?.transcript).toHaveLength(1);

    registry.removeDialog("d1");
    expect(registry.dialogsView()).toEqual([]);
  });

  test("runner status flows from idle to running and back", async () => {
    const registry = new SentinelRegistry();
    let settle!: (verdict: { verdict: "pass"; message: string }) => void;
    const loop: AuditLoopFn = () => ({
      async *[Symbol.asyncIterator]() {
        const verdict = await new Promise<{ verdict: "pass"; message: string }>(
          (resolve) => {
            settle = resolve;
          },
        );
        yield {
          type: "tool_execution_start",
          toolCallId: "c",
          toolName: "audit_verdict",
          args: verdict,
        } as AgentEvent;
        yield { type: "agent_end", messages: [] } as AgentEvent;
      },
      async result() {
        return [];
      },
    });

    const rule: SourcedRule = {
      name: "r",
      trigger: { type: "turn_end" },
      mode: "background",
      prompt: "check",
      source: "global",
    };
    const runner = new RuleRunner(rule, {
      audit: {
        agentLoop: loop,
        streamFn: streamFnStub,
        registry: registryModels,
        sessionModel: model,
        defaults: {},
        cwd: "/tmp",
      },
      cache: new VerdictCache(),
      semaphore: new Semaphore(3),
      history: registry,
    });
    registry.setRunners(new Map([[rule.name, runner]]));

    expect(registry.runningCount()).toBe(0);
    expect(registry.statuses()[0]?.state).toBe("idle");

    const pending = runner.run({
      ruleName: "r",
      rule,
      prompt: "check",
      scopeText: "scope",
      eventData: {},
    });
    const started = Date.now();
    while (registry.runningCount() === 0) {
      if (Date.now() - started > 1000) throw new Error("audit never started");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(registry.statuses()[0]?.state).toBe("running");
    expect(registry.statuses()[0]?.live).toHaveLength(1);

    settle({ verdict: "pass", message: "ok" });
    await pending;
    expect(registry.runningCount()).toBe(0);
    expect(registry.statuses()[0]?.state).toBe("idle");
  });
});
