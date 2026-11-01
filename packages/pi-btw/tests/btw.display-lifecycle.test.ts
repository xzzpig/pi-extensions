import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type AgentSessionEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  Text,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  createTranscriptState,
  type TranscriptEntry,
  type TranscriptState,
} from "@xzzpig/pi-components/transcript";
import { BtwOverlayComponent } from "../extensions/btw";
import {
  BtwToolDisplayAdapter,
  BtwTranscriptDisplay,
  type BtwToolDisplayApi,
} from "../extensions/btw-transcript-display";
import { BtwToolComponents } from "../extensions/btw-tool-components";
import { applyBtwTranscriptEvent } from "../extensions/btw-transcript-ingestion";

const themeInitCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    initTheme: (...args: Parameters<typeof actual.initTheme>) => {
      themeInitCalls.count++;
      return actual.initTheme(...args);
    },
  };
});

initTheme("dark", false);

type ThemeCounters = { fg: number; bg: number; bold: number };

function createTheme(prefix: string): {
  theme: ExtensionContext["ui"]["theme"];
  counters: ThemeCounters;
} {
  const counters: ThemeCounters = { fg: 0, bg: 0, bold: 0 };
  const theme = {
    fg: (_color: string, text: string) => {
      counters.fg++;
      return `${prefix}(${text})`;
    },
    bg: (_color: string, text: string) => {
      counters.bg++;
      return `${prefix}(${text})`;
    },
    bold: (text: string) => {
      counters.bold++;
      return `${prefix}(${text})`;
    },
  } as unknown as ExtensionContext["ui"]["theme"];
  return { theme, counters };
}

function createTui(): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  return {
    tui: {
      mode: "fullscreen",
      requestRender,
      terminal: { write: vi.fn() },
    } as unknown as TUI,
    requestRender,
  };
}

