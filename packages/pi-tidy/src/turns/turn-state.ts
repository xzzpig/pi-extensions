import type { HeaderStyle } from "../draw/frame-draw.ts";
import { liveSlot } from "../live.ts";

export type CollapseTurns = "off" | "afterRun" | "live";
export type FinalReplyStyle = "frame" | "rail" | "rules" | "off";
export type TurnOutcome = "running" | "completed" | "interrupted" | "error" | "incomplete" | "unknown";
export interface TurnMessage {
  role: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  durationMs?: number;
  content?: any;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: any;
  nestedCalls?: { calls: Array<{ status: string }> };
}
export interface Turn {
  messages: Map<string, TurnMessage>;
  tools: Map<string, { name: string; args: unknown; failed?: boolean; nestedFailed?: number }>;
  root?: string;
  firstAssistant?: string;
  latestText?: string;
  lastAssistant?: string;
  final?: string;
  startedAt?: number;
  endedAt?: number;
  outcome: TurnOutcome;
  toolMs?: number;
  open?: boolean;
  /** Bumped on every mutation, so a per-frame summary can tell it went stale. */
  version?: number;
}
export interface SavedTurn {
  keys: string[];
  startedAt: number;
  endedAt: number;
  outcome: TurnOutcome;
  toolMs?: number;
}
export const TURN_ENTRY = "pi-tidy:turn";

export function messageKey(message: TurnMessage | undefined): string | undefined {
  if (!message) return undefined;
  // Called per message per frame by the turn lookup; the key is a string build
  // over fields that never change for a given message object.
  const cached = messageKeys.get(message);
  if (cached !== undefined) return cached;
  const key = message.role === "toolResult"
    ? `tool:${message.toolCallId}`
    : typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? `${message.role}:${message.timestamp}:${message.provider ?? ""}:${message.model ?? ""}`
      : undefined;
  if (key !== undefined) messageKeys.set(message, key);
  return key;
}
const messageKeys = new WeakMap<object, string>();
export function hasText(message: TurnMessage | undefined): boolean {
  return Array.isArray(message?.content) && message.content.some((block: any) => block.type === "text" && block.text?.trim());
}
export function unionMs(intervals: readonly (readonly [number, number])[]): number {
  let end = -Infinity;
  let total = 0;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}
function newTurn(startedAt?: number): Turn {
  return { messages: new Map(), tools: new Map(), startedAt, outcome: "running" };
}
function add(turn: Turn, key: string, message: TurnMessage): void {
  turn.version = (turn.version ?? 0) + 1;
  turn.messages.set(key, message);
  if (message.role === "user" && !turn.root) turn.root = key;
  if (message.role === "assistant") {
    if (!turn.firstAssistant) turn.firstAssistant = key;
    turn.lastAssistant = key;
    if (hasText(message)) turn.latestText = key;
    for (const block of message.content ?? []) if (block.type === "toolCall") {
      const previous = turn.tools.get(block.id);
      turn.tools.set(block.id, { name: block.name, args: block.arguments, failed: previous?.failed, nestedFailed: previous?.nestedFailed });
    }
  } else if (message.role === "toolResult" && message.toolCallId) {
    const previous = turn.tools.get(message.toolCallId);
    const calls = message.nestedCalls?.calls ?? (message.toolName === "codemode" ? message.details?.calls : undefined);
    const nestedFailed = Array.isArray(calls) ? calls.filter((call) => call.status === "error").length : 0;
    turn.tools.set(message.toolCallId, { name: message.toolName ?? previous?.name ?? "tool", args: previous?.args, failed: message.isError, nestedFailed });
  }
}
function finishText(turn: Turn): void {
  turn.version = (turn.version ?? 0) + 1;
  const last = turn.lastAssistant && turn.messages.get(turn.lastAssistant);
  if (turn.outcome === "unknown" && last) {
    if (last.stopReason === "error") turn.outcome = "error";
    else if (last.stopReason === "aborted") turn.outcome = "interrupted";
    else if (last.stopReason === "length") turn.outcome = "incomplete";
  }
  turn.final = last && hasText(last) && !last.content.some((block: any) => block.type === "toolCall") ? turn.lastAssistant : undefined;
}

