import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  appendEntry,
  applyAgentSessionEvent,
  ensureTurn,
  findLatestEntry,
  finishTurn,
  upsertText,
  type TranscriptState,
  type TranscriptTurnOutcome,
} from "@xzzpig/pi-components/transcript";

export interface BtwTranscriptMutationTracker {
  readonly version: number;
  bump(): void;
  appendEntry: typeof appendEntry;
  ensureTurn: typeof ensureTurn;
  finishTurn: typeof finishTurn;
  upsertText: typeof upsertText;
}

/**
 * Wraps the shared transcript mutation helpers BTW's replay/failure paths use,
 * bumping one version per public mutation. The overlay's line cache cannot
 * detect the shared helpers' in-place entry edits by identity, so the version
 * is the only invalidation signal for those paths.
 */
export function createBtwTranscriptMutationTracker(): BtwTranscriptMutationTracker {
  let version = 0;
  const bump = (): void => {
    version++;
  };
  return {
    get version(): number {
      return version;
    },
    bump,
    appendEntry: (...args) => {
      bump();
      return appendEntry(...args);
    },
    ensureTurn: (...args) => {
      bump();
      return ensureTurn(...args);
    },
    finishTurn: (...args) => {
      bump();
      return finishTurn(...args);
    },
    upsertText: (...args) => {
      bump();
      return upsertText(...args);
    },
  };
}

/**
 * Event types the shared transcript ingestion handles. BTW's overlay version
 * only advances for these, so unrelated session events (agent_start/end,
 * model changes, ...) do not invalidate the rendered transcript.
 */
const TRANSCRIPT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "auto_retry_start",
  "auto_retry_end",
]);

function finishUnclosedUserTurn(state: TranscriptState): void {
  const currentTurnId = state.currentTurnId;
  if (currentTurnId === null) return;
  const latestAssistant = findLatestEntry(
    state,
    currentTurnId,
    "assistant-text",
  );
  if (latestAssistant && !latestAssistant.streaming) {
    finishTurn(state, currentTurnId);
  }
}

/**
 * Ends the active assistant segment without waiting for `message_end`. Real
 * hosts emit it before a tool runs; this keeps the segment boundary explicit
 * for hosts that only stream updates, so a later thinking/text update starts a
 * new entry instead of overwriting the pre-tool message.
 */
function endActiveAssistantSegment(state: TranscriptState): void {
  const segment = state.activeAssistant;
  if (!segment) return;
  for (const entryId of [segment.thinkingEntryId, segment.textEntryId]) {
    if (entryId === undefined) continue;
    const entry = state.entries.find((candidate) => candidate.id === entryId);
    if (
      entry &&
      (entry.type === "thinking" || entry.type === "assistant-text")
    ) {
      entry.streaming = false;
    }
  }
  state.activeAssistant = null;
}

/**
 * Ingests one live agent-session event into the BTW transcript through the
 * shared event ingestion.
 *
 * A turn is not one assistant message: `message_start` opens a new assistant
 * segment, a tool call closes it, and `message_end` finishes it. BTW's former
 * per-turn `upsertText` merge overwrote the first thinking/answer when the
 * assistant spoke again after a tool call; the shared ingestion appends
 * distinct entries so the presenter keeps one native component per message.
 *
 * `turn_end` is handled here because BTW records the turn outcome (completed,
 * aborted, failed) while the shared ingestion ends a turn without one.
 * `onMutation` runs once per handled event because the shared helpers mutate
 * entries in place; the overlay's version-based line cache cannot detect that
 * by identity.
 */
export function applyBtwTranscriptEvent(
  state: TranscriptState,
  event: AgentSessionEvent,
  onMutation: () => void,
): void {
  if (!TRANSCRIPT_EVENT_TYPES.has(event.type)) return;

  if (event.type === "turn_end") {
    const stopReason =
      event.message.role === "assistant" ? event.message.stopReason : "stop";
    const outcome: TranscriptTurnOutcome =
      stopReason === "aborted"
        ? "aborted"
        : stopReason === "error"
          ? "failed"
          : "completed";
    finishTurn(state, undefined, outcome);
    onMutation();
    return;
  }

  if (
    (event.type === "message_start" || event.type === "message_end") &&
    event.message.role === "user"
  ) {
    // A follow-up user message opens a fresh turn even when the previous turn
    // end boundary was never observed (for example a host that aborted without
    // emitting turn_end). The shared ingestion would otherwise merge both user
    // messages into the still-open turn.
    finishUnclosedUserTurn(state);
  }

  if (event.type === "tool_execution_start") {
    // A tool call separates assistant messages; the segment cannot accept
    // later thinking/text updates from the next message.
    endActiveAssistantSegment(state);
  }

  applyAgentSessionEvent(state, event);
  onMutation();
}
