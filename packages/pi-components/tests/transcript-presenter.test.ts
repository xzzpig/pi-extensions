import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  appendAssistantMessage,
  appendEntry,
  applyAgentSessionEvent,
  createTranscriptState,
  ensureToolCall,
  ensureTurn,
  finishTurn,
  removeTranscriptTurn,
  upsertText,
  upsertToolResult,
  type TranscriptState,
} from "../src/transcript.ts";
import { TranscriptPresenter } from "../src/transcript-presenter.ts";
// Test-only cross-package import: pi-components does not depend on the
// collapse plugin at runtime. Loading its real controller exercises the patch
// the presenter must coexist with, without adding a package dependency.
import {
  COLLAPSED_AFFORDANCE_LABEL,
  CollapseController,
} from "../../pi-thinking-collapse/src/state.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

const COLLAPSED_LABEL = "Thinking (collapsed)";

function plain(lines: readonly string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).join("\n");
}

function clickAt(y: number, width: number): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 1,
    y,
    screenX: 1,
    screenY: y,
    width,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}

function messageEvent(
  type: "message_start" | "message_update" | "message_end",
  content: Array<Record<string, unknown>>,
): unknown {
  return { type, message: { role: "assistant", content } };
}

function completedAssistant(
  state: TranscriptState,
  turnId: number,
  thinking: string,
  text: string,
): void {
  appendAssistantMessage(state, turnId, { thinking, text });
}

class FakeToolComponent implements Component {
  output: string[];
  lastMouse: TuiMouseEvent | undefined;
  invalidations = 0;

  constructor(output: string[]) {
    this.output = output;
  }

  render(_width: number): string[] {
    return this.output;
  }

  invalidate(): void {
    this.invalidations++;
  }

  handleMouse(event: TuiMouseEvent): { handled: boolean } {
    this.lastMouse = event;
    return { handled: true };
  }
}

beforeEach(() => {
  initTheme();
});