/** Session-scoped state; messages and tools bind once, not by render order. */
export class TurnStore {
  byMessage = new Map<string, Turn>();
  byTool = new Map<string, Turn>();
  current?: Turn;
  private toolStarts = new Map<string, number>();
  private toolIntervals: [number, number][] = [];
  pendingLlmAt?: number;
  settlementOutcome?: "completed" | "aborted" | "error";

  begin(now = Date.now()): void {
    if (this.current) return; // retries, queued steering and automatic continuation stay in this run
    this.current = newTurn(now);
    this.pendingLlmAt = undefined;
    this.settlementOutcome = undefined;
    this.toolStarts.clear();
    this.toolIntervals = [];
  }
  note(message: TurnMessage, ended = false): void {
    const key = messageKey(message);
    if (!key || !this.current) return;
    if (message.role === "user" && !this.current.root && message.timestamp !== undefined) {
      this.current.startedAt = Math.min(this.current.startedAt!, message.timestamp);
    }
    add(this.current, key, message);
    this.byMessage.set(key, this.current);
    if (message.role === "toolResult" && message.toolCallId) this.byTool.set(message.toolCallId, this.current);
    if (message.role === "assistant") for (const block of message.content ?? []) {
      if (block.type === "toolCall") this.byTool.set(block.id, this.current);
    }
    if (message.role === "assistant") this.pendingLlmAt = !ended && message.durationMs === undefined ? message.timestamp : undefined;
  }
  requestStart(now = Date.now()): void {
    if (this.current && this.toolStarts.size === 0) this.pendingLlmAt = now;
  }
  toolStart(id: string, parent: string | undefined, now = Date.now()): void {
    if (this.current && !parent) this.toolStarts.set(id, now);
  }
  toolEnd(id: string, parent: string | undefined, now = Date.now()): void {
    const start = this.toolStarts.get(id);
    if (this.current && !parent && start !== undefined) {
      this.toolIntervals.push([start, now]);
      this.toolStarts.delete(id);
      this.current.toolMs = unionMs(this.toolIntervals);
    }
  }
  toolTime(turn: Turn, now = Date.now()): number | undefined {
    if (turn !== this.current) return turn.tools.size === 0 ? 0 : turn.toolMs;
    return unionMs([...this.toolIntervals, ...[...this.toolStarts.values()].map((start): [number, number] => [start, now])]);
  }
  llmTime(turn: Turn, now = Date.now()): number | undefined {
    const messages = [...turn.messages.values()].filter((message) => message.role === "assistant");
    const intervals: [number, number][] = [];
    for (const message of messages) {
      if (typeof message.durationMs !== "number" || !Number.isFinite(message.durationMs) || message.durationMs < 0) {
        if (turn !== this.current || message.timestamp !== this.pendingLlmAt) return undefined;
      } else if (message.timestamp !== undefined) intervals.push([message.timestamp, message.timestamp + message.durationMs]);
    }
    if (turn === this.current && this.pendingLlmAt !== undefined) intervals.push([this.pendingLlmAt, now]);
    return intervals.length ? unionMs(intervals) : undefined;
  }
  settle(aborted: boolean, now = Date.now()): SavedTurn | undefined {
    const turn = this.current;
    if (!turn) return undefined;
    turn.version = (turn.version ?? 0) + 1;
    const reason = turn.lastAssistant && turn.messages.get(turn.lastAssistant)?.stopReason;
    turn.outcome = aborted || this.settlementOutcome === "aborted" || reason === "aborted" ? "interrupted"
      : this.settlementOutcome === "error" || reason === "error" ? "error" : reason === "length" ? "incomplete" : "completed";
    turn.endedAt = now;
    turn.toolMs = this.toolTime(turn, now);
    finishText(turn);
    this.current = undefined;
    this.pendingLlmAt = undefined;
    return { keys: [...turn.messages.keys()], startedAt: turn.startedAt!, endedAt: now, outcome: turn.outcome, toolMs: turn.toolMs };
  }
  restore(entries: readonly any[]): void {
    this.byMessage.clear();
    this.byTool.clear();
    this.current = undefined;
    this.pendingLlmAt = undefined;
    let legacy: Turn | undefined;
    for (const entry of entries) {
      if (entry.type === "message") {
        const message = entry.message as TurnMessage;
        const key = messageKey(message);
        if (!key) continue;
        if (!legacy || message.role === "user") legacy = newTurn();
        legacy.outcome = "unknown";
        add(legacy, key, message);
        finishText(legacy);
        this.byMessage.set(key, legacy);
        for (const id of legacy.tools.keys()) this.byTool.set(id, legacy);
      } else if (entry.type === "custom" && entry.customType === TURN_ENTRY) {
        const saved = entry.data as SavedTurn;
        if (!Array.isArray(saved?.keys) || !saved.keys.every((key) => typeof key === "string") ||
          !Number.isFinite(saved.startedAt) || !Number.isFinite(saved.endedAt) || saved.endedAt < saved.startedAt ||
          !["completed", "interrupted", "error", "incomplete", "unknown"].includes(saved.outcome)) continue;
        const turn = newTurn(saved.startedAt);
        for (const key of saved.keys) {
          const message = this.byMessage.get(key)?.messages.get(key);
          if (message) { add(turn, key, message); this.byMessage.set(key, turn); }
        }
        Object.assign(turn, { endedAt: saved.endedAt, outcome: saved.outcome,
          toolMs: typeof saved.toolMs === "number" && Number.isFinite(saved.toolMs) && saved.toolMs >= 0 ? saved.toolMs : undefined });
        finishText(turn);
        for (const id of turn.tools.keys()) this.byTool.set(id, turn);
        legacy = undefined;
      }
    }
  }
}

