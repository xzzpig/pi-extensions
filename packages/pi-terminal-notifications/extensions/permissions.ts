export const PERMISSIONS_UI_PROMPT_EVENT = "permissions:ui_prompt";
export const PERMISSIONS_DECISION_EVENT = "permissions:decision";
export const PERMISSIONS_FORWARDED_DECISION_EVENT =
  "permissions:forwarded_decision";

const INTERACTIVE_DECISIONS = new Set([
  "confirmation_unavailable",
  "user_approved",
  "user_approved_for_session",
  "user_denied",
]);

export interface PermissionPrompt {
  agentName?: string;
  forwarding?: ForwardedPromptContext;
  message?: string;
  requestId: string;
  surface?: string;
  value?: string;
}

export interface ForwardedPromptContext {
  requesterAgentName?: string;
  requesterSessionId?: string;
}

export interface PermissionDecision {
  agentName?: string;
  resolution: string;
  surface: string;
  value: string;
}

export interface ForwardedPermissionDecision {
  requestId: string;
}

export interface PermissionPromptTracker {
  resolveDecision(decision: PermissionDecision): boolean;
  resolveForwardedDecision(decision: ForwardedPermissionDecision): boolean;
  shutdown(): void;
  track(prompt: PermissionPrompt): void;
}

export interface PermissionPromptTrackerOptions {
  onResolved(requestId: string): void;
}

interface PendingPermissionPrompt {
  prompt: PermissionPrompt;
}

export function parsePermissionPrompt(
  event: unknown,
): PermissionPrompt | undefined {
  const record = asRecord(event);
  const requestId = stringField(record, "requestId");
  if (!requestId) {
    return undefined;
  }

  return {
    agentName: stringField(record, "agentName"),
    forwarding: forwardedPromptContext(record?.forwarding),
    message: stringField(record, "message"),
    requestId,
    surface: stringField(record, "surface"),
    value: stringField(record, "value"),
  };
}

export function parsePermissionDecision(
  event: unknown,
): PermissionDecision | undefined {
  const record = asRecord(event);
  const resolution = stringField(record, "resolution");
  const surface = stringField(record, "surface");
  const value = stringField(record, "value");
  if (!resolution || !surface || !value) {
    return undefined;
  }

  return {
    agentName: stringField(record, "agentName"),
    resolution,
    surface,
    value,
  };
}

export function parseForwardedPermissionDecision(
  event: unknown,
): ForwardedPermissionDecision | undefined {
  const record = asRecord(event);
  const requestId = stringField(record, "requestId");
  const result = stringField(record, "result");
  const resolution = stringField(record, "resolution");
  const responderSessionId = stringField(record, "responderSessionId");
  const respondedAt = record?.respondedAt;
  if (
    !requestId ||
    (result !== "allow" && result !== "deny") ||
    !resolution ||
    !responderSessionId ||
    !Number.isFinite(respondedAt) ||
    !asRecord(record?.forwarding)
  ) {
    return undefined;
  }

  return { requestId };
}

export function createPermissionPromptTracker(
  options: PermissionPromptTrackerOptions,
): PermissionPromptTracker {
  const pending: PendingPermissionPrompt[] = [];

  const resolve = (entry: PendingPermissionPrompt): void => {
    const index = pending.indexOf(entry);
    if (index === -1) {
      return;
    }

    pending.splice(index, 1);
    try {
      options.onResolved(entry.prompt.requestId);
    } catch {
      // The notification extension must not alter permission handling.
    }
  };

  return {
    resolveDecision(decision) {
      if (!isInteractivePermissionDecision(decision)) {
        return false;
      }

      const directCandidates = pending.filter(
        (candidate) =>
          !candidate.prompt.forwarding &&
          promptAgentMatchesDecision(candidate.prompt, decision),
      );
      const entry =
        directCandidates.find((candidate) =>
          promptMatchesDecision(candidate.prompt, decision),
        ) ??
        // PermissionDecisionEvent intentionally has no requestId. Some direct
        // gates publish a display projection for ui_prompt and a distinct
        // decision projection at completion. With one compatible pending
        // prompt the association is unambiguous; otherwise retain strict
        // projection matching rather than guessing between requests.
        (directCandidates.length === 1 ? directCandidates[0] : undefined);
      if (!entry) {
        return false;
      }

      resolve(entry);
      return true;
    },
    resolveForwardedDecision(decision) {
      const entry = pending.find(
        (candidate) =>
          Boolean(candidate.prompt.forwarding) &&
          candidate.prompt.requestId === decision.requestId,
      );
      if (!entry) {
        return false;
      }

      resolve(entry);
      return true;
    },
    shutdown() {
      pending.splice(0);
    },
    track(prompt) {
      if (
        pending.some((entry) => entry.prompt.requestId === prompt.requestId)
      ) {
        return;
      }

      pending.push({ prompt });
    },
  };
}

function isInteractivePermissionDecision(
  decision: PermissionDecision,
): boolean {
  return INTERACTIVE_DECISIONS.has(decision.resolution);
}

function promptMatchesDecision(
  prompt: PermissionPrompt,
  decision: PermissionDecision,
): boolean {
  return (
    optionalFieldMatches(prompt.surface, decision.surface) &&
    optionalFieldMatches(prompt.value, decision.value) &&
    promptAgentMatchesDecision(prompt, decision)
  );
}

function promptAgentMatchesDecision(
  prompt: PermissionPrompt,
  decision: PermissionDecision,
): boolean {
  return optionalFieldMatches(prompt.agentName, decision.agentName);
}

function optionalFieldMatches(
  expected: string | undefined,
  actual: string | undefined,
): boolean {
  return expected === undefined || actual === undefined || expected === actual;
}

function forwardedPromptContext(
  value: unknown,
): ForwardedPromptContext | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    requesterAgentName: stringField(record, "requesterAgentName"),
    requesterSessionId: stringField(record, "requesterSessionId"),
  };
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
