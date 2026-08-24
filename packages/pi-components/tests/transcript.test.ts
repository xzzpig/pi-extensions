import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  appendEntry,
  createTranscriptState,
  ensureToolCall,
  ensureTranscriptTheme,
  ensureTurn,
  finishTurn,
  removeTranscriptTurn,
  renderTranscriptLines,
  safeTerminalText,
  SessionTranscript,
  TranscriptToolComponents,
  TranscriptViewport,
  TruncatedToolArgs,
  upsertText,
  upsertToolResult,
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

describe("ensureTranscriptTheme", () => {
  it("never clobbers an already-initialized host theme", () => {
    const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
    const globals = globalThis as unknown as Record<PropertyKey, unknown>;
    const sentinel = { name: "host-light-theme" };
    const original = globals[key];
    try {
      globals[key] = sentinel;
      ensureTranscriptTheme();
      ensureTranscriptTheme(); // idempotent
      expect(globals[key]).toBe(sentinel);
    } finally {
      globals[key] = original;
    }
  });
});

describe("SessionTranscript", () => {
  it("normalizes streamed messages, tool results, and retry lifecycle events", () => {
    const transcript = new SessionTranscript();

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
    const call = entries.find((entry) => entry.type === "tool-call");
    if (call?.type === "tool-call") {
      expect(call.args).toEqual({ path: "package.json" });
    }
    const result = entries.find((entry) => entry.type === "tool-result");
    expect(result?.type).toBe("tool-result");
    if (result?.type === "tool-result") {
      // Raw structured payloads are preserved verbatim for native renderers.
      expect(result.result).toEqual({
        content: [{ type: "text", text: "x".repeat(400) }],
      });
      expect(result.isError).toBe(false);
      expect(result.streaming).toBe(false);
    }
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

  it("deep-copies structured tool data in snapshots", () => {
    const transcript = new SessionTranscript();
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: { path: "a.ts", oldText: "a", newText: "b" },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "done" }],
          details: { diff: ["-a", "+b"] },
        },
        isError: false,
      }),
    );

    const snapshot = transcript.snapshot();
    const snapCall = snapshot.find((entry) => entry.type === "tool-call");
    const snapResult = snapshot.find((entry) => entry.type === "tool-result");
    if (
      snapCall?.type === "tool-call" &&
      snapCall.args !== null &&
      typeof snapCall.args === "object"
    ) {
      (snapCall.args as { path?: string }).path = "mutated";
    }
    if (snapResult?.type === "tool-result") {
      if (snapResult.result) snapResult.result.details = "mutated";
    }

    const liveCall = transcript.entries.find(
      (entry) => entry.type === "tool-call",
    );
    const liveResult = transcript.entries.find(
      (entry) => entry.type === "tool-result",
    );
    expect(liveCall).toMatchObject({ args: { path: "a.ts" } });
    expect(liveResult).toMatchObject({
      result: { details: { diff: ["-a", "+b"] } },
    });
  });
});

describe("native tool components", () => {
  it("keeps one persistent component per tool call and prunes it with entries", () => {
    const transcript = new SessionTranscript();
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "echo hi" },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_update",
        toolCallId: "bash-1",
        partialResult: { content: [{ type: "text", text: "partial" }] },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_end",
        toolCallId: "bash-1",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      }),
    );

    const component = transcript.toolComponents.get("bash-1");
    expect(component).toBeDefined();
    // Streaming updates mutate the same instance instead of recreating it.
    expect(transcript.toolComponents.get("bash-1")).toBe(component);

    transcript.clear();
    expect(transcript.toolComponents.get("bash-1")).toBeUndefined();
  });

  it("backfills arguments when a result arrives before its start event", () => {
    const transcript = new SessionTranscript();
    transcript.apply(
      event({
        type: "tool_execution_end",
        // Unknown tool name exercises Pi's generic fallback renderer, which
        // prints both the raw args JSON and the text output verbatim.
        toolCallId: "late-1",
        toolName: "sidecar",
        result: { content: [{ type: "text", text: "contents" }] },
        isError: false,
      }),
    );
    expect(transcript.toolComponents.get("late-1")).toBeDefined();

    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "late-1",
        toolName: "read",
        args: { path: "README.md" },
      }),
    );
    const rendered = renderTranscriptLines(transcript.entries, {
      width: 80,
      theme: theme as never,
      toolComponents: transcript.toolComponents,
    }).join("\n");
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("README.md");
    expect(plain).toContain("contents");
  });

  it("forwards repaint requests to a TUI attached after creation", () => {
    const transcript = new SessionTranscript();
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "bash-live",
        toolName: "bash",
        args: { command: "sleep 5" },
      }),
    );

    // No TUI attached yet: events apply without crashing, nothing to notify.
    expect(transcript.toolComponents.get("bash-live")).toBeDefined();

    const requestRender = vi.fn();
    (transcript.toolComponents as TranscriptToolComponents).attachTui({
      requestRender,
    });

    // Streaming bash output relies on these repaint signals reaching the
    // host TUI while the tool is still running.
    transcript.apply(
      event({
        type: "tool_execution_update",
        toolCallId: "bash-live",
        partialResult: { content: [{ type: "text", text: "partial" }] },
      }),
    );
    transcript.apply(
      event({
        type: "tool_execution_end",
        toolCallId: "bash-live",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      }),
    );
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("drops components when their turn is removed or entries are trimmed", () => {
    const transcript = new SessionTranscript({ maxEntries: 8 });
    transcript.apply(event({ type: "turn_start" }));
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "trim-1",
        toolName: "bash",
        args: { command: "true" },
      }),
    );
    expect(transcript.toolComponents.get("trim-1")).toBeDefined();

    transcript.removeCurrentTurn();
    expect(transcript.toolComponents.get("trim-1")).toBeUndefined();

    transcript.apply(event({ type: "turn_start" }));
    transcript.apply(
      event({
        type: "tool_execution_start",
        toolCallId: "trim-2",
        toolName: "bash",
        args: { command: "true" },
      }),
    );
    for (let index = 0; index < 12; index++) {
      transcript.appendCompletedTurn({ assistant: `filler ${index}` });
    }
    expect(transcript.entries.some((e) => e.type === "tool-call")).toBe(false);
    expect(transcript.toolComponents.get("trim-2")).toBeUndefined();
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
    // Native bash renderer shows the command line, not the tool name.
    expect(rendered).toContain("printf ok");
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

