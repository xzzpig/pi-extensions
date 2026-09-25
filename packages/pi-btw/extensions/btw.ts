import {
  appendEntry,
  createTranscriptState,
  ensureToolCall,
  ensureTurn,
  findLatestEntry,
  finishTurn,
  hasStreamingTranscriptEntry,
  renderTranscriptLines,
  type ToolComponentLookup,
  type TranscriptEntry,
  type TranscriptState,
  type TranscriptToolResultPayload,
  upsertText,
  upsertToolResult,
} from "@xzzpig/pi-components/transcript";
import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  getMarkdownTheme,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type Message,
  type ThinkingLevel as AiThinkingLevel,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  Box,
  Container,
  Input,
  Key,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
  type KeyId,
  type MarkdownTheme,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override";
const BTW_THINKING_OVERRIDE_TYPE = "btw-thinking-override";
const BTW_DEFAULT_FOCUS_SHORTCUTS: readonly KeyId[] = [Key.alt("/"), Key.super("/"), Key.ctrlAlt("w")];
const BTW_FOCUS_KEYS_ENV = "PI_BTW_FOCUS_KEYS";
const BTW_FOCUS_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
// Mirrors the SpecialKey union in @earendil-works/pi-tui keys.d.ts (lower-cased).
const BTW_FOCUS_SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
// Symbols from the SymbolKey union (letters/digits are matched directly).
const BTW_FOCUS_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*",
  "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

/**
 * Resolve the BTW overlay focus-toggle shortcuts.
 *
 * Users whose window manager or terminal claims the default shortcuts can override them by
 * setting PI_BTW_FOCUS_KEYS to a comma-separated list of pi-tui key identifiers
 * (e.g. "ctrl+/,ctrl+alt+b"). Blank, duplicate, or unparseable entries are ignored; if no
 * usable entries remain, the defaults are kept so focus toggling never becomes impossible.
 */
export function resolveBtwFocusShortcuts(env: NodeJS.ProcessEnv = process.env): KeyId[] {
  const raw = env[BTW_FOCUS_KEYS_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return [...BTW_DEFAULT_FOCUS_SHORTCUTS];
  }

  const seen = new Set<string>();
  const shortcuts: KeyId[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim().toLowerCase();
    if (!candidate || seen.has(candidate) || !isValidFocusShortcut(candidate)) {
      continue;
    }
    seen.add(candidate);
    shortcuts.push(candidate as KeyId);
  }

  return shortcuts.length > 0 ? shortcuts : [...BTW_DEFAULT_FOCUS_SHORTCUTS];
}

/**
 * Validate a candidate against the pi-tui KeyId grammar: zero or more distinct recognized
 * modifiers followed by exactly one base key (letter, digit, symbol, or named special key).
 * Rejects typos like "cmd+/" or "control+x" and duplicate/empty segments.
 */
export function isValidFocusShortcut(candidate: string): boolean {
  const segments = candidate.split("+");
  const base = segments.pop();
  if (base === undefined || !isValidFocusBaseKey(base)) {
    return false;
  }

  const seen = new Set<string>();
  for (const segment of segments) {
    if (!BTW_FOCUS_MODIFIERS.has(segment) || seen.has(segment)) {
      return false;
    }
    seen.add(segment);
  }

  return true;
}

function isValidFocusBaseKey(base: string): boolean {
  if (base.length === 1) {
    return /[a-z0-9]/.test(base) || BTW_FOCUS_SYMBOL_KEYS.has(base);
  }
  return BTW_FOCUS_SPECIAL_KEYS.has(base);
}

function formatFocusShortcutLabel(shortcut: KeyId): string {
  return shortcut
    .split("+")
    .map((segment) => {
      switch (segment) {
        case "ctrl":
          return "Ctrl";
        case "alt":
          return "Alt";
        case "shift":
          return "Shift";
        case "super":
          return "Super";
        default:
          return segment.length === 1 ? segment.toUpperCase() : segment;
      }
    })
    .join("+");
}

export function describeFocusShortcuts(shortcuts: readonly KeyId[]): string {
  const labels = shortcuts.map(formatFocusShortcutLabel);
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

const BTW_FOCUS_SHORTCUTS: readonly KeyId[] = resolveBtwFocusShortcuts();
const BTW_FOCUS_SHORTCUTS_LABEL = describeFocusShortcuts(BTW_FOCUS_SHORTCUTS);

function matchesBtwFocusShortcut(data: string): boolean {
  return BTW_FOCUS_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}

/** Toggles the overlay between framed "window" width and edge-to-edge "full" width. */
const BTW_WIDTH_TOGGLE_SHORTCUT: KeyId = Key.alt("w");

function matchesBtwWidthToggle(data: string): boolean {
  return matchesKey(data, BTW_WIDTH_TOGGLE_SHORTCUT);
}

type BtwOverlayWidthMode = "window" | "full";

const BTW_SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

const BTW_CONTEXT_BOUNDARY_USER_TEXT = [
  "[BTW SESSION BOUNDARY]",
  "You are now in a separate BTW side session. The preceding main-session messages are background context only; any unfinished work there is being handled independently. Do not autonomously start, resume, complete, or take action on that main-session work. Respond only to the user's BTW request and subsequent BTW follow-ups, using the main-session context only when it directly helps. Prepare or return work to the main session only when the user explicitly asks for a handoff.",
].join("\n");

const BTW_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

const BTW_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
const BTW_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

type SessionThinkingLevel = "off" | AiThinkingLevel;
type BtwThreadMode = "contextual" | "tangent" | "readonly";
type SessionModel = NonNullable<ExtensionCommandContext["model"]>;
/**
 * Loose model reference parsed from `/btw:model <provider> <id> <api>` and persisted to
 * session entries. Resolved to a full SessionModel via ctx.modelRegistry.find(...).
 */
type BtwModelRef = Pick<SessionModel, "provider" | "id" | "api">;

type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

type ParsedBtwArgs = {
  question: string;
  save: boolean;
};

type SaveState = "not-saved" | "saved" | "queued";

type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

type BtwModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

type BtwThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

type ResolvedBtwModel = {
  model: SessionModel | null;
  source: "override" | "main" | "none";
  configuredOverride: SessionModel | null;
  fallbackReason?: string;
};

type ResolvedBtwSettings = {
  model: SessionModel | null;
  modelSource: "override" | "main" | "none";
  configuredModelOverride: SessionModel | null;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: "override" | "main";
  fallbackReason?: string;
};

// Entry and state shapes are owned by @xzzpig/pi-components; these aliases
// keep the historical local names readable without duplicating the structure.
type BtwTurnOutcome = import("@xzzpig/pi-components/transcript").TranscriptTurnOutcome;
type BtwTranscriptEntry = TranscriptEntry;

type BtwTranscript = BtwTranscriptEntry[];

type BtwTranscriptState = TranscriptState;

type BtwSessionRuntime = {
  session: AgentSession;
  mode: BtwThreadMode;
  subscriptions: Set<() => void>;
  sideThreadStartIndex: number;
  abortPromise?: Promise<void>;
  promptQueue: Promise<void>;
};

type OverlayRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === customType;
}

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => appendSystemPrompt,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async (_options) => {},
  };

  return resourceLoader;
}