// SAFETY: fixtures provide exactly the event fields the ingestion path reads.
function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function addAssistantTurn(
  state: TranscriptState,
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

function addToolTurn(state: TranscriptState, toolCallId = "call-1"): void {
  for (const next of [
    event({ type: "turn_start" }),
    event({
      type: "tool_execution_start",
      toolCallId,
      toolName: "read",
      args: { path: "a" },
    }),
    event({
      type: "tool_execution_end",
      toolCallId,
      toolName: "read",
      result: {
        content: [
          {
            type: "text",
            text: Array.from(
              { length: 15 },
              (_, index) => `RESULT_LINE_${index}`,
            ).join("\n"),
          },
        ],
      },
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
}

interface ProviderHarness {
  api: BtwToolDisplayApi;
  setOutput(value: string): void;
  setRevision(value: number): void;
  factoryCalls(): number;
}

function createProviderHarness(
  initialOutput = "V1",
  initialRevision = 1,
): ProviderHarness {
  let output = initialOutput;
  let revision = initialRevision;
  let calls = 0;
  const api: BtwToolDisplayApi = {
    version: 1,
    decorateTool: (tool) => tool,
    getToolPresentation: (name) => {
      if (name !== "read") return undefined;
      const snapshotOutput = output;
      return {
        name: "read",
        renderCall: () => {
          calls++;
          return new Text(`CALL:${snapshotOutput}`);
        },
      };
    },
    get presentationRevision() {
      return revision;
    },
  };
  return {
    api,
    setOutput(value) {
      output = value;
    },
    setRevision(value) {
      revision = value;
    },
    factoryCalls() {
      return calls;
    },
  };
}

function createHarness(
  options: {
    theme?: ExtensionContext["ui"]["theme"];
    tui?: TUI;
    api?: BtwToolDisplayApi;
  } = {},
) {
  const provider = createProviderHarness();
  let currentApi: BtwToolDisplayApi | undefined = options.api ?? provider.api;
  const adapter = new BtwToolDisplayAdapter({
    getDisplayApi: () => currentApi,
    isLocalWorkspace: () => true,
  });
  const state = createTranscriptState();
  const toolComponents = new BtwToolComponents({
    cwd: "/test/project",
    resolveToolDefinition: adapter.resolveToolDefinition,
  });
  state.toolComponents = toolComponents;
  const themeInfo = createTheme("A");
  const tuiInfo = createTui();
  const display = new BtwTranscriptDisplay({
    theme: options.theme ?? themeInfo.theme,
    toolComponents,
    resolveToolDefinition: adapter.resolveToolDefinition,
    emptyText: "No BTW thread yet. Ask a side question to start one.",
    assistantLabel: "Assistant",
    tui: options.tui ?? tuiInfo.tui,
    getDisplayProvider: () => adapter.displayProvider,
    rebuildToolComponents: () => toolComponents.rebuild(),
  });
  toolComponents.setRequestRender(() => display.requestRender());
  return {
    provider,
    adapter,
    state,
    toolComponents,
    display,
    theme: themeInfo.theme,
    themeCounters: themeInfo.counters,
    tui: tuiInfo.tui,
    requestRender: tuiInfo.requestRender,
    setApi(api: BtwToolDisplayApi | undefined) {
      currentApi = api;
    },
  };
}

function mouseClick(
  x: number,
  y: number,
  width: number,
  height: number,
): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}

function clickToolRow(
  display: BtwTranscriptDisplay,
  entries: readonly TranscriptEntry[],
  width: number,
  toolCallId = "call-1",
): void {
  const frame = display.renderFrame(entries, width);
  const row = frame.rows.find(
    (candidate) =>
      candidate.kind === "tool" && candidate.toolCallId === toolCallId,
  );
  expect(row).toBeDefined();
  const y = frame.lines.findIndex(
    (line, index) =>
      index >= row!.top &&
      index < row!.top + row!.height &&
      (line.includes("CALL:") || line.includes("RESULT_LINE_0")),
  );
  expect(y).toBeGreaterThanOrEqual(0);
  expect(display.handleMouse(mouseClick(1, y, width, row!.height))).toBe(true);
}

function clickAssistantRow(
  display: BtwTranscriptDisplay,
  entries: readonly TranscriptEntry[],
  width: number,
): void {
  const frame = display.renderFrame(entries, width);
  const row = frame.rows.find((candidate) => candidate.kind === "assistant");
  expect(row).toBeDefined();
  expect(
    display.handleMouse(mouseClick(0, row!.top + 1, width, row!.height)),
  ).toBe(true);
}

function overlayFor(
  display: BtwTranscriptDisplay,
  state: TranscriptState,
  theme: ExtensionContext["ui"]["theme"],
  tui: TUI,
  getState: () => TranscriptState = () => state,
): BtwOverlayComponent {
  const keybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.thinking.toggle": {
      defaultKeys: "ctrl+t",
      description: "Toggle thinking",
    },
  });
  return new BtwOverlayComponent(
    tui,
    theme,
    keybindings,
    () => getState().entries,
    () => 0,
    () => getState().toolComponents,
    () => null,
    () => "contextual",
    () => "window",
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    () => "local",
    undefined,
    undefined,
    display,
  );
}

beforeEach(() => {
  initTheme("dark", false);
});

describe("BTW display revision and provider refresh", () => {
  it("rebuilds tool components when the provider revision changes despite a cached frame", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    const first = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(first).toContain("CALL:V1");
    const calls = harness.provider.factoryCalls();
    expect(calls).toBeGreaterThan(0);

    harness.provider.setOutput("V2");
    harness.provider.setRevision(2);
    const second = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(second).toContain("CALL:V2");
    expect(second).not.toContain("CALL:V1");
    expect(harness.provider.factoryCalls()).toBeGreaterThan(calls);
  });

  it("rebuilds tool components when the provider API identity changes (reload)", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    expect(
      harness.display.renderFrame(harness.state.entries, 80).lines.join("\n"),
    ).toContain("CALL:V1");

    const replacement = createProviderHarness("V2", 1);
    harness.setApi(replacement.api);
    const afterReload = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(afterReload).toContain("CALL:V2");
    expect(afterReload).not.toContain("CALL:V1");
  });

  it("invalidates the line cache when a tool component requests render without an entry change", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    expect(
      harness.display.renderFrame(harness.state.entries, 80).lines.join("\n"),
    ).toContain("RESULT_LINE_0");

    harness.toolComponents.handleUpdate("call-1", "read", {
      content: [{ type: "text", text: "UPDATED" }],
    });
    const after = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(after).toContain("UPDATED");
    expect(
      harness.state.entries.some(
        (entry) => entry.type === "tool-result" && entry.text === "UPDATED",
      ),
    ).toBe(false);
  });

  it("updates the overlay cache when a renderer calls context.invalidate", () => {
    let output = "INVALIDATE_V1";
    let invalidate: (() => void) | undefined;
    const api: BtwToolDisplayApi = {
      version: 1,
      decorateTool: (tool) => tool,
      getToolPresentation: (name) =>
        name === "read"
          ? {
              name: "read",
              renderCall: (_args, _theme, context) => {
                const candidate = context.invalidate;
                if (typeof candidate === "function")
                  invalidate = candidate as () => void;
                return {
                  render: () => [output],
                  invalidate: () => {},
                };
              },
            }
          : undefined,
      presentationRevision: 1,
    };
    const harness = createHarness({ api });
    addToolTurn(harness.state);
    const overlay = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    expect(overlay.render(80).join("\n")).toContain("INVALIDATE_V1");

    output = "INVALIDATE_V2";
    expect(invalidate).toBeDefined();
    invalidate!();
    const after = overlay.render(80).join("\n");
    expect(after).toContain("INVALIDATE_V2");
    expect(after).not.toContain("INVALIDATE_V1");
  });

  it("re-renders after a component requests paint during rendering", () => {
    let renderCount = 0;
    const api: BtwToolDisplayApi = {
      version: 1,
      decorateTool: (tool) => tool,
      getToolPresentation: (name) =>
        name === "read"
          ? {
              name: "read",
              renderCall: (_args, _theme, context) => {
                const request = context.invalidate;
                return {
                  render: () => {
                    renderCount++;
                    if (renderCount === 1 && typeof request === "function") {
                      (request as () => void)();
                    }
                    return [`RENDER_${renderCount}`];
                  },
                  invalidate: () => {},
                };
              },
            }
          : undefined,
      presentationRevision: 1,
    };
    const harness = createHarness({ api });
    addToolTurn(harness.state);
    const overlay = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    const first = overlay.render(80).join("\n");
    expect(first).toContain("RENDER_1");
    const second = overlay.render(80).join("\n");
    expect(second).toContain("RENDER_2");
    expect(second).not.toContain("RENDER_1");
  });

  it("keeps tool expansion across a provider rebuild", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    const collapsed = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(collapsed).not.toContain("RESULT_LINE_14");

    clickToolRow(harness.display, harness.state.entries, 80);
    const expanded = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(expanded).toContain("RESULT_LINE_14");

    harness.provider.setOutput("V2");
    harness.provider.setRevision(2);
    const rebuilt = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(rebuilt).toContain("CALL:V2");
    expect(rebuilt).toContain("RESULT_LINE_14");
  });

  it("keeps thinking expansion across a theme change without using the old theme", () => {
    const harness = createHarness();
    addAssistantTurn(harness.state, "THINKING_TEXT", "ANSWER");
    const first = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(first).toContain("THINKING_TEXT");
    expect(first).toContain("A(");

    clickAssistantRow(harness.display, harness.state.entries, 80);
    const collapsed = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(collapsed).not.toContain("THINKING_TEXT");
    expect(collapsed).toContain("Thinking...");

    const next = createTheme("B");
    const oldFgCalls = harness.themeCounters.fg;
    themeInitCalls.count = 0;
    harness.display.setTheme(next.theme);
    const themed = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(themed).toContain("B(");
    expect(themed).not.toContain("THINKING_TEXT");
    expect(themed).toContain("Thinking...");
    expect(harness.themeCounters.fg).toBe(oldFgCalls);
    expect(themeInitCalls.count).toBe(0);
  });

  it("updates the frame revision on width changes", () => {
    const harness = createHarness();
    addAssistantTurn(harness.state, "THINKING_TEXT", "ANSWER");
    const wide = harness.display.renderFrame(harness.state.entries, 80);
    const narrow = harness.display.renderFrame(harness.state.entries, 60);
    expect(narrow.width).toBe(60);
    expect(narrow.revision).toBeGreaterThan(wide.revision);
  });
});

