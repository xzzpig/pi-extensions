import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type AgentSessionEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  visibleWidth,
  type Component,
  type Focusable,
  type Terminal,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  createTranscriptState,
  type ToolComponentLookup,
  type TranscriptEntry,
} from "@xzzpig/pi-components/transcript";
import {
  BtwOverlayComponent,
  resolveBtwThinkingShortcuts,
} from "../extensions/btw";
import { applyBtwTranscriptEvent } from "../extensions/btw-transcript-ingestion";
import {
  BTW_OVERLAY_TRANSCRIPT_TOP,
  isBtwSgrMouseSequence,
  mapBtwOverlayTranscriptMouse,
} from "../extensions/btw-overlay-interaction";

initTheme("dark", false);

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ExtensionContext["ui"]["theme"];

// SAFETY: the ingestion path only reads the event type, message content and
// tool fields; transport metadata is irrelevant to these fixtures.
function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function addAssistantTurn(
  state: ReturnType<typeof createTranscriptState>,
  thinking: string,
  text: string,
): void {
  const content = [
    { type: "thinking", thinking },
    { type: "text", text },
  ];
  const message = { role: "assistant", content };
  for (const next of [
    event({ type: "turn_start" }),
    event({ type: "message_start", message }),
    event({ type: "message_update", message }),
    event({ type: "message_end", message }),
    event({
      type: "turn_end",
      message: { ...message, stopReason: "stop" },
      toolResults: [],
    }),
  ]) {
    applyBtwTranscriptEvent(state, next, () => {});
  }
}

function completedEntries(
  thinking = "THINKING_TEXT",
  text = "ANSWER",
): TranscriptEntry[] {
  const state = createTranscriptState();
  addAssistantTurn(state, thinking, text);
  return state.entries;
}

function mouse(
  type: TuiMouseEvent["type"],
  x: number,
  y: number,
  extra: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === "click" ? { clickCount: 1 } : {}),
    ...extra,
  };
}

function createOverlay(
  options: {
    entries?: () => TranscriptEntry[];
    mode?: "regular" | "fullscreen";
    widthMode?: "window" | "full";
    thinkingShortcuts?: readonly string[];
    toolComponents?: ToolComponentLookup;
    tui?: TUI;
  } = {},
): {
  overlay: BtwOverlayComponent;
  requestRender: ReturnType<typeof vi.fn>;
} {
  const requestRender = vi.fn();
  const tui =
    options.tui ??
    ({
      mode: options.mode ?? "fullscreen",
      requestRender,
      terminal: { write: vi.fn() },
    } as unknown as TUI);
  const keybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.thinking.toggle": {
      defaultKeys: "ctrl+t",
      description: "Toggle thinking",
    },
  });
  const overlay = new BtwOverlayComponent(
    tui,
    plainTheme,
    keybindings,
    options.entries ?? (() => completedEntries()),
    () => 0,
    () => options.toolComponents ?? new Map(),
    () => null,
    () => "contextual",
    () => options.widthMode ?? "window",
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    () => "local",
    undefined,
    options.thinkingShortcuts ? () => options.thinkingShortcuts! : undefined,
  );
  return { overlay, requestRender };
}

function findLine(lines: readonly string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

function clickLine(
  overlay: BtwOverlayComponent,
  lines: readonly string[],
  needle: string,
  x = 1,
  width = 80,
): void {
  const y = findLine(lines, needle);
  expect(
    y,
    `expected a rendered line containing ${needle}`,
  ).toBeGreaterThanOrEqual(0);
  overlay.focused = true;
  const result = overlay.handleMouse(mouse("click", x, y, { width }));
  expect(result).toEqual({ handled: true });
}

class WideToolComponent implements Component {
  renders = 0;
  mouseHandled = 0;

  constructor(private readonly output: string[]) {}

  render(): string[] {
    this.renders++;
    return this.output;
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.mouseHandled++;
    return { handled: true };
  }
}

function addWideToolState(tool: WideToolComponent): {
  entries: TranscriptEntry[];
  toolComponents: ToolComponentLookup;
} {
  const state = createTranscriptState();
  addAssistantTurn(state, "BEFORE_THINK", "before");
  for (const next of [
    event({ type: "turn_start" }),
    event({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "a" },
    }),
    event({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    }),
    event({
      type: "turn_end",
      message: { role: "assistant", content: [], stopReason: "stop" },
      toolResults: [],
    }),
  ]) {
    applyBtwTranscriptEvent(state, next, () => {});
  }
  addAssistantTurn(state, "AFTER_THINK", "after");
  return {
    entries: state.entries,
    toolComponents: new Map([["call-1", tool]]),
  };
}

