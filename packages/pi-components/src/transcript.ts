import {
  AssistantMessageComponent,
  getMarkdownTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/**
 * Structural subset of Pi's theme used by transcript rendering.
 * Pi theme-key unions vary across supported SDK versions, while the public
 * transcript API only passes named string keys.
 */
export interface TranscriptTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** Structural subset of Pi's TUI used by the scroll viewport. */
export interface TranscriptTui {
  requestRender(): void;
}

type Theme = TranscriptTheme;
type ThemeColor = string;
type ThemeBackground = string;

export type TranscriptNoticeTone = "info" | "warning" | "error";

export type TranscriptEntry =
  | {
      id: number;
      turnId: number;
      type: "turn-boundary";
      phase: "start" | "end";
    }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | {
      id: number;
      turnId: number;
      type: "thinking";
      text: string;
      streaming: boolean;
    }
  | {
      id: number;
      turnId: number;
      type: "assistant-text";
      text: string;
      streaming: boolean;
    }
  | {
      id: number;
      turnId: number;
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: string;
    }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    }
  | {
      id: number;
      turnId: number;
      type: "notice";
      text: string;
      tone: TranscriptNoticeTone;
    };

interface ActiveAssistantSegment {
  turnId: number;
  thinkingEntryId?: number;
  textEntryId?: number;
}

export interface TranscriptState {
  entries: TranscriptEntry[];
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  activeAssistant: ActiveAssistantSegment | null;
  toolCalls: Map<
    string,
    { turnId: number; callEntryId: number; resultEntryId?: number }
  >;
}

export interface SessionTranscriptOptions {
  /** Maximum retained entries. Oldest entries are discarded first. */
  maxEntries?: number;
  /** Maximum retained text across all entries. */
  maxChars?: number;
  /** Maximum retained text for an individual tool result. */
  maxToolResultChars?: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_CHARS = 512 * 1024;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 16 * 1024;

export function createTranscriptState(): TranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    activeAssistant: null,
    toolCalls: new Map(),
  };
}

function codePointWidth(codePoint: number): 1 | 2 {
  return codePoint > 0xffff ? 2 : 1;
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff
  );
}

function consumeControlString(
  value: string,
  index: number,
  osc: boolean,
): number {
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePointWidth(codePoint);
    if (osc && codePoint === 0x07) return index + width;
    if (codePoint === 0x9c) return index + width;
    if (codePoint === 0x1b && value.charCodeAt(index + 1) === 0x5c)
      return index + 2;
    index += width;
  }
  return value.length;
}

function consumeCsi(value: string, index: number): number {
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePointWidth(codePoint);
    if (codePoint >= 0x40 && codePoint <= 0x7e) return index + width;
    index += width;
  }
  return value.length;
}

function looksLikeBinaryContent(text: string): boolean {
  if (text.includes("\0")) return true;
  let suspiciousControls = 0;
  let replacementCharacters = 0;
  let codePoints = 0;
  for (const character of text) {
    codePoints++;
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x08 || (codePoint >= 0x0e && codePoint <= 0x1f))
      suspiciousControls++;
    if (codePoint === 0xfffd) replacementCharacters++;
  }
  return (
    codePoints > 0 &&
    ((suspiciousControls >= 4 && suspiciousControls / codePoints >= 0.1) ||
      (replacementCharacters >= 3 && replacementCharacters / codePoints >= 0.1))
  );
}