describe("historical record ingestion (builder API)", () => {
  it("replays a completed exchange with turn boundaries and cleared streaming flags", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    appendEntry(state, { type: "user-message", turnId, text: "please fix" });
    upsertText(state, turnId, "assistant-text", "done", true);
    finishTurn(state, turnId);

    const kinds = state.entries.map((entry) => entry.type);
    expect(kinds).toContain("user-message");
    expect(
      state.entries.filter((entry) => entry.type === "turn-boundary"),
    ).toHaveLength(2);
    const assistant = state.entries.find(
      (entry) => entry.type === "assistant-text",
    );
    expect(assistant?.streaming).toBe(false);
    expect(state.currentTurnId).toBeNull();

    // Idempotent finish: no duplicate end boundary, ids stay unique.
    finishTurn(state, turnId);
    expect(
      state.entries.filter((entry) => entry.type === "turn-boundary"),
    ).toHaveLength(2);
    expect(new Set(state.entries.map((entry) => entry.id)).size).toBe(
      state.entries.length,
    );
  });

  it("pairs tool results with calls in either arrival order and backfills arguments", () => {
    // Result after call.
    const replay = createTranscriptState();
    const turnId = ensureTurn(replay);
    const record = ensureToolCall(replay, turnId, "call-1", "bash", {
      command: "ls",
    });
    upsertToolResult(
      replay,
      turnId,
      "call-1",
      "bash",
      { content: [{ type: "text", text: "out" }] },
      false,
      false,
    );
    expect(record.resultEntryId).toBeDefined();
    const result = replay.entries.find(
      (entry) => entry.id === record.resultEntryId,
    );
    expect(result?.type).toBe("tool-result");

    // Result before call: placeholder gets arguments backfilled later.
    const reversed = createTranscriptState();
    const lateTurn = ensureTurn(reversed);
    upsertToolResult(
      reversed,
      lateTurn,
      "call-2",
      "read",
      { content: [{ type: "text", text: "body" }] },
      false,
      false,
    );
    ensureToolCall(reversed, lateTurn, "call-2", "read", { path: "a.ts" });
    const paired = reversed.toolCalls.get("call-2");
    expect(paired?.resultEntryId).toBeDefined();
    const callEntry = reversed.entries.find(
      (entry) => entry.id === paired?.callEntryId,
    );
    expect(
      callEntry?.type === "tool-call" &&
        (callEntry.args as { path?: string })?.path,
    ).toBe("a.ts");
    expect(
      reversed.entries.filter((entry) => entry.type === "tool-call"),
    ).toHaveLength(1);
  });

  it("degrades oversized and unserializable arguments instead of throwing", () => {
    const state = createTranscriptState({ maxToolArgsChars: 64 });
    const turnId = ensureTurn(state);

    ensureToolCall(state, turnId, "big-1", "write", {
      content: "x".repeat(5000),
    });
    const bigCall = state.entries.find((entry) => entry.type === "tool-call");
    const stored =
      bigCall?.type === "tool-call"
        ? (bigCall.args as TruncatedToolArgs)
        : undefined;
    expect(stored?.truncated).toBe(true);
    expect(stored?.originalChars).toBeGreaterThan(64);
    expect(stored?.preview.length).toBeLessThanOrEqual(64);

    // Rendering still succeeds with the degraded marker stored.
    const lines = renderTranscriptLines(state.entries, {
      width: 80,
      theme: theme as never,
    });
    expect(lines.join("\n")).toContain("write");

    // Circular (unserializable) arguments must not throw either.
    const hostile: Record<string, unknown> = {};
    hostile.self = hostile;
    expect(() =>
      ensureToolCall(state, turnId, "loop-1", "bash", hostile),
    ).not.toThrow();
    const loopCall = state.entries.find(
      (entry) => entry.type === "tool-call" && entry.toolCallId === "loop-1",
    );
    expect(
      loopCall?.type === "tool-call" &&
        (loopCall.args as TruncatedToolArgs)?.truncated,
    ).toBe(true);
  });

  it("prunes tool components when their turn is removed from replayed records", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    ensureToolCall(state, turnId, "gone-1", "bash", { command: "echo" });
    state.toolComponents.handleStart("gone-1", "bash", { command: "echo" });
    expect(state.toolComponents.has("gone-1")).toBe(true);

    removeTranscriptTurn(state, turnId);
    expect(state.toolComponents.has("gone-1")).toBe(false);
    expect(state.toolCalls.has("gone-1")).toBe(false);
    expect(
      state.entries.filter((entry) => entry.turnId === turnId),
    ).toHaveLength(0);
  });
});
