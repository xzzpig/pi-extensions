import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type {
  AuditLoopFn,
  AuditModelRegistry,
} from "../extensions/audit-loop.ts";
import {
  ConfigureDialog,
  type ApplyChangeResult,
  type ConfigChange,
  type ConfigureHost,
} from "../extensions/configure-dialog.ts";
import type { ConfigScope, SourcedRule } from "../extensions/config.ts";
import { SentinelRegistry } from "../extensions/registry.ts";

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

const streamFnStub = (() => {
  throw new Error("unused");
}) as unknown as StreamFn;

const validRuleJson = JSON.stringify({
  name: "bash-safety",
  trigger: { type: "tool_call", tools: ["bash"] },
  mode: "blocking",
  prompt: "检查 {{input.command}}",
});

interface SubmitParams {
  changeType: "add" | "update" | "remove";
  ruleJson?: string;
  name?: string;
}

function makeHarness(options: {
  selects?: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  applyResult?: ApplyChangeResult;
  fileRules?: SourcedRule[];
}) {
  const selects = [...(options.selects ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const submitted: string[] = [];
  const applied: Array<{ change: ConfigChange; scope: ConfigScope }> = [];
  const notifications: string[] = [];
  let params: SubmitParams = { changeType: "add", ruleJson: validRuleJson };

  const loop: AuditLoopFn = (_prompts, context) => ({
    async *[Symbol.asyncIterator]() {
      const tool = context.tools?.find(
        (candidate) => candidate.name === "submit_config",
      );
      if (tool) {
        const result = await tool.execute("c", params, undefined, undefined);
        submitted.push(
          result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      }
      yield { type: "agent_end", messages: [] } as AgentEvent;
    },
    async result() {
      return [];
    },
  });

  const host: ConfigureHost = {
    applyChange: (change, scope) => {
      applied.push({ change, scope });
      return options.applyResult ?? { ok: true, summary: "已写入" };
    },
    closeFleet: async () => {},
    getRules: () => [],
    getFileRules: () => options.fileRules ?? [],
  };

  const sentinelRegistry = new SentinelRegistry();
  const dialog = new ConfigureDialog({
    agentLoop: loop,
    streamFn: streamFnStub,
    registry,
    sessionModel: model,
    defaults: {},
    host,
    sentinelRegistry,
  });

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      select: async () => selects.shift(),
      input: async () => inputs.shift(),
      confirm: async () => false,
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;

  return {
    dialog,
    ctx,
    submitted,
    applied,
    notifications,
    sentinelRegistry,
    setParams: (next: SubmitParams) => {
      params = next;
    },
  };
}

async function waitForSubmit(
  h: ReturnType<typeof makeHarness>,
): Promise<string> {
  const started = Date.now();
  while (h.submitted.length === 0) {
    if (Date.now() - started > 2000) throw new Error("submit never happened");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return h.submitted[0];
}

describe("configure dialog", () => {
  test("starts in the background and is visible to the fleet registry", () => {
    const h = makeHarness({});
    h.dialog.start(h.ctx, "检查 rm 命令是否安全");

    expect(h.dialog.isRunning).toBe(true);
    const views = h.sentinelRegistry.dialogsView();
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe("running");
    expect(views[0]?.transcript[0]?.text).toContain("rm 命令");
  });

  test("an invalid draft is not written and the error goes back to the loop", async () => {
    const h = makeHarness({});
    h.setParams({ changeType: "add", ruleJson: '{"name":"broken"}' });
    h.dialog.start(h.ctx, "配置");

    const result = await waitForSubmit(h);
    expect(result).toContain("校验失败");
    expect(h.applied).toHaveLength(0);
  });

  test("continue-adjusting returns the requirement and writes nothing", async () => {
    const h = makeHarness({
      selects: ["继续调整"],
      inputs: ["阈值消息里不要包含命令全文"],
    });
    h.dialog.start(h.ctx, "配置");

    const result = await waitForSubmit(h);
    expect(result).toContain("阈值消息里不要包含命令全文");
    expect(h.applied).toHaveLength(0);
  });

  test("discarding writes nothing", async () => {
    const h = makeHarness({ selects: ["放弃"] });
    h.dialog.start(h.ctx, "配置");

    const result = await waitForSubmit(h);
    expect(result).toContain("已放弃");
    expect(h.applied).toHaveLength(0);
  });

  test("removing a rule that does not exist reports the missing rule", async () => {
    const h = makeHarness({
      selects: ["写入", "project"],
      applyResult: { ok: false, error: '规则 "ghost" 在 project 配置中不存在' },
    });
    h.setParams({ changeType: "remove", name: "ghost" });
    h.dialog.start(h.ctx, "删除规则");

    const result = await waitForSubmit(h);
    expect(result).toContain("不存在");
    expect(h.applied).toEqual([
      { change: { type: "remove", name: "ghost" }, scope: "project" },
    ]);
  });

  test("a session rule shadowing an inherited namesake reports the shadowing", async () => {
    const h = makeHarness({
      selects: ["写入", "session"],
      fileRules: [
        {
          name: "bash-safety",
          trigger: { type: "tool_call", tools: ["bash"] },
          mode: "blocking",
          prompt: "global check",
          source: "global",
        },
      ],
    });
    h.setParams({ changeType: "add", ruleJson: validRuleJson });
    h.dialog.start(h.ctx, "配置");

    const result = await waitForSubmit(h);
    expect(result).toContain("遮蔽");
    expect(result).toContain("bash-safety");
  });

  test("a session rule without an inherited namesake has no shadow notice", async () => {
    const h = makeHarness({ selects: ["写入", "session"] });
    h.setParams({ changeType: "add", ruleJson: validRuleJson });
    h.dialog.start(h.ctx, "配置");

    const result = await waitForSubmit(h);
    expect(result).not.toContain("遮蔽");
  });

  test("a confirmed write selects the scope and applies the change", async () => {
    const h = makeHarness({ selects: ["写入", "global"] });
    h.dialog.start(h.ctx, "配置");

    const result = await waitForSubmit(h);
    expect(result).toContain("已写入 global 作用域");
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0].scope).toBe("global");
    expect(h.applied[0].change.type).toBe("add");
  });

  test("a failed write surfaces the error", async () => {
    const h = makeHarness({
      selects: ["写入", "project"],
      applyResult: { ok: false, error: "项目未受信任，无法写入项目配置" },
    });
    h.dialog.start(h.ctx, "配置");

    const result = await waitForSubmit(h);
    expect(result).toContain("写入失败");
    expect(result).toContain("未受信任");
  });
});
