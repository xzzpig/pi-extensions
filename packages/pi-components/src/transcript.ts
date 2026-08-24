import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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

/**
 * Structured tool result payload as delivered by agent session events. It is
 * stored verbatim so Pi's native tool renderers receive the same shape the
 * main transcript would.
 */
export interface TranscriptToolResultPayload {
  content?: Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  details?: unknown;
}

/**
 * Host context used to construct Pi's native `ToolExecutionComponent`
 * instances. Every field is optional: missing values fall back to a detached
 * stub TUI and `process.cwd()`.
 */
export interface NativeToolRenderOptions {
  /** Structural TUI subset; only `requestRender` is required. */
  tui?: TranscriptTui;
  /** Working directory used to resolve built-in tool definitions. */
  cwd?: string;
  /** Resolver for extension-registered custom tool definitions. */
  resolveToolDefinition?: (toolName: string) => ToolDefinition | undefined;
  /** Pass-through for Pi's image rendering settings. */
  showImages?: boolean;
  imageWidthCells?: number;
  /** Initial expanded state for tool output. */
  expanded?: boolean;
}

/** Structural lookup accepted by render functions; maps satisfy this. */
export interface ToolComponentLookup {
  get(toolCallId: string): ToolExecutionComponent | undefined;
}

/** Full TUI type expected by Pi's component constructor. */
type NativeToolTui = NonNullable<
  ConstructorParameters<typeof ToolExecutionComponent>[5]
>;

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
      /** Raw provider arguments object, preserved for native renderers. */
      args: unknown;
    }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      /** Raw structured result; `null` until the first result arrives. */
      result: TranscriptToolResultPayload | null;
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
  /** Persistent native tool components keyed by tool call id. */
  toolComponents: TranscriptToolComponents;
  /** Argument char cap applied to every recorded tool call. */
  toolArgsCharLimit: number;
}

export interface SessionTranscriptOptions extends NativeToolRenderOptions {
  /** Maximum retained entries. Oldest entries are discarded first. */
  maxEntries?: number;
  /** Maximum retained text across all entries. */
  maxChars?: number;
  /**
   * Per-tool-call argument size cap in JSON characters. Oversized arguments
   * are replaced by a truncated marker object so pathological payloads cannot
   * break rendering or memory bounds. Defaults to 64 KiB.
   */
  maxToolArgsChars?: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_CHARS = 512 * 1024;
const DEFAULT_MAX_TOOL_ARGS_CHARS = 64 * 1024;

let themeEnsured = false;

/**
 * The SDK shares its global theme across module instances (tsx/jiti/host) via
 * these globalThis symbols — the same keys its exported `theme` proxy checks
 * before throwing "Theme not initialized" (see theme.js in pi-coding-agent).
 * Both historical and current spellings are probed for older host support.
 */
const THEME_GLOBAL_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_GLOBAL_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

function isTranscriptThemeInitialized(): boolean {
  // SAFETY: the SDK stores its theme on globalThis under a symbol key; the
  // proxy does `if (!t) throw` on the same lookup, so a defined value means
  // a fully constructed Theme instance the proxy will hand back directly.
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  return (
    globals[THEME_GLOBAL_KEY] !== undefined ||
    globals[THEME_GLOBAL_KEY_OLD] !== undefined
  );
}

/**
 * Ensures Pi's global theme is initialized so native message/tool components
 * can render outside a live interactive session (headless embeds, unit tests).
 *
 * IMPORTANT: when the host has already initialized the theme (interactive Pi
 * installs the user's chosen theme before any transcript renders), this is a
 * strict no-op. Re-calling `initTheme()` would re-resolve the default theme
 * from environment detection and can silently replace the user's selection
 * with the dark fallback — changing tool-call colors in the main session too.
 */
export function ensureTranscriptTheme(): void {
  if (themeEnsured) return;
  themeEnsured = true;
  if (isTranscriptThemeInitialized()) return;
  initTheme();
}

const DETACHED_TUI: TranscriptTui = { requestRender() {} };

/**
 * Owns the persistent `ToolExecutionComponent` instance for every live tool
 * call, mirroring how Pi's interactive mode keeps pending components keyed by
 * `toolCallId`. Instances are updated incrementally as events arrive and are
 * pruned by the host once their transcript entries disappear.
 */
export class TranscriptToolComponents implements ToolComponentLookup {
  private readonly components = new Map<string, ToolExecutionComponent>();
  private readonly options: NativeToolRenderOptions;
  private attachedTui: TranscriptTui | null;
  /**
   * Components capture their TUI at construction. This forwarder lets a host
   * attach (or replace) the real TUI at any time — including after tool
   * events already created instances — without rebuilding them.
   */
  private readonly forwardedTui: TranscriptTui;