/** Escapes terminal control sequences in model and tool output before rendering. */
export function safeTerminalText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  if (looksLikeBinaryContent(normalized))
    return "[binary content omitted for safe display]";

  let safe = "";
  for (let index = 0; index < normalized.length; ) {
    const codePoint = normalized.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePointWidth(codePoint);
    if (codePoint === 0x1b) {
      const next = normalized.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = consumeCsi(normalized, index + 2);
        continue;
      }
      if (
        next === 0x5d ||
        next === 0x50 ||
        next === 0x58 ||
        next === 0x5e ||
        next === 0x5f
      ) {
        index = consumeControlString(normalized, index + 2, next === 0x5d);
        continue;
      }
      index += next ? 2 : 1;
      continue;
    }
    if (codePoint === 0x9b) {
      index = consumeCsi(normalized, index + width);
      continue;
    }
    if (
      codePoint === 0x90 ||
      codePoint === 0x98 ||
      codePoint === 0x9d ||
      codePoint === 0x9e ||
      codePoint === 0x9f
    ) {
      index = consumeControlString(
        normalized,
        index + width,
        codePoint === 0x9d,
      );
      continue;
    }
    safe += isUnsafeTerminalCodePoint(codePoint)
      ? `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`
      : String.fromCodePoint(codePoint);
    index += width;
  }
  return safe;
}

function appendEntry(
  state: TranscriptState,
  entry: Omit<TranscriptEntry, "id"> & Record<string, unknown>,
): TranscriptEntry {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as TranscriptEntry;
  state.entries.push(nextEntry);
  return nextEntry;
}

function ensureTurn(state: TranscriptState): number {
  if (state.currentTurnId !== null) return state.currentTurnId;
  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendEntry(state, { type: "turn-boundary", turnId, phase: "start" });
  return turnId;
}

function findLatestEntry<TType extends TranscriptEntry["type"]>(
  state: TranscriptState,
  turnId: number,
  type: TType,
): Extract<TranscriptEntry, { type: TType }> | undefined {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (!entry) continue;
    if (entry.turnId === turnId && entry.type === type) {
      return entry as Extract<TranscriptEntry, { type: TType }>;
    }
  }
  return undefined;
}

function finishTurn(
  state: TranscriptState,
  turnId: number | null = state.currentTurnId,
): void {
  if (turnId === null) return;
  const alreadyFinished = state.entries.some(
    (entry) =>
      entry.turnId === turnId &&
      entry.type === "turn-boundary" &&
      entry.phase === "end",
  );
  if (!alreadyFinished)
    appendEntry(state, { type: "turn-boundary", turnId, phase: "end" });
  for (const entry of state.entries) {
    if (entry.turnId !== turnId) continue;
    if (
      entry.type === "thinking" ||
      entry.type === "assistant-text" ||
      entry.type === "tool-result"
    ) {
      entry.streaming = false;
    }
  }
  state.lastTurnId = turnId;
  if (state.currentTurnId === turnId) state.currentTurnId = null;
  if (state.activeAssistant?.turnId === turnId) state.activeAssistant = null;
}

export function removeTranscriptTurn(
  state: TranscriptState,
  turnId: number | null,
): void {
  if (turnId === null) return;
  state.entries = state.entries.filter((entry) => entry.turnId !== turnId);
  for (const [toolCallId, toolCall] of state.toolCalls.entries()) {
    if (toolCall.turnId === turnId) state.toolCalls.delete(toolCallId);
  }
  if (state.currentTurnId === turnId) state.currentTurnId = null;
  if (state.lastTurnId === turnId) state.lastTurnId = null;
  if (state.activeAssistant?.turnId === turnId) state.activeAssistant = null;
}

function extractMessageText(message: { content?: unknown }): string {
  if (typeof message.content === "string")
    return safeTerminalText(message.content);
  if (!Array.isArray(message.content)) return "";

  const textParts: string[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const typedPart = part as { type?: unknown; text?: unknown };
    if (typedPart.type === "text" && typeof typedPart.text === "string") {
      textParts.push(safeTerminalText(typedPart.text));
    }
  }
  return textParts.join("\n").trim();
}

function extractThinking(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";

  const thinkingParts: string[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const typedPart = part as { type?: unknown; thinking?: unknown };
    if (
      typedPart.type === "thinking" &&
      typeof typedPart.thinking === "string"
    ) {
      thinkingParts.push(safeTerminalText(typedPart.thinking));
    }
  }
  return thinkingParts.join("\n").trim();
}

