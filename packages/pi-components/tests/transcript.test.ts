import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  renderTranscriptLines,
  safeTerminalText,
  SessionTranscript,
  TranscriptViewport,
} from "../src/transcript.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

beforeEach(() => {
  initTheme();
});

describe("SessionTranscript", () => {
  it("normalizes streamed messages, tool results, and retry lifecycle events", () => {
    const transcript = new SessionTranscript({ maxToolResultChars: 20 });

    transcript.apply(event({ type: "turn_start" }));
    transcript.apply(
      event({
        type: "message_start",
        message: { role: "user", content: "Inspect the package" },
      }),
    );
    transcript.apply(
      event({
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "checking files" },
            { type: "text", text: "I will inspect the package." },
          ],
        },
        assistantMessageEvent: { type: "text_delta", delta: "" },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "package.json" },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_update",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "package.json" },
        partialResult: { content: [{ type: "text", text: "partial output" }] },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_end",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "package.json" },
        result: { content: [{ type: "text", text: "x".repeat(400) }] },
        isError: false,
      }),
    );
    transcript.apply(
      event({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "temporary provider failure",
      }),
    );
    transcript.apply(
      event({ type: "auto_retry_end", success: true, attempt: 1 }),
    );
    transcript.apply(
      event({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
      }),
    );
    transcript.apply(event({ type: "turn_end", message: {}, toolResults: [] }));

    const entries = transcript.snapshot();
    expect(
      entries.some(
        (entry) => entry.type === "thinking" && entry.text === "checking files",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) => entry.type === "assistant-text" && entry.text === "Done.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) => entry.type === "tool-call" && entry.toolName === "read",
      ),
    ).toBe(true);
    const result = entries.find((entry) => entry.type === "tool-result");
    expect(result?.type).toBe("tool-result");
    if (result?.type === "tool-result") expect(result.truncated).toBe(true);
    expect(entries.filter((entry) => entry.type === "notice")).toHaveLength(2);
    expect(entries.at(-1)).toMatchObject({
      type: "turn-boundary",
      phase: "end",
    });
  });

  it("bounds retained history without leaving stale tool indexes", () => {
    const transcript = new SessionTranscript({
      maxEntries: 16,
      maxChars: 1024,
    });
    for (let index = 0; index < 20; index++) {
      transcript.appendCompletedTurn({
        user: `question ${index}`,
        assistant: `answer ${index}`,
      });
    }

    expect(transcript.entries.length).toBeLessThanOrEqual(16);
    expect(
      transcript.entries.some(
        (entry) =>
          entry.type === "assistant-text" && entry.text === "answer 19",
      ),
    ).toBe(true);
  });
});