describe("BTW display lifecycle", () => {
  it("preserves expansion across detach/attach and drops the old TUI reference", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    clickToolRow(harness.display, harness.state.entries, 80);
    expect(
      harness.display.renderFrame(harness.state.entries, 80).lines.join("\n"),
    ).toContain("RESULT_LINE_14");

    harness.display.detachTui();
    harness.toolComponents.detachTui();
    expect(
      (harness.display as unknown as { options: { tui?: unknown } }).options
        .tui,
    ).toBeUndefined();
    expect(
      (harness.toolComponents as unknown as { toolOptions: { tui?: unknown } })
        .toolOptions.tui,
    ).toBeUndefined();
    harness.requestRender.mockClear();
    harness.toolComponents.handleUpdate("call-1", "read", {
      content: [
        {
          type: "text",
          text: Array.from(
            { length: 15 },
            (_, index) => `AFTER_DETACH_${index}`,
          ).join("\n"),
        },
      ],
    });
    expect(harness.requestRender).not.toHaveBeenCalled();

    const next = createTui();
    harness.display.attachTui(next.tui);
    harness.toolComponents.attachTui(next.tui);
    const reopened = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(reopened).toContain("AFTER_DETACH_14");
    harness.toolComponents.handleUpdate("call-1", "read", {
      content: [{ type: "text", text: "AFTER_ATTACH" }],
    });
    expect(next.requestRender).toHaveBeenCalled();
  });

  it("clears retained state and does not carry old expansion into new entries", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    clickToolRow(harness.display, harness.state.entries, 80);
    expect(
      harness.display.renderFrame(harness.state.entries, 80).lines.join("\n"),
    ).toContain("RESULT_LINE_14");

    harness.display.clear();
    harness.toolComponents.clear();
    expect(harness.display.componentCount).toBe(0);
    expect(harness.toolComponents.size).toBe(0);
    expect(harness.display.renderFrame([], 80).lines.join("\n")).not.toContain(
      "RESULT_LINE_0",
    );

    addAssistantTurn(harness.state, "NEW_THINKING", "NEW_ANSWER");
    expect(
      harness.display.renderFrame(harness.state.entries, 80).lines.join("\n"),
    ).toContain("NEW_ANSWER");

    addToolTurn(harness.state, "call-2");
    const newTool = harness.display
      .renderFrame(harness.state.entries, 80)
      .lines.join("\n");
    expect(newTool).not.toContain("RESULT_LINE_14");

    harness.display.dispose();
    expect(
      harness.display.renderFrame(harness.state.entries, 80).lines,
    ).toEqual([]);
    harness.toolComponents.dispose();
    expect(harness.toolComponents.get("call-2")).toBeUndefined();
  });

  it("replaces the display after a thread switch without closing the overlay", () => {
    const first = createHarness();
    addAssistantTurn(first.state, "OLD_THINKING", "OLD_ANSWER");
    const { tui } = createTui();
    let current = first.state;
    const overlay = overlayFor(
      first.display,
      first.state,
      first.theme,
      tui,
      () => current,
    );
    expect(overlay.render(80).join("\n")).toContain("OLD_ANSWER");

    const second = createHarness();
    addAssistantTurn(second.state, "NEW_THINKING", "NEW_ANSWER");
    first.display.dispose();
    current = second.state;
    overlay.setTranscriptDisplay(second.display);
    const switched = overlay.render(80).join("\n");
    expect(switched).toContain("NEW_ANSWER");
    expect(switched).not.toContain("OLD_ANSWER");
  });
});

