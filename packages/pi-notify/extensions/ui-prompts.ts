/**
 * Generic UI-wait adapter support.
 *
 * Pi core (>= 0.84.4) wraps every blocking `ctx.ui` dialog and emits
 * `ui_prompt_start`/`ui_prompt_end` around the outermost span, dispatched
 * to `pi.on()` handlers. This module parses those payloads and keeps the
 * two classification contexts (active pi-ask flows, pending
 * permission-system confirmation requests) that label otherwise-anonymous
 * dialog spans.
 *
 * Labeled plugin events never notify or touch Herdr state themselves; they
 * only provide context for the span the core event opens.
 */
import { asRecord, sanitizeLabel, stringField } from "./events.js";
import type { UiSpanSilentPayload } from "../api.js";

export const UI_PROMPT_START_EVENT = "ui_prompt_start";
export const UI_PROMPT_END_EVENT = "ui_prompt_end";

/** Herdr label for spans without any more specific context. */
export const DEFAULT_UI_PROMPT_LABEL = "Waiting for input";
export const PERMISSION_REQUIRED_LABEL = "Permission required";

/** Source stamped on notifications routed from generic dialog spans. */
export const UI_PROMPT_SOURCE = "pi-ui";

/** Defensive projection of a core `ui_prompt_*` payload. */
export interface UiPromptEvent {
  kind: string;
  title?: string;
}

export function parseUiPromptEvent(event: unknown): UiPromptEvent | undefined {
  const record = asRecord(event);
  const kind = stringField(record, "kind");
  if (!kind) {
    return undefined;
  }

  const title = stringField(record, "title");
  if (title === undefined) {
    return { kind };
  }

  return { kind, title };
}

/**
 * Defensive projection of a `pi-notify:ui_span_silent` payload. Valid
 * payloads are objects with an optional non-blank string `reason`; anything
 * else is rejected wholesale so an ill-formed raw emit can never silence a
 * real dialog.
 */
export function parseUiSpanSilentPayload(
  event: unknown,
): UiSpanSilentPayload | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }

  const reason = record.reason;
  if (reason === undefined) {
    return {};
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return undefined;
  }
  return { reason: reason.trim() };
}

export type UiPromptEventId = "input-required" | "permission-required";

export interface UiPromptClassification {
  eventId: UiPromptEventId;
  /** Herdr overlay label (sanitized); never used in notification bodies. */
  label: string;
}

export interface UiPromptContexts {
  registerAskFlow(flowId: string, title: string | undefined): void;
  completeAskFlow(flowId: string): void;
  trackPermission(
    requestId: string,
    requesterAgentName: string | undefined,
  ): void;
  resolvePermission(requestId: string): void;
  classify(coreTitle: string | undefined): UiPromptClassification;
  /** One-shot: the next span opened consumes the pending silent marker. */
  markSilent(): void;
  /** Consumes and clears the pending marker; true when one was pending. */
  consumeSilent(): boolean;
  reset(): void;
}

/**
 * Classification contexts for dialog spans, in spec priority order:
 * a pending silent marker (consumed by the adapter before classification)
 * silences the span entirely; otherwise a pending permission request makes
 * the span `permission-required` (label credits the forwarding requester
 * when known), otherwise an active ask flow supplies its sanitized question
 * title, otherwise the core event title, otherwise the default copy.
 */
export function createUiPromptContexts(): UiPromptContexts {
  const askFlows = new Map<string, string | undefined>();
  const pendingPermissions = new Map<string, string | undefined>();
  let pendingSilent = false;

  const firstPendingPermission = (): string | undefined =>
    pendingPermissions.keys().next().value;

  return {
    registerAskFlow(flowId, title) {
      askFlows.set(
        flowId,
        title !== undefined ? sanitizeLabel(title) : undefined,
      );
    },
    completeAskFlow(flowId) {
      askFlows.delete(flowId);
    },
    trackPermission(requestId, requesterAgentName) {
      pendingPermissions.set(
        requestId,
        requesterAgentName !== undefined
          ? sanitizeLabel(requesterAgentName)
          : undefined,
      );
    },
    resolvePermission(requestId) {
      pendingPermissions.delete(requestId);
    },
    markSilent() {
      pendingSilent = true;
    },
    consumeSilent() {
      if (!pendingSilent) {
        return false;
      }
      pendingSilent = false;
      return true;
    },
    classify(coreTitle) {
      const requestId = firstPendingPermission();
      if (requestId !== undefined) {
        const requesterAgentName = pendingPermissions.get(requestId);
        return {
          eventId: "permission-required",
          label: requesterAgentName
            ? `Permission required by ${requesterAgentName}`
            : PERMISSION_REQUIRED_LABEL,
        };
      }

      if (askFlows.size > 0) {
        const flowId = askFlows.keys().next().value;
        const askTitle =
          flowId === undefined ? undefined : askFlows.get(flowId);
        return {
          eventId: "input-required",
          label: askTitle ?? DEFAULT_UI_PROMPT_LABEL,
        };
      }

      return {
        eventId: "input-required",
        label:
          coreTitle !== undefined
            ? sanitizeLabel(coreTitle)
            : DEFAULT_UI_PROMPT_LABEL,
      };
    },
    reset() {
      askFlows.clear();
      pendingPermissions.clear();
      pendingSilent = false;
    },
  };
}

export interface UiPromptSpanTracker {
  nextSpanId(): string;
}

/** Monotonic span ids; spans are keyed by id inside the state machine. */
export function createUiPromptSpanTracker(): UiPromptSpanTracker {
  let sequence = 0;
  return {
    nextSpanId: () => `ui-prompt-${(sequence += 1)}`,
  };
}