function formatToolPreview(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of [
      "path",
      "file",
      "filePath",
      "command",
      "query",
      "pattern",
    ]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return safeTerminalText(candidate.trim()).slice(0, 240);
      }
    }
  }
  try {
    const serialized = JSON.stringify(value);
    return safeTerminalText(
      serialized && serialized !== "{}" ? serialized : "",
    ).slice(0, 240);
  } catch {
    return safeTerminalText(String(value ?? "")).slice(0, 240);
  }
}

function summarizeToolResult(
  value: unknown,
  maxLength: number,
): { content: string; truncated: boolean } {
  let content = "";
  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };
    if (Array.isArray(toolValue.content)) {
      const textParts: string[] = [];
      for (const part of toolValue.content) {
        if (part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
      content = textParts.join("\n").trim();
    }
    if (!content && typeof toolValue.error === "string")
      content = toolValue.error;
    if (!content && typeof toolValue.message === "string")
      content = toolValue.message;
  }
  if (!content) {
    if (typeof value === "string") content = value;
    else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2) ?? "";
      } catch {
        content = String(value);
      }
    }
  }
  if (!content) content = "(no tool output)";
  const safe = safeTerminalText(content);
  const truncated = safe.length > maxLength;
  return {
    content: truncated
      ? `${safe.slice(0, Math.max(0, maxLength - 3))}...`
      : safe,
    truncated,
  };
}

function ensureToolCall(
  state: TranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) return existing;
  const callEntry = appendEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  });
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

function findActiveAssistantEntry(
  state: TranscriptState,
  entryId: number | undefined,
  type: "thinking" | "assistant-text",
):
  | Extract<TranscriptEntry, { type: "thinking" | "assistant-text" }>
  | undefined {
  if (entryId === undefined) return undefined;
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  return entry?.type === type ? entry : undefined;
}

function updateActiveAssistantText(
  state: TranscriptState,
  segment: ActiveAssistantSegment,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) return;
  const entryId =
    type === "thinking" ? segment.thinkingEntryId : segment.textEntryId;
  const existing = findActiveAssistantEntry(state, entryId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }

  const entry = appendEntry(state, {
    type,
    turnId: segment.turnId,
    text,
    streaming,
  });
  if (type === "thinking") segment.thinkingEntryId = entry.id;
  else segment.textEntryId = entry.id;
}

function ensureActiveAssistantSegment(
  state: TranscriptState,
  turnId: number,
  startNew: boolean,
): ActiveAssistantSegment {
  if (startNew || state.activeAssistant?.turnId !== turnId) {
    state.activeAssistant = { turnId };
  }
  return state.activeAssistant;
}

function finishActiveAssistantSegment(state: TranscriptState): void {
  const segment = state.activeAssistant;
  if (!segment) return;
  const thinking = findActiveAssistantEntry(
    state,
    segment.thinkingEntryId,
    "thinking",
  );
  if (thinking) thinking.streaming = false;
  const text = findActiveAssistantEntry(
    state,
    segment.textEntryId,
    "assistant-text",
  );
  if (text) text.streaming = false;
  state.activeAssistant = null;
}

function upsertText(
  state: TranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) return;
  const existing = findLatestEntry(state, turnId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }
  appendEntry(state, { type, turnId, text, streaming });
}

function upsertToolResult(
  state: TranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  result: { content: string; truncated: boolean },
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCall(state, turnId, toolCallId, toolName, "");
  const existing =
    toolCall.resultEntryId === undefined
      ? undefined
      : state.entries.find(
          (entry) =>
            entry.id === toolCall.resultEntryId && entry.type === "tool-result",
        );
  if (existing && existing.type === "tool-result") {
    existing.content = result.content;
    existing.truncated = result.truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }
  const resultEntry = appendEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content: result.content,
    truncated: result.truncated,
    isError,
    streaming,
  });
  toolCall.resultEntryId = resultEntry.id;
}

function appendNotice(
  state: TranscriptState,
  text: string,
  tone: TranscriptNoticeTone,
): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTurn(state);
  appendEntry(state, {
    type: "notice",
    turnId,
    text: safeTerminalText(text),
    tone,
  });
}

