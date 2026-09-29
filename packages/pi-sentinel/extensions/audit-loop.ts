import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AgentLoopConfig, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";
import {
  Type,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  BUILTIN_AUDITOR_TOOLS,
  DEFAULT_TIMEOUT_MS,
  type BuiltinAuditorTool,
  type SentinelDefaults,
  type SentinelRule,
} from "./config.js";
import { renderAuditMessage, type TemplateEventData } from "./template.js";

/**
 * Guard a `StreamFn` against synchronous throws.
 *
 * `streamSimple` normally encodes failures into the returned stream, but a
 * synchronous throw (missing auth, bad request construction) would otherwise
 * escape into `agentLoop`'s promise chain, where nothing catches it: the audit
 * stream never ends and the audit only fails after the full timeout. Converting
 * the throw into an already-terminated error stream keeps the failure fast and
 * classifies it through the normal stopReason=error path.
 */
export function guardedStreamFn(inner: StreamFn): StreamFn {
  return (model, context, options) => {
    try {
      return inner(model, context, options);
    } catch (error) {
      return errorStream(model, error);
    }
  };
}

function errorStream(
  model: Model<Api>,
  error: unknown,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

/** Side-loop audit execution.
 *
 * Each audit runs an independent `agentLoop` whose system prompt is a leading
 * system message, whose only mandatory tool is `audit_verdict`, and whose
 * optional investigation tools come from the rule's host-built-in whitelist.
 * The audit never touches the main context and cannot trigger sentinel rules.
 */

const AUDIT_SYSTEM_PROMPT = [
  "你是 pi-sentinel 的审计员，对主 agent 的一次行为做独立的自然语言审查。",
  "",
  "规则：",
  "1. 必须调用 `audit_verdict` 工具给出结论，不要用自由文本表达裁决。",
  "2. verdict 语义：`pass` = 无问题；`warn` = 有风险但可继续；`fail` = 必须阻止或明确违规。",
  "3. message 用一两句话说明判断依据；pass 时 message 写“无问题”即可。",
  "4. 结论语言跟随规则 prompt 的语言。",
  "5. 只依据用户消息中的规则要求与审计范围作答，不要臆测未提供的信息。",
].join("\n");

/** Verdict levels accepted from `audit_verdict`. */
export const VERDICT_LEVELS = ["pass", "warn", "fail"] as const;
export type VerdictLevel = (typeof VERDICT_LEVELS)[number];

export const MAX_VERDICT_MESSAGE_CHARS = 2000;

export interface AuditVerdict {
  verdict: VerdictLevel;
  message: string;
}

export interface LiveAuditDetails {
  ruleName: string;
  startedAt: number;
  model: string;
  promptSummary: string;
  scopeSummary: string;
  unresolvedPaths: string[];
  toolCallCount: number;
  /** Tail of the streamed assistant text (ring buffer, ~2KB). */
  streamTail: string;
  /** Steering messages accepted for this audit. */
  steeredMessages: string[];
  status: "running" | "done";
}

export interface AuditOutcome {
  status: "verdict" | "failed" | "cancelled";
  verdict?: AuditVerdict;
  /** Present for status "failed". */
  failureReason?: string;
  model?: string;
  durationMs: number;
  unresolvedPaths: string[];
  toolCallCount: number;
  live: LiveAuditDetails;
}

export interface AuditRequest {
  ruleName: string;
  rule: SentinelRule;
  /** Raw prompt template. */
  prompt: string;
  /** Prompt rendered against the event data (cache key + audit message). */
  renderedPrompt?: string;
  /** Scope block body. */
  scopeText: string;
  eventData: TemplateEventData;
}

/** Minimal model registry surface needed for audit model resolution. */
export interface AuditModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAvailable(): Model<Api>[];
  hasConfiguredAuth(model: Model<Api>): boolean;
}

/** Event stream shape returned by `agentLoop`. */
export interface AuditEventStream extends AsyncIterable<AgentEvent> {
  result(): Promise<AgentMessage[]>;
}

export type AuditLoopFn = (
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
) => AuditEventStream;

export interface AuditDeps {
  agentLoop: AuditLoopFn;
  streamFn: StreamFn;
  registry: AuditModelRegistry;
  sessionModel: Model<Api> | undefined;
  defaults: SentinelDefaults;
  cwd: string;
  now?: () => number;
}

export interface AuditHandle {
  live: LiveAuditDetails;
  done: Promise<AuditOutcome>;
  /** Queue a steering message; false when the audit already ended. */
  steer(message: string): boolean;
  abort(): void;
}

