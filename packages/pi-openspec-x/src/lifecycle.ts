/**
 * Lifecycle bus events and the pi-notify bridge (design D9; openspec change
 * add-pi-openspec-x, tasks 9.3 and 9.4).
 *
 * Every key flow node publishes one versioned lifecycle event on the single
 * channel `pi-openspec-x:lifecycle:v1` (payload carries the change id and a
 * structured `type`), so third parties — for example pi-sentinel's `event:`
 * trigger — can subscribe declaratively.
 *
 * pi-notify is bridged by LITERAL channel name, never by importing the package:
 * `pi-notify:publish` carries `{ eventId, source, label? }`, and a silent UI
 * span is claimed with `pi-notify:ui_span_silent` before a blocking dialog
 * opens. When pi-notify is absent the emits are harmless no-ops on a bus with
 * no listener; nothing here throws or depends on the package.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";

/** The one versioned lifecycle channel. */
export const OPSX_LIFECYCLE_CHANNEL = "pi-openspec-x:lifecycle:v1";

/** pi-notify's publish channel (literal; no import). */
export const PI_NOTIFY_PUBLISH_CHANNEL = "pi-notify:publish";
/** pi-notify's silent-UI-span channel (literal; no import). */
export const PI_NOTIFY_UI_SPAN_SILENT_CHANNEL = "pi-notify:ui_span_silent";
/** The source name every pi-notify payload carries. */
export const PI_NOTIFY_SOURCE = "pi-openspec-x";

export type OpsxLifecycleEventType =
  | "plan_started"
  | "phase_changed"
  | "review_verdict"
  | "approval_wait"
  | "plan_approved"
  | "implement_started"
  | "task_dispatched"
  | "task_completed"
  | "final_verdict"
  | "flow_completed"
  | "mode_exited";

/** The structured lifecycle payload consumers can rely on. */
export interface OpsxLifecyclePayload {
  version: 1;
  type: OpsxLifecycleEventType;
  /** The openspec change this flow belongs to. */
  change: string;
  /** ISO timestamp. */
  at: string;
  mode?: "plan" | "agent" | "direct";
  phase?: string;
  round?: number;
  verdict?: string;
  taskId?: string;
  message?: string;
}

export type OpsxLifecycleInput = Omit<
  OpsxLifecyclePayload,
  "version" | "at"
> & {
  at?: string;
};

/** Minimal bus view; the real `pi.events` EventBus satisfies it. */
export type EventEmitterLike = Pick<EventBus, "emit">;

/**
 * Publish one lifecycle event. A throwing bus never breaks the flow: the
 * payload is still returned for tests and local logging.
 */
export function publishLifecycle(
  events: EventEmitterLike,
  input: OpsxLifecycleInput,
): OpsxLifecyclePayload {
  const payload: OpsxLifecyclePayload = {
    version: 1,
    ...input,
    at: input.at ?? new Date().toISOString(),
  };
  try {
    events.emit(OPSX_LIFECYCLE_CHANNEL, payload);
  } catch {
    // Observability is best-effort.
  }
  return payload;
}

/** pi-notify's notification event ids this plugin uses. */
export type PiNotifyEventId =
  | "input-required"
  | "task-completed"
  | "integration-error";

export interface PiNotifyPayload {
  eventId: PiNotifyEventId;
  source: string;
  label?: string;
}

/**
 * Publish one pi-notify notification. Returns the payload; a missing
 * pi-notify simply means no listener sees it.
 */
export function publishNotify(
  events: EventEmitterLike,
  input: { eventId: PiNotifyEventId; label?: string },
): PiNotifyPayload {
  const payload: PiNotifyPayload = {
    eventId: input.eventId,
    source: PI_NOTIFY_SOURCE,
    ...(input.label ? { label: input.label } : {}),
  };
  try {
    events.emit(PI_NOTIFY_PUBLISH_CHANNEL, payload);
  } catch {
    // Best-effort.
  }
  return payload;
}

/**
 * Claim the next UI span as silent before opening a blocking dialog that is
 * not an agent-waiting prompt.
 */
export function emitSilentUiSpan(
  events: EventEmitterLike,
  reason?: string,
): void {
  try {
    events.emit(PI_NOTIFY_UI_SPAN_SILENT_CHANNEL, reason ? { reason } : {});
  } catch {
    // Best-effort.
  }
}

/** The flow nodes that map onto a pi-notify event id. */
export const NOTIFY_NODE_EVENT_ID: Record<
  "approval_wait" | "flow_completed" | "gate_error",
  PiNotifyEventId
> = {
  approval_wait: "input-required",
  flow_completed: "task-completed",
  gate_error: "integration-error",
};

/** Publish the pi-notify notification for a flow node. */
export function notifyFlowNode(
  events: EventEmitterLike,
  node: keyof typeof NOTIFY_NODE_EVENT_ID,
  label?: string,
): PiNotifyPayload {
  return publishNotify(events, {
    eventId: NOTIFY_NODE_EVENT_ID[node],
    ...(label ? { label } : {}),
  });
}