describe("TranscriptPresenter without thinking-collapse", () => {
  it("renders the empty state and an optional empty text", () => {
    const presenter = new TranscriptPresenter({
      theme,
      emptyText: "Nothing here yet.",
    });
    presenter.sync([]);
    const frame = presenter.render(40);
    expect(plain(frame.lines)).toContain("Nothing here yet.");
    expect(frame.rows).toEqual([]);
    expect(presenter.componentCount).toBe(0);
  });

  it("passes the real streaming flag and separates messages around tools", () => {
    const state = createTranscriptState();
    applyAgentSessionEvent(state, { type: "turn_start" });
    applyAgentSessionEvent(state, {
      type: "message_start",
      message: { role: "user", content: "run the check" },
    });
    applyAgentSessionEvent(
      state,
      messageEvent("message_start", [
        { type: "thinking", thinking: "FIRST_THINK" },
        { type: "text", text: "FIRST_ANSWER" },
      ]),
    );
    applyAgentSessionEvent(
      state,
      messageEvent("message_end", [
        { type: "thinking", thinking: "FIRST_THINK" },
        { type: "text", text: "FIRST_ANSWER" },
      ]),
    );
    applyAgentSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "check-1",
      toolName: "sidecar",
      args: { command: "run-check" },
    });
    applyAgentSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "check-1",
      toolName: "sidecar",
      result: { content: [{ type: "text", text: "TOOL_OUTPUT" }] },
      isError: false,
    });
    applyAgentSessionEvent(
      state,
      messageEvent("message_start", [{ type: "text", text: "SECOND_ANSWER" }]),
    );
    applyAgentSessionEvent(
      state,
      messageEvent("message_end", [{ type: "text", text: "SECOND_ANSWER" }]),
    );
    applyAgentSessionEvent(state, {
      type: "turn_end",
      message: {},
      toolResults: [],
    });

    const presenter = new TranscriptPresenter({ theme });
    presenter.sync(state.entries);
    const frame = presenter.render(100);
    const userRows = frame.rows.filter((row) => row.kind === "user");
    const assistantRows = frame.rows.filter((row) => row.kind === "assistant");
    const toolRows = frame.rows.filter((row) => row.kind === "tool");
    expect(userRows).toHaveLength(1);
    expect(assistantRows).toHaveLength(2);
    expect(toolRows).toHaveLength(1);
    expect(assistantRows[0].segmentId).not.toBe(assistantRows[1].segmentId);
    // Row ranges address the component output in full-transcript coordinates.
    expect(
      plain(
        frame.lines.slice(
          assistantRows[0].top,
          assistantRows[0].top + assistantRows[0].height,
        ),
      ),
    ).toContain("FIRST_ANSWER");
    expect(
      plain(
        frame.lines.slice(
          assistantRows[1].top,
          assistantRows[1].top + assistantRows[1].height,
        ),
      ),
    ).toContain("SECOND_ANSWER");

    const rendered = plain(frame.lines);
    // Pi's shell-integration zone markers are stripped for embedded overlays.
    expect(frame.lines.join("\n")).not.toContain(
      `${String.fromCharCode(27)}]133;`,
    );
    const firstAnswer = rendered.indexOf("FIRST_ANSWER");
    const toolOutput = rendered.indexOf("TOOL_OUTPUT");
    const secondAnswer = rendered.indexOf("SECOND_ANSWER");
    expect(firstAnswer).toBeGreaterThanOrEqual(0);
    expect(toolOutput).toBeGreaterThan(firstAnswer);
    expect(secondAnswer).toBeGreaterThan(toolOutput);
  });

  it("keeps one component per replayed assistant message", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    appendEntry(state, {
      type: "user-message",
      turnId,
      text: "replay the thread",
    });
    completedAssistant(state, turnId, "REPLAY_THINK_1", "REPLAY_ANSWER_1");
    ensureToolCall(state, turnId, "call-replay", "sidecar", {
      command: "echo replay",
    });
    upsertToolResult(
      state,
      turnId,
      "call-replay",
      "sidecar",
      { content: [{ type: "text", text: "REPLAY_TOOL_OUTPUT" }] },
      false,
      false,
    );
    completedAssistant(state, turnId, "REPLAY_THINK_2", "REPLAY_ANSWER_2");
    finishTurn(state, turnId);

    const presenter = new TranscriptPresenter({ theme });
    presenter.sync(state.entries);
    const frame = presenter.render(100);
    const assistantRows = frame.rows.filter((row) => row.kind === "assistant");
    expect(assistantRows).toHaveLength(2);
    const rendered = plain(frame.lines);
    expect(rendered).toContain("REPLAY_THINK_1");
    expect(rendered).toContain("REPLAY_THINK_2");
    expect(rendered.indexOf("REPLAY_ANSWER_1")).toBeLessThan(
      rendered.indexOf("REPLAY_TOOL_OUTPUT"),
    );
    expect(rendered.indexOf("REPLAY_TOOL_OUTPUT")).toBeLessThan(
      rendered.indexOf("REPLAY_ANSWER_2"),
    );
  });

  it("constructs assistant components empty and sends streaming on first content", () => {
    const state = createTranscriptState();
    ensureTurn(state);
    applyAgentSessionEvent(
      state,
      messageEvent("message_start", [
        { type: "thinking", thinking: "FIRST_STREAM" },
      ]),
    );
    const updateSpy = vi.spyOn(
      AssistantMessageComponent.prototype,
      "updateContent",
    );
    try {
      const presenter = new TranscriptPresenter({ theme });
      // The component must be constructed empty: no content is rendered as
      // completed before the presenter knows the real streaming state.
      expect(updateSpy).not.toHaveBeenCalled();

      presenter.sync(state.entries);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0][1]).toBe(true);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("treats a finished turn boundary as the end of streaming", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    // A replayed/hand-built record can leave the entry flag set; the finished
    // turn boundary is authoritative for the presenter's streaming state.
    upsertText(state, turnId, "thinking", "STALE_STREAM", true);
    appendEntry(state, { type: "turn-boundary", turnId, phase: "end" });

    const presenter = new TranscriptPresenter({ theme });
    const updateSpy = vi.spyOn(
      AssistantMessageComponent.prototype,
      "updateContent",
    );
    try {
      presenter.sync(state.entries);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0][1]).toBe(false);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("updates content once and leaves it alone on resize and unchanged sync", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    appendEntry(state, { type: "user-message", turnId, text: "QUESTION" });
    completedAssistant(state, turnId, "THINK", "ANSWER");

    const presenter = new TranscriptPresenter({ theme });
    const updateSpy = vi.spyOn(
      AssistantMessageComponent.prototype,
      "updateContent",
    );
    try {
      presenter.sync(state.entries);
      presenter.render(80);
      const callsAfterFirstFrame = updateSpy.mock.calls.length;
      expect(callsAfterFirstFrame).toBeGreaterThan(0);
      const revisionAfterFirstSync = presenter.revision;

      presenter.sync(state.entries);
      expect(presenter.revision).toBe(revisionAfterFirstSync);
      presenter.render(120);
      expect(updateSpy.mock.calls.length).toBe(callsAfterFirstFrame);
      // A width change is a display change, not a content re-assignment.
      expect(presenter.revision).toBeGreaterThan(revisionAfterFirstSync);

      const revisionBeforeContentChange = presenter.revision;
      upsertText(state, turnId, "assistant-text", "UPDATED_ANSWER", false);
      presenter.sync(state.entries);
      expect(presenter.revision).toBeGreaterThan(revisionBeforeContentChange);
      expect(updateSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstFrame);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("re-renders when a component requests a repaint without entry changes", () => {
    const state = createTranscriptState();
    applyAgentSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "repaint-1",
      toolName: "sidecar",
      args: { command: "slow" },
    });
    const toolComponent = new FakeToolComponent(["FIRST_OUTPUT"]);
    const presenter = new TranscriptPresenter({
      theme,
      toolComponents: {
        get: (toolCallId) =>
          toolCallId === "repaint-1"
            ? (toolComponent as unknown as never)
            : undefined,
      },
    });
    presenter.sync(state.entries);
    const first = presenter.render(60);
    expect(plain(first.lines)).toContain("FIRST_OUTPUT");

    // A renderer repaint (timer, streaming child) changes no entry, so the
    // revision must invalidate the presenter's line cache explicitly.
    toolComponent.output = ["SECOND_OUTPUT"];
    presenter.requestRender();
    expect(presenter.revision).toBeGreaterThan(first.revision);
    const second = presenter.render(60);
    expect(plain(second.lines)).toContain("SECOND_OUTPUT");
    expect(second.revision).toBeGreaterThan(first.revision);
  });

  it("keeps rich tool output verbatim and routes normalized mouse events", () => {
    const state = createTranscriptState();
    applyAgentSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "sidecar",
      args: { command: "diff" },
    });
    const longLine = `diff -- ${"x".repeat(200)}`;
    const toolComponent = new FakeToolComponent([longLine]);
    const presenter = new TranscriptPresenter({
      theme,
      toolComponents: {
        get: (toolCallId) =>
          toolCallId === "tool-1"
            ? (toolComponent as unknown as never)
            : undefined,
      },
    });
    presenter.sync(state.entries);
    const frame = presenter.render(40);
    const toolRow = frame.rows.find((row) => row.kind === "tool");
    expect(toolRow).toBeDefined();
    if (!toolRow) return;
    // Rich tool output owns its geometry: no re-wrapping or truncation.
    expect(frame.lines[toolRow.top]).toBe(longLine);
    expect(toolRow.height).toBe(1);

    expect(presenter.handleMouse(clickAt(toolRow.top, 40))).toBe(true);
    expect(toolComponent.lastMouse?.y).toBe(0);
    expect(toolComponent.lastMouse?.height).toBe(1);
    expect(toolComponent.lastMouse?.width).toBe(40);
    expect(presenter.handleMouse(clickAt(999, 40))).toBe(false);
  });

  it("invalidates theme-driven output without resetting the host theme", () => {
    let themeVersion = "v1";
    const mutableTheme = {
      fg: (name: string, text: string) => `${themeVersion}:${name}:${text}`,
      bg: (_name: string, text: string) => `${themeVersion}:${text}`,
      bold: (text: string) => text,
    };
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    completedAssistant(state, turnId, "THEME_THINK", "THEME_ANSWER");

    const presenter = new TranscriptPresenter({ theme: mutableTheme });
    presenter.sync(state.entries);
    const first = presenter.render(80);
    expect(plain(first.lines)).toContain("v1:");
    const revisionBefore = presenter.revision;

    themeVersion = "v2";
    presenter.invalidate();
    expect(presenter.revision).toBeGreaterThan(revisionBefore);
    const second = presenter.render(80);
    expect(plain(second.lines)).toContain("v2:");
    expect(plain(second.lines)).not.toContain("v1:");
  });

  it("unified thinking toggle resets per-block overrides and covers new blocks", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    completedAssistant(state, turnId, "TOGGLE_THINK", "TOGGLE_ANSWER");

    const presenter = new TranscriptPresenter({
      theme,
      thinkingLabel: COLLAPSED_LABEL,
    });
    presenter.sync(state.entries);
    let frame = presenter.render(80);
    expect(plain(frame.lines)).toContain("TOGGLE_THINK");

    expect(presenter.toggleThinkingVisibility()).toBe(false);
    frame = presenter.render(80);
    expect(plain(frame.lines)).not.toContain("TOGGLE_THINK");
    expect(presenter.toggleThinkingVisibility()).toBe(true);
    frame = presenter.render(80);
    expect(plain(frame.lines)).toContain("TOGGLE_THINK");

    // Native per-block click hides this one thinking block.
    const thinkLine = frame.lines.findIndex((line) =>
      stripTerminalSequences(line).includes("TOGGLE_THINK"),
    );
    expect(thinkLine).toBeGreaterThanOrEqual(0);
    expect(presenter.handleMouse(clickAt(thinkLine, 80))).toBe(true);
    frame = presenter.render(80);
    expect(plain(frame.lines)).not.toContain("TOGGLE_THINK");
    expect(plain(frame.lines)).toContain(COLLAPSED_LABEL);

    // The unified toggle clears that override again.
    presenter.setThinkingVisible(true);
    frame = presenter.render(80);
    expect(plain(frame.lines)).toContain("TOGGLE_THINK");

    presenter.setThinkingVisible(false);
    frame = presenter.render(80);
    expect(plain(frame.lines)).not.toContain("TOGGLE_THINK");

    // Blocks created after the local choice inherit it.
    completedAssistant(state, turnId, "NEW_THINK", "NEW_ANSWER");
    presenter.sync(state.entries);
    frame = presenter.render(80);
    expect(plain(frame.lines)).not.toContain("NEW_THINK");
    expect(presenter.thinkingVisible).toBe(false);

    presenter.setThinkingVisible(true);
    frame = presenter.render(80);
    expect(plain(frame.lines)).toContain("TOGGLE_THINK");
    expect(plain(frame.lines)).toContain("NEW_THINK");
  });

  it("prunes, clears, and disposes retained components and TUI wiring", () => {
    const requestRender = vi.fn();
    const presenter = new TranscriptPresenter({ theme });
    presenter.attachTui({ requestRender });

    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    appendEntry(state, { type: "user-message", turnId, text: "FIRST" });
    completedAssistant(state, turnId, "FIRST_THINK", "FIRST_ANSWER");
    presenter.sync(state.entries);
    presenter.render(80);
    expect(presenter.componentCount).toBe(2);
    expect(requestRender).toHaveBeenCalled();

    removeTranscriptTurn(state, turnId);
    presenter.sync(state.entries);
    presenter.render(80);
    expect(presenter.componentCount).toBe(0);

    const callsBeforeDetach = requestRender.mock.calls.length;
    presenter.detachTui();
    const nextTurn = ensureTurn(state);
    appendEntry(state, {
      type: "user-message",
      turnId: nextTurn,
      text: "SECOND",
    });
    completedAssistant(state, nextTurn, "SECOND_THINK", "SECOND_ANSWER");
    presenter.sync(state.entries);
    presenter.render(80);
    expect(presenter.componentCount).toBe(2);
    expect(requestRender.mock.calls.length).toBe(callsBeforeDetach);

    presenter.clear();
    expect(presenter.componentCount).toBe(0);
    expect(plain(presenter.render(80).lines)).toContain("No transcript yet.");

    presenter.attachTui({ requestRender });
    presenter.dispose();
    expect(presenter.componentCount).toBe(0);
    expect(presenter.render(80).lines).toEqual([]);
    expect(presenter.handleMouse(clickAt(0, 80))).toBe(false);
    const callsBeforeDisposeRequest = requestRender.mock.calls.length;
    presenter.requestRender();
    expect(requestRender.mock.calls.length).toBe(callsBeforeDisposeRequest);
  });
});