function entryLength(entry: TranscriptEntry): number {
  switch (entry.type) {
    case "user-message":
    case "thinking":
    case "assistant-text":
    case "notice":
      return entry.text.length;
    case "tool-call":
      return entry.toolName.length + entry.args.length;
    case "tool-result":
      return entry.toolName.length + entry.content.length;
    default:
      return 0;
  }
}

function pruneToolCallIndex(state: TranscriptState): void {
  const entryIds = new Set(state.entries.map((entry) => entry.id));
  for (const [toolCallId, record] of state.toolCalls.entries()) {
    if (!entryIds.has(record.callEntryId)) state.toolCalls.delete(toolCallId);
    else if (
      record.resultEntryId !== undefined &&
      !entryIds.has(record.resultEntryId)
    ) {
      record.resultEntryId = undefined;
    }
  }
}

export function trimTranscriptState(
  state: TranscriptState,
  options: SessionTranscriptOptions = {},
): void {
  const maxEntries = Math.max(16, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxChars = Math.max(1024, options.maxChars ?? DEFAULT_MAX_CHARS);
  while (state.entries.length > maxEntries) state.entries.shift();
  let chars = state.entries.reduce(
    (total, entry) => total + entryLength(entry),
    0,
  );
  while (chars > maxChars && state.entries.length > 1) {
    const removed = state.entries.shift();
    if (removed) chars -= entryLength(removed);
  }
  pruneToolCallIndex(state);
}

type SessionEventLike = {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: unknown;
  attempt?: unknown;
  maxAttempts?: unknown;
  delayMs?: unknown;
  errorMessage?: unknown;
  success?: unknown;
  finalError?: unknown;
};

function eventString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim()
    ? safeTerminalText(value)
    : fallback;
}

function eventNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type TranscriptMessageEventPhase = "start" | "update" | "end";

function applyTranscriptMessageEvent(
  state: TranscriptState,
  event: SessionEventLike,
  phase: TranscriptMessageEventPhase,
): void {
  const message = event.message ?? {};
  if (message.role === "user") {
    const turnId = ensureTurn(state);
    const text = extractMessageText(message);
    if (!text) return;
    const existing = findLatestEntry(state, turnId, "user-message");
    if (existing) existing.text = text;
    else appendEntry(state, { type: "user-message", turnId, text });
    return;
  }
  if (message.role !== "assistant") return;

  const turnId = ensureTurn(state);
  const segment = ensureActiveAssistantSegment(
    state,
    turnId,
    phase === "start",
  );
  const streaming = phase !== "end";
  updateActiveAssistantText(
    state,
    segment,
    "thinking",
    extractThinking(message),
    streaming,
  );
  updateActiveAssistantText(
    state,
    segment,
    "assistant-text",
    extractMessageText(message),
    streaming,
  );
  if (phase === "end") finishActiveAssistantSegment(state);
}

function eventToolCallId(
  state: TranscriptState,
  event: SessionEventLike,
): string {
  return eventString(event.toolCallId, `unknown-tool-${state.nextEntryId}`);
}

function applyTranscriptToolResult(
  state: TranscriptState,
  event: SessionEventLike,
  value: unknown,
  maxToolResultChars: number,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCallId = eventToolCallId(state, event);
  const turnId = state.toolCalls.get(toolCallId)?.turnId ?? ensureTurn(state);
  upsertToolResult(
    state,
    turnId,
    toolCallId,
    eventString(event.toolName, "tool"),
    summarizeToolResult(value, maxToolResultChars),
    isError,
    streaming,
  );
}

function appendRetryStartNotice(
  state: TranscriptState,
  event: SessionEventLike,
): void {
  const attempt = eventNumber(event.attempt);
  const maxAttempts = eventNumber(event.maxAttempts);
  const delaySeconds = Math.max(
    0,
    Math.ceil(eventNumber(event.delayMs) / 1000),
  );
  const error = eventString(event.errorMessage, "temporary error");
  appendNotice(
    state,
    `Retry ${attempt}/${maxAttempts} in ${delaySeconds}s: ${error}`,
    "warning",
  );
}

