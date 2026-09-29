import type {
  AgentContext,
  AgentMessage,
  AgentLoopConfig,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  convertToLlm,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Model } from "@earendil-works/pi-ai";
import {
  resolveAuditModel,
  type AuditEventStream,
  type AuditLoopFn,
  type AuditModelRegistry,
} from "./audit-loop.js";
import {
  validateRule,
  type ConfigScope,
  type SentinelDefaults,
  type SentinelRule,
  type SourcedRule,
} from "./config.js";
import type { SentinelRegistry } from "./registry.js";

/**
 * `/sentinel:configure`: a background natural-language configuration dialog.
 *
 * The dialog runs an independent `agentLoop` (never the main session), and its
 * `submit_config` tool suspends the loop while the main process validates the
 * draft, shows a preview, and applies an explicit user decision. Nothing is
 * written unless the user picks "写入"; validation errors and "继续调整"
 * requirements are returned to the loop as tool results.
 */

const CONFIGURE_SYSTEM_PROMPT = [
  "你是 pi-sentinel 的配置助手，通过自然语言多轮对话帮助用户生成或修改哨兵规则。",
  "",
  "规则对象字段：name(唯一), trigger{type: tool_call|tool_result|turn_end|agent_end|context_tokens, tools?: string[], threshold?: 正整数}, mode: blocking|background（blocking 仅限 tool_call）, prompt(模板字符串), model?, thinking?, tools?（审计员内置工具白名单：read/grep/find/ls/bash/edit/write）, maxTurns?, window?{messages|tokens|full}, overlap?, onFailure?, cache?, cacheTtlMs?, timeoutMs?, enabled?, dedupe?, includeThinking?, includeToolInputs?, includeToolOutputs?。",
  "prompt 使用 Handlebars 模板变量，例如 {{tool}}、{{input.command}}、{{json input}}、{{content}}、{{turnIndex}}、{{tokens}}。",
  '示例：{"name":"bash-safety","trigger":{"type":"tool_call","tools":["bash"]},"mode":"blocking","prompt":"检查命令 {{input.command}} 是否包含危险的递归删除"}',
  "",
  "流程：先与用户澄清需求，确认后调用 submit_config 工具提交草稿（changeType 为 add/update/remove；add/update 用 ruleJson 传规则对象的 JSON 字符串；remove 用 name）。",
  "草稿会先校验再让用户确认写入作用域；用户可能要求继续调整或放弃。校验错误会作为工具结果返回，请据此修正后重新提交。",
].join("\n");

export const CONFIGURE_DIALOG_MAX_TURNS = 20;

export type ConfigChange =
  | { type: "add"; rule: SentinelRule }
  | { type: "update"; rule: SentinelRule }
  | { type: "remove"; name: string };

export interface ApplyChangeResult {
  ok: boolean;
  error?: string;
  summary?: string;
}

/** Host capabilities the dialog needs from the runtime. */
export interface ConfigureHost {
  /** Validate and apply a change to one scope (read-merge-write / session op). */
  applyChange(change: ConfigChange, scope: ConfigScope): ApplyChangeResult;
  /** Close the fleet overlay if it is open, to avoid nested focus. */
  closeFleet(): Promise<void>;
  /** Effective rules (for context). */
  getRules(): SourcedRule[];
  /**
   * File-scope rules before session merging, used to detect shadowing: after a
   * session write the effective list already contains the session rule, so the
   * inherited namesake is only observable in the unmerged file scope.
   */
  getFileRules?(): SourcedRule[];
}

export interface ConfigureDialogDeps {
  agentLoop: AuditLoopFn;
  streamFn: StreamFn;
  registry: AuditModelRegistry;
  sessionModel: Model<import("@earendil-works/pi-ai").Api> | undefined;
  defaults: SentinelDefaults;
  host: ConfigureHost;
  sentinelRegistry: SentinelRegistry;
  now?: () => number;
}

