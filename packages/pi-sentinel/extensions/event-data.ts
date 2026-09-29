import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ImageContent,
  JsonValue,
  TextContent,
} from "@earendil-works/pi-ai";
import type { SentinelWindow, TriggerType } from "./config.js";
import { MAX_FIELD_CHARS, truncateText } from "./template.js";

/**
 * Event data construction and audit-scope serialization.
 *
 * Every trigger builds a whitelisted event object that doubles as the template
 * variable root; tool triggers also use it as the default scope block, while
 * conversation triggers serialize messages instead.
 */

export interface SerializeOptions {
  includeThinking: boolean;
  includeToolInputs: boolean;
  includeToolOutputs: boolean;
}

export const DEFAULT_SERIALIZE_OPTIONS: SerializeOptions = {
  includeThinking: true,
  includeToolInputs: true,
  includeToolOutputs: true,
};

export interface ToolCallEventData {
  tool: string;
  toolCallId: string;
  input: JsonValue;
}

export interface ToolResultEventData {
  tool: string;
  toolCallId: string;
  input: JsonValue;
  content: string;
  isError: boolean;
}

export interface TurnToolResult {
  tool: string;
  content: string;
  isError: boolean;
}

export interface TurnEndEventData {
  turnIndex: number;
  assistant: string;
  toolResults: TurnToolResult[];
}

export interface AgentEndEventData {
  messageCount: number;
}

export interface ContextTokensMessage {
  role: string;
  tool?: string;
  text: string;
}

export interface ContextTokensEventData {
  tokens: number;
  threshold: number;
  level: number;
  messages: ContextTokensMessage[];
}

export interface EventEventData {
  /** Configured event name verbatim (including any `core:` prefix). */
  name: string;
  event: JsonValue;
}

/** Estimate tokens from characters (matches the repo-wide chars/4 convention). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Placeholder replacing values that cannot survive a JSON round-trip. */
const UNSERIALIZABLE_PLACEHOLDER = "[unserializable]";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Project a raw event payload into a JSON-safe value: null/boolean/number/
 * string pass through, arrays and plain objects recurse, and anything else
 * (functions, class instances, ...) becomes a `"[unserializable]"` string so
 * the payload is safe for template rendering and scope JSON.
 */
export function toJsonSafe(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => toJsonSafe(entry));
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toJsonSafe(entry);
    }
    return out;
  }
  return UNSERIALIZABLE_PLACEHOLDER;
}

/** Marker prepended when the scope is trimmed from the head to fit a budget. */
export const SCOPE_TRUNCATION_PREFIX = "...[范围截断 ";

function truncateDeep(value: JsonValue): JsonValue {
  if (typeof value === "string") return truncateText(value);
  if (Array.isArray(value)) return value.map((entry) => truncateDeep(entry));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value))
      out[key] = truncateDeep(entry);
    return out;
  }
  return value;
}

/** JSON-safe event payload with every string field truncated. */
export function truncateEventData<T extends Record<string, JsonValue>>(
  data: T,
): T {
  return truncateDeep(data) as T;
}

/** Serialize tool input, honoring `includeToolInputs`. */
export function serializeToolInput(
  input: Record<string, unknown>,
  options: SerializeOptions,
): JsonValue {
  if (!options.includeToolInputs) return {};
  return truncateDeep(input as JsonValue);
}

function imagePlaceholder(count: number): string {
  return `[图片 ${count} 项]`;
}

/** Render a tool result / message content array as plain text. */
export function contentToText(
  content: string | (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return truncateText(content);
  const parts: string[] = [];
  let images = 0;
  const flushImages = () => {
    if (images > 0) {
      parts.push(imagePlaceholder(images));
      images = 0;
    }
  };
  for (const block of content) {
    if (block.type === "image") {
      images += 1;
      continue;
    }
    flushImages();
    if (block.type === "text") parts.push(block.text);
  }
  flushImages();
  return truncateText(parts.join("\n"));
}

function toolCallPlaceholder(
  name: string,
  args: Record<string, unknown>,
  options: SerializeOptions,
): string {
  if (!options.includeToolInputs) return `[${name}]`;
  return `[${name}(${JSON.stringify(truncateDeep(args as JsonValue))})]`;
}

/**
 * Serialize one message into the text form used by scope blocks and the
 * `context_tokens` `messages` field.
 */
export function serializeMessage(
  message: AgentMessage,
  options: SerializeOptions,
): string {
  switch (message.role) {
    case "user":
      return contentToText(message.content);
    case "assistant": {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push(block.text);
        } else if (block.type === "thinking") {
          if (options.includeThinking && !block.redacted) {
            parts.push(`[thinking: ${block.thinking}]`);
          }
        } else if (block.type === "toolCall") {
          parts.push(toolCallPlaceholder(block.name, block.arguments, options));
        }
      }
      return truncateText(parts.join("\n"));
    }
    case "toolResult": {
      const text = options.includeToolOutputs
        ? contentToText(message.content)
        : "";
      return text;
    }
    case "system":
      return truncateText(
        typeof message.content === "string" ? message.content : "",
      );
    default:
      return "";
  }
}