beforeEach(() => {
  initTheme("dark", false);
});

describe("BTW overlay mouse mapping", () => {
  it("maps only visible transcript content, never chrome, borders, or the input row", () => {
    const layout = {
      transcriptTop: BTW_OVERLAY_TRANSCRIPT_TOP,
      transcriptHeight: 2,
      scrollOffset: 1,
      contentLeft: 1,
      contentWidth: 10,
      lineCount: 3,
    };
    expect(
      mapBtwOverlayTranscriptMouse(mouse("click", 1, 4), layout),
    ).toMatchObject({
      x: 0,
      y: 1,
    });
    expect(
      mapBtwOverlayTranscriptMouse(mouse("click", 1, 3), layout),
    ).toBeUndefined();
    expect(
      mapBtwOverlayTranscriptMouse(mouse("click", 1, 6), layout),
    ).toBeUndefined();
    expect(
      mapBtwOverlayTranscriptMouse(mouse("click", 0, 4), layout),
    ).toBeUndefined();
    expect(
      mapBtwOverlayTranscriptMouse(mouse("click", 11, 4), layout),
    ).toBeUndefined();
    expect(
      mapBtwOverlayTranscriptMouse(mouse("click", 1, 4), {
        ...layout,
        lineCount: 1,
        scrollOffset: 0,
      }),
    ).toMatchObject({ y: 0 });
    expect(
      mapBtwOverlayTranscriptMouse(mouse("click", 1, 5), {
        ...layout,
        lineCount: 1,
        scrollOffset: 0,
      }),
    ).toBeUndefined();
  });

  it("recognizes SGR mouse reports", () => {
    expect(isBtwSgrMouseSequence("\x1b[<0;10;4M")).toBe(true);
    expect(isBtwSgrMouseSequence("\x1b[<64;10;4M")).toBe(true);
    expect(isBtwSgrMouseSequence("plain")).toBe(false);
  });

  it("expands a thinking block from a framed fullscreen click", () => {
    const { overlay } = createOverlay();
    const lines = overlay.render(80);
    expect(findLine(lines, "THINKING_TEXT")).toBeGreaterThanOrEqual(0);
    clickLine(overlay, lines, "THINKING_TEXT");
    const after = overlay.render(80);
    expect(findLine(after, "THINKING_TEXT")).toBe(-1);
    expect(findLine(after, "Thinking...")).toBeGreaterThanOrEqual(0);
  });

  it("uses the borderless content column in full-width mode", () => {
    const { overlay } = createOverlay({ widthMode: "full" });
    const lines = overlay.render(80);
    clickLine(overlay, lines, "THINKING_TEXT", 0);
    const after = overlay.render(80);
    expect(findLine(after, "THINKING_TEXT")).toBe(-1);
    expect(findLine(after, "Thinking...")).toBeGreaterThanOrEqual(0);
  });

  it("re-maps hits after a width change", () => {
    const { overlay } = createOverlay();
    const wide = overlay.render(80);
    expect(findLine(wide, "THINKING_TEXT")).toBeGreaterThanOrEqual(0);
    const narrow = overlay.render(60);
    clickLine(overlay, narrow, "THINKING_TEXT", 1, 60);
    const after = overlay.render(60);
    expect(findLine(after, "THINKING_TEXT")).toBe(-1);
    expect(findLine(after, "Thinking...")).toBeGreaterThanOrEqual(0);
  });

  it("keeps wide tool output verbatim and maps tool/thinking hits after scrolling", () => {
    const tool = new WideToolComponent([
      "X".repeat(200),
      "| a | b |",
      "| - | - |",
      ...Array.from({ length: 17 }, (_, index) => `tool line ${index}`),
    ]);
    const { entries, toolComponents } = addWideToolState(tool);
    const { overlay } = createOverlay({
      entries: () => entries,
      toolComponents,
    });

    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[5~");
    const top = overlay.render(80);
    expect(top.filter((line) => line.includes("X")).length).toBe(1);
    expect(top.filter((line) => line.includes("| a | b |")).length).toBe(1);
    clickLine(overlay, top, "| a | b |");
    expect(tool.mouseHandled).toBe(1);

    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[6~");
    const bottom = overlay.render(80);
    expect(findLine(bottom, "AFTER_THINK")).toBeGreaterThanOrEqual(0);
    clickLine(overlay, bottom, "AFTER_THINK");
    const after = overlay.render(80);
    expect(findLine(after, "AFTER_THINK")).toBe(-1);
    expect(findLine(after, "Thinking...")).toBeGreaterThanOrEqual(0);

    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[5~");
    const narrow = overlay.render(40);
    const xLines = narrow.filter((line) => line.includes("X"));
    expect(xLines.length).toBe(1);
    expect(xLines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("does not hit the transcript when the input area is clicked", () => {
    const { overlay } = createOverlay();
    const lines = overlay.render(80);
    const inputY = findLine(lines, "Ready. Enter submits") + 1;
    expect(inputY).toBeGreaterThan(BTW_OVERLAY_TRANSCRIPT_TOP);
    overlay.focused = true;
    expect(overlay.handleMouse(mouse("click", 1, inputY))).toBeUndefined();
    expect(
      findLine(overlay.render(80), "THINKING_TEXT"),
    ).toBeGreaterThanOrEqual(0);
  });

  it("does not hit a thinking block that scrolled out of the viewport", () => {
    const state = createTranscriptState();
    addAssistantTurn(
      state,
      "THINKING_TEXT",
      Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
    );
    const { overlay } = createOverlay({ entries: () => state.entries });
    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[5~");
    const lines = overlay.render(80);
    expect(findLine(lines, "THINKING_TEXT")).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[6~");
    const scrolled = overlay.render(80);
    expect(findLine(scrolled, "THINKING_TEXT")).toBe(-1);
    overlay.focused = true;
    overlay.handleMouse(mouse("click", 1, BTW_OVERLAY_TRANSCRIPT_TOP));
    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[5~");
    expect(
      findLine(overlay.render(80), "THINKING_TEXT"),
    ).toBeGreaterThanOrEqual(0);
  });

  it("focuses on the first press and only toggles after focus", () => {
    const { overlay } = createOverlay();
    const lines = overlay.render(80);
    const y = findLine(lines, "THINKING_TEXT");
    expect(y).toBeGreaterThanOrEqual(0);
    expect(overlay.focused).toBe(false);
    expect(overlay.handleMouse(mouse("press", 1, y))).toEqual({
      handled: true,
      focus: true,
    });
    overlay.focused = true;
    expect(overlay.handleMouse(mouse("click", 1, y))).toEqual({
      handled: true,
    });
    expect(findLine(overlay.render(80), "THINKING_TEXT")).toBe(-1);
  });

  it("scrolls with a fullscreen wheel only while focused", () => {
    const state = createTranscriptState();
    addAssistantTurn(
      state,
      "THINKING_TEXT",
      Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
    );
    const { overlay } = createOverlay({ entries: () => state.entries });
    const initial = overlay.render(80);
    expect(
      overlay.handleMouse(mouse("wheel", 1, 5, { wheelDelta: -1 })),
    ).toBeUndefined();
    expect(overlay.render(80).join("\n")).toBe(initial.join("\n"));

    overlay.focused = true;
    expect(
      overlay.handleMouse(mouse("wheel", 1, 5, { wheelDelta: -1 })),
    ).toEqual({ handled: true });
    expect(overlay.render(80).join("\n")).not.toBe(initial.join("\n"));
  });
});

describe("BTW overlay keyboard and focus routing", () => {
  it("toggles thinking with the default Ctrl+T in regular mode and ignores click reports", () => {
    const state = createTranscriptState();
    addAssistantTurn(
      state,
      "THINKING_TEXT",
      Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
    );
    const { overlay } = createOverlay({
      mode: "regular",
      entries: () => state.entries,
    });
    expect(overlay.hintsText.text).toContain("Ctrl+T thinking");
    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[5~");
    const initial = overlay.render(80);
    expect(initial.join("\n")).toContain("THINKING_TEXT");
    overlay.handleInput("\x14");
    expect(overlay.render(80).join("\n")).not.toContain("THINKING_TEXT");
    expect(overlay.render(80).join("\n")).toContain("Thinking...");

    overlay.setDraft("draft");
    overlay.handleInput("\x1b[<0;10;10M");
    expect(overlay.getDraft()).toBe("draft");

    for (let index = 0; index < 2; index++) overlay.handleInput("\x1b[6~");
    const beforeWheel = overlay.render(80).join("\n");
    overlay.handleInput("\x1b[<64;10;10M");
    expect(overlay.render(80).join("\n")).not.toBe(beforeWheel);
  });

  it("uses the configured thinking key and shows it in the footer", () => {
    const { overlay } = createOverlay({ thinkingShortcuts: ["alt+t"] });
    expect(overlay.hintsText.text).toContain("Alt+T thinking");
    expect(overlay.render(80).join("\n")).toContain("THINKING_TEXT");
    overlay.handleInput("\x1bt");
    expect(overlay.render(80).join("\n")).not.toContain("THINKING_TEXT");
  });

  it("resolves the default and rejects unusable PI_BTW_THINKING_KEYS entries", () => {
    expect(resolveBtwThinkingShortcuts({})).toEqual(["ctrl+t"]);
    expect(resolveBtwThinkingShortcuts({ PI_BTW_THINKING_KEYS: "  " })).toEqual(
      ["ctrl+t"],
    );
    expect(
      resolveBtwThinkingShortcuts({
        PI_BTW_THINKING_KEYS: "Alt+T, alt+t, ctrl+x",
      }),
    ).toEqual(["alt+t", "ctrl+x"]);
    expect(
      resolveBtwThinkingShortcuts({ PI_BTW_THINKING_KEYS: "cmd+t,bogus+++" }),
    ).toEqual(["ctrl+t"]);
  });
});

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 30;
  kittyProtocolActive = false;
  private inputHandler?: (data: string) => void;

  start(onInput: (data: string) => void): void {
    this.inputHandler = onInput;
  }

  stop(): void {}

  async drainInput(): Promise<void> {}

  write(): void {}

  moveBy(): void {}

  hideCursor(): void {}

  showCursor(): void {}

  clearLine(): void {}

  clearFromCursor(): void {}

  clearScreen(): void {}

  setTitle(): void {}

  setProgress(): void {}

  setProgramStatus(): void {}

  emit(data: string): void {
    this.inputHandler?.(data);
  }
}

class FakeMainEditor implements Component, Focusable {
  focused = false;
  toggleCount = 0;
  received: string[] = [];

  constructor(private readonly keybindings: KeybindingsManager) {}

  render(): string[] {
    return ["main editor"];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    this.received.push(data);
    if (this.keybindings.matches(data, "app.thinking.toggle")) {
      this.toggleCount++;
    }
  }
}

describe("BTW overlay focus contract with the real TUI router", () => {
  it("keeps Ctrl+T local while focused and lets the main editor action run after unfocus", () => {
    const terminal = new FakeTerminal();
    const tui = new TuiMainScreen(terminal);
    const keybindings = new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.thinking.toggle": {
        defaultKeys: "ctrl+t",
        description: "Toggle thinking",
      },
    });
    const mainEditor = new FakeMainEditor(keybindings);
    const state = createTranscriptState();
    addAssistantTurn(state, "THINKING_TEXT", "ANSWER");
    const overlay = new BtwOverlayComponent(
      tui,
      plainTheme,
      keybindings,
      () => state.entries,
      () => 0,
      () => new Map(),
      () => null,
      () => "contextual",
      () => "window",
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      () => "local",
    );

    tui.start();
    tui.setFocus(mainEditor);
    const handle = tui.showOverlay(overlay, {
      anchor: "top-center",
      width: 80,
      maxHeight: 30,
      nonCapturing: true,
    });
    handle.focus();
    overlay.render(80);

    try {
      terminal.emit("\x14");
      expect(overlay.focused).toBe(true);
      expect(mainEditor.toggleCount).toBe(0);
      expect(overlay.render(80).join("\n")).not.toContain("THINKING_TEXT");
      expect(overlay.render(80).join("\n")).toContain("Thinking...");

      handle.unfocus();
      expect(overlay.focused).toBe(false);
      terminal.emit("\x14");
      expect(mainEditor.toggleCount).toBe(1);
      expect(overlay.render(80).join("\n")).not.toContain("THINKING_TEXT");
    } finally {
      handle.hide();
      tui.stop();
    }
  });
});
