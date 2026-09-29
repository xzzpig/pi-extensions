import type {
  AgentEvent,
  AgentMessage,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AuditLoopFn, AuditVerdict } from "../extensions/audit-loop.ts";
import {
  DEFAULT_FLEET_KEYBINDINGS,
  resolveDefaults,
  type LoadedSentinelConfig,
  type SentinelDefaults,
  type SourcedRule,
} from "../extensions/config.ts";
import { SentinelRuntime } from "../extensions/index.ts";
import type { FindingMessage } from "../extensions/injection.ts";

/** Test harness shared by the trigger-wiring suites. */

export const testModel = {
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

export interface AuditControl {
  verdict(verdict: AuditVerdict): void;
  fail(reason: string): void;
}

export interface SentMessage {
  message: FindingMessage;
  deliverAs: string | undefined;
}

export interface HarnessOptions {
  rules: Array<Partial<SourcedRule> & { name: string }>;
  defaults?: SentinelDefaults;
  maxConcurrent?: number;
  now?: () => number;
  /** Override file-config loading (tests must not read the real home config). */
  configLoader?: (ctx: ExtensionContext) => LoadedSentinelConfig;
  /** Override the audit loop (e.g. to drive the configuration dialog). */
  agentLoop?: AuditLoopFn;
  /** Wire runtime handlers at creation (event-trigger tests need them). */
  register?: boolean;
}

export function messageEntry(
  id: string,
  message: AgentMessage,
): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  };
}

export function compactionEntry(id: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "summary",
    firstKeptEntryId: id,
    tokensBefore: 1000,
  };
}

/** Plain text of a message (used to inspect captured audit prompts). */
export function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

export function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function failingAssistant(reason: string): AssistantMessage {
  return {
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: reason,
    timestamp: 0,
  };
}

export function createHarness(options: HarnessOptions) {
  const controls: AuditControl[] = [];
  const sent: SentMessage[] = [];
  const notified: Array<{ message: string; type?: string }> = [];
  const entries: SessionEntry[] = [];
  const capturedPrompts: AgentMessage[][] = [];

  let usage: ContextUsage | undefined = {
    tokens: null,
    contextWindow: 200_000,
    percent: null,
  };
  let idle = true;

  const loop: AuditLoopFn = (prompts) => {
    capturedPrompts.push(prompts);
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
            message: failingAssistant(String(result.payload)),
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

  const sessionManager = {
    buildContextEntries: () => entries,
    getBranch: () => entries,
    getLeafId: () => entries.at(-1)?.id ?? null,
    getEntries: () => entries,
  };

  const modelRegistry = {
    find: () => testModel,
    getAvailable: () => [testModel],
    hasConfiguredAuth: () => true,
    streamSimple: () => {
      throw new Error("streamSimple should not be called in tests");
    },
  };

  const ctx = {
    cwd: "/tmp",
    mode: "print",
    hasUI: false,
    model: testModel,
    modelRegistry,
    sessionManager,
    ui: {
      notify: (message: string, type?: string) =>
        notified.push({ message, type }),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      setStatus: () => {},
      setWidget: () => {},
    },
    isIdle: () => idle,
    getContextUsage: () => usage,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;

  const handlers = new Map<
    string,
    (event: unknown, context: ExtensionContext) => unknown
  >();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const commands = new Map<string, unknown>();
  let entryCounter = 0;
  const pi = {
    on: (
      event: string,
      handler: (event: unknown, context: ExtensionContext) => unknown,
    ) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    },
    events: {
      on: (channel: string, handler: (data: unknown) => void) => {
        busHandlers.set(channel, handler);
        return () => {
          busHandlers.delete(channel);
        };
      },
      emit: (channel: string, data: unknown) => {
        busHandlers.get(channel)?.(data);
      },
    },
    registerMessageRenderer: () => {},
    registerCommand: (name: string, options: unknown) => {
      commands.set(name, options);
    },
    appendEntry: (customType: string, data?: unknown) => {
      entryCounter += 1;
      entries.push({
        type: "custom",
        id: `op-${entryCounter}`,
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType,
        data,
      });
    },
    sendMessage: (
      message: FindingMessage,
      opts?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
    ) => {
      sent.push({ message, deliverAs: opts?.deliverAs });
    },
  } as unknown as ExtensionAPI;

  const config: LoadedSentinelConfig = {
    defaults: resolveDefaults(options.defaults ?? {}),
    rules: options.rules.map((rule) => ({
      trigger: { type: "turn_end" },
      mode: "background",
      prompt: "check",
      ...rule,
      source: "global",
    })) as SourcedRule[],
    fleetKeybindings: DEFAULT_FLEET_KEYBINDINGS,
    warnings: [],
  };
  if (options.maxConcurrent !== undefined)
    config.defaults.maxConcurrent = options.maxConcurrent;

  const runtime = new SentinelRuntime(pi, {
    agentLoop: options.agentLoop ?? loop,
    now: options.now,
    configLoader: options.configLoader,
  });
  // Production wires handlers before the first config load; registering here
  // lets rebuild() establish event-trigger subscriptions at creation.
  if (options.register) runtime.register();
  runtime.applyConfig(config, ctx);

  return {
    runtime,
    ctx,
    pi,
    handlers,
    busHandlers,
    commands,
    config,
    controls,
    sent,
    notified,
    entries,
    capturedPrompts,
    setTokens: (tokens: number | null) => {
      usage = {
        tokens,
        contextWindow: 200_000,
        percent: tokens === null ? null : 0,
      };
    },
    setUsage: (next: ContextUsage | undefined) => {
      usage = next;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    addMessage: (id: string, message: AgentMessage) => {
      entries.push(messageEntry(id, message));
    },
    setEntries: (next: SessionEntry[]) => {
      entries.length = 0;
      entries.push(...next);
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export const passVerdict: AuditVerdict = { verdict: "pass", message: "ok" };
export const failVerdict: AuditVerdict = { verdict: "fail", message: "bad" };
export const warnVerdict: AuditVerdict = {
  verdict: "warn",
  message: "careful",
};

export type { StreamFn };
