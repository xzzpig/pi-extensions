/**
 * Internal event model and shared parsing helpers.
 *
 * The event catalog lives in the public `api.ts`; this module re-exports it
 * for internal consumers and adds runtime-only event shapes.
 */
import { NOTIFICATION_EVENT_IDS, type NotificationEventId } from "../api.js";

export { NOTIFICATION_EVENT_IDS };
export type { NotificationEventId };

/** Default channel subscription: all events except `context-compacted`. */
export const DEFAULT_SUBSCRIBED_EVENT_IDS: readonly NotificationEventId[] =
  NOTIFICATION_EVENT_IDS.filter((id) => id !== "context-compacted");

/** Immutable internal event passed to channels after sanitization. */
export interface InternalNotificationEvent {
  id: NotificationEventId;
  source: string;
  label?: string;
  projectName: string;
  sessionName?: string;
  timestamp: number;
}

export interface CreateEventInput {
  id: NotificationEventId;
  source: string;
  label?: string;
  projectName: string;
  sessionName?: string;
}

export function createNotificationEvent(
  input: CreateEventInput,
): InternalNotificationEvent {
  return {
    id: input.id,
    source: input.source,
    ...(input.label !== undefined ? { label: input.label } : {}),
    projectName: input.projectName,
    ...(input.sessionName !== undefined
      ? { sessionName: input.sessionName }
      : {}),
    timestamp: Date.now(),
  };
}

export function isNotificationEventId(
  value: unknown,
): value is NotificationEventId {
  return (
    typeof value === "string" &&
    NOTIFICATION_EVENT_IDS.includes(value as NotificationEventId)
  );
}

/** Result of parsing a publish-channel payload (validated + sanitized). */
export interface ParsedPublishPayload {
  eventId: NotificationEventId;
  source: string;
  label?: string;
}

/**
 * Parse a raw `pi-notify:publish` payload defensively: validates the event
 * id and source, sanitizes the label, and drops every other field. Returns
 * undefined for invalid payloads (the receiver warns locally and ignores).
 */
export function parsePublishPayload(
  value: unknown,
): ParsedPublishPayload | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const eventId = record.eventId;
  if (!isNotificationEventId(eventId)) {
    return undefined;
  }

  const source = stringField(record, "source");
  if (!source) {
    return undefined;
  }

  const label = record.label;
  if (label !== undefined && typeof label !== "string") {
    return undefined;
  }

  return {
    eventId,
    source,
    ...(label !== undefined ? { label: sanitizeLabel(label) } : {}),
  };
}

/**
 * Sanitize a display label: strip control characters, collapse whitespace,
 * and trim. Used for publish payloads and adapter-provided labels.
 */
export function sanitizeLabel(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    // Keep printable ASCII (excluding DEL) and everything above U+00A0;
    // control characters (and U+007F) become spaces. Whitespace is then
    // collapsed, so embedded newlines cannot inject extra message lines.
    // Bidi/format control characters (zero-width, bidi overrides, BOM,
    // soft hyphen) are dropped so a label cannot reorder rendered text.
    if (
      ((codePoint >= 0x20 && codePoint < 0x7f) || codePoint >= 0xa0) &&
      !IS_BIDI_OR_FORMAT_CHARACTER(character)
    ) {
      return character;
    }

    return " ";
  })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function IS_BIDI_OR_FORMAT_CHARACTER(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x200b && codePoint <= 0x206f) || // ZWSP/ZWNJ/bidi controls
    codePoint === 0xad || // soft hyphen
    codePoint === 0xfeff // BOM / zero-width no-break space
  );
}

export function stringField(value: unknown, field: string): string | undefined {
  const record = asRecord(value);
  const entry = record?.[field];
  return typeof entry === "string" && entry.trim().length > 0
    ? entry.trim()
    : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
