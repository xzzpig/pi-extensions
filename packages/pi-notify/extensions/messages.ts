/**
 * Fixed, low-sensitivity message projection for notification events.
 *
 * Only a sanitized label, the project directory basename, and the session
 * display name are ever projected; no raw event content is used.
 */
import type { NotificationEventId } from "../api.js";
import { sanitizeLabel, type InternalNotificationEvent } from "./events.js";

export const NOTIFICATION_TITLES: Record<NotificationEventId, string> = {
  "agent-completed": "Pi finished the task",
  "agent-error": "Pi encountered an error",
  "input-required": "Pi needs your input",
  "permission-required": "Pi needs permission",
  "context-compacted": "Pi compacted the context",
  "task-completed": "Pi completed a task",
  "integration-error": "Pi encountered an integration error",
};

export const OSC_LINE_SEPARATOR = " · ";
export const NTFY_MAX_BODY_BYTES = 4000;
export const OSC_MAX_BODY_CHARS = 512;
const ELLIPSIS = "…";

export function notificationTitle(eventId: NotificationEventId): string {
  return NOTIFICATION_TITLES[eventId];
}

/**
 * Compose the notification body lines in Label -> Project -> Session order,
 * omitting missing fields. Every line is sanitized for display.
 */
export function buildBodyLines(event: InternalNotificationEvent): string[] {
  const lines: string[] = [];
  if (event.label) {
    lines.push(sanitizeLabel(event.label));
  }
  if (event.projectName) {
    lines.push(sanitizeLabel(event.projectName));
  }
  if (event.sessionName) {
    lines.push(sanitizeLabel(event.sessionName));
  }
  return lines;
}

/** ntfy body: one line per field, limited to 4000 UTF-8 bytes. */
export function formatNtfyBody(event: InternalNotificationEvent): string {
  const lines = buildBodyLines(event);
  if (lines.length === 0) {
    return "";
  }

  return truncateUtf8Bytes(lines.join("\n"), NTFY_MAX_BODY_BYTES);
}

/** OSC body: a single line joined with ` · `, limited to 512 code points. */
export function formatOscBody(event: InternalNotificationEvent): string {
  const lines = buildBodyLines(event);
  if (lines.length === 0) {
    return "";
  }

  return truncateCodePoints(lines.join(OSC_LINE_SEPARATOR), OSC_MAX_BODY_CHARS);
}

/**
 * OSC 9 has no title slot, so the fixed title is prepended to the body
 * (used as the notification text).
 */
export function osc9BodyWithTitle(title: string, body: string): string {
  if (!body) {
    return title;
  }
  if (!title) {
    return body;
  }

  return `${title}${OSC_LINE_SEPARATOR}${body}`;
}

/** Truncate to `maxBytes` UTF-8 bytes, appending an ellipsis when truncated. */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const fullLength = Buffer.byteLength(text, "utf8");
  if (fullLength <= maxBytes) {
    return text;
  }

  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, "utf8");
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  let prefix = "";
  for (const character of text) {
    const next = prefix + character;
    if (Buffer.byteLength(next, "utf8") > budget) {
      break;
    }
    prefix = next;
  }

  return `${prefix}${ELLIPSIS}`;
}

/** Truncate to at most `max` Unicode code points, appending an ellipsis. */
export function truncateCodePoints(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.length <= max) {
    return text;
  }

  const keep = Math.max(0, max - Array.from(ELLIPSIS).length);
  return `${characters.slice(0, keep).join("")}${ELLIPSIS}`;
}