const STREAM_TAIL_CHARS = 2048;
const PROMPT_SUMMARY_CHARS = 200;

function summarize(text: string, limit = PROMPT_SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/** Resolve a rule/default model spec against the registry. */
export function resolveAuditModel(
  spec: string | undefined,
  registry: AuditModelRegistry,
  sessionModel: Model<Api> | undefined,
): { model: Model<Api> } | { error: string } {
  if (!spec) {
    if (!sessionModel) return { error: "没有可用的会话模型" };
    return { model: sessionModel };
  }

  let model: Model<Api> | undefined;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
  } else {
    model = registry.getAvailable().find((candidate) => candidate.id === spec);
  }

  if (!model) return { error: `模型未找到: ${spec}` };
  if (!registry.hasConfiguredAuth(model))
    return { error: `模型未配置凭据: ${spec}` };
  return { model };
}

/** Parse and normalize an `audit_verdict` payload. */
export function parseVerdict(value: unknown): AuditVerdict | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  const message = record.message;
  if (
    typeof verdict !== "string" ||
    !(VERDICT_LEVELS as readonly string[]).includes(verdict)
  ) {
    return null;
  }
  if (typeof message !== "string" || message.trim().length === 0) return null;
  const trimmed = message.trim();
  return {
    verdict: verdict as VerdictLevel,
    message:
      trimmed.length > MAX_VERDICT_MESSAGE_CHARS
        ? trimmed.slice(0, MAX_VERDICT_MESSAGE_CHARS)
        : trimmed,
  };
}

const verdictSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal("pass"),
    Type.Literal("warn"),
    Type.Literal("fail"),
  ]),
  message: Type.String({
    description: "一句话说明判断依据；pass 时写“无问题”",
  }),
});

/** Build the mandatory `audit_verdict` tool, capturing the last payload. */
export function createAuditVerdictTool(
  onVerdict: (value: unknown) => void,
): AgentTool<typeof verdictSchema> {
  return {
    name: "audit_verdict",
    label: "审计裁决",
    description: "给出本次审计的最终裁决。必须在结束前调用一次。",
    parameters: verdictSchema,
    execute: async (_toolCallId, params) => {
      onVerdict(params);
      return {
        content: [{ type: "text", text: "裁决已记录" }],
        details: undefined,
      };
    },
  };
}

const BUILTIN_TOOL_FACTORIES: Record<
  BuiltinAuditorTool,
  (cwd: string) => AgentTool<any>
> = {
  read: createReadTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
};

/** Construct the executable tool set for a rule's auditor whitelist. */
export function buildAuditorTools(
  rule: SentinelRule,
  cwd: string,
  onVerdict: (value: unknown) => void,
): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [createAuditVerdictTool(onVerdict)];
  for (const name of rule.tools ?? []) {
    if (!(BUILTIN_AUDITOR_TOOLS as readonly string[]).includes(name)) continue;
    tools.push(BUILTIN_TOOL_FACTORIES[name](cwd));
  }
  return tools;
}

function appendTail(current: string, delta: string): string {
  const next = current + delta;
  return next.length > STREAM_TAIL_CHARS
    ? next.slice(next.length - STREAM_TAIL_CHARS)
    : next;
}

function timeoutFor(rule: SentinelRule, defaults: SentinelDefaults): number {
  return rule.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS[rule.mode];
}

function maxTurnsFor(rule: SentinelRule): number {
  return rule.maxTurns ?? ((rule.tools?.length ?? 0) > 0 ? 4 : 1);
}

/**
 * Start an audit. Resolves immediately with a handle whose `done` settles when
 * the side loop finishes, fails, times out, or is cancelled.
 */
