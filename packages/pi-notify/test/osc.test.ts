import { describe, expect, it, vi } from "vitest";

import {
  buildOscSequences,
  createOscSender,
  emitOscSequences,
  resolveOscProtocol,
  sanitizeOscText,
} from "../extensions/channels/osc.js";
import {
  DEFAULT_OSC_FALLBACK,
  DEFAULT_TERM_PROGRAM_PROTOCOLS,
} from "../extensions/config.js";
import { createNotificationEvent } from "../extensions/events.js";

const BASE = {
  fallback: DEFAULT_OSC_FALLBACK,
  termPrograms: { ...DEFAULT_TERM_PROGRAM_PROTOCOLS },
  kittyWindowId: undefined,
};

function event(overrides: Record<string, unknown> = {}) {
  return createNotificationEvent({
    id: "agent-completed",
    source: "pi",
    projectName: "my-project",
    ...overrides,
  });
}

describe("resolveOscProtocol", () => {
  it("prefers the kitty window id signal", () => {
    expect(
      resolveOscProtocol({
        ...BASE,
        termProgram: "ghostty",
        kittyWindowId: "123",
      }),
    ).toBe("osc99");
  });

  it("maps known TERM_PROGRAM values", () => {
    expect(resolveOscProtocol({ ...BASE, termProgram: "ghostty" })).toBe(
      "osc777",
    );
    expect(resolveOscProtocol({ ...BASE, termProgram: "WezTerm" })).toBe(
      "osc777",
    );
    expect(resolveOscProtocol({ ...BASE, termProgram: "WarpTerminal" })).toBe(
      "osc777",
    );
    expect(resolveOscProtocol({ ...BASE, termProgram: "iTerm.app" })).toBe(
      "osc9",
    );
    expect(resolveOscProtocol({ ...BASE, termProgram: "vscode" })).toBe(
      "osc99",
    );
  });

  it("supports case-insensitive user mappings that extend built-ins", () => {
    const termPrograms: Record<
      string,
      import("../extensions/config.js").NotificationProtocol
    > = {
      ...BASE.termPrograms,
      MyTerminal: "osc9",
    };
    expect(
      resolveOscProtocol({
        ...BASE,
        termPrograms,
        termProgram: "myterminal",
      }),
    ).toBe("osc9");
    expect(
      resolveOscProtocol({ ...BASE, termPrograms, termProgram: "MYTERMINAL" }),
    ).toBe("osc9");
    // Built-in mappings survive user additions; kitty is only detected via
    // KITTY_WINDOW_ID (kitty does not set TERM_PROGRAM), so its name falls
    // back to the default protocol.
    expect(
      resolveOscProtocol({ ...BASE, termPrograms, termProgram: "kitty" }),
    ).toBe("osc9");
  });

  it("falls back to the configured fallback for unknown or missing terminals", () => {
    expect(resolveOscProtocol({ ...BASE, termProgram: "unknown" })).toBe(
      "osc9",
    );
    expect(resolveOscProtocol({ ...BASE, termProgram: undefined })).toBe(
      "osc9",
    );
    expect(
      resolveOscProtocol({
        ...BASE,
        termProgram: "unknown",
        fallback: "osc777",
      }),
    ).toBe("osc777");
  });
});

describe("buildOscSequences", () => {
  it("builds an OSC 9 sequence with the title prepended", () => {
    expect(
      buildOscSequences("osc9", {
        title: "Pi finished the task",
        body: "my-project",
        identifier: "pi-1",
      }),
    ).toEqual(["\x1b]9;Pi finished the task · my-project\x1b\\"]);
  });

  it("builds OSC 99 title and body sequences sharing one identifier", () => {
    const sequences = buildOscSequences("osc99", {
      title: "Pi finished the task",
      body: "my-project",
      identifier: "agent-completed-1",
    });
    expect(sequences).toEqual([
      "\x1b]99;i=agent-completed-1:p=title;Pi finished the task\x1b\\",
      "\x1b]99;i=agent-completed-1:p=body;my-project\x1b\\",
    ]);
  });

  it("builds an OSC 777 sequence with title and body", () => {
    expect(
      buildOscSequences("osc777", {
        title: "Pi finished the task",
        body: "my-project",
        identifier: "pi-1",
      }),
    ).toEqual(["\x1b]777;notify;Pi finished the task;my-project\x1b\\"]);
  });

  it("returns no sequences when there is nothing to show", () => {
    expect(
      buildOscSequences("osc9", { title: "", body: "", identifier: "x" }),
    ).toEqual([]);
  });
});

describe("sanitizeOscText", () => {
  it("strips controls, OSC separators and collapses whitespace", () => {
    expect(sanitizeOscText(" one;two\u001b]99;evil\nthree ")).toBe(
      "one:two ]99:evil three",
    );
  });

  it("limits text to 512 code points", () => {
    expect(Array.from(sanitizeOscText("x".repeat(600)))).toHaveLength(512);
  });
});

describe("emitOscSequences", () => {
  it("writes every sequence and reports failure", () => {
    const write = vi.fn();
    expect(emitOscSequences(["a", "b"], write)).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(
      emitOscSequences(["a"], () => {
        throw new Error("tty gone");
      }),
    ).toBe(false);
  });
});

describe("createOscSender", () => {
  it("writes a protocol sequence for the resolved terminal", () => {
    const write = vi.fn();
    const sender = createOscSender({
      ...BASE,
      termProgram: "WarpTerminal",
      write,
    });
    sender.send(event({ projectName: "p" }));
    expect(write).toHaveBeenCalledWith(
      "\x1b]777;notify;Pi finished the task;p\x1b\\",
    );
  });

  it("uses a unique identifier per osc99 notification", () => {
    const write = vi.fn();
    const sender = createOscSender({ ...BASE, termProgram: "vscode", write });
    sender.send(event({ projectName: "a" }));
    sender.send(event({ projectName: "b" }));
    const identifiers = write.mock.calls.map(
      ([sequence]) => /i=([^:]+):/.exec(sequence as string)?.[1],
    );
    expect(new Set(identifiers).size).toBe(2);
  });
});