/** Parse and validate a rule JSON draft. */
export function parseRuleDraft(
  ruleJson: string | undefined,
): { ok: true; rule: SentinelRule } | { ok: false; error: string } {
  if (!ruleJson || ruleJson.trim().length === 0) {
    return {
      ok: false,
      error: "缺少 ruleJson（add/update 必须提供规则对象 JSON）",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ruleJson);
  } catch (error) {
    return {
      ok: false,
      error: `ruleJson 不是合法 JSON: ${(error as Error).message}`,
    };
  }
  const result = validateRule(parsed);
  if (!result.ok) return { ok: false, error: `规则校验失败: ${result.error}` };
  return { ok: true, rule: result.rule };
}

const submitSchema = Type.Object({
  changeType: Type.Union([
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("remove"),
  ]),
  ruleJson: Type.Optional(
    Type.String({ description: "add/update 时规则对象的 JSON 字符串" }),
  ),
  name: Type.Optional(Type.String({ description: "remove 时的规则名" })),
});

type SubmitParams = {
  changeType: "add" | "update" | "remove";
  ruleJson?: string;
  name?: string;
};

export interface ConfigureDialogViewState {
  id: string;
  startedAt: number;
  turnCount: number;
  status: "running" | "done";
  transcript: Array<{
    role: "user" | "assistant" | "system";
    text: string;
    at: number;
  }>;
  draftSummary?: string;
}

export class ConfigureDialog {
  private controller: AbortController | null = null;
  private running = false;
  private readonly id = `configure-${Math.random().toString(36).slice(2, 10)}`;

  constructor(private readonly deps: ConfigureDialogDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  get dialogId(): string {
    return this.id;
  }

  /** Start the background dialog; returns immediately. */
  start(ctx: ExtensionContext, initialDescription?: string): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();

    const now = this.now();
    this.deps.sentinelRegistry.registerDialog({
      id: this.id,
      startedAt: now,
      turnCount: 0,
      status: "running",
      transcript: [],
    });

    const initial =
      initialDescription?.trim() ||
      "我想配置一条新的哨兵规则，请先询问我的需求。";
    this.appendTranscript("user", initial);
    void this.runLoop(ctx, initial, this.controller.signal)
      .catch(() => {})
      .finally(() => {
        this.running = false;
        this.controller = null;
        // Finished dialogs must not linger in the fleet list.
        this.deps.sentinelRegistry.removeDialog(this.id);
      });
  }