  constructor(options: NativeToolRenderOptions = {}) {
    this.options = options;
    this.attachedTui = options.tui ?? null;
    this.forwardedTui = {
      requestRender: () => this.attachedTui?.requestRender(),
    };
  }

  /** Wires (or replaces) the host TUI that receives repaint requests. */
  attachTui(tui: TranscriptTui): void {
    this.attachedTui = tui;
  }

  get size(): number {
    return this.components.size;
  }

  has(toolCallId: string): boolean {
    return this.components.has(toolCallId);
  }

  get(toolCallId: string): ToolExecutionComponent | undefined {
    return this.components.get(toolCallId);
  }

  handleStart(toolCallId: string, toolName: string, args: unknown): void {
    const component = this.ensure(toolCallId, toolName);
    if (this.createdWithoutArgs.delete(toolCallId)) {
      component.updateArgs(args ?? {});
    }
    component.setArgsComplete();
    component.markExecutionStarted();
    this.requestRender();
  }

  handleUpdate(
    toolCallId: string,
    toolName: string,
    partialResult: unknown,
  ): void {
    const component = this.ensure(toolCallId, toolName);
    component.updateResult(toComponentResult(partialResult, false), true);
    this.requestRender();
  }

  handleEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    const component = this.ensure(toolCallId, toolName);
    component.updateResult(toComponentResult(result, isError), false);
    this.requestRender();
  }

  /** Drops instances whose transcript entries no longer exist. */
  retainOnly(aliveToolCallIds: ReadonlySet<string>): void {
    for (const toolCallId of this.components.keys()) {
      if (!aliveToolCallIds.has(toolCallId)) this.components.delete(toolCallId);
    }
  }

  clear(): void {
    this.components.clear();
  }

  private ensure(toolCallId: string, toolName: string): ToolExecutionComponent {
    const existing = this.components.get(toolCallId);
    if (existing) return existing;
    // Results may arrive before their start event; remember the placeholder so
    // handleStart can backfill the real arguments later.
    this.createdWithoutArgs.add(toolCallId);
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      {},
      {
        showImages: this.options.showImages,
        imageWidthCells: this.options.imageWidthCells,
      },
      this.options.resolveToolDefinition?.(toolName),
      // Forwards to the attached host TUI; only requestRender is invoked.
      this.forwardedTui as NativeToolTui,
      this.options.cwd ?? process.cwd(),
    );
    if (this.options.expanded) component.setExpanded(true);
    this.components.set(toolCallId, component);
    return component;
  }

  private requestRender(): void {
    // Matches Pi's interactive mode, which repaints after every tool event.
    this.attachedTui?.requestRender();
  }

  private readonly createdWithoutArgs = new Set<string>();
}

function toComponentResult(
  value: unknown,
  isError: boolean,
): {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  details?: unknown;
  isError: boolean;
} {
  const payload =
    value && typeof value === "object"
      ? (value as TranscriptToolResultPayload)
      : {};
  const content = Array.isArray(payload.content)
    ? payload.content.map((part) => ({
        type: part?.type ?? "text",
        text: part?.text,
        data: part?.data,
        mimeType: part?.mimeType,
      }))
    : [];
  return { content, details: payload.details, isError };
}

export function createTranscriptState(
  nativeTools: NativeToolRenderOptions & SessionTranscriptOptions = {},
): TranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    activeAssistant: null,
    toolCalls: new Map(),
    toolComponents: new TranscriptToolComponents(nativeTools),
    toolArgsCharLimit: Math.max(
      16,
      nativeTools.maxToolArgsChars ?? DEFAULT_MAX_TOOL_ARGS_CHARS,
    ),
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

/**
 * Appends a fully-formed entry, assigning the next sequential id.
 *
 * Public building block for hosts that construct transcripts from historical
 * records instead of live agent events. The entry must be structurally valid
 * for its `type`; ids and array placement are owned by this function.
 */