async function createBtwModelRuntimeOptions(
  ctx: ExtensionCommandContext,
  model: SessionModel,
): Promise<Pick<CreateAgentSessionOptions, "modelRuntime">> {
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  const hasRuntimeApiKey = ctx.modelRegistry.getProviderAuthStatus(model.provider).source === "runtime";

  if (!nativeProvider && !providerConfig && !hasRuntimeApiKey) {
    return {};
  }

  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  if (nativeProvider) {
    modelRuntime.registerNativeProvider(nativeProvider);
  } else if (providerConfig) {
    modelRuntime.registerProvider(model.provider, providerConfig);
  }
  await modelRuntime.refresh({ allowNetwork: false });

  // --api-key is stored only in the parent runtime.
  if (hasRuntimeApiKey) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) {
      await modelRuntime.setRuntimeApiKey(model.provider, auth.apiKey);
    }
  }

  return { modelRuntime };
}

function hasResolvedAuthValues(values?: Record<string, string | null | undefined>): boolean {
  return !!values && Object.values(values).some((value) => typeof value === "string" && value.length > 0);
}

function hasUsableModelAuth(
  ctx: ExtensionCommandContext,
  model: SessionModel,
  auth: Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>>,
): boolean {
  if (!auth.ok) {
    return false;
  }

  return (
    !!auth.apiKey ||
    hasResolvedAuthValues(auth.headers) ||
    hasResolvedAuthValues(auth.env) ||
    ctx.modelRegistry.hasConfiguredAuth(model)
  );
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

function parseBtwModelArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; model: BtwModelRef }
  | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) {
    return { action: "invalid", message: "Usage: /btw:model <provider> <model> <api> | clear" };
  }

  const [provider, id, api] = parts;
  return { action: "set", model: { provider, id, api } as BtwModelRef };
}

function parseBtwThinkingArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  return { action: "set", thinkingLevel: trimmed as SessionThinkingLevel };
}

function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

/**
 * Tool surfaces keyed by BTW mode. Read-only mode exposes only pi's built-in
 * read-only tools so the child session cannot mutate the workspace; every other
 * mode matches pi's default coding-agent toolset (read/bash/edit/write).
 */
const BTW_TOOLS_BY_MODE: Record<BtwThreadMode, readonly string[]> = {
  contextual: ["read", "bash", "edit", "write"],
  tangent: ["read", "bash", "edit", "write"],
  readonly: ["read", "grep", "find", "ls"],
};

function buildBtwSeedState(
  ctx: ExtensionCommandContext,
  thread: BtwDetails[],
  mode: BtwThreadMode,
  sessionModel: SessionModel | null,
): { messages: Message[]; sideThreadStartIndex: number } {
  const messages: Message[] = [];

  if (mode === "contextual" || mode === "readonly") {
    try {
      messages.push(
        ...(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]).filter(
          (message) => !isVisibleBtwMessage(message),
        ),
      );
    } catch {
      messages.push(
        ...ctx.sessionManager.getEntries().flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }

          const message = entry as unknown as Partial<Message> & { role?: string; customType?: string; content?: unknown };
          if (typeof message.role !== "string" || !Array.isArray(message.content)) {
            return [];
          }

          return isVisibleBtwMessage({ role: message.role, customType: message.customType }) ? [] : [message as Message];
        }),
      );
    }

    messages.push({
      role: "user",
      content: [{ type: "text", text: BTW_CONTEXT_BOUNDARY_USER_TEXT }],
      timestamp: Date.now(),
    });
  }

  // Keep inherited main context and the internal boundary out of BTW handoffs.
  const sideThreadStartIndex = messages.length;

  if (thread.length > 0) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_USER_TEXT }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_ASSISTANT_TEXT }],
        provider: sessionModel?.provider ?? "unknown",
        model: sessionModel?.id ?? "unknown",
        api: sessionModel?.api ?? "openai-responses",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    );

    for (const entry of thread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: entry.provider,
          model: entry.model,
          api: entry.api || sessionModel?.api || ctx.model?.api || "openai-responses",
          usage:
            entry.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }
  }

  return {
    messages,
    sideThreadStartIndex,
  };
}

function toToolResultPayload(value: unknown): TranscriptToolResultPayload | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "object") {
    return value as TranscriptToolResultPayload;
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  return { content: [{ type: "text", text: String(value) }] };
}

// Entry/state construction is delegated to the shared library so replayed
// records and live events share one ingestion path and component registry.
function createEmptyTranscriptState(): BtwTranscriptState {
  // Default-collapsed tool output, matching Pi's main transcript behavior.
  return createTranscriptState();
}

// The overlay caches rendered transcript lines across frames. The shared
// library mutates entries IN PLACE (upsertText rewrites text on the latest
// entry; finishTurn flips streaming=false across the whole finished turn), so
// identity checks cannot detect changes — every mutation must bump this
// version through the wrappers below.
let transcriptVersion = 0;

function bumpTranscriptVersion(): void {
  transcriptVersion++;
}

const mutAppendEntry: typeof appendEntry = (...args) => {
  bumpTranscriptVersion();
  return appendEntry(...args);
};
const mutEnsureTurn: typeof ensureTurn = (...args) => {
  bumpTranscriptVersion();
  return ensureTurn(...args);
};
const mutFinishTurn: typeof finishTurn = (...args) => {
  bumpTranscriptVersion();
  return finishTurn(...args);
};
const mutEnsureToolCall: typeof ensureToolCall = (...args) => {
  bumpTranscriptVersion();
  return ensureToolCall(...args);
};
const mutUpsertText: typeof upsertText = (...args) => {
  bumpTranscriptVersion();
  return upsertText(...args);
};
const mutUpsertToolResult: typeof upsertToolResult = (...args) => {
  bumpTranscriptVersion();
  return upsertToolResult(...args);
};

function ensureTranscriptTurnForUserMessage(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestEntry(state, state.currentTurnId, "assistant-text");
    if (currentAssistant && !currentAssistant.streaming) {
      mutFinishTurn(state, state.currentTurnId);
    }
  }

  return mutEnsureTurn(state);
}

function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function upsertUserMessageEntry(state: BtwTranscriptState, turnId: number, text: string): void {
  if (!text) {
    return;
  }

  const existing = findLatestEntry(state, turnId, "user-message");
  if (existing) {
    existing.text = text;
    bumpTranscriptVersion();
    return;
  }

  mutAppendEntry(state, { type: "user-message", turnId, text });
}

function applyAssistantMessageToTranscript(
  state: BtwTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const assistantMessage = message;
  const thinking = extractThinking(assistantMessage);
  const answer = extractMessageText(assistantMessage);

  if (thinking) {
    mutUpsertText(state, turnId, "thinking", thinking, streaming);
  }

  if (answer) {
    mutUpsertText(state, turnId, "assistant-text", answer, streaming);
  }
}

