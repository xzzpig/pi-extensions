import { describe, expect, it, vi } from "vitest";

import {
  assertPiNotifyPublishPayload,
  isPiNotifyPublishPayload,
  NOTIFICATION_EVENT_IDS,
  PI_NOTIFY_PUBLISH_EVENT,
  publishNotification,
} from "../api.js";

describe("pi-notify publish API", () => {
  it("exports the closed event catalog", () => {
    expect(NOTIFICATION_EVENT_IDS).toEqual([
      "agent-completed",
      "agent-error",
      "input-required",
      "permission-required",
      "context-compacted",
      "task-completed",
      "integration-error",
    ]);
    expect(PI_NOTIFY_PUBLISH_EVENT).toBe("pi-notify:publish");
  });

  it("publishes a valid payload through the event bus", () => {
    const emit = vi.fn();
    publishNotification({
      events: { emit },
      eventId: "task-completed",
      source: "my-plugin",
      label: "Deploy finished",
    });

    expect(emit).toHaveBeenCalledExactlyOnceWith(PI_NOTIFY_PUBLISH_EVENT, {
      eventId: "task-completed",
      source: "my-plugin",
      label: "Deploy finished",
    });
  });

  it("omits the label from the payload when absent", () => {
    const emit = vi.fn();
    publishNotification({
      events: { emit },
      eventId: "integration-error",
      source: "my-plugin",
    });

    expect(emit).toHaveBeenCalledWith(PI_NOTIFY_PUBLISH_EVENT, {
      eventId: "integration-error",
      source: "my-plugin",
    });
  });

  it("throws TypeError for an unknown event id", () => {
    expect(() =>
      publishNotification({
        events: { emit: vi.fn() },
        eventId: "tool-failed" as never,
        source: "my-plugin",
      }),
    ).toThrow(TypeError);
  });

  it("throws TypeError for an empty source", () => {
    expect(() =>
      publishNotification({
        events: { emit: vi.fn() },
        eventId: "agent-completed",
        source: "   ",
      }),
    ).toThrow(TypeError);
  });

  it("throws TypeError for a non-string label", () => {
    expect(() =>
      publishNotification({
        events: { emit: vi.fn() },
        eventId: "agent-completed",
        source: "my-plugin",
        label: 42 as never,
      }),
    ).toThrow(TypeError);
  });

  it("throws TypeError when the event bus has no emit function", () => {
    expect(() =>
      publishNotification({
        events: {} as never,
        eventId: "agent-completed",
        source: "my-plugin",
      }),
    ).toThrow(TypeError);
  });
});

describe("payload guards", () => {
  it("accepts a canonical payload", () => {
    const payload = { eventId: "input-required", source: "ask", label: "ok" };
    expect(isPiNotifyPublishPayload(payload)).toBe(true);
    expect(() => assertPiNotifyPublishPayload(payload)).not.toThrow();
  });

  it("rejects non-objects, unknown events, empty source and bad labels", () => {
    expect(isPiNotifyPublishPayload(null)).toBe(false);
    expect(isPiNotifyPublishPayload([])).toBe(false);
    expect(isPiNotifyPublishPayload({ eventId: "unknown", source: "x" })).toBe(
      false,
    );
    expect(
      isPiNotifyPublishPayload({ eventId: "agent-error", source: "" }),
    ).toBe(false);
    expect(
      isPiNotifyPublishPayload({
        eventId: "agent-error",
        source: "x",
        label: 1,
      }),
    ).toBe(false);
    expect(
      isPiNotifyPublishPayload({
        eventId: "agent-error",
        source: "x",
        extra: 1,
      }),
    ).toBe(true);
  });

  it("assert throws with a helpful TypeError", () => {
    expect(() =>
      assertPiNotifyPublishPayload({ eventId: "nope", source: "x" }),
    ).toThrow(/unknown eventId/);
    expect(() => assertPiNotifyPublishPayload(null)).toThrow(/object/);
  });
});
