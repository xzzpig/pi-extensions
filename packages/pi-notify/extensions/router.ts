/**
 * Notification router: fans a semantic event out to every enabled channel
 * instance that subscribes to it. OSC channels only run in TUI mode. Errors
 * are contained per instance and reported through the health tracker.
 */
import type { InternalNotificationEvent } from "./events.js";
import type { HealthReporter } from "./health.js";

export interface RoutableChannel {
  id: string;
  type: "osc" | "ntfy";
  enabled: boolean;
  subscribed: readonly string[];
  send(event: InternalNotificationEvent): void | Promise<void>;
}

export interface RouterOptions {
  mode: () => string;
  health: HealthReporter;
}

export interface NotificationRouter {
  setChannels(channels: readonly RoutableChannel[]): void;
  setEnabled(enabled: boolean): void;
  route(event: InternalNotificationEvent): void;
}

export function createRouter(options: RouterOptions): NotificationRouter {
  let channels: readonly RoutableChannel[] = [];
  let enabled = true;

  return {
    setChannels(next) {
      channels = next;
    },
    setEnabled(next) {
      enabled = next;
    },
    route(event) {
      if (!enabled) {
        return;
      }

      for (const channel of channels) {
        if (!channel.enabled || !channel.subscribed.includes(event.id)) {
          continue;
        }
        if (channel.type === "osc" && options.mode() !== "tui") {
          continue;
        }

        try {
          const result = channel.send(event);
          if (isPromiseLike(result)) {
            result.then(
              () => options.health.record(channel.id, { ok: true }),
              (error: unknown) =>
                options.health.record(channel.id, {
                  ok: false,
                  detail: sanitizedError(error),
                }),
            );
          } else {
            options.health.record(channel.id, { ok: true });
          }
        } catch (error) {
          options.health.record(channel.id, {
            ok: false,
            detail: sanitizedError(error),
          });
        }
      }
    },
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Channel errors must already be sanitized; this defends against raw leaks. */
function sanitizedError(error: unknown): string {
  if (error instanceof Error) {
    return /^[ -~]+$/.test(error.message)
      ? error.message.slice(0, 120)
      : "channel error";
  }
  return "channel error";
}