function applyTranscriptEvent(state: BtwTranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start": {
      mutEnsureTurn(state);
      return;
    }
    case "message_start": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = mutEnsureTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, true);
      }
      return;
    }
    case "message_update": {
      if (event.message.role !== "assistant") {
        return;
      }

      const turnId = mutEnsureTurn(state);
      applyAssistantMessageToTranscript(state, turnId, event.message, true);
      return;
    }
    case "message_end": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = mutEnsureTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, false);
      }
      return;
    }
    case "tool_execution_start": {
      const turnId = mutEnsureTurn(state);
      mutEnsureToolCall(state, turnId, event.toolCallId, event.toolName, event.args);
      state.toolComponents.handleStart(event.toolCallId, event.toolName, event.args);
      return;
    }
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? mutEnsureTurn(state);
      const result = toToolResultPayload(event.partialResult);
      mutUpsertToolResult(state, turnId, event.toolCallId, event.toolName, result, false, true);
      state.toolComponents.handleUpdate(event.toolCallId, event.toolName, result);
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? mutEnsureTurn(state);
      const result = toToolResultPayload(event.result);
      mutUpsertToolResult(state, turnId, event.toolCallId, event.toolName, result, event.isError, false);
      state.toolComponents.handleEnd(event.toolCallId, event.toolName, result, event.isError);
      return;
    }
    case "turn_end": {
      const stopReason = event.message.role === "assistant" ? event.message.stopReason : "stop";
      const outcome: BtwTurnOutcome =
        stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
      mutFinishTurn(state, undefined, outcome);
      return;
    }
    default:
      return;
  }
}

function appendPersistedTranscriptTurn(state: BtwTranscriptState, details: BtwDetails): void {
  const turnId = mutEnsureTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) {
    mutUpsertText(state, turnId, "thinking", details.thinking, false);
  }
  mutUpsertText(state, turnId, "assistant-text", details.answer, false);
  mutFinishTurn(state, turnId);
}

function setTranscriptFailure(state: BtwTranscriptState, message: string): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? mutEnsureTurn(state);
  mutUpsertText(state, turnId, "assistant-text", `❌ ${message}`, false);
  mutFinishTurn(state, turnId, "failed");
}

function getCompletedExchangeCount(entries: BtwTranscript): number {
  const completedTurnIds = new Set(
    entries.flatMap((entry) =>
      entry.type === "turn-boundary" &&
      entry.phase === "end" &&
      (entry.outcome === undefined || entry.outcome === "completed")
        ? [entry.turnId]
        : [],
    ),
  );
  return entries.filter(
    (entry) => entry.type === "assistant-text" && !entry.streaming && completedTurnIds.has(entry.turnId),
  ).length;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return null;
}

type BtwHandoffExchange = {
  user: string;
  assistant: string;
};

function buildBtwMessageContent(question: string, answer: string): string {
  return `**Question**\n\n${question}\n\n**Answer**\n\n${answer}`;
}

