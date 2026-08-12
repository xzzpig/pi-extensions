import { describe, expect, it, vi } from "vitest";

import {
  createNtfyRequestUrl,
  createNtfySender,
  deliver,
  ntfyHttpWarning,
  type FetchLike,
} from "../extensions/channels/ntfy.js";
import type { NtfyChannelConfig } from "../extensions/config.js";
import { createNotificationEvent } from "../extensions/events.js";

const DEFAULT_ICON =
  "https://cdn.jsdelivr.net/npm/@xzzpig/pi-notify@0.1.0/assets/pi.png";

function config(overrides: Partial<NtfyChannelConfig> = {}): NtfyChannelConfig {
  return {
    serverUrl: "https://ntfy.sh",
    topic: "my-topic",
    timeoutMs: 5000,
    eventOptions: {},
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return createNotificationEvent({
    id: "agent-completed",
    source: "pi",
    projectName: "my-project",
    ...overrides,
  });
}

function fetchMock() {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

function callArgs(
  fetchImpl: ReturnType<typeof fetchMock>,
): [string, Record<string, unknown>] {
  return fetchImpl.mock.calls[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
}

describe("createNtfyRequestUrl", () => {
  it("composes server and topic safely", () => {
    expect(createNtfyRequestUrl("https://ntfy.sh/", "topic").toString()).toBe(
      "https://ntfy.sh/topic",
    );
    expect(
      createNtfyRequestUrl("https://host.example/ntfy", "topic").toString(),
    ).toBe("https://host.example/ntfy/topic");
  });

  it("rejects non-http(s) servers", () => {
    expect(() => createNtfyRequestUrl("ftp://x.example", "t")).toThrow(
      "invalid ntfy server url",
    );
    expect(() => createNtfyRequestUrl("not a url", "t")).toThrow(
      "invalid ntfy server url",
    );
  });
});

describe("ntfyHttpWarning", () => {
  it("warns only when HTTP is combined with a token", () => {
    expect(
      ntfyHttpWarning(config({ serverUrl: "http://ntfy.local", token: "t" })),
    ).toMatch(/plain text/);
    expect(
      ntfyHttpWarning(config({ serverUrl: "http://ntfy.local" })),
    ).toBeUndefined();
    expect(ntfyHttpWarning(config({ token: "t" }))).toBeUndefined();
  });
});

describe("deliver", () => {
  it("POSTs text with Title, Priority and the default Icon", async () => {
    const fetchImpl = fetchMock();
    await deliver(
      event(),
      config(),
      DEFAULT_ICON,
      fetchImpl as unknown as FetchLike,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe("https://ntfy.sh/my-topic");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("my-project");
    expect(init.headers).toMatchObject({
      Title: "Pi finished the task",
      Priority: "3",
      Icon: DEFAULT_ICON,
    });
  });

  it("sends the Bearer token and event overrides when configured", async () => {
    const fetchImpl = fetchMock();
    await deliver(
      event({ id: "agent-error" }),
      config({
        token: "tok123",
        priority: 4,
        eventOptions: {
          "agent-error": { priority: 5, icon: "https://i.example/x.png" },
        },
      }),
      DEFAULT_ICON,
      fetchImpl as unknown as FetchLike,
    );
    const [, init] = callArgs(fetchImpl);
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok123",
      Priority: "5",
      Icon: "https://i.example/x.png",
    });
  });

  it("omits the Icon header when the icon is disabled", async () => {
    const fetchImpl = fetchMock();
    await deliver(
      event(),
      config({ icon: null }),
      DEFAULT_ICON,
      fetchImpl as unknown as FetchLike,
    );
    const [, init] = callArgs(fetchImpl);
    expect(init.headers).not.toHaveProperty("Icon");
  });

  it("uses built-in priorities when nothing is overridden", async () => {
    const fetchImpl = fetchMock();
    await deliver(
      event({ id: "context-compacted" }),
      config(),
      DEFAULT_ICON,
      fetchImpl as unknown as FetchLike,
    );
    const [, init] = callArgs(fetchImpl);
    expect(init.headers).toMatchObject({ Priority: "2" });
  });

  it("never retries and reports only sanitized failures", async () => {
    const failing = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(
      deliver(event(), config(), DEFAULT_ICON, failing as unknown as FetchLike),
    ).rejects.toThrow("http 500");
    expect(failing).toHaveBeenCalledTimes(1);

    const network = vi
      .fn()
      .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    await expect(
      deliver(event(), config(), DEFAULT_ICON, network as unknown as FetchLike),
    ).rejects.toThrow("network error");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("maps timeouts to a sanitized timeout error", async () => {
    const timeout = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      );
    await expect(
      deliver(
        event(),
        config({ timeoutMs: 250 }),
        DEFAULT_ICON,
        timeout as unknown as FetchLike,
      ),
    ).rejects.toThrow("timeout after 250ms");
  });

  it("uses the configured AbortSignal for the timeout", async () => {
    const fetchImpl = fetchMock();
    await deliver(
      event(),
      config({ timeoutMs: 1234 }),
      DEFAULT_ICON,
      fetchImpl as unknown as FetchLike,
    );
    const [, init] = callArgs(fetchImpl);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createNtfySender", () => {
  it("provides a fire-and-forget send", async () => {
    const fetchImpl = fetchMock();
    const sender = createNtfySender({
      config: config(),
      defaultIconUrl: DEFAULT_ICON,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    const result = sender.send(event());
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