export const turnStore = liveSlot("turn-store", new TurnStore());
export const turnOptions = liveSlot("turn-presentation-options", {
  collapseTurns: "off" as CollapseTurns,
  frameFinalReply: false,
  /** Down the left edge of a reply's code blocks: the language, then a `copy` chip. */
  codeBlocks: true,
  /** Side-by-side panes for a `diff` code block, as for an edit. */
  splitDiff: true,
  splitDiffMinWidth: 72,
  /** How a drawn final reply looks; `frameFinalReply` says whether it is drawn. */
  replyStyle: "frame" as Exclude<FinalReplyStyle, "off">,
  icons: true,
  assistantColor: "accent",
  timeFormat: "auto",
  headerStyle: "inline" as HeaderStyle,
});
export function turnFor(message: TurnMessage | undefined): Turn | undefined {
  const key = messageKey(message);
  return key ? turnStore.get().byMessage.get(key) : undefined;
}
export function folded(turn: Turn): boolean {
  const mode = turnOptions.get().collapseTurns;
  return mode !== "off" && (turn.open !== undefined ? !turn.open : mode === "live" || turn.outcome !== "running");
}
export function expandTurnForTool(id: string | undefined, open: boolean): void {
  if (!id || turnOptions.get().collapseTurns === "off") return;
  const turn = turnStore.get().byTool.get(id);
  if (turn) turn.open = open;
}
/** The call belongs to a turn that is open, so it hangs on that turn's rail. */
export function railTurnTool(id: string | undefined): boolean {
  if (!id || turnOptions.get().collapseTurns === "off") return false;
  const turn = turnStore.get().byTool.get(id);
  return !!turn && !folded(turn);
}
export function hideTurnTool(id: string | undefined): boolean {
  if (!id || turnOptions.get().collapseTurns === "off") return false;
  const turn = turnStore.get().byTool.get(id);
  return !!turn && folded(turn);
}