describe("TranscriptPresenter with thinking-collapse", () => {
  let controller: CollapseController;

  beforeAll(() => {
    controller = new CollapseController();
    controller.install();
  });

  afterAll(() => {
    controller.dispose();
  });

  it("keeps streaming thinking visible and collapses it on completion", () => {
    const state = createTranscriptState();
    ensureTurn(state);
    applyAgentSessionEvent(
      state,
      messageEvent("message_start", [
        { type: "thinking", thinking: "STREAM_THINK" },
      ]),
    );
    const presenter = new TranscriptPresenter({
      theme,
      thinkingLabel: COLLAPSED_LABEL,
    });
    presenter.sync(state.entries);
    let frame = presenter.render(80);
    expect(plain(frame.lines)).toContain("STREAM_THINK");

    applyAgentSessionEvent(
      state,
      messageEvent("message_end", [
        { type: "thinking", thinking: "STREAM_THINK" },
        { type: "text", text: "STREAM_DONE" },
      ]),
    );
    presenter.sync(state.entries);
    frame = presenter.render(80);
    const rendered = plain(frame.lines);
    expect(rendered).not.toContain("STREAM_THINK");
    expect(rendered).toContain(COLLAPSED_LABEL);
    expect(rendered).toContain("STREAM_DONE");
  });

  it("keeps the collapse affordance when thinkingLabel is omitted", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    completedAssistant(
      state,
      turnId,
      "DEFAULT_LABEL_THINK",
      "DEFAULT_LABEL_ANSWER",
    );
    const presenter = new TranscriptPresenter({ theme });
    presenter.sync(state.entries);
    const rendered = plain(presenter.render(80).lines);
    expect(rendered).not.toContain("DEFAULT_LABEL_THINK");
    expect(rendered).toContain(COLLAPSED_AFFORDANCE_LABEL);
  });

  it("ends streaming for completed, aborted, and failed turns", () => {
    for (const outcome of ["completed", "aborted", "failed"] as const) {
      const state = createTranscriptState();
      const turnId = ensureTurn(state);
      applyAgentSessionEvent(
        state,
        messageEvent("message_start", [
          { type: "thinking", thinking: `THINK_${outcome}` },
          { type: "text", text: `ANSWER_${outcome}` },
        ]),
      );
      const presenter = new TranscriptPresenter({
        theme,
        thinkingLabel: COLLAPSED_LABEL,
      });
      presenter.sync(state.entries);
      expect(plain(presenter.render(80).lines)).toContain(`THINK_${outcome}`);

      finishTurn(state, turnId, outcome);
      presenter.sync(state.entries);
      const rendered = plain(presenter.render(80).lines);
      expect(rendered).not.toContain(`THINK_${outcome}`);
      expect(rendered).toContain(COLLAPSED_LABEL);
    }
  });

  it("expands only the clicked block and keeps that choice across updates and resize", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    completedAssistant(state, turnId, "THINK_ONE", "ANSWER_ONE");
    completedAssistant(state, turnId, "THINK_TWO", "ANSWER_TWO");

    const presenter = new TranscriptPresenter({
      theme,
      thinkingLabel: COLLAPSED_LABEL,
    });
    presenter.sync(state.entries);
    let frame = presenter.render(80);
    let rendered = plain(frame.lines);
    expect(rendered).not.toContain("THINK_ONE");
    expect(rendered).not.toContain("THINK_TWO");

    const collapsedLines = frame.lines
      .map((line, index) => ({ line: stripTerminalSequences(line), index }))
      .filter((entry) => entry.line.includes(COLLAPSED_LABEL));
    expect(collapsedLines).toHaveLength(2);
    expect(presenter.handleMouse(clickAt(collapsedLines[1].index, 80))).toBe(
      true,
    );

    frame = presenter.render(80);
    rendered = plain(frame.lines);
    expect(rendered).toContain("THINK_TWO");
    expect(rendered).not.toContain("THINK_ONE");

    // Updating the same message keeps the native per-block override.
    upsertText(state, turnId, "assistant-text", "ANSWER_TWO_UPDATED", false);
    presenter.sync(state.entries);
    frame = presenter.render(100);
    rendered = plain(frame.lines);
    expect(rendered).toContain("THINK_TWO");
    expect(rendered).toContain("ANSWER_TWO_UPDATED");

    // Resizing must not reset the expanded choice either.
    frame = presenter.render(120);
    expect(plain(frame.lines)).toContain("THINK_TWO");

    // In auto mode a per-block click is not a unified preference: a new block
    // still follows the host patch and starts collapsed.
    completedAssistant(state, turnId, "THINK_THREE", "ANSWER_THREE");
    presenter.sync(state.entries);
    rendered = plain(presenter.render(120).lines);
    expect(rendered).toContain("THINK_TWO");
    expect(rendered).not.toContain("THINK_THREE");
  });

  it("unified toggle still hides every retained thinking block", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    completedAssistant(state, turnId, "HIDE_THINK_ONE", "HIDE_ANSWER_ONE");
    completedAssistant(state, turnId, "HIDE_THINK_TWO", "HIDE_ANSWER_TWO");
    const presenter = new TranscriptPresenter({
      theme,
      thinkingLabel: COLLAPSED_LABEL,
    });
    presenter.sync(state.entries);
    expect(plain(presenter.render(80).lines)).not.toContain("HIDE_THINK_ONE");

    presenter.setThinkingVisible(false);
    const rendered = plain(presenter.render(80).lines);
    expect(rendered).not.toContain("HIDE_THINK_ONE");
    expect(rendered).not.toContain("HIDE_THINK_TWO");
    expect(rendered).toContain(COLLAPSED_LABEL);
  });

  it("unified expand sets native overrides for completed blocks and covers new blocks", () => {
    const state = createTranscriptState();
    const turnId = ensureTurn(state);
    completedAssistant(state, turnId, "THINK_ONE", "ANSWER_ONE");
    completedAssistant(state, turnId, "THINK_TWO", "ANSWER_TWO");

    // A component outside the presenter represents the main session. Presenter
    // toggles must not touch its state.
    const mainComponent = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      COLLAPSED_LABEL,
      1,
    );
    mainComponent.updateContent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "MAIN_THINK" },
          { type: "text", text: "MAIN_ANSWER" },
        ],
      } as never,
      false,
    );
    const mainRendered = plain(mainComponent.render(80));
    expect(mainRendered).not.toContain("MAIN_THINK");

    const presenter = new TranscriptPresenter({
      theme,
      thinkingLabel: COLLAPSED_LABEL,
    });
    presenter.sync(state.entries);
    let rendered = plain(presenter.render(80).lines);
    expect(rendered).not.toContain("THINK_ONE");
    expect(rendered).not.toContain("THINK_TWO");

    // The unified toggle clears overrides, forces a known collapsed state, and
    // then uses the native MouseRegion click path to expand completed blocks.
    presenter.setThinkingVisible(true);
    rendered = plain(presenter.render(80).lines);
    expect(rendered).toContain("THINK_ONE");
    expect(rendered).toContain("THINK_TWO");

    // A block added after the local choice inherits the visible preference.
    completedAssistant(state, turnId, "THINK_THREE", "ANSWER_THREE");
    presenter.sync(state.entries);
    rendered = plain(presenter.render(80).lines);
    expect(rendered).toContain("THINK_THREE");

    // A new streaming message also inherits the visible preference and stays
    // expanded when the host patch would normally collapse it on completion.
    applyAgentSessionEvent(
      state,
      messageEvent("message_start", [
        { type: "thinking", thinking: "THINK_STREAM" },
      ]),
    );
    presenter.sync(state.entries);
    expect(plain(presenter.render(80).lines)).toContain("THINK_STREAM");
    applyAgentSessionEvent(
      state,
      messageEvent("message_end", [
        { type: "thinking", thinking: "THINK_STREAM" },
        { type: "text", text: "STREAM_ANSWER" },
      ]),
    );
    presenter.sync(state.entries);
    rendered = plain(presenter.render(80).lines);
    expect(rendered).toContain("THINK_STREAM");
    expect(rendered).toContain("STREAM_ANSWER");

    // Content updates, theme invalidation, and resizing keep the overrides.
    upsertText(state, turnId, "assistant-text", "ANSWER_TWO_UPDATED", false);
    presenter.sync(state.entries);
    expect(plain(presenter.render(100).lines)).toContain("THINK_TWO");
    presenter.invalidate();
    expect(plain(presenter.render(100).lines)).toContain("THINK_TWO");
    expect(plain(presenter.render(120).lines)).toContain("THINK_TWO");

    // A later native per-block click still toggles only that block.
    let frame = presenter.render(120);
    const thinkOneLine = frame.lines.findIndex((line) =>
      stripTerminalSequences(line).includes("THINK_ONE"),
    );
    expect(thinkOneLine).toBeGreaterThanOrEqual(0);
    expect(presenter.handleMouse(clickAt(thinkOneLine, 120))).toBe(true);
    rendered = plain(presenter.render(120).lines);
    expect(rendered).not.toContain("THINK_ONE");
    expect(rendered).toContain("THINK_TWO");
    expect(rendered).toContain("THINK_THREE");

    // The per-block collapse must not bounce back after a content update,
    // theme invalidation, or resize.
    const answerOne = state.entries.find(
      (entry) => entry.type === "assistant-text" && entry.text === "ANSWER_ONE",
    );
    expect(answerOne?.type).toBe("assistant-text");
    if (answerOne?.type === "assistant-text")
      answerOne.text = "ANSWER_ONE_UPDATED";
    presenter.sync(state.entries);
    rendered = plain(presenter.render(120).lines);
    expect(rendered).not.toContain("THINK_ONE");
    expect(rendered).toContain("ANSWER_ONE_UPDATED");
    presenter.invalidate();
    expect(plain(presenter.render(120).lines)).not.toContain("THINK_ONE");
    expect(plain(presenter.render(140).lines)).not.toContain("THINK_ONE");

    // Unified collapse and expand round-trip through the same public paths.
    presenter.setThinkingVisible(false);
    rendered = plain(presenter.render(120).lines);
    expect(rendered).not.toContain("THINK_TWO");
    expect(rendered).not.toContain("THINK_THREE");
    expect(rendered).not.toContain("THINK_STREAM");
    presenter.setThinkingVisible(true);
    rendered = plain(presenter.render(120).lines);
    expect(rendered).toContain("THINK_ONE");
    expect(rendered).toContain("THINK_TWO");
    expect(rendered).toContain("THINK_THREE");
    expect(rendered).toContain("THINK_STREAM");

    // The main-session component is unaffected by presenter toggles.
    expect(plain(mainComponent.render(80))).toBe(mainRendered);
  });
});