function appendRetryEndNotice(
  state: TranscriptState,
  event: SessionEventLike,
): void {
  const attempt = eventNumber(event.attempt);
  if (event.success === true) {
    appendNotice(state, `Retry ${attempt} succeeded.`, "info");
    return;
  }
  const finalError = eventString(event.finalError);
  const message = finalError
    ? `Retry ${attempt} failed: ${finalError}`
    : `Retry ${attempt} failed.`;
  appendNotice(state, message, "error");
}

export function applyAgentSessionEvent(
  state: TranscriptState,
  input: unknown,
  options: SessionTranscriptOptions = {},
): void {
  if (!input || typeof input !== "object") return;
  const event = input as SessionEventLike;
  if (typeof event.type !== "string") return;
  const maxToolResultChars = Math.max(
    256,
    options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
  );
  switch (event.type) {
    case "turn_start":
      ensureTurn(state);
      break;
    case "message_start":
      applyTranscriptMessageEvent(state, event, "start");
      break;
    case "message_update":
      applyTranscriptMessageEvent(state, event, "update");
      break;
    case "message_end":
      applyTranscriptMessageEvent(state, event, "end");
      break;
    case "tool_execution_start": {
      const turnId = ensureTurn(state);
      const toolCallId = eventToolCallId(state, event);
      ensureToolCall(
        state,
        turnId,
        toolCallId,
        eventString(event.toolName, "tool"),
        formatToolPreview(event.args),
      );
      break;
    }
    case "tool_execution_update":
      applyTranscriptToolResult(
        state,
        event,
        event.partialResult,
        maxToolResultChars,
        false,
        true,
      );
      break;
    case "tool_execution_end":
      applyTranscriptToolResult(
        state,
        event,
        event.result,
        maxToolResultChars,
        event.isError === true,
        false,
      );
      break;
    case "turn_end":
      finishTurn(state);
      break;
    case "auto_retry_start":
      appendRetryStartNotice(state, event);
      break;
    case "auto_retry_end":
      appendRetryEndNotice(state, event);
      break;
    default:
      break;
  }
  trimTranscriptState(state, options);
}

export class SessionTranscript {
  private readonly state = createTranscriptState();
  private readonly options: SessionTranscriptOptions;

  constructor(options: SessionTranscriptOptions = {}) {
    this.options = options;
  }

  get entries(): readonly TranscriptEntry[] {
    return this.state.entries;
  }

  snapshot(): TranscriptEntry[] {
    return this.state.entries.map((entry) => ({ ...entry }));
  }

  get currentTurnId(): number | null {
    return this.state.currentTurnId;
  }

  apply(event: unknown): void {
    applyAgentSessionEvent(this.state, event, this.options);
  }

  appendCompletedTurn(details: {
    user?: string;
    thinking?: string;
    assistant: string;
  }): void {
    const turnId = ensureTurn(this.state);
    if (details.user)
      appendEntry(this.state, {
        type: "user-message",
        turnId,
        text: safeTerminalText(details.user),
      });
    if (details.thinking)
      upsertText(
        this.state,
        turnId,
        "thinking",
        safeTerminalText(details.thinking),
        false,
      );
    upsertText(
      this.state,
      turnId,
      "assistant-text",
      safeTerminalText(details.assistant),
      false,
    );
    finishTurn(this.state, turnId);
    trimTranscriptState(this.state, this.options);
  }

  appendFailure(message: string): void {
    const turnId =
      this.state.currentTurnId ??
      this.state.lastTurnId ??
      ensureTurn(this.state);
    upsertText(
      this.state,
      turnId,
      "assistant-text",
      `Error: ${safeTerminalText(message)}`,
      false,
    );
    finishTurn(this.state, turnId);
    trimTranscriptState(this.state, this.options);
  }

  appendNotice(message: string, tone: TranscriptNoticeTone = "info"): void {
    appendNotice(this.state, message, tone);
    trimTranscriptState(this.state, this.options);
  }

