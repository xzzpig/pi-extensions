/**
 * Agent run state machine: a visible run spans the first `agent_start` to
 * the final `agent_settled`. Auto-retries, auto-compaction, and queued
 * continuations between them never produce a final result.
 */
import { asRecord, stringField } from "./events.js";

export type AgentRunResult = "completed" | "error" | "silent";

export interface AgentRunTracker {
  onAgentStart(): void;
  onAgentEnd(event: unknown): void;
  onSettled(): AgentRunResult | undefined;
  shutdown(): void;
}

export function createAgentRunTracker(): AgentRunTracker {
  let active = false;
  let candidate: AgentRunResult | undefined;

  return {
    onAgentStart() {
      active = true;
      candidate = undefined;
    },
    onAgentEnd(event) {
      candidate = classifyAgentEnd(event);
    },
    onSettled() {
      if (!active) {
        return undefined;
      }

      active = false;
      const result = candidate ?? "completed";
      candidate = undefined;
      return result;
    },
    shutdown() {
      active = false;
      candidate = undefined;
    },
  };
}

/**
 * Classify the final stop reason of an `agent_end` event. The extension
 * payload carries the run's messages; the last assistant message determines
 * the outcome. `error`/`length` -> error, `aborted` -> silent, everything
 * else (including an undetectable reason) -> completed.
 */
export function classifyAgentEnd(event: unknown): AgentRunResult {
  const record = asRecord(event);
  if (record) {
    const messages = record.messages;
    if (Array.isArray(messages)) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asRecord(messages[index]);
        if (!message || message.role !== "assistant") {
          continue;
        }
        const reason =
          stringField(message, "stopReason") ??
          stringField(message, "stop_reason") ??
          stringField(message, "finishReason");
        if (reason) {
          return classifyStopReason(reason);
        }
      }
    }

    const directReason =
      stringField(record, "stopReason") ?? stringField(record, "stop_reason");
    if (directReason) {
      return classifyStopReason(directReason);
    }
  }

  return "completed";
}

function classifyStopReason(reason: string): AgentRunResult {
  if (reason === "error" || reason === "length") {
    return "error";
  }
  if (reason === "aborted") {
    return "silent";
  }
  return "completed";
}