describe("transcript rendering", () => {
  it("renders assistant markdown, thinking, tool calls, results, and notices", () => {
    const transcript = new SessionTranscript();
    transcript.appendCompletedTurn({
      user: "Show the result",
      thinking: "I am checking the file",
      assistant: "The answer is **ready**.",
    });
    transcript.appendNotice("Retry succeeded.", "info");
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "printf ok" },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_end",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "printf ok" },
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      }),
    );

    const lines = renderTranscriptLines(transcript.entries, {
      width: 80,
      theme: theme as never,
      assistantLabel: "Auditor",
    });
    const rendered = lines.join("\n");
    expect(rendered).toContain("Auditor");
    expect(rendered).toContain("ready");
    expect(rendered).not.toContain("**ready**");
    expect(rendered).toContain("I am checking the file");
    expect(rendered).toContain("bash");
    expect(rendered).toContain("ok");
    expect(rendered).toContain("Retry succeeded.");
    // UserMessageComponent supplies the Pi-native message background. The
    // OSC 133 shell-integration zones must not leak into an embedded overlay.
    expect(rendered).toContain("\x1b[48;2;");
    expect(rendered).not.toContain("\x1b]133;");
  });

  it("uses Pi-native code highlighting for assistant transcript text", () => {
    const transcript = new SessionTranscript();
    transcript.appendCompletedTurn({
      user: "Show TypeScript",
      thinking: "Formatting a code sample.",
      assistant: "```ts\nconst answer = 42;\n```",
    });

    const rendered = renderTranscriptLines(transcript.entries, {
      width: 80,
      theme: theme as never,
    }).join("\n");
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("const answer = 42;");
    expect(rendered).toContain("\x1b[38;2;");
  });

  it("keeps tool activity between assistant message segments", () => {
    const transcript = new SessionTranscript();
    transcript.apply(event({ type: "turn_start" }));
    transcript.apply(
      event({
        type: "message_start",
        message: { role: "user", content: "Run the check" },
      }),
    );
    transcript.apply(
      event({
        type: "message_start",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "FIRST_THINKING" },
            { type: "text", text: "FIRST_ANSWER" },
          ],
        },
      }),
    );
    transcript.apply(
      event({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "FIRST_THINKING" },
            { type: "text", text: "FIRST_ANSWER" },
          ],
        },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "check-1",
        toolName: "bash",
        args: { command: "run-check" },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_end",
        toolCallId: "check-1",
        toolName: "bash",
        args: { command: "run-check" },
        result: { content: [{ type: "text", text: "CHECK_OUTPUT" }] },
        isError: false,
      }),
    );
    transcript.apply(
      event({
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "FINAL_ANSWER" }],
        },
      }),
    );
    transcript.apply(
      event({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "FINAL_ANSWER" }],
        },
      }),
    );
    transcript.apply(event({ type: "turn_end", message: {}, toolResults: [] }));

    const rendered = renderTranscriptLines(transcript.entries, {
      width: 100,
      theme: theme as never,
    }).join("\n");
    const firstAnswer = rendered.indexOf("FIRST_ANSWER");
    const toolCall = rendered.indexOf("run-check");
    const toolResult = rendered.indexOf("CHECK_OUTPUT");
    const finalAnswer = rendered.indexOf("FINAL_ANSWER");

    expect(firstAnswer).toBeGreaterThanOrEqual(0);
    expect(toolCall).toBeGreaterThan(firstAnswer);
    expect(toolResult).toBeGreaterThan(toolCall);
    expect(finalAnswer).toBeGreaterThan(toolResult);
  });

  it("keeps multiple assistant messages from the same turn", () => {
    const transcript = new SessionTranscript();
    transcript.apply(event({ type: "turn_start" }));
    for (const text of ["FIRST_MESSAGE", "SECOND_MESSAGE"]) {
      transcript.apply(
        event({
          type: "message_start",
          message: { role: "assistant", content: [{ type: "text", text }] },
        }),
      );
      transcript.apply(
        event({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text }] },
        }),
      );
    }
    transcript.apply(event({ type: "turn_end", message: {}, toolResults: [] }));

    const rendered = renderTranscriptLines(transcript.entries, {
      width: 100,
      theme: theme as never,
    }).join("\n");
    const firstMessage = rendered.indexOf("FIRST_MESSAGE");
    const secondMessage = rendered.indexOf("SECOND_MESSAGE");

    expect(firstMessage).toBeGreaterThanOrEqual(0);
    expect(secondMessage).toBeGreaterThan(firstMessage);
  });

  it("removes terminal control sequences from untrusted display text", () => {
    expect(safeTerminalText("safe\u001b]52;c;secret\u0007 text\u0001")).toBe(
      "safe text[U+0001]",
    );
  });
});

describe("TranscriptViewport", () => {
  it("follows new output and supports keyboard navigation", () => {
    const transcript = new SessionTranscript();
    for (let index = 0; index < 6; index++) {
      transcript.appendCompletedTurn({
        user: `question ${index}`,
        assistant: `answer ${index}\nsecond line`,
      });
    }
    const requestRender = vi.fn();
    const tui = { requestRender } as never;
    const viewport = new TranscriptViewport({
      tui,
      theme: theme as never,
      readEntries: () => transcript.entries,
    });

    const latest = viewport.render(60, 4);
    expect(latest.following).toBe(true);
    expect(latest.hiddenBelow).toBe(0);
    expect(latest.hiddenAbove).toBeGreaterThan(0);

    expect(viewport.handleInput("\x1b[H")).toBe(true);
    const first = viewport.render(60, 4);
    expect(first.hiddenAbove).toBe(0);
    expect(first.hiddenBelow).toBeGreaterThan(0);

    expect(viewport.handleInput("\x1b[F")).toBe(true);
    expect(viewport.render(60, 4).following).toBe(true);
    expect(requestRender).toHaveBeenCalled();
  });

  it("scrolls for SGR mouse-wheel events after the host enables reporting", () => {
    const transcript = new SessionTranscript();
    transcript.appendCompletedTurn({
      user: "review",
      assistant: Array.from(
        { length: 20 },
        (_value, index) => `line ${index + 1}`,
      ).join("\n"),
    });
    const requestRender = vi.fn();
    const viewport = new TranscriptViewport({
      tui: { requestRender } as never,
      theme: theme as never,
      readEntries: () => transcript.entries,
    });

    const latest = viewport.render(60, 4);
    expect(latest.following).toBe(true);
    expect(viewport.handleInput("\x1b[<64;1;1M")).toBe(true);

    const scrolled = viewport.render(60, 4);
    expect(scrolled.following).toBe(false);
    expect(scrolled.hiddenBelow).toBeGreaterThan(0);
    expect(requestRender).toHaveBeenCalled();
  });
});
