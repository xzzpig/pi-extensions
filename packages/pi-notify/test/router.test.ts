import { describe, expect, it, vi } from "vitest";

import { createHealthTracker } from "../extensions/health.js";
import { createRouter, type RoutableChannel } from "../extensions/router.js";
import { createNotificationEvent } from "../extensions/events.js";

function event(id = "agent-completed") {
  return createNotificationEvent({
    id: id as never,
    source: "pi",
    projectName: "p",
  });
}

function channel(overrides: Partial<RoutableChannel> = {}): RoutableChannel {
  return {
    id: "ch",
    type: "ntfy",
    enabled: true,
    subscribed: ["agent-completed"],
    send: vi.fn(),
    ...overrides,
  };
}

describe("router", () => {
  it("fans out only to enabled, subscribed channels", () => {
    const sent = vi.fn();
    const skipped = vi.fn();
    const router = createRouter({
      mode: () => "tui",
      health: createHealthTracker({ onFailure: vi.fn(), onRecovery: vi.fn() }),
    });
    router.setChannels([
      channel({ id: "a", subscribed: ["agent-completed"], send: sent }),
      channel({ id: "b", subscribed: ["agent-error"], send: skipped }),
      channel({ id: "c", enabled: false, send: skipped }),
    ]);
    router.route(event("agent-completed"));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });

  it("skips OSC channels outside TUI mode", () => {
    const sent = vi.fn();
    const router = createRouter({
      mode: () => "json",
      health: createHealthTracker({ onFailure: vi.fn(), onRecovery: vi.fn() }),
    });
    router.setChannels([channel({ id: "a", type: "osc", send: sent })]);
    router.route(event());
    expect(sent).not.toHaveBeenCalled();
  });

  it("stops routing when the top-level switch is off", () => {
    const sent = vi.fn();
    const router = createRouter({
      mode: () => "tui",
      health: createHealthTracker({ onFailure: vi.fn(), onRecovery: vi.fn() }),
    });
    router.setChannels([channel({ id: "a", send: sent })]);
    router.setEnabled(false);
    router.route(event());
    expect(sent).not.toHaveBeenCalled();
  });

  it("reports sync failures once and recovers on the next success", () => {
    const onFailure = vi.fn();
    const onRecovery = vi.fn();
    const health = createHealthTracker({ onFailure, onRecovery });
    const router = createRouter({ mode: () => "tui", health });
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("http 500");
      })
      .mockImplementationOnce(() => {
        throw new Error("http 500");
      })
      .mockReturnValue(undefined);
    router.setChannels([channel({ id: "a", send })]);
    router.route(event());
    router.route(event());
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onRecovery).not.toHaveBeenCalled();
    router.route(event());
    expect(onRecovery).toHaveBeenCalledTimes(1);
  });

  it("reports async rejections without throwing", async () => {
    const onFailure = vi.fn();
    const health = createHealthTracker({ onFailure, onRecovery: vi.fn() });
    const router = createRouter({ mode: () => "tui", health });
    const send = vi.fn().mockRejectedValue(new Error("network error"));
    router.setChannels([channel({ id: "a", send })]);
    router.route(event());
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onFailure).toHaveBeenCalledWith(
      "a",
      expect.stringContaining("network error"),
    );
  });

  it("sanitizes non-ascii error messages", () => {
    const onFailure = vi.fn();
    const health = createHealthTracker({ onFailure, onRecovery: vi.fn() });
    const router = createRouter({ mode: () => "tui", health });
    const send = vi.fn().mockRejectedValue(new Error("token: 秘密\u0000"));
    router.setChannels([channel({ id: "a", send })]);
    router.route(event());
    return vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith("a", "channel error");
    });
  });
});

describe("health tracker", () => {
  it("keeps silence during repeated failures and resets on reload", () => {
    const onFailure = vi.fn();
    const onRecovery = vi.fn();
    const health = createHealthTracker({ onFailure, onRecovery });
    health.record("a", { ok: false, detail: "x" });
    health.record("a", { ok: false, detail: "x" });
    health.record("a", { ok: true });
    health.record("a", { ok: true });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onRecovery).toHaveBeenCalledTimes(1);

    health.reset();
    health.record("a", { ok: false, detail: "x" });
    expect(onFailure).toHaveBeenCalledTimes(2);
  });
});

describe("router with mixed channel outcomes", () => {
  it("keeps a healthy channel unaffected by another channel's failure", () => {
    const onFailure = vi.fn();
    const onRecovery = vi.fn();
    const health = createHealthTracker({ onFailure, onRecovery });
    const router = createRouter({ mode: () => "tui", health });
    const goodSend = vi.fn().mockReturnValue(undefined);
    const badSend = vi.fn().mockImplementation(() => {
      throw new Error("http 500");
    });
    router.setChannels([
      channel({ id: "good", send: goodSend }),
      channel({ id: "bad", send: badSend }),
    ]);

    router.route(event());
    expect(goodSend).toHaveBeenCalledTimes(1);
    expect(badSend).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("bad", "http 500");
    // A later success on the bad channel must recover only that channel.
    badSend.mockImplementation(() => {});
    router.route(event());
    expect(onRecovery).toHaveBeenCalledWith("bad");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
