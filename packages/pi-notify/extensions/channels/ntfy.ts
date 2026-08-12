/**
 * ntfy push notification channel.
 *
 * Node fetch POST with a pure-text body plus Title/Priority/Icon headers
 * and an optional Bearer token. Delivery is strictly fire-and-forget: the
 * caller never waits, failures are never retried, and errors are sanitized
 * so tokens, topics and URL paths cannot leak into diagnostics.
 */
import {
  resolveNtfyIcon,
  resolveNtfyPriority,
  type NtfyChannelConfig,
} from "../config.js";
import type { InternalNotificationEvent } from "../events.js";
import { formatNtfyBody, notificationTitle } from "../messages.js";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

export interface NtfySenderOptions {
  config: NtfyChannelConfig;
  defaultIconUrl: string;
  fetchImpl?: FetchLike;
}

export interface NtfySender {
  send(event: InternalNotificationEvent): Promise<void>;
}

const HTTP_WITH_TOKEN_WARNING =
  "pi-notify: ntfy channel uses HTTP with a token; credentials are sent in plain text";

export function createNtfySender(options: NtfySenderOptions): NtfySender {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async send(event) {
      await deliver(event, config, options.defaultIconUrl, fetchImpl);
    },
  };
}

export function ntfyHttpWarning(config: NtfyChannelConfig): string | undefined {
  return /^http:\/\//i.test(config.serverUrl) && config.token
    ? HTTP_WITH_TOKEN_WARNING
    : undefined;
}

/**
 * Build the ntfy endpoint URL defensively. Only http/https URLs with a
 * hostname are allowed; the topic is a validated [-_A-Za-z0-9] token, so
 * the composed URL cannot escape the configured scheme or host.
 */
export function createNtfyRequestUrl(serverUrl: string, topic: string): URL {
  let url: URL;
  try {
    url = new URL(`${serverUrl.replace(/\/+$/, "")}/${topic}`);
  } catch {
    throw new Error("invalid ntfy server url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("invalid ntfy server url");
  }
  return url;
}

export async function deliver(
  event: InternalNotificationEvent,
  config: NtfyChannelConfig,
  defaultIconUrl: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const url = createNtfyRequestUrl(config.serverUrl, config.topic);
  const title = notificationTitle(event.id);
  const body = formatNtfyBody(event);
  if (!body && !title) {
    return;
  }

  const priority = resolveNtfyPriority(event.id, config);
  const icon = resolveNtfyIcon(event.id, config, defaultIconUrl);

  const headers: Record<string, string> = {
    Title: title,
    Priority: String(priority),
  };
  if (icon !== null) {
    headers.Icon = icon;
  }
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === "TimeoutError"
        ? `timeout after ${config.timeoutMs}ms`
        : "network error",
    );
  }

  if (!response.ok) {
    throw new Error(`http ${response.status}`);
  }
}