function formatThread(thread: BtwHandoffExchange[]): string {
  return thread.map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`).join("\n\n---\n\n");
}

function isThreadContinuationMarker(messages: Message[], index: number): boolean {
  const userMessage = messages[index];
  const assistantMessage = messages[index + 1];
  return (
    userMessage?.role === "user" &&
    extractMessageText(userMessage) === BTW_CONTINUE_THREAD_USER_TEXT &&
    assistantMessage?.role === "assistant" &&
    extractMessageText(assistantMessage) === BTW_CONTINUE_THREAD_ASSISTANT_TEXT
  );
}

function extractBtwHandoffThread(sessionRuntime: BtwSessionRuntime): BtwHandoffExchange[] {
  const handoffMessages = sessionRuntime.session.state.messages.slice(sessionRuntime.sideThreadStartIndex);
  const threadMessages = isThreadContinuationMarker(handoffMessages as Message[], 0) ? handoffMessages.slice(2) : handoffMessages;
  const exchanges: BtwHandoffExchange[] = [];
  let currentUser = "";
  let currentAssistant = "";
  let excludeCurrent = false;

  const pushCurrent = () => {
    if (!excludeCurrent && (currentUser || currentAssistant)) {
      exchanges.push({
        user: currentUser.trim() || "(No user prompt)",
        assistant: currentAssistant.trim() || "(No assistant response)",
      });
    }
    currentUser = "";
    currentAssistant = "";
    excludeCurrent = false;
  };

  for (const message of threadMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (message.role === "user") {
      const text = extractMessageText(message).trim();
      if (!text) {
        continue;
      }
      pushCurrent();
      currentUser = text;
      continue;
    }

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      excludeCurrent = true;
      continue;
    }

    const text = extractMessageText(message).trim();
    if (text) {
      currentAssistant = currentAssistant ? `${currentAssistant}\n\n${text}` : text;
    }
  }

  pushCurrent();
  return exchanges;
}

function saveVisibleBtwNote(
  pi: ExtensionAPI,
  details: BtwDetails,
  saveRequested: boolean,
  wasBusy: boolean,
): SaveState {
  if (!saveRequested) {
    return "not-saved";
  }

  const message = {
    customType: BTW_MESSAGE_TYPE,
    content: buildBtwMessageContent(details.question, details.answer),
    display: true,
    details,
  };

  if (wasBusy) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    return "queued";
  }

  pi.sendMessage(message);
  return "saved";
}

function canRenderBtwOverlay(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

function notifyInlineQuestionRequired(
  ctx: ExtensionCommandContext,
  command: "/btw" | "/btw:tangent" | "/btw:new" | "/btw:ask",
): void {
  notify(ctx, `${command} cannot open its composer outside Pi's TUI. Pass the question inline instead.`, "warning");
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

/** Fixed overlay rows outside the transcript viewport (must match render() structure). */
const BTW_OVERLAY_CHROME_LINES = 9;

function getOverlayTitle(mode: BtwThreadMode): string {
  if (mode === "tangent") {
    return "BTW tangent";
  }
  if (mode === "readonly") {
    return "BTW ask · read-only";
  }
  return "BTW";
}

class BtwOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly statusText: Text;
  private readonly modeText: Text;
  private readonly summaryText: Text;
  private readonly hintsText: Text;
  private readonly readTranscriptEntries: () => BtwTranscript;
  private readonly getTranscriptVersion: () => number;
  private readonly readToolComponents: () => ToolComponentLookup;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => BtwThreadMode;
  private readonly getWidthMode: () => BtwOverlayWidthMode;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly onToggleWidthCallback: () => void;
  private readonly tui: TUI;
  private readonly theme: ExtensionContext["ui"]["theme"];
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private followTranscript = true;
  private transcriptRenderCache: { version: number; width: number; lines: string[] } | null = null;
  private ownsMouseReporting = false;
  private _focused = false;
  private modeTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: ExtensionContext["ui"]["theme"],
    keybindings: KeybindingsManager,
    readTranscriptEntries: () => BtwTranscript,
    getTranscriptVersion: () => number,
    readToolComponents: () => ToolComponentLookup,
    getStatus: () => string | null,
    getMode: () => BtwThreadMode,
    getWidthMode: () => BtwOverlayWidthMode,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
    onUnfocus: () => void,
    onToggleWidth: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.readTranscriptEntries = readTranscriptEntries;
    this.getTranscriptVersion = getTranscriptVersion;
    this.readToolComponents = readToolComponents;
    this.getStatus = getStatus;
    this.getMode = getMode;
    this.getWidthMode = getWidthMode;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;
    this.onUnfocusCallback = onUnfocus;
    this.onToggleWidthCallback = onToggleWidth;

    this.modeText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.statusText = new Text("", 1, 0);

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };

    this.hintsText = new Text("", 1, 0);

    // Enable SGR mouse reporting so wheel/touchpad events reach handleInput().
    // In fullscreen (alt-screen) mode pi-tui owns these terminal modes itself
    // (entered once on start, never re-asserted) and already forwards wheel
    // events to a focused overlay. Touching them here would conflict: on
    // dispose() we would write ?1000l ?1006l and permanently disable the very
    // modes pi-tui relies on to scroll the message view, breaking scrolling
    // for the rest of the session. Only opt in to mouse reporting in regular
    // (inline) mode where pi-tui does not manage it.
    //
    // `tui.mode` ("regular" | "fullscreen") was added in a later pi-tui than
    // the catalog-pinned peer; read it defensively so this compiles across
    // versions and treats an absent/unknown mode as regular (no conflict).
    const tuiMode = (this.tui as { mode?: "regular" | "fullscreen" }).mode;
    this.ownsMouseReporting = tuiMode !== "fullscreen";
    if (this.ownsMouseReporting) {
      this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
    }

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.input.handleInput = (data: string) => {
      if (keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) {
          this.input.setValue("");
          this.tui.requestRender();
          return;
        }

        this.onDismissCallback();
        return;
      }

      if (keybindings.matches(data, "tui.select.cancel")) {
        this.onDismissCallback();
        return;
      }
      originalHandleInput(data);
    };

    this.refresh();
  }

  private get borderless(): boolean {
    // Full-width mode drops the vertical bars and corner glyphs so a terminal
    // Shift+drag selection captures only the dialog's own text — with side
    // borders, the leftmost/rightmost columns would land inside the drag.
    return this.getWidthMode() === "full";
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    if (this.borderless) {
      return `${truncated}${" ".repeat(padding)}`;
    }
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapTranscript(lines: string[], innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of lines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    const terminalRows = process.stdout.rows ?? 30;
    return Math.max(18, Math.min(32, Math.floor(terminalRows * 0.78)));
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) {
      this.followTranscript = false;
    }
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    // Only undo the modes we actually enabled. In fullscreen mode pi-tui owns
    // mouse reporting; writing the disable sequence here would break message
    // scrolling until the TUI is restarted.
    if (this.ownsMouseReporting) {
      this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
    }
  }

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) {
      return null;
    }

    const button = Number(match[1]);
    if ((button & 64) !== 64) {
      return null;
    }

    return (button & 1) === 0 ? -3 : 3;
  }

  handleInput(data: string): void {
    if (matchesBtwFocusShortcut(data)) {
      this.onUnfocusCallback();
      return;
    }

    if (matchesBtwWidthToggle(data)) {
      this.onToggleWidthCallback();
      return;
    }

    const mouseScrollDelta = this.getMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scrollTranscript(mouseScrollDelta);
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      const step = matchesKey(data, Key.pageUp) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(-step);
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.pageDown) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(step);
      return;
    }

    this.input.handleInput(data);
  }

  private inputFrameLine(dialogWidth: number): string {
    const borderColumns = this.borderless ? 0 : 2;
    const targetWidth = Math.max(1, dialogWidth - borderColumns);
    const previousFocused = this.input.focused;
    // Input.render() emits CURSOR_MARKER when focused. In overlay mode that APC marker
    // can skew width/composition on this one row before the TUI strips it, producing a
    // right-edge notch and shifted border. Render the embedded input unfocused here so
    // the row stays geometrically stable while the overlay still owns keyboard input.
    this.input.focused = false;
    try {
      const renderedInputLine = this.input.render(targetWidth)[0] ?? "";
      const inputLine = truncateToWidth(renderedInputLine, targetWidth, "");
      const padding = Math.max(0, targetWidth - visibleWidth(inputLine));
      if (this.borderless) {
        return `${inputLine}${" ".repeat(padding)}`;
      }
      return `${this.theme.fg("border", "│")}${inputLine}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  private fitRenderedLine(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const innerWidth = Math.max(22, dialogWidth - 2);
    // Rebuild the transcript blocks only when the transcript changed (version
    // bumped by any state mutation) or the width moved: user/assistant messages
    // go through the main-window components (markdown-aware), tool blocks stay
    // textual. Component output is already wrapped to innerWidth, so the extra
    // wrap below only guards long tool-result lines. Without the cache every
    // streaming frame would re-run the full markdown render for the whole
    // transcript.
    const transcriptVersion = this.getTranscriptVersion();
    const cached = this.transcriptRenderCache;
    let transcriptLines: string[];
    if (cached && cached.version === transcriptVersion && cached.width === innerWidth) {
      transcriptLines = cached.lines;
    } else {
      transcriptLines = this.wrapTranscript(
        renderTranscriptLines(this.readTranscriptEntries(), {
          width: innerWidth,
          theme: this.theme,
          emptyText: "No BTW thread yet. Ask a side question to start one.",
          assistantLabel: "Assistant",
          thinkingLabel: "Thinking",
          toolComponents: this.readToolComponents(),
        }),
        innerWidth,
      );
      this.transcriptRenderCache = { version: transcriptVersion, width: innerWidth, lines: transcriptLines };
    }
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = BTW_OVERLAY_CHROME_LINES;
    const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [this.borderLine(innerWidth, "top")];

    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(this.modeTextValue.trim())), innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue.trim()), innerWidth));
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines.map((line) => this.fitRenderedLine(line, width));
  }

  setDraft(value: string): void {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  refresh(): void {
    this.modeTextValue = `${getOverlayTitle(this.getMode())} · hidden thread preserved`;
    this.modeText.setText(this.modeTextValue);
    const entries = this.readTranscriptEntries();
    const exchanges = getCompletedExchangeCount(entries);
    const active = hasStreamingTranscriptEntry(entries) ? " · streaming" : " · idle";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;
    this.summaryText.setText(this.summaryTextValue);

    const status = this.getStatus() ?? "Ready. Enter submits; Escape dismisses without clearing.";
    this.statusTextValue = status;
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = `Scroll wheel ↑↓ PgUp/PgDn · Enter · ${BTW_FOCUS_SHORTCUTS_LABEL} focus · Alt+w width · Esc`;
    this.hintsText.setText(this.hintsTextValue);
    this.tui.requestRender();
  }
}

export default function (pi: ExtensionAPI) {
  let pendingThread: BtwDetails[] = [];
  let pendingMode: BtwThreadMode = "contextual";
  let btwModelOverride: SessionModel | null = null;
  let btwThinkingOverride: SessionThinkingLevel | null = null;
  let transcriptState = createEmptyTranscriptState();
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  let overlayWidthMode: BtwOverlayWidthMode = "window";
  let overlayRuntime: OverlayRuntime | null = null;
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  let activeBtwSession: BtwSessionRuntime | null = null;
  let btwLifecycleGeneration = 0;
  let btwSubmissionQueue = Promise.resolve();

  function invalidateBtwLifecycle(): void {
    btwLifecycleGeneration += 1;
  }

  function syncUi(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? lastUiContext;
    if (activeCtx?.hasUI) {
      activeCtx.ui.setWidget("btw", undefined);
      overlayRuntime?.refresh?.();
    }
  }

  function setOverlayStatus(status: string | null, ctx?: ExtensionContext | ExtensionCommandContext): void {
    overlayStatus = status;
    syncUi(ctx);
  }

  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }

  function dismissOverlay(): void {
    overlayRuntime?.close?.();
    overlayRuntime = null;
  }

  function toggleOverlayFocus(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    overlayRuntime?.refresh?.();
  }

  function focusOverlay(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    handle.focus();
    overlayRuntime?.refresh?.();
  }

  function getOverlayOptions(): OverlayOptions {
    const base: OverlayOptions = {
      minWidth: 72,
      maxHeight: "78%",
      anchor: "top-center",
      nonCapturing: true,
    };
    if (overlayWidthMode === "full") {
      // Edge-to-edge so a terminal Shift+drag selection captures only the
      // dialog's own text — nothing from the main screen sits beside it.
      return { ...base, width: "100%", margin: { top: 1 } };
    }
    // Framed "window" look: narrower, inset from the terminal edges.
    return { ...base, width: "78%", margin: { top: 1, left: 2, right: 2 } };
  }

  async function toggleOverlayWidth(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    overlayWidthMode = overlayWidthMode === "window" ? "full" : "window";

    // overlayOptions is resolved once at showOverlay time, so a width change
    // requires tearing down and re-opening the overlay. The close path persists
    // the draft into overlayDraft, and ensureOverlay restores it on reopen.
    const wasFocused = overlayRuntime?.handle?.isFocused() ?? true;
    dismissOverlay();
    await ensureOverlay(ctx);
    if (!wasFocused) {
      overlayRuntime?.handle?.unfocus();
      overlayRuntime?.refresh?.();
    }
    setOverlayStatus(
      overlayWidthMode === "full"
        ? "Full-width mode. Shift+drag now selects only the dialog. Alt+w to restore the window."
        : "Window mode. Alt+w switches to full-width for clean copy selection.",
      ctx,
    );
  }

  function removeBtwSessionSubscription(sessionRuntime: BtwSessionRuntime, unsubscribe: () => void): void {
    if (!sessionRuntime.subscriptions.delete(unsubscribe)) {
      return;
    }

    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors during BTW session replacement/shutdown.
    }
  }

  function clearBtwSessionSubscriptions(sessionRuntime: BtwSessionRuntime): void {
    for (const unsubscribe of [...sessionRuntime.subscriptions]) {
      removeBtwSessionSubscription(sessionRuntime, unsubscribe);
    }
  }

  function handleBtwSessionEvent(
    sessionRuntime: BtwSessionRuntime,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (activeBtwSession?.session !== sessionRuntime.session || !overlayRuntime) {
      return;
    }

    applyTranscriptEvent(transcriptState, event);

    if (event.type === "tool_execution_start") {
      setOverlayStatus(`⏳ running tool: ${event.toolName}`, ctx);
      return;
    }

    if (event.type === "tool_execution_end") {
      setOverlayStatus(sessionRuntime.session.isStreaming ? `⏳ running tool: ${event.toolName}` : "⏳ streaming...", ctx);
      return;
    }

    if (event.type === "turn_end") {
      setOverlayStatus("⏳ streaming...", ctx);
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_start"
    ) {
      syncUi(ctx);
    }
  }

  function subscribeOverlayToActiveBtwSession(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const sessionRuntime = activeBtwSession;
    if (!sessionRuntime || sessionRuntime.subscriptions.size > 0) {
      return;
    }

    const unsubscribe = sessionRuntime.session.subscribe((event: AgentSessionEvent) => {
      handleBtwSessionEvent(sessionRuntime, event, ctx);
    });
    sessionRuntime.subscriptions.add(unsubscribe);
  }

  function requestBtwSessionAbort(sessionRuntime: BtwSessionRuntime): Promise<void> {
    sessionRuntime.abortPromise ??= Promise.resolve()
      .then(() => sessionRuntime.session.abort())
      .catch(() => {
        // Ignore abort errors during BTW cancellation/replacement/shutdown.
      });
    return sessionRuntime.abortPromise;
  }

  async function disposeBtwSession(): Promise<void> {
    const current = activeBtwSession;
    activeBtwSession = null;
    if (!current) {
      return;
    }

    clearBtwSessionSubscriptions(current);
    await requestBtwSessionAbort(current);
    current.session.dispose();
  }

  async function dismissOverlaySession(): Promise<void> {
    invalidateBtwLifecycle();
    dismissOverlay();
    await disposeBtwSession();
  }

  /**
   * Escape behaves differently depending on whether the BTW side session is
   * currently doing work:
   *
   * - streaming: the first Escape aborts the in-flight request but keeps the
   *   overlay open (so the partial transcript stays readable and the thread
   *   remains usable). A second Escape dismisses, even while cancellation settles.
   * - idle: Escape dismisses the overlay immediately (previous behavior).
   */
  async function dismissOrAbortOverlaySession(): Promise<void> {
    const sessionRuntime = activeBtwSession;
    if (sessionRuntime?.session.isStreaming && !sessionRuntime.abortPromise) {
      setOverlayStatus("⏹ Aborting. Press Esc again to dismiss the BTW overlay.");
      await requestBtwSessionAbort(sessionRuntime);
      if (activeBtwSession === sessionRuntime && overlayRuntime) {
        setOverlayStatus("⏹ Aborted. Press Esc again to dismiss the BTW overlay.");
      }
      return;
    }
    await dismissOverlaySession();
  }

  async function resolveBtwModel(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwModel> {
    if (btwModelOverride) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(btwModelOverride);
      if (hasUsableModelAuth(ctx, btwModelOverride, auth)) {
        return {
          model: btwModelOverride,
          source: "override",
          configuredOverride: btwModelOverride,
        };
      }

      const fallbackReason = ctx.model
        ? `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials. Falling back to main model ${formatModelRef(
            ctx.model,
          )}.`
        : `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials, and no main model is active.`;
      if (notifyOnFallback) {
        notify(ctx, fallbackReason, "warning");
      }

      if (ctx.model) {
        return {
          model: ctx.model,
          source: "main",
          configuredOverride: btwModelOverride,
          fallbackReason,
        };
      }

      return {
        model: null,
        source: "none",
        configuredOverride: btwModelOverride,
        fallbackReason,
      };
    }

    if (ctx.model) {
      return {
        model: ctx.model,
        source: "main",
        configuredOverride: null,
      };
    }

    return {
      model: null,
      source: "none",
      configuredOverride: null,
    };
  }

  async function resolveBtwSettings(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwSettings> {
    const resolvedModel = await resolveBtwModel(ctx, notifyOnFallback);
    const thinkingLevel = btwThinkingOverride ?? (pi.getThinkingLevel() as SessionThinkingLevel);

    return {
      model: resolvedModel.model,
      modelSource: resolvedModel.source,
      configuredModelOverride: resolvedModel.configuredOverride,
      thinkingLevel,
      thinkingSource: btwThinkingOverride ? "override" : "main",
      fallbackReason: resolvedModel.fallbackReason,
    };
  }

  function describeResolvedModel(settings: ResolvedBtwSettings): string {
    if (!settings.model) {
      if (settings.configuredModelOverride && settings.fallbackReason) {
        return `BTW model unavailable. ${settings.fallbackReason}`;
      }
      return "BTW model unavailable. No active model selected.";
    }

    const source =
      settings.modelSource === "override"
        ? "override"
        : settings.configuredModelOverride
          ? "inherited fallback"
          : "inherits main thread";
    return `BTW model: ${formatModelRef(settings.model)} (${source}).${
      settings.fallbackReason ? ` ${settings.fallbackReason}` : ""
    }`;
  }

  function describeResolvedThinking(settings: ResolvedBtwSettings): string {
    const source = settings.thinkingSource === "override" ? "override" : "inherits main thread";
    return `BTW thinking: ${settings.thinkingLevel} (${source}).`;
  }

  async function setBtwModelOverride(ctx: ExtensionCommandContext, nextModel: SessionModel | null): Promise<void> {
    invalidateBtwLifecycle();
    btwModelOverride = nextModel;
    const details: BtwModelOverrideDetails = nextModel
      ? { action: "set", timestamp: Date.now(), provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_MODEL_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextModel
      ? `BTW model override set to ${formatModelRef(nextModel)}.`
      : "BTW model override cleared. BTW now inherits the main thread model.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedModel(settings)}`, "info");
  }

  async function setBtwThinkingOverride(
    ctx: ExtensionCommandContext,
    nextThinkingLevel: SessionThinkingLevel | null,
  ): Promise<void> {
    invalidateBtwLifecycle();
    btwThinkingOverride = nextThinkingLevel;
    const details: BtwThinkingOverrideDetails = nextThinkingLevel
      ? { action: "set", timestamp: Date.now(), thinkingLevel: nextThinkingLevel }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextThinkingLevel
      ? `BTW thinking override set to ${nextThinkingLevel}.`
      : "BTW thinking override cleared. BTW now inherits the main thread thinking level.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedThinking(settings)}`, "info");
  }

  async function createBtwSubSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
    settings: ResolvedBtwSettings,
  ): Promise<BtwSessionRuntime> {
    if (!settings.model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const modelRuntimeOptions = await createBtwModelRuntimeOptions(ctx, settings.model);
    const sessionManager = SessionManager.inMemory();
    const { messages: seedMessages, sideThreadStartIndex } = buildBtwSeedState(ctx, pendingThread, mode, settings.model);

    // The session manager is the source of provider context. Seed it before
    // creating the AgentSession so its initial context includes these messages.
    for (const message of seedMessages) {
      sessionManager.appendMessage(message);
    }

    const sessionOptions: CreateAgentSessionOptions = {
      sessionManager,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      // Read-only mode narrows this to pi's built-in read-only toolset.
      tools: [...BTW_TOOLS_BY_MODE[mode]],
      resourceLoader: createBtwResourceLoader(ctx),
      ...modelRuntimeOptions,
    };
    const { session } = await createAgentSession(sessionOptions);

    return { session, mode, subscriptions: new Set(), sideThreadStartIndex, promptQueue: Promise.resolve() };
  }

  async function ensureBtwSession(ctx: ExtensionCommandContext, mode: BtwThreadMode): Promise<BtwSessionRuntime | null> {
    const settings = await resolveBtwSettings(ctx, true);
    if (!settings.model) {
      return null;
    }

    if (activeBtwSession?.mode === mode) {
      return activeBtwSession;
    }

    await disposeBtwSession();
    activeBtwSession = await createBtwSubSession(ctx, mode, settings);
    return activeBtwSession;
  }

  async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!canRenderBtwOverlay(ctx)) {
      return;
    }
    lastUiContext = ctx;

    if (overlayRuntime?.handle) {
      subscribeOverlayToActiveBtwSession(ctx);
      focusOverlay();
      return;
    }

    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      if (activeBtwSession) {
        clearBtwSessionSubscriptions(activeBtwSession);
      }
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        async (tui, theme, keybindings, done) => {
          // Route native tool component repaint requests (streaming bash
          // output, elapsed-time intervals) to the live TUI.
          transcriptState.toolComponents.attachTui(tui);
          runtime.finish = () => {
            done();
          };

          const overlay = new BtwOverlayComponent(
            tui,
            theme,
            keybindings,
            () => transcriptState.entries,
            () => transcriptVersion,
            () => transcriptState.toolComponents,
            () => overlayStatus,
            () => pendingMode,
            () => overlayWidthMode,
            (value) => {
              void submitFromOverlay(ctx, value);
            },
            () => {
              void dismissOrAbortOverlaySession();
            },
            () => {
              overlayRuntime?.handle?.unfocus();
              overlayRuntime?.refresh?.();
            },
            () => {
              void toggleOverlayWidth(ctx);
            },
          );

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            closeRuntime();
          };

          subscribeOverlayToActiveBtwSession(ctx);

          if (runtime.closed) {
            done();
          }

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: getOverlayOptions(),
          onHandle: (handle) => {
            runtime.handle = handle;
            handle.focus();
            if (runtime.closed) {
              closeRuntime();
            }
          },
        },
      )
      .catch((error) => {
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
  }

  async function dispatchBtwCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const trimmedArgs = args.trim();

    if (name === "btw") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question) {
        if (!canRenderBtwOverlay(ctx)) {
          notifyInlineQuestionRequired(ctx, "/btw");
          return true;
        }
        await ensureBtwSession(ctx, pendingMode);
        await ensureOverlay(ctx);
        return true;
      }

      if (pendingMode !== "contextual") {
        await resetThread(ctx, true, "contextual");
      }

      await runBtw(ctx, question, save, "contextual");
      return true;
    }

    if (name === "btw:tangent") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:tangent");
        return true;
      }
      if (pendingMode !== "tangent") {
        await resetThread(ctx, true, "tangent");
      }

      if (!question) {
        await ensureBtwSession(ctx, "tangent");
        await ensureOverlay(ctx);
        return true;
      }

      await runBtw(ctx, question, save, "tangent");
      return true;
    }

    if (name === "btw:ask") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:ask");
        return true;
      }

      // Read-only mode is a distinct capability boundary, so switching into it
      // resets the thread and lets ensureBtwSession recreate the child session.
      if (pendingMode !== "readonly") {
        await resetThread(ctx, true, "readonly");
      }

      if (!question) {
        await ensureBtwSession(ctx, "readonly");
        await ensureOverlay(ctx);
        return true;
      }

      await runBtw(ctx, question, save, "readonly");
      return true;
    }

    if (name === "btw:new") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:new");
        return true;
      }

      await resetThread(ctx, true, "contextual");
      if (question) {
        await runBtw(ctx, question, save, "contextual");
      } else {
        await ensureBtwSession(ctx, "contextual");
        setOverlayStatus("Started a fresh BTW thread.", ctx);
        await ensureOverlay(ctx);
        notify(ctx, "Started a fresh BTW thread.", "info");
      }
      return true;
    }

    if (name === "btw:clear") {
      await resetThread(ctx);
      dismissOverlay();
      notify(ctx, "Cleared BTW thread.", "info");
      return true;
    }

    if (name === "btw:model") {
      const parsed = parseBtwModelArgs(trimmedArgs);
      if (parsed.action === "invalid") {
        setOverlayStatus(parsed.message, ctx);
        notify(ctx, parsed.message, "error");
        return true;
      }

      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx);
        const message = describeResolvedModel(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, settings.model ? "info" : "warning");
        return true;
      }

      if (parsed.action === "clear") {
        await setBtwModelOverride(ctx, null);
        return true;
      }
      const ref = parsed.model;
      const resolved = ctx.modelRegistry.find(ref.provider, ref.id);
      if (!resolved) {
        const message = `Unknown model ${ref.provider}/${ref.id}. Use /login or /models to add it before setting it as the BTW override.`;
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return true;
      }
      await setBtwModelOverride(ctx, resolved);
      return true;
    }

    if (name === "btw:thinking") {
      const parsed = parseBtwThinkingArgs(trimmedArgs);
      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx);
        const message = describeResolvedThinking(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, "info");
        return true;
      }

      await setBtwThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.thinkingLevel);
      return true;
    }

    if (name === "btw:inject") {
      await btwSubmissionQueue;
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to inject.", "warning");
        return true;
      }

      setOverlayStatus("⏳ injecting into the main session...", ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a side conversation I had. ${instructions}\n\n${formatThread(thread)}`
          : `Here is a side conversation I had for additional context:\n\n${formatThread(thread)}`;

        sendThreadToMain(ctx, content);
        const count = thread.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected BTW thread (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Inject failed. Thread preserved for retry or summarize.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (name === "btw:summarize") {
      await btwSubmissionQueue;
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to summarize.", "warning");
        return true;
      }

      setOverlayStatus("⏳ summarizing...", ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const summary = await summarizeThread(ctx, thread);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a summary of a side conversation I had. ${instructions}\n\n${summary}`
          : `Here is a summary of a side conversation I had:\n\n${summary}`;

        sendThreadToMain(ctx, content);
        const count = thread.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected BTW summary (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Summarize failed. Thread preserved for retry or injection.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    return false;
  }

  function parseOverlayBtwCommand(value: string): { name: string; args: string } | null {
    const trimmed = value.trim();
    const match = trimmed.match(/^\/(btw:(?:new|ask|tangent|clear|inject|summarize|model|thinking))(?:\s+(.*))?$/);
    if (!match) {
      return null;
    }

    return {
      name: match[1],
      args: match[2]?.trim() ?? "",
    };
  }

  async function submitFromOverlay(ctx: ExtensionCommandContext | ExtensionContext, value: string): Promise<void> {
    const question = value.trim();
    if (!question) {
      setOverlayStatus("Enter a BTW prompt before submitting.", ctx);
      return;
    }

    if (!("getSystemPrompt" in ctx)) {
      setOverlayStatus("BTW overlay submit requires a command context. Reopen BTW from a command.", ctx);
      return;
    }

    const cmdCtx = ctx as ExtensionCommandContext;
    const btwCommand = parseOverlayBtwCommand(question);
    if (btwCommand) {
      setOverlayDraft("");
      await dispatchBtwCommand(btwCommand.name, btwCommand.args, cmdCtx);
      return;
    }

    setOverlayDraft("");
    setOverlayStatus("⏳ streaming...", ctx);
    syncUi(ctx);
    await runBtw(cmdCtx, question, false, pendingMode);
  }

  async function resetThread(
    ctx: ExtensionContext | ExtensionCommandContext,
    persist = true,
    mode: BtwThreadMode = "contextual",
  ): Promise<void> {
    invalidateBtwLifecycle();
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = mode;
    transcriptState = createEmptyTranscriptState();
    bumpTranscriptVersion();
    setOverlayDraft("");
    setOverlayStatus(null, ctx);
    if (persist) {
      const details: BtwResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    syncUi(ctx);
  }

  async function restoreThread(ctx: ExtensionContext): Promise<void> {
    invalidateBtwLifecycle();
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = "contextual";
    btwModelOverride = null;
    btwThinkingOverride = null;
    transcriptState = createEmptyTranscriptState();
    bumpTranscriptVersion();
    overlayDraft = "";
    lastUiContext = ctx;
    overlayStatus = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;

    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], BTW_MODEL_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwModelOverrideDetails }).data;
        if (details?.action === "set") {
          const resolved = ctx.modelRegistry.find(details.provider, details.id);
          if (resolved) {
            btwModelOverride = resolved;
          } else {
            // Configured override is no longer in the registry; drop it on restore.
            btwModelOverride = null;
          }
        } else if (details?.action === "clear") {
          btwModelOverride = null;
        }
      }

      if (isCustomEntry(branch[i], BTW_THINKING_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwThinkingOverrideDetails }).data;
        btwThinkingOverride =
          details?.action === "set"
            ? details.thinkingLevel
            : details?.action === "clear"
              ? null
              : btwThinkingOverride;
      }

      if (isCustomEntry(branch[i], BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const details = (branch[i] as unknown as { data?: BtwResetDetails }).data;
        pendingMode = details?.mode ?? "contextual";
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        continue;
      }

      const details = (entry as unknown as { data?: BtwDetails }).data;
      if (!details?.question || !details.answer) {
        continue;
      }

      const normalizedDetails: BtwDetails = {
        ...details,
        api: details.api || ctx.model?.api || "openai-responses",
      };

      pendingThread.push(normalizedDetails);
      appendPersistedTranscriptTurn(transcriptState, normalizedDetails);
    }

    syncUi(ctx);
  }

  async function runBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
  ): Promise<void> {
    const generation = btwLifecycleGeneration;
    const submission = btwSubmissionQueue.then(async () => {
      if (generation !== btwLifecycleGeneration) {
        return;
      }
      await executeBtw(ctx, question, saveRequested, mode, generation);
    });
    btwSubmissionQueue = submission.catch(() => {});
    await submission;
  }

  async function executeBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
    generation: number,
  ): Promise<void> {
    const isCurrentGeneration = () => generation === btwLifecycleGeneration;
    lastUiContext = ctx;
    const settings = await resolveBtwSettings(ctx);
    if (!isCurrentGeneration()) {
      return;
    }
    const model = settings.model;
    if (!model) {
      const message = settings.fallbackReason || "No active model selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!isCurrentGeneration()) {
      return;
    }
    if (!hasUsableModelAuth(ctx, model, auth)) {
      const message = auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      await ensureOverlay(ctx);
      return;
    }

    const sessionRuntime = await ensureBtwSession(ctx, mode);
    if (!isCurrentGeneration()) {
      if (sessionRuntime && activeBtwSession === sessionRuntime) {
        await disposeBtwSession();
      }
      return;
    }
    if (!sessionRuntime) {
      setOverlayStatus("No active model selected.", ctx);
      notify(ctx, "No active model selected.", "error");
      return;
    }

    const session = sessionRuntime.session;
    const wasBusy = !ctx.isIdle();
    const overlayAvailable = canRenderBtwOverlay(ctx);
    pendingMode = mode;
    const thinkingLevel = settings.thinkingLevel;

    let releasePromptTurn!: () => void;
    const previousPromptTurns = sessionRuntime.promptQueue;
    const currentPromptTurn = new Promise<void>((resolve) => {
      releasePromptTurn = resolve;
    });
    sessionRuntime.promptQueue = previousPromptTurns.then(() => currentPromptTurn);

    if (session.isStreaming || sessionRuntime.abortPromise) {
      setOverlayStatus("⏳ waiting for the current BTW turn to finish...", ctx);
    }
    await previousPromptTurns;
    if (activeBtwSession !== sessionRuntime) {
      releasePromptTurn();
      return;
    }

    if (sessionRuntime.abortPromise) {
      setOverlayStatus("⏳ waiting for cancellation to finish...", ctx);
      await sessionRuntime.abortPromise;
      if (activeBtwSession !== sessionRuntime) {
        releasePromptTurn();
        return;
      }
    }

    if (!isCurrentGeneration()) {
      releasePromptTurn();
      return;
    }

    sessionRuntime.abortPromise = undefined;
    setOverlayStatus("⏳ streaming...", ctx);
    await ensureOverlay(ctx);

    try {
      await session.prompt(question, { source: "extension" });
      if (!isCurrentGeneration()) {
        return;
      }

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        const abortedTurnId = transcriptState.currentTurnId ?? transcriptState.lastTurnId;
        if (abortedTurnId !== null) mutFinishTurn(transcriptState, abortedTurnId, "aborted");
        setOverlayStatus("⏹ Aborted. Press Esc again to dismiss the BTW overlay.", ctx);
        return;
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "BTW request failed.");
      }

      const completedTurnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
      const streamedThinking =
        completedTurnId === null ? "" : findLatestEntry(transcriptState, completedTurnId, "thinking")?.text;
      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || streamedThinking || "";

      const details: BtwDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        api: model.api,
        thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
      };

      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);

      const saveState = saveVisibleBtwNote(pi, details, saveRequested || !overlayAvailable, wasBusy);
      if (!overlayAvailable) {
        const message =
          saveState === "queued"
            ? "BTW response queued to display after the current turn finishes."
            : "Displayed BTW response in the session.";
        notify(ctx, message, "info");
        setOverlayStatus(message, ctx);
      } else if (saveState === "saved") {
        notify(ctx, "Saved BTW note to the session.", "info");
        setOverlayStatus("Saved BTW note to the session.", ctx);
      } else if (saveState === "queued") {
        notify(ctx, "BTW note queued to save after the current turn finishes.", "info");
        setOverlayStatus("BTW note queued to save after the current turn finishes.", ctx);
      } else {
        setOverlayStatus("Ready for a follow-up. Hidden BTW thread updated.", ctx);
      }
    } catch (error) {
      if (!isCurrentGeneration()) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      setTranscriptFailure(transcriptState, errorMessage);
      setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, errorMessage, "error");
      await disposeBtwSession();
    } finally {
      releasePromptTurn();
      syncUi(ctx);
    }
  }

  function getPendingThreadForHandoff(): BtwHandoffExchange[] {
    return pendingThread.map((entry) => ({ user: entry.question, assistant: entry.answer }));
  }

  async function getBtwHandoffThread(
    ctx: ExtensionCommandContext,
  ): Promise<{ sessionRuntime: BtwSessionRuntime | null; thread: BtwHandoffExchange[] }> {
    const pendingSubmissions = btwSubmissionQueue;
    await pendingSubmissions;

    const sessionRuntime = activeBtwSession ?? (await ensureBtwSession(ctx, pendingMode));
    if (sessionRuntime) {
      const pendingPromptTurns = sessionRuntime.promptQueue;
      const pendingAbort = sessionRuntime.abortPromise;
      await pendingPromptTurns;
      await pendingAbort;
      if (activeBtwSession !== sessionRuntime) {
        throw new Error("BTW session closed before handoff completed.");
      }
    }

    const thread = sessionRuntime ? extractBtwHandoffThread(sessionRuntime) : [];
    const resolvedThread = thread.length > 0 ? thread : getPendingThreadForHandoff();

    if (resolvedThread.length === 0) {
      throw new Error("No BTW thread available for handoff.");
    }

    return { sessionRuntime, thread: resolvedThread };
  }

  async function summarizeThread(ctx: ExtensionCommandContext, thread: BtwHandoffExchange[]): Promise<string> {
    const settings = await resolveBtwSettings(ctx, true);
    const model = settings.model;
    if (!model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!hasUsableModelAuth(ctx, model, auth)) {
      throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
    }

    const modelRuntimeOptions = await createBtwModelRuntimeOptions(ctx, model);

    const sessionOptions: CreateAgentSessionOptions = {
      sessionManager: SessionManager.inMemory(),
      model,
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARIZE_SYSTEM_PROMPT]),
      ...modelRuntimeOptions,
    };
    const { session } = await createAgentSession(sessionOptions);

    try {
      await session.prompt(formatThread(thread), { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW summarize finished without a response.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("BTW summarize aborted.");
      }

      return extractAnswer(response);
    } finally {
      try {
        await session.abort();
      } catch {
        // Ignore abort errors during summarize session shutdown.
      }
      session.dispose();
    }
  }

  function sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    }
  }

  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content = details
      ? buildBtwMessageContent(details.question, details.answer)
      : typeof message.content === "string"
        ? message.content
        : "[non-text btw message]";

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold("[BTW]")), 0, 0));
    box.addChild(
      new Markdown(content, 0, 0, getMarkdownTheme(), {
        color: (text: string) => theme.fg("customMessageText", text),
      }),
    );

    if (expanded && details) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`,
          ),
          0,
          0,
        ),
      );

      if (details.usage) {
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`,
            ),
            0,
            0,
          ),
        );
      }
    }

    return box;
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleBtwMessage(message)),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    invalidateBtwLifecycle();
    await disposeBtwSession();
    dismissOverlay();
  });

  for (const shortcut of BTW_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle BTW overlay focus while leaving it open.",
      handler: async (_ctx) => {
        toggleOverlayFocus();
      },
    });
  }

  pi.registerShortcut(BTW_WIDTH_TOGGLE_SHORTCUT, {
    description: "Toggle the BTW overlay between window and full-width layouts.",
    handler: async () => {
      if (!overlayRuntime || !lastUiContext) {
        return;
      }
      await toggleOverlayWidth(lastUiContext);
    },
  });

  pi.registerCommand("btw", {
    description: "Continue a side conversation in a focused BTW modal. Add --save to also persist a visible note.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw", args, ctx);
    },
  });

  pi.registerCommand("side", {
    description: "Alias for /btw: continue a side conversation in a focused BTW modal.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw", args, ctx);
    },
  });

  pi.registerCommand("btw:tangent", {
    description: "Start or continue a contextless BTW tangent in the focused BTW modal.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:tangent", args, ctx);
    },
  });

  pi.registerCommand("btw:ask", {
    description: "Ask a read-only side question: inherits main-session context but exposes only read/grep/find/ls tools.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:ask", args, ctx);
    },
  });

  pi.registerCommand("btw:new", {
    description: "Start a fresh BTW thread with main-session context. Optionally ask the first question immediately.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:new", args, ctx);
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Dismiss the BTW modal/widget and clear the current thread.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:clear", args, ctx);
    },
  });

  pi.registerCommand("btw:inject", {
    description: "Inject the full BTW thread into the main agent as a user message.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:inject", args, ctx);
    },
  });

  pi.registerCommand("btw:summarize", {
    description: "Summarize the BTW thread, then inject the summary into the main agent.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:summarize", args, ctx);
    },
  });

  pi.registerCommand("btw:model", {
    description: "Show, set, or clear the BTW-only model override.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:model", args, ctx);
    },
  });

  pi.registerCommand("btw:thinking", {
    description: "Show, set, or clear the BTW-only thinking override.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:thinking", args, ctx);
    },
  });
}

