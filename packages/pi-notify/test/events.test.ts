import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBSCRIBED_EVENT_IDS,
  isNotificationEventId,
  parsePublishPayload,
  sanitizeLabel,
} from "../extensions/events.js";
import { NOTIFICATION_EVENT_IDS } from "../api.js";

describe("event catalog", () => {
  it("defaults to all events except context-compacted", () => {
    expect(DEFAULT_SUBSCRIBED_EVENT_IDS).toEqual(
      NOTIFICATION_EVENT_IDS.filter((id) => id !== "context-compacted"),
    );
    expect(DEFAULT_SUBSCRIBED_EVENT_IDS).not.toContain("context-compacted");
  });

  it("recognizes only closed event ids", () => {
    expect(isNotificationEventId("agent-error")).toBe(true);
    expect(isNotificationEventId("tool-failed")).toBe(false);
    expect(isNotificationEventId(42)).toBe(false);
  });
});

describe("parsePublishPayload", () => {
  it("validates and sanitizes a canonical payload", () => {
    expect(
      parsePublishPayload({
        eventId: "agent-error",
        source: " my-plugin ",
        label: "  foo\n  bar  ",
        extra: "dropped",
      }),
    ).toEqual({
      eventId: "agent-error",
      source: "my-plugin",
      label: "foo bar",
    });
  });

  it("omits the label when absent", () => {
    expect(
      parsePublishPayload({ eventId: "agent-completed", source: "pi" }),
    ).toEqual({ eventId: "agent-completed", source: "pi" });
  });

  it("returns undefined for invalid payloads", () => {
    expect(parsePublishPayload(null)).toBeUndefined();
    expect(
      parsePublishPayload({ eventId: "tool-failed", source: "x" }),
    ).toBeUndefined();
    expect(
      parsePublishPayload({ eventId: "agent-error", source: "" }),
    ).toBeUndefined();
    expect(
      parsePublishPayload({ eventId: "agent-error", source: "x", label: 1 }),
    ).toBeUndefined();
  });
});

describe("sanitizeLabel", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeLabel("a\u0000b\u001bc\u007fd\n e\u0009f")).toBe(
      "a b c d e f",
    );
    expect(sanitizeLabel("  \t x \n y  ")).toBe("x y");
  });

  it("drops bidi and format control characters (zero-width, overrides, BOM, soft hyphen)", () => {
    expect(sanitizeLabel("a\u200bb\u202ec\u200dd")).toBe("a b c d");
    expect(sanitizeLabel("x\u00ady\ufeffz")).toBe("x y z");
    expect(sanitizeLabel("\u202aRTL\u202c")).toBe("RTL");
  });
});