export function startAudit(
  request: AuditRequest,
  deps: AuditDeps,
): AuditHandle {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const controller = new AbortController();
  const steeringQueue: string[] = [];

  const live: LiveAuditDetails = {
    ruleName: request.ruleName,
    startedAt,
    model: deps.sessionModel ? modelLabel(deps.sessionModel) : "(未解析)",
    promptSummary: summarize(request.prompt),
    scopeSummary: summarize(request.scopeText),
    unresolvedPaths: [],
    toolCallCount: 0,
    streamTail: "",
    steeredMessages: [],
    status: "running",
  };

  const timeoutMs = timeoutFor(request.rule, deps.defaults);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const done = (async (): Promise<AuditOutcome> => {
    let verdict: AuditVerdict | null = null;
    let stopReason: string | undefined;
    let stopErrorMessage: string | undefined;

    const finish = (
      status: AuditOutcome["status"],
      failureReason?: string,
    ): AuditOutcome => {
      live.status = "done";
      return {
        status,
        verdict: verdict ?? undefined,
        failureReason,
        model: live.model === "(未解析)" ? undefined : live.model,
        durationMs: now() - startedAt,
        unresolvedPaths: [...live.unresolvedPaths],
        toolCallCount: live.toolCallCount,
        live,
      };
    };

    const resolved = resolveAuditModel(
      request.rule.model ?? deps.defaults.model,
      deps.registry,
      deps.sessionModel,
    );
    if ("error" in resolved) {
      return finish("failed", resolved.error);
    }
    const model = resolved.model;
    live.model = modelLabel(model);

    const tools = buildAuditorTools(request.rule, deps.cwd, (value) => {
      verdict = parseVerdict(value) ?? verdict;
    });
    const maxTurns = maxTurnsFor(request.rule);
    let turnCount = 0;

    const message = renderAuditMessage({
      prompt: request.prompt,
      eventData: request.eventData,
      scopeText: request.scopeText,
      renderedPrompt: request.renderedPrompt,
    });
    live.unresolvedPaths = message.unresolved;

    const systemMessage: AgentMessage = {
      role: "system",
      content: AUDIT_SYSTEM_PROMPT,
      timestamp: now(),
    };
    const userMessage: AgentMessage = {
      role: "user",
      content: message.text,
      timestamp: now(),
    };

    const thinkingLevel =
      request.rule.thinking ?? deps.defaults.thinking ?? "off";

    const config: AgentLoopConfig = {
      model,
      convertToLlm,
      // pi-ai's ThinkingLevel excludes "off"; omit the option to disable thinking.
      reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
      maxTokens: Math.min(8192, model.maxTokens),
      finishTurn: () => {
        turnCount += 1;
        return turnCount >= maxTurns
          ? { action: "end" }
          : { action: "continue" };
      },
      getSteeringMessages: async () => {
        const queued = steeringQueue.splice(0, steeringQueue.length);
        return queued.map((text) => ({
          role: "user",
          content: text,
          timestamp: now(),
        })) satisfies AgentMessage[];
      },
    };

    const iteration = (async () => {
      const stream = deps.agentLoop(
        [userMessage],
        { messages: [systemMessage], tools },
        config,
        controller.signal,
        deps.streamFn,
      );
      for await (const event of stream) {
        if (event.type === "tool_execution_start") {
          live.toolCallCount += 1;
          if (event.toolName === "audit_verdict") {
            verdict = parseVerdict(event.args) ?? verdict;
          }
        } else if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") {
            live.streamTail = appendTail(live.streamTail, update.delta);
          } else if (update.type === "thinking_delta") {
            live.streamTail = appendTail(live.streamTail, update.delta);
          }
        } else if (event.type === "turn_end") {
          if (event.message.role === "assistant") {
            stopReason = event.message.stopReason;
            stopErrorMessage = event.message.errorMessage;
          }
        } else if (event.type === "agent_end") {
          for (const finalMessage of event.messages) {
            if (finalMessage.role === "assistant") {
              stopReason = finalMessage.stopReason;
              stopErrorMessage = finalMessage.errorMessage;
            }
          }
        }
      }
      await stream.result();
    })();
    iteration.catch(() => {});

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      controller.signal.addEventListener("abort", () => resolve("timeout"), {
        once: true,
      });
    });

    await Promise.race([iteration, timeoutPromise]);
    clearTimeout(timeout);

    if (timedOut) return finish("failed", `审计超时（${timeoutMs}ms）`);
    if (controller.signal.aborted) return finish("cancelled");
    if (verdict) return finish("verdict");
    if (stopReason === "error" || stopReason === "aborted") {
      const detail = stopErrorMessage ? `：${stopErrorMessage}` : "";
      return finish("failed", `审计循环结束原因: ${stopReason}${detail}`);
    }
    return finish("failed", "未产生裁决（audit_verdict 未调用）");
  })();

  return {
    live,
    done,
    steer: (text: string) => {
      if (live.status !== "running") return false;
      steeringQueue.push(text);
      live.steeredMessages.push(text);
      return true;
    },
    abort: () => controller.abort(),
  };
}

/** Convenience type re-export for wiring code. */
export type { AssistantMessageEventStream, Context };