  /** Abort the dialog (session switch/shutdown). */
  abort(): void {
    this.controller?.abort();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private appendTranscript(
    role: "user" | "assistant" | "system",
    text: string,
  ): void {
    this.deps.sentinelRegistry.appendDialogEntry(this.id, {
      role,
      text,
      at: this.now(),
    });
  }

  private buildSubmitTool(
    ctx: ExtensionContext,
  ): AgentTool<typeof submitSchema> {
    return {
      name: "submit_config",
      label: "提交哨兵配置草稿",
      description:
        "提交配置草稿供用户确认写入；校验错误或用户要求会作为结果返回。",
      parameters: submitSchema,
      execute: async (_toolCallId, params: SubmitParams) => {
        const result = await this.handleSubmit(ctx, params);
        return {
          content: [{ type: "text", text: result }],
          details: undefined,
        };
      },
    };
  }

  /** Validate, preview, and apply one submitted draft. */
  private async handleSubmit(
    ctx: ExtensionContext,
    params: SubmitParams,
  ): Promise<string> {
    let change: ConfigChange;
    if (params.changeType === "remove") {
      if (!params.name || params.name.trim().length === 0) {
        return "校验失败: remove 必须提供 name";
      }
      change = { type: "remove", name: params.name.trim() };
      this.deps.sentinelRegistry.updateDialog(this.id, {
        draftSummary: `remove ${change.name}`,
      });
    } else {
      const parsed = parseRuleDraft(params.ruleJson);
      if (!parsed.ok) return parsed.error;
      change =
        params.changeType === "update"
          ? { type: "update", rule: parsed.rule }
          : { type: "add", rule: parsed.rule };
      this.deps.sentinelRegistry.updateDialog(this.id, {
        draftSummary: `${params.changeType} ${parsed.rule.name}`,
      });
    }

    // Avoid nested focus: the preview dialog must not stack on the fleet overlay.
    await this.deps.host.closeFleet();

    const preview = `变更：${describeChange(change)}\n选择下一步操作：`;
    const action = await ctx.ui.select(`pi-sentinel 配置草稿预览\n${preview}`, [
      "写入",
      "继续调整",
      "放弃",
    ]);
    if (!action) return "未选择操作，草稿未写入；请等待用户指示。";
    if (action === "放弃") return "已放弃，未写入任何配置。";

    if (action === "继续调整") {
      const requirement = await ctx.ui.input(
        "请描述调整要求",
        "例如：阈值消息里不要包含命令全文",
      );
      const text = requirement?.trim() || "请根据我的进一步要求继续调整草稿。";
      this.appendTranscript("user", text);
      return `用户要求继续调整：${text}`;
    }

    const scopeChoice = await ctx.ui.select("写入作用域", [
      "global",
      "project",
      "session",
    ]);
    if (!scopeChoice) return "未选择作用域，草稿未写入。";
    const scope = scopeChoice as ConfigScope;

    const applied = this.deps.host.applyChange(change, scope);
    if (!applied.ok) return `写入失败：${applied.error ?? "未知错误"}`;

    const shadowNotice = this.shadowNotice(change, scope);
    return `已写入 ${scope} 作用域并立即生效。${applied.summary ?? ""}${shadowNotice}`;
  }

  /** Warn when a new session rule shadows an inherited same-name rule. */
  private shadowNotice(change: ConfigChange, scope: ConfigScope): string {
    if (scope !== "session" || change.type === "remove") return "";
    const name = change.rule.name;
    const inherited = (
      this.deps.host.getFileRules?.() ?? this.deps.host.getRules()
    ).some((rule) => rule.name === name && rule.source !== "session");
    return inherited ? `\n注意：会话级规则 "${name}" 遮蔽了同名继承规则。` : "";
  }

  private async runLoop(
    ctx: ExtensionContext,
    initial: string,
    signal: AbortSignal,
  ): Promise<void> {
    const modelResult = resolveAuditModel(
      this.deps.defaults.configure?.model ?? this.deps.defaults.model,
      this.deps.registry,
      this.deps.sessionModel,
    );
    if ("error" in modelResult) {
      ctx.ui.notify(
        `pi-sentinel 配置对话无法启动：${modelResult.error}`,
        "warning",
      );
      this.appendTranscript("system", `模型解析失败：${modelResult.error}`);
      return;
    }

    const systemMessage: AgentMessage = {
      role: "system",
      content: CONFIGURE_SYSTEM_PROMPT,
      timestamp: this.now(),
    };
    const userMessage: AgentMessage = {
      role: "user",
      content: initial,
      timestamp: this.now(),
    };
    const tools = [this.buildSubmitTool(ctx)];

    let turnCount = 0;
    const config: AgentLoopConfig = {
      model: modelResult.model,
      convertToLlm,
      maxTokens: Math.min(4096, modelResult.model.maxTokens),
      finishTurn: () => {
        turnCount += 1;
        this.deps.sentinelRegistry.updateDialog(this.id, { turnCount });
        return turnCount >= CONFIGURE_DIALOG_MAX_TURNS
          ? { action: "end" }
          : { action: "continue" };
      },
    };

    const context: AgentContext = { messages: [systemMessage], tools };
    const stream: AuditEventStream = this.deps.agentLoop(
      [userMessage],
      context,
      config,
      signal,
      this.deps.streamFn,
    );

    for await (const event of stream) {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = assistantText(event.message);
        if (text) this.appendTranscript("assistant", text);
      }
    }
    await stream.result();
  }
}

function describeChange(change: ConfigChange): string {
  if (change.type === "remove") return `删除规则 "${change.name}"`;
  return `${change.type === "add" ? "新增" : "修改"}规则 "${change.rule.name}" (${change.rule.mode}/${change.rule.trigger.type})`;
}

function assistantText(message: AgentMessage): string {
  if (!("content" in message) || typeof message.content === "string") return "";
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}