  removeCurrentTurn(): void {
    removeTranscriptTurn(
      this.state,
      this.state.currentTurnId ?? this.state.lastTurnId,
    );
  }

  clear(): void {
    this.state.entries = [];
    this.state.currentTurnId = null;
    this.state.lastTurnId = null;
    this.state.toolCalls.clear();
  }
}

export function hasStreamingTranscriptEntry(
  entries: readonly TranscriptEntry[],
): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "thinking" ||
        entry.type === "assistant-text" ||
        entry.type === "tool-result") &&
      entry.streaming,
  );
}

export function getCompletedTranscriptExchangeCount(
  entries: readonly TranscriptEntry[],
): number {
  return entries.filter(
    (entry) => entry.type === "assistant-text" && !entry.streaming,
  ).length;
}

type TranscriptRenderBlock =
  | { kind: "separator" }
  | { kind: "user"; text: string }
  | { kind: "assistant"; thinking: string; text: string }
  | { kind: "tool-call"; toolName: string; args: string }
  | {
      kind: "tool-result";
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    }
  | { kind: "notice"; text: string; tone: TranscriptNoticeTone };

function buildRenderBlocks(
  entries: readonly TranscriptEntry[],
): TranscriptRenderBlock[] {
  const blocks: TranscriptRenderBlock[] = [];
  let pendingAssistant:
    | { kind: "assistant"; thinking: string; text: string }
    | undefined;

  const flushAssistant = (): void => {
    if (!pendingAssistant) return;
    blocks.push(pendingAssistant);
    pendingAssistant = undefined;
  };
  const appendAssistantText = (
    type: "thinking" | "assistant-text",
    text: string,
  ): void => {
    const safeText = safeTerminalText(text);
    if (!safeText) return;

    const field = type === "thinking" ? "thinking" : "text";
    if (pendingAssistant?.[field]) flushAssistant();
    if (!pendingAssistant)
      pendingAssistant = { kind: "assistant", thinking: "", text: "" };
    pendingAssistant[field] = safeText;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "turn-boundary":
        flushAssistant();
        if (entry.phase === "start" && blocks.length > 0)
          blocks.push({ kind: "separator" });
        break;
      case "user-message":
        flushAssistant();
        blocks.push({ kind: "user", text: entry.text });
        break;
      case "thinking":
        appendAssistantText("thinking", entry.text);
        break;
      case "assistant-text":
        appendAssistantText("assistant-text", entry.text);
        break;
      case "tool-call":
        flushAssistant();
        blocks.push({
          kind: "tool-call",
          toolName: entry.toolName,
          args: entry.args,
        });
        break;
      case "tool-result":
        flushAssistant();
        blocks.push({
          kind: "tool-result",
          content: entry.content,
          truncated: entry.truncated,
          isError: entry.isError,
          streaming: entry.streaming,
        });
        break;
      case "notice":
        flushAssistant();
        blocks.push({ kind: "notice", text: entry.text, tone: entry.tone });
        break;
      default:
        break;
    }
  }
  flushAssistant();
  return blocks;
}

const OSC_133_SEQUENCE = /\x1b]133;[ABC]\x07/g;

type PresentationAssistantMessage = NonNullable<
  ConstructorParameters<typeof AssistantMessageComponent>[0]
>;

function stripOsc133(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(OSC_133_SEQUENCE, ""));
}

function createPresentationAssistantMessage(
  thinking: string,
  text: string,
): PresentationAssistantMessage {
  const content = [
    ...(thinking
      ? [{ type: "thinking" as const, thinking: safeTerminalText(thinking) }]
      : []),
    ...(text ? [{ type: "text" as const, text: safeTerminalText(text) }] : []),
  ];

  // Pi's renderer reads only role/content. A transcript can merge events that
  // have no single provider response, so it intentionally has no transport metadata.
  return { role: "assistant", content } as PresentationAssistantMessage;
}

function renderNativeUserMessage(text: string, width: number): string[] {
  return stripOsc133(
    new UserMessageComponent(
      safeTerminalText(text),
      getMarkdownTheme(),
      1,
    ).render(width),
  );
}

