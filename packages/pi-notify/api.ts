/**
 * Public API for @xzzpig/pi-notify.
 *
 * Third-party Pi extensions can publish notification events on the shared
 * `pi-notify:publish` channel, or use the `publishNotification` helper.
 * Event IDs are closed: only the events declared in `NOTIFICATION_EVENT_IDS`
 * are routable.
 */

export const PI_NOTIFY_PUBLISH_EVENT = "pi-notify:publish";

export const NOTIFICATION_EVENT_IDS = [
  "agent-completed",
  "agent-error",
  "input-required",
  "permission-required",
  "context-compacted",
  "task-completed",
  "integration-error",
] as const;

export type NotificationEventId = (typeof NOTIFICATION_EVENT_IDS)[number];

/** Payload published on the `pi-notify:publish` channel. */
export interface PiNotifyPublishPayload {
  eventId: NotificationEventId;
  source: string;
  /** Optional safe, display-only label. Sanitized by the receiver. */
  label?: string;
}

/** Minimal event bus required by `publishNotification`. */
export interface PiNotifyEventBus {
  emit(channel: string, data: unknown): unknown;
}

export interface PublishNotificationOptions {
  events: PiNotifyEventBus;
  eventId: NotificationEventId;
  source: string;
  label?: string;
}

const EVENT_ID_SET = new Set<string>(NOTIFICATION_EVENT_IDS);

export function isPiNotifyPublishPayload(
  value: unknown,
): value is PiNotifyPublishPayload {
  if (!isRecord(value)) {
    return false;
  }

  const eventId = value.eventId;
  if (typeof eventId !== "string" || !EVENT_ID_SET.has(eventId)) {
    return false;
  }

  const source = value.source;
  if (typeof source !== "string" || source.trim().length === 0) {
    return false;
  }

  const label = value.label;
  return label === undefined || typeof label === "string";
}

export function assertPiNotifyPublishPayload(
  value: unknown,
): asserts value is PiNotifyPublishPayload {
  if (!isRecord(value)) {
    throw new TypeError("pi-notify: publish payload must be a non-null object");
  }

  const eventId = value.eventId;
  if (typeof eventId !== "string" || !EVENT_ID_SET.has(eventId)) {
    throw new TypeError(
      `pi-notify: unknown eventId ${JSON.stringify(eventId)}`,
    );
  }

  const source = value.source;
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new TypeError("pi-notify: source must be a non-empty string");
  }

  const label = value.label;
  if (label !== undefined && typeof label !== "string") {
    throw new TypeError("pi-notify: label must be a string");
  }
}

/**
 * Publish a notification event through `events.emit(PI_NOTIFY_PUBLISH_EVENT,
 * payload)`. Throws `TypeError` for an invalid payload or an event bus that
 * does not provide `emit`.
 */
export function publishNotification(options: PublishNotificationOptions): void {
  if (!isRecord(options)) {
    throw new TypeError(
      "pi-notify: publishNotification requires an options object",
    );
  }

  const events = options.events;
  if (!isRecord(events) || typeof events.emit !== "function") {
    throw new TypeError(
      "pi-notify: events must provide an emit(channel, data) function",
    );
  }

  const payload: PiNotifyPublishPayload = {
    eventId: options.eventId,
    source: options.source,
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
  assertPiNotifyPublishPayload(payload);

  events.emit(PI_NOTIFY_PUBLISH_EVENT, payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
