/**
 * pi-subagents completion adapter.
 *
 * Maps the public async/foreground completion events to semantic events:
 * success -> `task-completed`, failed/timeout -> `integration-error`,
 * cancelled/stopped/paused/detached -> silent. Only a sanitized agent name
 * may be used as a label; outputs, task prompts, session paths and error
 * bodies are never projected.
 */
import { sanitizeLabel, stringField, asRecord } from "./events.js";

export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT =
  "subagent:foreground-complete";

export type SubagentResultKind =
  | "task-completed"
  | "integration-error"
  | "silent";

export interface ParsedSubagentCompletion {
  kind: SubagentResultKind;
  label?: string;
}

export function parseSubagentCompletion(
  event: unknown,
): ParsedSubagentCompletion {
  const record = asRecord(event);
  if (!record) {
    return { kind: "silent" };
  }

  const withLabel = (kind: SubagentResultKind): ParsedSubagentCompletion => {
    const label = sanitizeLabel(stringField(record, "agent") ?? "");
    return { kind, ...(label ? { label } : {}) };
  };

  const status = stringField(record, "status");
  if (status) {
    if (status === "completed") {
      return withLabel("task-completed");
    }
    if (status === "failed") {
      return withLabel("integration-error");
    }
    return { kind: "silent" };
  }

  const classification = classifyCompletionFields(record);
  if (classification !== undefined) {
    return withLabel(classification);
  }

  const results = record.results;
  if (Array.isArray(results) && results.length > 0) {
    return classifyChildren(results);
  }

  return { kind: "silent" };
}

interface CompletionFields {
  success: boolean;
  explicitlyFailed: boolean;
  timedOut: boolean;
  stopped: boolean;
  interrupted: boolean;
  detached: boolean;
  state?: string;
  processSignal?: string;
  exitCode?: number;
}

function classifyCompletionFields(
  record: Record<string, unknown>,
): SubagentResultKind | undefined {
  const fields = collectCompletionFields(record);
  if (fields.detached || fields.stopped || fields.interrupted) {
    return "silent";
  }
  if (fields.success) {
    return "task-completed";
  }
  if (
    fields.processSignal &&
    fields.exitCode !== undefined &&
    fields.exitCode !== 0
  ) {
    return "silent";
  }
  if (fields.explicitlyFailed || fields.timedOut) {
    return "integration-error";
  }
  if (fields.state === "complete") {
    return "task-completed";
  }
  if (fields.state === "failed") {
    return "integration-error";
  }
  if (fields.exitCode !== undefined) {
    return fields.exitCode === 0 ? "task-completed" : "integration-error";
  }
  return undefined;
}

function collectCompletionFields(
  record: Record<string, unknown>,
): CompletionFields {
  const state = stringField(record, "state");
  return {
    success: record.success === true,
    explicitlyFailed: record.success === false,
    timedOut: record.timedOut === true,
    stopped: record.stopped === true || state === "stopped",
    interrupted: record.interrupted === true || state === "paused",
    detached: record.detached === true,
    state,
    processSignal: stringField(record, "processSignal"),
    exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
  };
}

function classifyChildren(results: unknown[]): ParsedSubagentCompletion {
  const statuses = results
    .map((child) => stringField(asRecord(child), "status"))
    .filter((status): status is string => Boolean(status));

  if (statuses.some((status) => status === "failed")) {
    return { kind: "integration-error" };
  }
  if (
    statuses.length > 0 &&
    statuses.every((status) => status === "completed")
  ) {
    return { kind: "task-completed" };
  }
  return { kind: "silent" };
}