function renderNativeAssistantMessage(
  thinking: string,
  text: string,
  width: number,
  thinkingLabel: string,
): string[] {
  return stripOsc133(
    new AssistantMessageComponent(
      createPresentationAssistantMessage(thinking, text),
      false,
      getMarkdownTheme(),
      thinkingLabel,
      1,
    ).render(width),
  );
}

function wrapRenderedLines(lines: readonly string[], width: number): string[] {
  const wrapped: string[] = [];
  for (const line of lines) {
    if (!line) wrapped.push("");
    else wrapped.push(...wrapTextWithAnsi(line, Math.max(1, width)));
  }
  return wrapped;
}

function transcriptBadge(
  theme: Theme,
  label: string,
  background: ThemeBackground,
  foreground: ThemeColor,
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

function toolResultLabel(
  theme: Theme,
  isError: boolean,
  streaming: boolean,
): string {
  if (isError) return theme.fg("error", "↳ error");
  if (streaming) return theme.fg("warning", "↳ streaming result");
  return theme.fg("dim", "↳ result");
}

function noticeToneColor(tone: TranscriptNoticeTone): ThemeColor {
  switch (tone) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    default:
      return "dim";
  }
}

export interface TranscriptRenderOptions {
  width: number;
  theme: Theme;
  emptyText?: string;
  assistantLabel?: string;
  toolLabel?: string;
  thinkingLabel?: string;
  assistantBadgeBackground?: ThemeBackground;
  assistantBadgeForeground?: ThemeColor;
  toolBadgeBackground?: ThemeBackground;
  toolBadgeForeground?: ThemeColor;
}

/**
 * Render normalized transcript entries as terminal lines. User and assistant
 * messages deliberately use Pi's native components so markdown, code,
 * thinking, and message theming stay consistent with the main transcript.
 */
export function renderTranscriptLines(
  entries: readonly TranscriptEntry[],
  options: TranscriptRenderOptions,
): string[] {
  const width = Math.max(1, options.width);
  const { theme } = options;
  if (entries.length === 0)
    return [theme.fg("dim", options.emptyText ?? "No transcript yet.")];

  const lines: string[] = [];
  const assistantBadge = transcriptBadge(
    theme,
    options.assistantLabel ?? "Assistant",
    options.assistantBadgeBackground ?? "customMessageBg",
    options.assistantBadgeForeground ?? "success",
  );
  const toolBadge = transcriptBadge(
    theme,
    options.toolLabel ?? "Tool",
    options.toolBadgeBackground ?? "toolPendingBg",
    options.toolBadgeForeground ?? "warning",
  );
  const separator = theme.fg(
    "borderMuted",
    "────────────────────────────────────────",
  );
  const indent = "    ";

  const blankBefore = (): void => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };

  for (const block of buildRenderBlocks(entries)) {
    switch (block.kind) {
      case "separator":
        blankBefore();
        lines.push(separator);
        break;
      case "user":
        lines.push(...renderNativeUserMessage(block.text, width));
        break;
      case "assistant":
        blankBefore();
        lines.push(assistantBadge);
        lines.push(
          ...renderNativeAssistantMessage(
            block.thinking,
            block.text,
            width,
            options.thinkingLabel ?? "Thinking",
          ),
        );
        break;
      case "tool-call": {
        blankBefore();
        const name = theme.fg(
          "warning",
          theme.bold(safeTerminalText(block.toolName)),
        );
        const args = block.args
          ? theme.fg("dim", ` · ${safeTerminalText(block.args)}`)
          : "";
        lines.push(`${toolBadge} ${name}${args}`);
        break;
      }
      case "tool-result": {
        const label = toolResultLabel(theme, block.isError, block.streaming);
        lines.push(
          `${label}${block.truncated ? theme.fg("dim", " (truncated)") : ""}`,
        );
        for (const resultLine of safeTerminalText(block.content).split("\n")) {
          lines.push(
            `${indent}${block.isError ? theme.fg("error", resultLine) : theme.fg("dim", resultLine)}`,
          );
        }
        break;
      }
      case "notice": {
        blankBefore();
        const color = noticeToneColor(block.tone);
        for (const noticeLine of safeTerminalText(block.text).split("\n"))
          lines.push(theme.fg(color, noticeLine));
        break;
      }
      default:
        break;
    }
  }

  return wrapRenderedLines(lines, width).map((line) =>
    visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
  );
}