/** Role label used in transcript scope blocks. */
export function messageRoleLabel(message: AgentMessage): string {
  if (message.role === "toolResult") return `toolResult:${message.toolName}`;
  return message.role;
}

/** Serialize a message list into the `role + text` transcript form. */
export function buildTranscriptText(
  messages: readonly AgentMessage[],
  options: SerializeOptions = DEFAULT_SERIALIZE_OPTIONS,
): string {
  return messages
    .map(
      (message) =>
        `[${messageRoleLabel(message)}] ${serializeMessage(message, options)}`,
    )
    .join("\n");
}

/** Serialize a message list into the `{ role, tool?, text }` element form. */
export function buildMessageElements(
  messages: readonly AgentMessage[],
  options: SerializeOptions = DEFAULT_SERIALIZE_OPTIONS,
): ContextTokensMessage[] {
  return messages.map((message) => {
    const element: ContextTokensMessage = {
      role: message.role === "toolResult" ? "toolResult" : message.role,
      text: serializeMessage(message, options),
    };
    if (message.role === "toolResult") element.tool = message.toolName;
    return element;
  });
}

export interface ToolCallEventInput {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export function buildToolCallEventData(
  event: ToolCallEventInput,
  options: SerializeOptions = DEFAULT_SERIALIZE_OPTIONS,
): ToolCallEventData {
  return {
    tool: event.toolName,
    toolCallId: event.toolCallId,
    input: serializeToolInput(event.input, options),
  };
}

export interface ToolResultEventInput {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

export function buildToolResultEventData(
  event: ToolResultEventInput,
  options: SerializeOptions = DEFAULT_SERIALIZE_OPTIONS,
): ToolResultEventData {
  return {
    tool: event.toolName,
    toolCallId: event.toolCallId,
    input: serializeToolInput(event.input, options),
    content: options.includeToolOutputs ? contentToText(event.content) : "",
    isError: event.isError,
  };
}

export interface TurnEndEventInput {
  turnIndex: number;
  assistant: AgentMessage;
  toolResults: readonly AgentMessage[];
}

export function buildTurnEndEventData(
  event: TurnEndEventInput,
  options: SerializeOptions = DEFAULT_SERIALIZE_OPTIONS,
): TurnEndEventData {
  const toolResults: TurnToolResult[] = event.toolResults.map((message) => {
    const isToolResult = message.role === "toolResult";
    return {
      tool: isToolResult ? message.toolName : message.role,
      content:
        isToolResult && options.includeToolOutputs
          ? contentToText(message.content)
          : "",
      isError: isToolResult ? message.isError : false,
    };
  });
  return {
    turnIndex: event.turnIndex,
    assistant: serializeMessage(event.assistant, options),
    toolResults,
  };
}

export function buildAgentEndEventData(
  messageCount: number,
): AgentEndEventData {
  return { messageCount };
}

export interface ContextTokensEventInput {
  tokens: number;
  threshold: number;
  level: number;
  /** Incremental messages since the previous firing of this rule. */
  messages: readonly AgentMessage[];
}

export function buildContextTokensEventData(
  event: ContextTokensEventInput,
  options: SerializeOptions = DEFAULT_SERIALIZE_OPTIONS,
): ContextTokensEventData {
  return {
    tokens: event.tokens,
    threshold: event.threshold,
    level: event.level,
    messages: buildMessageElements(event.messages, options),
  };
}

export interface EventEventInput {
  name: string;
  payload: unknown;
}

/**
 * Build the `event` trigger's data object. A plain-object payload is used
 * directly (host core events arrive as plain objects); any other bus value is
 * wrapped as `{ value }`. Non-JSON-safe members are projected away and every
 * string is truncated by `truncateEventData`.
 */
export function buildEventEventData(event: EventEventInput): EventEventData {
  const projected = toJsonSafe(event.payload);
  const payload: JsonValue = isPlainObject(event.payload)
    ? projected
    : { value: projected };
  return truncateEventData({ name: event.name, event: payload });
}

/** Last N messages. */
export function sliceByMessageCount(
  messages: readonly AgentMessage[],
  count: number,
): AgentMessage[] {
  if (count >= messages.length) return [...messages];
  return messages.slice(messages.length - count);
}

/** Tail of the conversation that fits in approximately `tokens` (chars/4). */
export function sliceByTokens(
  messages: readonly AgentMessage[],
  tokens: number,
): AgentMessage[] {
  const budget = tokens * 4;
  let used = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const size = serializeMessage(
      messages[index],
      DEFAULT_SERIALIZE_OPTIONS,
    ).length;
    if (used + size > budget && start < messages.length) break;
    used += size;
    start = index;
  }
  return messages.slice(start);
}

/** Drop text from the head until it fits `maxWindowTokens`, keeping the tail. */
export function capScopeTokens(text: string, maxWindowTokens: number): string {
  const maxChars = maxWindowTokens * 4;
  if (text.length <= maxChars) return text;
  const removed = text.length - maxChars;
  return `${SCOPE_TRUNCATION_PREFIX}${removed} 字符]\n${text.slice(removed)}`;
}

/** Union of all trigger event data objects. */
export type SentinelEventData =
  | ToolCallEventData
  | ToolResultEventData
  | TurnEndEventData
  | AgentEndEventData
  | ContextTokensEventData
  | EventEventData;

export interface ScopeInput {
  triggerType: TriggerType;
  eventData: SentinelEventData | Record<string, JsonValue>;
  /** Default conversation scope for turn_end/agent_end/context_tokens. */
  defaultMessages?: readonly AgentMessage[];
  /** Full conversation, used when a rule window overrides the default. */
  allMessages: readonly AgentMessage[];
  window?: SentinelWindow;
  maxWindowTokens: number;
  serialize?: SerializeOptions;
}

/**
 * Build the scope block for an audit.
 *
 * Tool triggers default to the serialized event object; conversation triggers
 * default to their own message range. A rule `window` always replaces the
 * default with a conversation slice, and the result is capped by
 * `maxWindowTokens` from the head.
 */
export function buildScopeText(input: ScopeInput): string {
  const options = input.serialize ?? DEFAULT_SERIALIZE_OPTIONS;

  if (input.window?.full) {
    return capScopeTokens(
      buildTranscriptText(input.allMessages, options),
      input.maxWindowTokens,
    );
  }
  if (input.window?.messages !== undefined) {
    return capScopeTokens(
      buildTranscriptText(
        sliceByMessageCount(input.allMessages, input.window.messages),
        options,
      ),
      input.maxWindowTokens,
    );
  }
  if (input.window?.tokens !== undefined) {
    return capScopeTokens(
      buildTranscriptText(
        sliceByTokens(input.allMessages, input.window.tokens),
        options,
      ),
      input.maxWindowTokens,
    );
  }

  if (
    input.triggerType === "tool_call" ||
    input.triggerType === "tool_result" ||
    input.triggerType === "event"
  ) {
    return capScopeTokens(
      JSON.stringify(input.eventData),
      input.maxWindowTokens,
    );
  }

  return capScopeTokens(
    buildTranscriptText(input.defaultMessages ?? input.allMessages, options),
    input.maxWindowTokens,
  );
}

/** Default scope window per trigger, used when a rule sets no `window`. */
export function defaultWindowKind(
  triggerType: TriggerType,
): "event" | "turn" | "agent" | "increment" {
  switch (triggerType) {
    case "tool_call":
    case "tool_result":
    case "event":
      return "event";
    case "turn_end":
      return "turn";
    case "agent_end":
      return "agent";
    case "context_tokens":
      return "increment";
  }
}

export { MAX_FIELD_CHARS };
