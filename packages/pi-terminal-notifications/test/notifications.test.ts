import { describe, expect, it } from "vitest";

import {
  buildTerminalNotification,
  emitTerminalNotification,
  sanitizeOscText,
} from "../extensions/notifications.js";

const notification = {
  body: "Pi needs your response",
  identifier: "pi-ask",
  title: "Pi ask",
};

describe("terminal notification protocols", () => {
  it("encodes exactly one sequence for each supported protocol", () => {
    expect(buildTerminalNotification("osc9", notification)).toBe(
      "\x1b]9;Pi needs your response\x1b\\",
    );
    expect(buildTerminalNotification("osc99", notification)).toBe(
      "\x1b]99;i=pi-ask:p=body;Pi needs your response\x1b\\",
    );
    expect(buildTerminalNotification("osc777", notification)).toBe(
      "\x1b]777;notify;Pi ask;Pi needs your response\x1b\\",
    );
  });

  it("removes terminal controls and OSC separators from notification text", () => {
    expect(sanitizeOscText(" one;two\u001b]99;evil\nthree ")).toBe(
      "one:two ]99:evil three",
    );
    expect(
      buildTerminalNotification("osc777", {
        body: "body;\u0007",
        identifier: "id;\u001b",
        title: "title;\u009c",
      }),
    ).toBe("\x1b]777;notify;title:;body:\x1b\\");
  });

  it("limits notification text and treats output failures as best effort", () => {
    const body = "x".repeat(300);
    const sequence = buildTerminalNotification("osc9", {
      body,
      identifier: "pi",
      title: "Pi",
    });
    expect(sequence).toHaveLength(256 + "\x1b]9;".length + "\x1b\\".length);

    expect(
      emitTerminalNotification("osc99", notification, () => {
        throw new Error("terminal unavailable");
      }),
    ).toBe(false);
  });
});