export function appendEntry(
  state: TranscriptState,
  entry: Omit<TranscriptEntry, "id"> & Record<string, unknown>,
): TranscriptEntry {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as TranscriptEntry;
  state.entries.push(nextEntry);
  return nextEntry;
}

/**
 * Returns the active turn id, opening a new turn (with a start boundary)
 * when none is open. Public building block for historical-record ingestion.
 */
export function ensureTurn(state: TranscriptState): number {
  if (state.currentTurnId !== null) return state.currentTurnId;
  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendEntry(state, { type: "turn-boundary", turnId, phase: "start" });
  return turnId;
}

/**
 * Finds the most recent entry of `type` inside `turnId`, scanning backwards.
 * Public building block used by upsert-style helpers and hosts that merge
 * repeated records (e.g. streamed message updates persisted as several lines).
 */
export function findLatestEntry<TType extends TranscriptEntry["type"]>(
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

/**
 * Closes `turnId` (defaulting to the current turn): appends the end boundary
 * unless one already exists, clears streaming flags on the turn's entries,
 * and updates bookkeeping. Idempotent — finishing an already-finished turn is
 * a no-op for boundary creation. Public building block for hosts that know
 * when a replayed exchange is complete.
 */
export function finishTurn(
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
  state.toolComponents.retainOnly(new Set(state.toolCalls.keys()));
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

function jsonSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function estimateToolResultSize(
  result: TranscriptToolResultPayload | null,
): number {
  if (!result) return 0;
  let size = 0;
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.text === "string") size += part.text.length;
      if (typeof part.data === "string") size += part.data.length;
    }
  }
  return size + jsonSize(result.details);
}

/** Deep-copies structured tool data for snapshots; falls back to the reference. */
function cloneStructured<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Degraded stand-in stored on a tool-call entry when the original arguments
 * exceed the state's char limit or cannot be serialized. Consumers can narrow
 * with the `truncated` flag; rendering falls back to the preview text.
 */
export interface TruncatedToolArgs {
  truncated: true;
  /** Present only when JSON serialization of the original payload failed. */
  reason?: "unserializable";
  /** Serialized length of the original payload, when it was serializable. */
  originalChars?: number;
  preview: string;
}

function buildTruncatedToolArgs(
  serialized: string | undefined,
  raw: unknown,
  limit: number,
): TruncatedToolArgs {
  if (serialized === undefined) {
    return {
      truncated: true,
      reason: "unserializable",
      preview: String(raw).slice(0, limit),
    };
  }
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, limit),
  };
}

/**
 * Returns a truncation marker when pathological tool arguments exceed
 * `limit` (or cannot be serialized), and `null` when the payload may be
 * stored verbatim. Ingestion therefore never throws and rendering stays
 * bounded regardless of provider payload size.
 */
function oversizedToolArgs(
  args: unknown,
  limit: number,
): TruncatedToolArgs | null {
  if (args === undefined || args === null) return null;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return buildTruncatedToolArgs(undefined, args, limit);
  }
  return serialized.length <= limit
    ? null
    : buildTruncatedToolArgs(serialized, args, limit);
}

/**
 * Finds or creates the tool-call record for `toolCallId`, appending a
 * tool-call entry when none exists yet.
 *
 * Public building block for hosts that ingest historical records where calls
 * and results may arrive in either order: when the result was recorded first,
 * the placeholder entry's arguments are backfilled here from the later call
 * record. Arguments exceeding the state's char limit are stored as a
 * truncated marker object instead of failing.
 */
export function ensureToolCall(
  state: TranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: unknown,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    // Result-before-call replay: backfill arguments onto the placeholder.
    if (args !== undefined && args !== null) {
      const callEntry = state.entries.find(
        (entry) =>
          entry.id === existing.callEntryId && entry.type === "tool-call",
      );
      if (
        callEntry &&
        callEntry.type === "tool-call" &&
        (callEntry.args === undefined || callEntry.args === null)
      ) {
        callEntry.args =
          oversizedToolArgs(args, state.toolArgsCharLimit) ?? args;
      }
    }
    return existing;
  }
  const callEntry = appendEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args: oversizedToolArgs(args, state.toolArgsCharLimit) ?? args,
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

/**
 * Inserts or updates the thinking/assistant-text entry for `turnId`.
 * Repeated records for the same turn merge into one entry (latest text wins).
 * Public building block for hosts that replay completed message records.
 */