export interface TranscriptViewportOptions
  extends Omit<TranscriptRenderOptions, "width"> {
  tui: TranscriptTui;
  readEntries: () => readonly TranscriptEntry[];
}

export interface TranscriptViewportRender {
  lines: string[];
  hiddenAbove: number;
  hiddenBelow: number;
  totalLines: number;
  following: boolean;
}

/**
 * Decodes an SGR mouse-wheel event into a transcript line delta.
 * Hosts remain responsible for enabling terminal mouse reporting when their
 * TUI mode does not already provide it.
 */
export function getTranscriptMouseScrollDelta(data: string): number | null {
  const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
  if (!match) return null;

  const button = Number(match[1]);
  if ((button & 64) !== 64) return null;
  return (button & 1) === 0 ? -3 : 3;
}

/**
 * Stateful scrolling viewport for a transcript. It owns no dialog chrome, so
 * extensions can compose it into their own overlay layout and controls.
 */
export class TranscriptViewport {
  private readonly tui: TranscriptTui;
  private readonly readEntries: () => readonly TranscriptEntry[];
  private readonly renderOptions: Omit<TranscriptRenderOptions, "width">;
  private scrollOffset = 0;
  private viewportHeight = 8;
  private totalLines = 0;
  private follow = true;

  constructor(options: TranscriptViewportOptions) {
    this.tui = options.tui;
    this.readEntries = options.readEntries;
    const { tui: _tui, readEntries: _readEntries, ...renderOptions } = options;
    this.renderOptions = renderOptions;
  }

  get following(): boolean {
    return this.follow;
  }

  refresh(): void {
    this.tui.requestRender();
  }

  scroll(delta: number): void {
    if (delta < 0) this.follow = false;
    const maxScroll = Math.max(0, this.totalLines - this.viewportHeight);
    this.scrollOffset = Math.max(
      0,
      Math.min(maxScroll, this.scrollOffset + delta),
    );
    if (this.scrollOffset >= maxScroll) this.follow = true;
    this.tui.requestRender();
  }

  followLatest(): void {
    this.follow = true;
    this.scrollOffset = Math.max(0, this.totalLines - this.viewportHeight);
    this.tui.requestRender();
  }

  handleInput(data: string): boolean {
    const mouseScrollDelta = getTranscriptMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scroll(mouseScrollDelta);
      return true;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scroll(-1);
      return true;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scroll(1);
      return true;
    }
    if (matchesKey(data, "pageUp")) {
      this.scroll(-Math.max(1, this.viewportHeight - 1));
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.scroll(Math.max(1, this.viewportHeight - 1));
      return true;
    }
    if (matchesKey(data, "home")) {
      this.follow = false;
      this.scrollOffset = 0;
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "end")) {
      this.followLatest();
      return true;
    }
    return false;
  }

  render(width: number, height: number): TranscriptViewportRender {
    const lines = renderTranscriptLines(this.readEntries(), {
      ...this.renderOptions,
      width,
    });
    this.viewportHeight = Math.max(1, height);
    this.totalLines = lines.length;
    const maxScroll = Math.max(0, lines.length - this.viewportHeight);
    if (this.follow) this.scrollOffset = maxScroll;
    else {
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
      if (this.scrollOffset >= maxScroll) this.follow = true;
    }
    const visible = lines.slice(
      this.scrollOffset,
      this.scrollOffset + this.viewportHeight,
    );
    return {
      lines: visible,
      hiddenAbove: this.scrollOffset,
      hiddenBelow: Math.max(0, maxScroll - this.scrollOffset),
      totalLines: lines.length,
      following: this.follow,
    };
  }
}
