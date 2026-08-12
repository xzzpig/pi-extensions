import { describe, expect, it } from "vitest";

import {
  buildBodyLines,
  formatNtfyBody,
  formatOscBody,
  NOTIFICATION_TITLES,
  notificationTitle,
  osc9BodyWithTitle,
  truncateCodePoints,
  truncateUtf8Bytes,
} from "../extensions/messages.js";
import { createNotificationEvent } from "../extensions/events.js";

function event(overrides: Record<string, unknown> = {}) {
  return createNotificationEvent({
    id: "agent-completed",
    source: "pi",
    projectName: "my-project",
    ...overrides,
  });
}

describe("notification titles", () => {
  it("uses the fixed action-oriented English titles", () => {
    expect(NOTIFICATION_TITLES).toEqual({
      "agent-completed": "Pi finished the task",
      "agent-error": "Pi encountered an error",
      "input-required": "Pi needs your input",
      "permission-required": "Pi needs permission",
      "context-compacted": "Pi compacted the context",
      "task-completed": "Pi completed a task",
      "integration-error": "Pi encountered an integration error",
    });
    expect(notificationTitle("input-required")).toBe("Pi needs your input");
  });
});

describe("body layout", () => {
  it("orders Label -> Project -> Session", () => {
    expect(
      buildBodyLines(
        event({
          label: "Deploy done",
          sessionName: "release-2024",
        }),
      ),
    ).toEqual(["Deploy done", "my-project", "release-2024"]);
  });

  it("omits missing fields", () => {
    expect(buildBodyLines(event())).toEqual(["my-project"]);
  });

  it("sanitizes every projected field", () => {
    expect(
      buildBodyLines(event({ label: "a\u0000b\nc", sessionName: "s \t x" })),
    ).toEqual(["a b c", "my-project", "s x"]);
  });

  it("never projects raw source fields", () => {
    const lines = buildBodyLines(
      event({
        id: "permission-required",
        sessionName: "session",
        // A malicious payload attempting to smuggle extra fields.
        ...{ message: "secret", surface: "bash", value: "rm -rf" },
      } as never),
    );
    expect(lines).toEqual(["my-project", "session"]);
  });
});

describe("ntfy body", () => {
  it("joins lines with newlines", () => {
    expect(formatNtfyBody(event({ label: "L", sessionName: "S" }))).toBe(
      "L\nmy-project\nS",
    );
  });

  it("truncates at 4000 UTF-8 bytes with an ellipsis", () => {
    const longLabel = "x".repeat(5000);
    const body = formatNtfyBody(event({ label: longLabel }));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4000);
    expect(body.endsWith("…")).toBe(true);
  });

  it("keeps multi-byte characters whole at the boundary", () => {
    const label = "😀".repeat(2000);
    const body = formatNtfyBody(event({ label }));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4000);
    expect(body.endsWith("…")).toBe(true);
    // No truncated surrogate pair: the body is always valid UTF-8.
    expect(() =>
      new TextDecoder().decode(Buffer.from(body, "utf8")),
    ).not.toThrow();
  });
});

describe("OSC body", () => {
  it("joins lines with the dot separator", () => {
    expect(formatOscBody(event({ label: "L", sessionName: "S" }))).toBe(
      "L · my-project · S",
    );
  });

  it("truncates at 512 code points with an ellipsis", () => {
    const body = formatOscBody(event({ label: "x".repeat(600) }));
    expect(Array.from(body).length).toBeLessThanOrEqual(512);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("OSC 9 title prefix", () => {
  it("prepends the fixed title to the body", () => {
    expect(osc9BodyWithTitle("Pi finished the task", "my-project")).toBe(
      "Pi finished the task · my-project",
    );
    expect(osc9BodyWithTitle("Pi finished the task", "")).toBe(
      "Pi finished the task",
    );
  });
});

describe("truncation utilities", () => {
  it("truncates UTF-8 by bytes", () => {
    expect(truncateUtf8Bytes("hello", 10)).toBe("hello");
    const truncated = truncateUtf8Bytes("hello😀world", 10);
    expect(truncated).toBe("hello…");
  });

  it("truncates by code points", () => {
    expect(truncateCodePoints("abcdef", 10)).toBe("abcdef");
    expect(truncateCodePoints("abcdef", 4)).toBe("abc…");
    expect(truncateCodePoints("😀😀😀", 2)).toBe("😀…");
  });
});