export function upsertText(
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

/**
 * Inserts or updates the structured result of a tool call, creating the call
 * placeholder first when the result arrives before its start event. Safe to
 * call repeatedly — the latest result wins and streaming flags update in place.
 * Public building block for hosts that ingest persisted tool results.
 */
export function upsertToolResult(
  state: TranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  result: TranscriptToolResultPayload | null,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCall(
    state,
    turnId,
    toolCallId,
    toolName,
    undefined,
  );
  const existing =
    toolCall.resultEntryId === undefined
      ? undefined
      : state.entries.find(
          (entry) =>
            entry.id === toolCall.resultEntryId && entry.type === "tool-result",
        );
  if (existing && existing.type === "tool-result") {
    existing.result = result;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }
  const resultEntry = appendEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    result,
    isError,
    streaming,
  });
  toolCall.resultEntryId = resultEntry.id;
}

/**
 * Appends a notice attached to the current turn (or the most recent one).
 * Text is sanitized before storage. Public building block for hosts that
 * surface stderr output, retry banners, or other non-conversation events.
 */
export function appendNotice(
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
      return entry.toolName.length + jsonSize(entry.args);
    case "tool-result":
      return entry.toolName.length + estimateToolResultSize(entry.result);
    default:
      return 0;
  }
}

function pruneToolCallIndex(state: TranscriptState): void {
  const entryIds = new Set(state.entries.map((entry) => entry.id));
  const aliveToolCallIds = new Set<string>();
  for (const [toolCallId, record] of state.toolCalls.entries()) {
    if (!entryIds.has(record.callEntryId)) {
      state.toolCalls.delete(toolCallId);
      continue;
    }
    aliveToolCallIds.add(toolCallId);
    if (
      record.resultEntryId !== undefined &&
      !entryIds.has(record.resultEntryId)
    ) {
      record.resultEntryId = undefined;
    }
  }
  // Result entries whose call entry was trimmed away have no renderable
  // position: their visual is owned by the component attached to the call.
  let hasOrphanResults = false;
  for (const entry of state.entries) {
    if (
      entry.type === "tool-result" &&
      !aliveToolCallIds.has(entry.toolCallId)
    ) {
      hasOrphanResults = true;
      break;
    }
  }
  if (hasOrphanResults) {
    state.entries = state.entries.filter(
      (entry) =>
        !(
          entry.type === "tool-result" &&
          !aliveToolCallIds.has(entry.toolCallId)
        ),
    );
  }
  state.toolComponents.retainOnly(aliveToolCallIds);
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

function normalizeToolResultPayload(
  value: unknown,
): TranscriptToolResultPayload | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return value as TranscriptToolResultPayload;
  if (typeof value === "string")
    return { content: [{ type: "text", text: value }] };
  return { content: [{ type: "text", text: String(value) }] };
}