describe("BTW overlay cache and reopen", () => {
  it("invalidates the overlay line cache on provider revision/API changes", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    const overlay = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    const first = overlay.render(80).join("\n");
    expect(first).toContain("CALL:V1");

    harness.provider.setOutput("V2");
    harness.provider.setRevision(2);
    const second = overlay.render(80).join("\n");
    expect(second).toContain("CALL:V2");
    expect(second).not.toContain("CALL:V1");

    const replacement = createProviderHarness("V3", 1);
    harness.setApi(replacement.api);
    const third = overlay.render(80).join("\n");
    expect(third).toContain("CALL:V3");
    expect(third).not.toContain("CALL:V2");
  });

  it("invalidates the overlay cache on a component repaint without an entry change", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    const overlay = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    expect(overlay.render(80).join("\n")).toContain("RESULT_LINE_0");

    harness.toolComponents.handleUpdate("call-1", "read", {
      content: [{ type: "text", text: "OVERLAY_UPDATE" }],
    });
    const after = overlay.render(80).join("\n");
    expect(after).toContain("OVERLAY_UPDATE");
    expect(
      harness.state.entries.some(
        (entry) =>
          entry.type === "tool-result" && entry.text === "OVERLAY_UPDATE",
      ),
    ).toBe(false);
  });

  it("keeps thinking expansion when the overlay is closed and reopened", () => {
    const harness = createHarness();
    addAssistantTurn(harness.state, "THINKING_TEXT", "ANSWER");
    const first = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    first.focused = true;
    const lines = first.render(80);
    const thinkingLine = lines.findIndex((line) =>
      line.includes("THINKING_TEXT"),
    );
    expect(thinkingLine).toBeGreaterThanOrEqual(0);
    expect(first.handleMouse(mouseClick(1, thinkingLine, 80, 1))).toEqual({
      handled: true,
    });
    expect(first.render(80).join("\n")).not.toContain("THINKING_TEXT");

    first.dispose();
    harness.toolComponents.detachTui();
    const second = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    const reopened = second.render(80).join("\n");
    expect(reopened).not.toContain("THINKING_TEXT");
    expect(reopened).toContain("Thinking...");
  });

  it("keeps tool expansion when the overlay is closed and reopened", () => {
    const harness = createHarness();
    addToolTurn(harness.state);
    const first = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    first.focused = true;
    const toolLine = first
      .render(80)
      .findIndex((line) => line.includes("CALL:V1"));
    expect(toolLine).toBeGreaterThanOrEqual(0);
    expect(first.handleMouse(mouseClick(2, toolLine, 80, 1))).toEqual({
      handled: true,
    });
    expect(first.render(80).join("\n")).toContain("RESULT_LINE_14");

    first.dispose();
    harness.toolComponents.detachTui();
    const second = overlayFor(
      harness.display,
      harness.state,
      harness.theme,
      harness.tui,
    );
    expect(second.render(80).join("\n")).toContain("RESULT_LINE_14");
  });
});