function applyTranscriptToolResult(
  state: TranscriptState,
  event: SessionEventLike,
  value: unknown,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCallId = eventToolCallId(state, event);
  const toolName = eventString(event.toolName, "tool");
  const turnId = state.toolCalls.get(toolCallId)?.turnId ?? ensureTurn(state);
  const payload = normalizeToolResultPayload(value);
  upsertToolResult(
    state,
    turnId,
    toolCallId,
    toolName,
    payload,
    isError,
    streaming,
  );
  if (streaming) {
    state.toolComponents.handleUpdate(toolCallId, toolName, payload);
  } else {
    state.toolComponents.handleEnd(toolCallId, toolName, payload, isError);
  }
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
      const toolName = eventString(event.toolName, "tool");
      ensureToolCall(state, turnId, toolCallId, toolName, event.args);
      state.toolComponents.handleStart(toolCallId, toolName, event.args);
      break;
    }
    case "tool_execution_update":
      applyTranscriptToolResult(state, event, event.partialResult, false, true);
      break;
    case "tool_execution_end":
      applyTranscriptToolResult(
        state,
        event,
        event.result,
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
  private readonly state: TranscriptState;
  private readonly options: SessionTranscriptOptions;

  constructor(options: SessionTranscriptOptions = {}) {
    this.options = options;
    this.state = createTranscriptState(options);
  }

  get entries(): readonly TranscriptEntry[] {
    return this.state.entries;
  }

  /** Live native tool components keyed by tool call id. */
  get toolComponents(): ToolComponentLookup {
    return this.state.toolComponents;
  }

  snapshot(): TranscriptEntry[] {
    return this.state.entries.map((entry) => {
      const copy = { ...entry } as TranscriptEntry;
      if (copy.type === "tool-call") copy.args = cloneStructured(copy.args);
      else if (copy.type === "tool-result") {
        copy.result = cloneStructured(copy.result);
      }
      return copy;
    });
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
    this.state.toolComponents.clear();
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
  | {
      kind: "tool-native";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: TranscriptToolResultPayload | null;
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

  // Tool results are upserted in place, so the last entry per call id wins.
  // Their visual output is owned by the native component rendered at the call
  // position, so result entries never emit blocks of their own.
  const latestResults = new Map<
    string,
    Extract<TranscriptEntry, { type: "tool-result" }>
  >();
  for (const entry of entries) {
    if (entry.type === "tool-result")
      latestResults.set(entry.toolCallId, entry);
  }

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
      case "tool-call": {
        flushAssistant();
        const result = latestResults.get(entry.toolCallId);
        blocks.push({
          kind: "tool-native",
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          args: entry.args,
          result: result?.result ?? null,
          isError: result?.isError ?? false,
          streaming: result?.streaming ?? false,
        });
        break;
      }
      case "tool-result":
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

function wrapRenderedLines(
  lines: readonly string[],
  width: number,
  verbatimLines?: ReadonlySet<number>,
): string[] {
  const wrapped: string[] = [];
  for (const [index, line] of lines.entries()) {
    // Native tool components own their geometry (diffs, borders, tables);
    // re-wrapping their output would corrupt it, same as Pi's main transcript.
    if (verbatimLines?.has(index)) {
      wrapped.push(line);
      continue;
    }
    if (!line) wrapped.push("");
    else wrapped.push(...wrapTextWithAnsi(line, Math.max(1, width)));
  }
  return wrapped;
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
  thinkingLabel?: string;
  assistantBadgeBackground?: ThemeBackground;
  assistantBadgeForeground?: ThemeColor;
  /**
   * Live native tool components keyed by tool call id. When omitted, tool
   * blocks are rendered through stateless ad-hoc components rebuilt from the
   * entry data on every frame.
   */
  toolComponents?: ToolComponentLookup;
}

/**
 * Builds a stateless component for tool blocks rendered without a live
 * registry (direct API use). Rebuilt per frame; correct output, no incremental
 * renderer state.
 */
function createAdHocToolComponent(
  block: Extract<TranscriptRenderBlock, { kind: "tool-native" }>,
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    block.toolName,
    block.toolCallId,
    block.args ?? {},
    {},
    undefined,
    // Only requestRender is ever invoked on the host TUI.
    DETACHED_TUI as NativeToolTui,
    process.cwd(),
  );
  component.setArgsComplete();
  component.markExecutionStarted();
  if (block.result) {
    component.updateResult(
      toComponentResult(block.result, block.isError),
      block.streaming,
    );
  }
  return component;
}

/**
 * Render normalized transcript entries as terminal lines. User and assistant
 * messages deliberately use Pi's native components so markdown, code,
 * thinking, and message theming stay consistent with the main transcript.
 * Tool calls are rendered by Pi's native `ToolExecutionComponent`, giving
 * built-in tools their familiar rich output (diffs, file previews, images).
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
  const verbatimLines = new Set<number>();
  const pushVerbatim = (rendered: readonly string[]): void => {
    for (const line of rendered) {
      verbatimLines.add(lines.length);
      lines.push(line);
    }
  };
  const assistantBadge = theme.bg(
    options.assistantBadgeBackground ?? "customMessageBg",
    theme.fg(
      options.assistantBadgeForeground ?? "success",
      theme.bold(` ${options.assistantLabel ?? "Assistant"} `),
    ),
  );
  const separator = theme.fg(
    "borderMuted",
    "────────────────────────────────────────",
  );

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
      case "tool-native": {
        blankBefore();
        const component =
          options.toolComponents?.get(block.toolCallId) ??
          createAdHocToolComponent(block);
        pushVerbatim(component.render(width));
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

  // wrapRenderedLines preserves length for verbatim lines, so indices stay
  // aligned for the width-truncation pass below.
  const wrapped = wrapRenderedLines(lines, width, verbatimLines);
  return wrapped.map((line, index) =>
    verbatimLines.has(index) || visibleWidth(line) <= width
      ? line
      : truncateToWidth(line, width, ""),
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
