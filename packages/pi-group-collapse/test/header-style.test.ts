/**
 * Header style contract (fork-only presentation: `▸ 分组 …`).
 *
 * A group shows exactly one header row, and it now carries a `分组` label
 * between the arrow and the counts, an accent-colored arrow and label, a
 * muted counts tail, and a neutral theme background across the available
 * width. The rows that must stay untouched are pinned here too:
 *
 * - one row high, folded and expanded alike, and the ▸/▾ state is never
 *   overwritten by the decoration;
 * - a narrow terminal drops the *label* first and keeps the counts and the
 *   error/warning marker, so decoration can never cost the carrier its
 *   summary or trigger a fallback the plain row would have survived;
 * - the marker keeps its semantic color and its position right after the
 *   arrow (failures outrank warnings, both outrank counts);
 * - width is measured in terminal cells (CJK double, ANSI-aware), never
 *   with `string.length`;
 * - colors are re-read from the live host theme on every render, so a
 *   theme switch changes the next frame instead of a cached string;
 * - member output below an expanded title, unbound components, and the
 *   click mapping keep their exact previous bytes and semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  Theme,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import extension, { getGroupCollapseRuntime } from "../index.ts";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import { summaryLine } from "../src/view.ts";
import {
  GROUP_HEADER_LABEL,
  groupHeaderLine,
  type HeaderTheme,
} from "../src/header-style.ts";
import type { SegmentSummary } from "../src/model.ts";

const WIDTH = 80;
const FOLDED = "▸";
const EXPANDED = "▾";
const LABEL = GROUP_HEADER_LABEL;

const summary = (partial: Partial<SegmentSummary>): SegmentSummary => ({
  tools: 0,
  thinking: 0,
  messages: 0,
  failed: 0,
  warnings: 0,
  errors: 0,
  ...partial,
});

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

const visible = (line: string): string => stripTerminalSequences(line);

/**
 * A theme double that emits real SGR sequences, so `visibleWidth` and
 * `stripTerminalSequences` behave exactly as they do with the host theme.
 */
const SGR: Readonly<Record<string, string>> = {
  accent: "\x1b[35m",
  muted: "\x1b[90m",
  error: "\x1b[31m",
  warning: "\x1b[33m",
  toolPendingBg: "\x1b[48;5;236m",
  customMessageBg: "\x1b[48;5;54m",
};

const stubTheme = (
  overrides: Partial<Record<string, string>> = {},
): HeaderTheme => ({
  fg: (slot, text) =>
    `${overrides[slot] ?? SGR[slot] ?? "\x1b[39m"}${text}\x1b[39m`,
  bg: (slot, text) =>
    `${overrides[slot] ?? SGR[slot] ?? "\x1b[49m"}${text}\x1b[49m`,
});

/** Every mandatory foreground slot of the SDK's Theme class. */
const THEME_FG_SLOTS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const;

/** Every background slot of the SDK's Theme class. */
const THEME_BG_SLOTS = [
  "selectedBg",
  "searchMatchBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

const PALETTE_A = {
  accent: "#8b7ae0",
  muted: "#9aa3a7",
  error: "#e05a5a",
  warning: "#d7b45a",
  panel: "#34383a",
};

const PALETTE_B = {
  accent: "#2f8f6f",
  muted: "#666666",
  error: "#cc0000",
  warning: "#aa8800",
  panel: "#e4e5e6",
};

/**
 * A real `Theme` instance from the SDK's public class — the same derivation
 * the host uses, not a hand-written escape string and not an internal key.
 */
const realTheme = (palette: typeof PALETTE_A): Theme => {
  const fg: Record<string, string> = {};
  for (const slot of THEME_FG_SLOTS) fg[slot] = palette.muted;
  fg.accent = palette.accent;
  fg.error = palette.error;
  fg.warning = palette.warning;
  const bg: Record<string, string> = {};
  for (const slot of THEME_BG_SLOTS) bg[slot] = palette.panel;
  // SAFETY: the loops above fill every mandatory ThemeColor/ThemeBg slot;
  // the casts only satisfy the exact-key record types of the constructor.
  return new Theme(
    fg as ConstructorParameters<typeof Theme>[0],
    bg as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
};

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function toolComponent(id: string, isError = false): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "bash",
    id,
    { command: `echo ${id}` },
    {},
    undefined,
    stubUi() as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `done ${id}` }], isError },
    false,
  );
  return component;
}

function makeAssistant(
  content: readonly { type: string; thinking?: string; text?: string }[],
): AssistantMessageComponent {
  const component = new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
  );
  component.updateContent(
    {
      role: "assistant",
      content: [...content],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    } as never,
    false,
  );
  return component;
}

function settled(runtime: GroupCollapseRuntime): void {
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
}

/** Runs one turn with `count` tools and settles it (so the group folds). */
function foldedToolGroup(
  runtime: GroupCollapseRuntime,
  receiver: { chatContainer: Container },
  ids: readonly string[] = ["t1"],
  isError = false,
): ToolExecutionComponent[] {
  runtime.handlePiEvent({ type: "agent_start" });
  const tools = ids.map((id) => toolComponent(id, isError));
  for (const tool of tools) receiver.chatContainer.addChild(tool);
  runtime.syncReceiver(receiver);
  for (const id of ids) {
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: id,
      isError,
    });
  }
  settled(runtime);
  return tools;
}

const start = (
  getTheme?: () => Theme | undefined,
): {
  runtime: GroupCollapseRuntime;
  receiver: { chatContainer: Container };
} => {
  const runtime = new GroupCollapseRuntime({ notify: () => {} });
  const receiver = { chatContainer: new Container() };
  runtime.onSessionStart({
    mode: "tui",
    cwd: "/tmp/no-config-header-style",
    getBranch: () => [],
    getTheme,
  });
  return { runtime, receiver };
};

/** A synthesized plain click, the shape pi-tui's fullscreen path sends. */
function click(component: object, row: number, width = WIDTH): unknown {
  return (
    component as unknown as { handleMouse(e: unknown): unknown }
  ).handleMouse({
    type: "click",
    x: 1,
    y: row,
    button: "left",
    width,
    height: 40,
    screenX: 1,
    screenY: row,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  });
}

describe("groupHeaderLine decoration", () => {
  test("a folded header carries the arrow, label, counts, and full-width background", () => {
    const counts = summary({ tools: 17, messages: 4 });
    const row = groupHeaderLine(counts, { width: WIDTH, theme: stubTheme() });
    expect(row).toBeDefined();
    const line = row as string;

    // Arrow and label in the accent slot, counts muted, background painted
    // with the neutral token.
    expect(line).toContain(`${SGR.accent}${FOLDED}\x1b[39m`);
    expect(line).toContain(`${SGR.accent}${LABEL}\x1b[39m`);
    expect(line).toContain(`${SGR.muted} 17 次工具调用 · 4 条消息\x1b[39m`);
    expect(line.startsWith(SGR.toolPendingBg)).toBe(true);
    expect(line.endsWith("\x1b[49m")).toBe(true);

    // One row, exactly the available columns, and the plain text contract
    // is unchanged apart from the label.
    expect(visibleWidth(line)).toBe(WIDTH);
    expect(visible(line).trimEnd()).toBe(
      `${FOLDED} ${LABEL} 17 次工具调用 · 4 条消息`,
    );
    expect(visible(line)).toContain(FOLDED);
  });

  test("the expanded title is the same header with ▾", () => {
    const counts = summary({ tools: 17, messages: 4 });
    const folded = groupHeaderLine(counts, {
      width: WIDTH,
      theme: stubTheme(),
    });
    const expanded = groupHeaderLine(counts, {
      width: WIDTH,
      expanded: true,
      theme: stubTheme(),
    });
    expect(visible(expanded as string).trimEnd()).toBe(
      `${EXPANDED} ${LABEL} 17 次工具调用 · 4 条消息`,
    );
    // Only the disclosure glyph differs; the decoration never flips state.
    expect(visible(expanded as string).slice(1)).toBe(
      visible(folded as string).slice(1),
    );
    expect(visible(expanded as string)).not.toContain(FOLDED);
  });

  test("error and warning markers keep their color and their place", () => {
    const failed = groupHeaderLine(summary({ tools: 2, failed: 1 }), {
      width: WIDTH,
      theme: stubTheme(),
    }) as string;
    expect(visible(failed).trimEnd()).toBe(`${FOLDED} ✗ ${LABEL} 2 次工具调用`);
    expect(failed).toContain(`${SGR.error}✗\x1b[39m`);
    // The alert stays at the left edge, directly after the arrow.
    expect(failed.indexOf("✗")).toBeLessThan(failed.indexOf(LABEL));

    const warned = groupHeaderLine(summary({ messages: 1, warnings: 1 }), {
      width: WIDTH,
      theme: stubTheme(),
    }) as string;
    expect(visible(warned).trimEnd()).toBe(`${FOLDED} ⚠ ${LABEL} 1 条消息`);
    expect(warned).toContain(`${SGR.warning}⚠\x1b[39m`);
  });

  test("the neutral band falls back to customMessageBg when toolPendingBg is unbacked", () => {
    const counts = summary({ tools: 2 });
    const noPending = stubTheme({ toolPendingBg: "\x1b[49m" });
    const row = groupHeaderLine(counts, {
      width: 40,
      theme: noPending,
    }) as string;
    expect(row.startsWith(SGR.customMessageBg)).toBe(true);
    expect(visibleWidth(row)).toBe(40);
  });

  test("a theme with no panel color leaves the row unpadded and unescaped", () => {
    // The generated system theme for terminals that report no colors sets
    // every background slot to "" — there is no neutral band to paint, and
    // no hard-coded color may be invented in its place.
    const counts = summary({ tools: 2 });
    const noPanels = stubTheme({
      toolPendingBg: "\x1b[49m",
      customMessageBg: "\x1b[49m",
    });
    const row = groupHeaderLine(counts, {
      width: 40,
      theme: noPanels,
    }) as string;
    expect(row.endsWith("\x1b[39m")).toBe(true);
    expect(visible(row)).toBe(`${FOLDED} ${LABEL} 2 次工具调用`);
    expect(visibleWidth(row)).toBeLessThan(40);
  });

  test("a narrow terminal drops the label first and keeps the counts", () => {
    const counts = summary({ tools: 123 });
    const plainLine = summaryLine(counts, { width: 16 }) as string;
    const decoratedWidth = visibleWidth(plainLine) + 1 + visibleWidth(LABEL);
    expect(decoratedWidth).toBeGreaterThan(16);

    const row = groupHeaderLine(counts, { width: 16, theme: stubTheme() });
    expect(row).toBeDefined();
    const line = row as string;
    // The counts survive, the label is gone, and the background still fills
    // the row (no extra cells spent on decoration).
    expect(visible(line).trimEnd()).toBe(plainLine);
    expect(visible(line)).not.toContain(LABEL);
    expect(visibleWidth(line)).toBe(16);
    expect(line.startsWith(SGR.toolPendingBg)).toBe(true);
  });

  test("CJK and ANSI never overflow, and the label only appears when it fits", () => {
    const counts = summary({
      tools: 123,
      thinking: 45,
      messages: 6,
      warnings: 1,
    });
    const theme = stubTheme();
    for (let width = 1; width <= 60; width++) {
      const row = groupHeaderLine(counts, { width, theme });
      const plainLine = summaryLine(counts, { width });
      // Decoration never removes a summary the plain row would have shown.
      expect(row === undefined).toBe(plainLine === undefined);
      if (row === undefined) continue;
      expect(visibleWidth(row)).toBe(width);
      const text = visible(row).trimEnd();
      expect(text.startsWith(FOLDED)).toBe(true);
      expect(visibleWidth(text)).toBeLessThanOrEqual(width);
      // The marker always survives; the label appears only with room, and
      // is omitted only when the decorated row would overflow.
      expect(text).toContain("⚠");
      if (!text.includes(LABEL)) {
        expect(visibleWidth(text) + 1 + visibleWidth(LABEL)).toBeGreaterThan(
          width,
        );
      }
    }
  });

  test("colors are read per call, so a theme switch changes the row", () => {
    const counts = summary({ tools: 2 });
    const first = groupHeaderLine(counts, { width: 40, theme: stubTheme() });
    const second = groupHeaderLine(counts, { width: 40, theme: stubTheme() });
    // Same theme: byte-stable (no time- or call-dependent state).
    expect(second).toBe(first);

    const otherTheme: HeaderTheme = {
      fg: (slot, text) => `\x1b[4${slot === "accent" ? 6 : 4}m${text}\x1b[39m`,
      bg: (_slot, text) => `\x1b[48;5;17m${text}\x1b[49m`,
    };
    const recolored = groupHeaderLine(counts, {
      width: 40,
      theme: otherTheme,
    }) as string;
    expect(recolored).not.toBe(first);
    // Only the escapes differ: the visible text and the width do not.
    expect(visible(recolored)).toBe(visible(first as string));
  });

  test("a theme without the tokens still renders the label, unpainted", () => {
    const throwing: HeaderTheme = {
      fg: () => {
        throw new Error("no such token");
      },
      bg: () => {
        throw new Error("no such token");
      },
    };
    const row = groupHeaderLine(summary({ tools: 2 }), {
      width: 40,
      theme: throwing,
    }) as string;
    expect(visible(row).trimEnd()).toBe(`${FOLDED} ${LABEL} 2 次工具调用`);
    expect(row).not.toContain("\x1b[");
  });

  test("a narrow row drops only the label and keeps every semantic color", () => {
    // The counts still fit at width 16, so the label goes and the arrow and
    // counts keep their colors at exactly the plain row's cell width.
    const plainRow = summaryLine(summary({ tools: 123 }), {
      width: 16,
    }) as string;
    const row = groupHeaderLine(summary({ tools: 123 }), {
      width: 16,
      theme: stubTheme(),
    }) as string;
    expect(visible(row).trimEnd()).toBe(plainRow);
    expect(row).not.toContain(LABEL);
    expect(row).toContain(`${SGR.accent}${FOLDED}\x1b[39m`);
    expect(row).toContain(`${SGR.muted} 123 次工具调用\x1b[39m`);
    expect(visibleWidth(row)).toBe(visibleWidth(plainRow));

    // A failure/warning marker keeps its semantic color without the label.
    const failed = groupHeaderLine(summary({ tools: 2, failed: 1 }), {
      width: 16,
      theme: stubTheme(),
    }) as string;
    expect(visible(failed).trimEnd()).toBe("▸ ✗ 2 次工具调用");
    expect(failed).toContain(`${SGR.error}✗\x1b[39m`);
    expect(failed).toContain(`${SGR.accent}${FOLDED}\x1b[39m`);
    expect(failed).not.toContain(LABEL);

    const warned = groupHeaderLine(summary({ messages: 1, warnings: 1 }), {
      width: 16,
      theme: stubTheme(),
    }) as string;
    expect(warned).toContain(`${SGR.warning}⚠\x1b[39m`);
    expect(warned).not.toContain(LABEL);
  });

  test("without a theme the header degrades to uncolored text", () => {
    const row = groupHeaderLine(summary({ tools: 2 }), { width: 40 });
    expect(row).toBe(`${FOLDED} ${LABEL} 2 次工具调用`);
  });
});

describe("runtime header decoration", () => {
  beforeEach(() => {
    // The host components (tool/assistant) read the process theme; the
    // header itself reads only the injected getter.
    initTheme();
  });

  afterEach(() => {
    initTheme();
  });

  test("a folded tool carrier renders the decorated header with the injected theme", () => {
    const theme = realTheme(PALETTE_A);
    const { runtime, receiver } = start(() => theme);
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1"]);
      const lines = tool.render(WIDTH);
      expect(lines.length).toBe(1);
      const [row] = lines;

      // One row, full width, decorated with the injected Theme's own escapes.
      expect(visibleWidth(row)).toBe(WIDTH);
      expect(visible(row).trimEnd()).toBe(`${FOLDED} ${LABEL} 1 次工具调用`);
      expect(row).toContain(`${theme.getFgAnsi("accent")}${FOLDED}`);
      expect(row).toContain(`${theme.getFgAnsi("accent")}${LABEL}`);
      expect(row.startsWith(theme.getBgAnsi("toolPendingBg"))).toBe(true);
      expect(row.endsWith("\x1b[49m")).toBe(true);
      // The member body stays hidden behind the header.
      expect(visible(row)).not.toContain("echo t1");
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("the same getter switching themes repaints the next frame", () => {
    let current = realTheme(PALETTE_A);
    const { runtime, receiver } = start(() => current);
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1"]);
      const first = tool.render(WIDTH)[0];
      expect(first).toContain(realTheme(PALETTE_A).getFgAnsi("accent"));

      // Same getter, new Theme object: the very next render is recolored.
      current = realTheme(PALETTE_B);
      const second = tool.render(WIDTH)[0];
      expect(second).toContain(current.getFgAnsi("accent"));
      expect(second).not.toContain(realTheme(PALETTE_A).getFgAnsi("accent"));
      expect(second).not.toBe(first);
      // Only the escapes changed: same text, same width, still one row.
      expect(visible(second)).toBe(visible(first));
      expect(visibleWidth(second)).toBe(WIDTH);
      expect(visible(second)).toContain(LABEL);
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("no theme getter renders the label uncolored, one row high", () => {
    const { runtime, receiver } = start();
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1"]);
      const lines = tool.render(WIDTH);
      expect(lines.length).toBe(1);
      expect(visible(lines[0])).toBe(`${FOLDED} ${LABEL} 1 次工具调用`);
      expect(lines[0]).not.toContain("\x1b[");
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("expanding keeps ▾ on the header and the member body byte-identical", () => {
    const { runtime, receiver } = start(() => realTheme(PALETTE_A));
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1", "t2"]);
      expect(visible(tool.render(WIDTH)[0])).toContain(FOLDED);
      expect(visible(tool.render(WIDTH)[0])).toContain(LABEL);

      click(tool, 0);
      const expanded = tool.render(WIDTH);
      // Title first, ▾, decorated, one row — then the member's own output.
      expect(visible(expanded[0])).toContain(EXPANDED);
      expect(visible(expanded[0])).toContain(LABEL);
      expect(visible(expanded[0])).not.toContain(FOLDED);
      expect(expanded[0].endsWith("\x1b[49m")).toBe(true);

      // A twin component that never joined the runtime renders its own
      // bytes: the title row is the only line the decoration touches.
      const twin = toolComponent("t1");
      expect(expanded.slice(1)).toEqual(twin.render(WIDTH));
      expect(plain(expanded.slice(1))).toContain("echo t1");

      // Collapsing again restores the folded arrow on the same row.
      click(tool, 0);
      const refolded = tool.render(WIDTH);
      expect(refolded.length).toBe(1);
      expect(visible(refolded[0])).toContain(FOLDED);
      expect(visible(refolded[0])).not.toContain(EXPANDED);
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("thinking carriers and their expanded titles are decorated too", () => {
    const { runtime, receiver } = start(() => realTheme(PALETTE_A));
    try {
      runtime.handlePiEvent({ type: "agent_start" });
      const assistant = makeAssistant([
        { type: "thinking", thinking: "ALPHA-THOUGHT" },
        { type: "text", text: "middle answer" },
      ]);
      receiver.chatContainer.addChild(assistant);
      runtime.syncReceiver(receiver);
      runtime.handlePiEvent({ type: "agent_start" });
      settled(runtime);

      const folded = assistant.render(WIDTH);
      const summaryRow = folded.findIndex((line) =>
        visible(line).includes("段思考"),
      );
      expect(summaryRow).toBeGreaterThanOrEqual(0);
      expect(visible(folded[summaryRow]).trimEnd()).toBe(
        `${FOLDED} ${LABEL} 1 段思考`,
      );
      expect(visibleWidth(folded[summaryRow])).toBe(WIDTH);
      expect(visible(folded.join("\n"))).not.toContain("ALPHA-THOUGHT");

      click(assistant, summaryRow);
      const open = assistant.render(WIDTH);
      const titleRow = open.findIndex((line) => visible(line).includes(LABEL));
      expect(titleRow).toBeGreaterThanOrEqual(0);
      expect(visible(open[titleRow])).toContain(EXPANDED);
      // The thinking body below the title is the run's own output.
      expect(visible(open.join("\n"))).toContain("ALPHA-THOUGHT");
      // Exactly one decorated row in this frame.
      expect(open.filter((line) => visible(line).includes(LABEL)).length).toBe(
        1,
      );
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("a narrow frame keeps the arrow and marker colors without the label", () => {
    const theme = realTheme(PALETTE_A);
    const { runtime, receiver } = start(() => theme);
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1"], true);
      const counts = summary({ tools: 1, failed: 1 });
      // Below 19 cells the label no longer fits, so only the label goes.
      for (const width of [16, 17, 18]) {
        const plainRow = summaryLine(counts, { width });
        if (plainRow === undefined) continue;
        const lines = tool.render(width);
        expect(lines.length).toBe(1);
        expect(visibleWidth(lines[0])).toBe(width);
        expect(visible(lines[0]).trimEnd()).toBe(plainRow);
        expect(lines[0]).not.toContain(LABEL);
        // The disclosure arrow and the failure marker keep their semantic
        // colors even though the label was dropped.
        expect(lines[0]).toContain(`${theme.getFgAnsi("accent")}${FOLDED}`);
        expect(lines[0]).toContain(`${theme.getFgAnsi("error")}✗`);
        expect(lines[0]).toContain(theme.getBgAnsi("toolPendingBg"));
      }
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("a narrow frame keeps the carrier's summary and its members folded", () => {
    const { runtime, receiver } = start(() => realTheme(PALETTE_A));
    try {
      const [tool] = foldedToolGroup(runtime, receiver, [
        "t1",
        "t2",
        "t3",
        "t4",
      ]);
      const counts = summary({ tools: 4 });
      for (const width of [12, 16, 18, 20, 24, 30]) {
        if (summaryLine(counts, { width }) === undefined) continue;
        const lines = tool.render(width);
        // The plain summary fits at this width, so the decorated frame must
        // keep a summary row: no member is revealed and no row overflows.
        expect(lines.length).toBe(1);
        expect(visibleWidth(lines[0])).toBe(width);
        expect(visible(lines[0]).trimEnd()).toContain("次工具调用");
        expect(visible(lines[0])).not.toContain("echo t1");
      }
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("a component the runtime never bound renders unchanged", () => {
    const unbound = toolComponent("free");
    const pristine = unbound.render(WIDTH).join("\n");
    const { runtime } = start();
    try {
      // Not added to the receiver, so no binding exists for it.
      runtime.syncReceiver({ chatContainer: new Container() });
      expect(unbound.render(WIDTH).join("\n")).toBe(pristine);
      expect(pristine).not.toContain(LABEL);
    } finally {
      runtime.onSessionShutdown();
    }
  });
});

describe("factory theme wiring", () => {
  const runtimeKey = Symbol.for("pi-group-collapse.runtime.v1");

  beforeEach(() => {
    // Host components read the process theme; the header reads the injected
    // getter.
    initTheme();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, runtimeKey);
  });

  test("session_start injects a live ctx.ui.theme getter and clears it on shutdown", () => {
    Reflect.deleteProperty(globalThis, runtimeKey);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const registration = {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
        return () => {};
      },
      registerCommand: () => {},
    };
    // SAFETY: the factory only calls these two registration methods.
    extension(registration as unknown as ExtensionAPI);
    const runtime = getGroupCollapseRuntime(() => {});
    const themeA = realTheme(PALETTE_A);
    const themeB = realTheme(PALETTE_B);
    // A mutable `ui` stands in for the host ctx: the injected getter must
    // read `ctx.ui.theme` every frame instead of holding the first Theme.
    let ui: { theme?: Theme; notify(): void } = {
      theme: themeA,
      notify() {},
    };
    const ctx = {
      mode: "tui",
      cwd: "/tmp/no-config-header-style",
      sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      get ui() {
        return ui;
      },
    };
    try {
      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeDefined();
      sessionStart?.({}, ctx);
      expect(runtime.debugHasThemeGetter()).toBe(true);

      const receiver = { chatContainer: new Container() };
      const [tool] = foldedToolGroup(runtime, receiver, ["t1"]);
      const first = tool.render(WIDTH)[0];
      expect(first).toContain(themeA.getFgAnsi("accent"));

      // Same getter, new ctx.ui.theme: the next render is recolored.
      ui = { theme: themeB, notify() {} };
      const second = tool.render(WIDTH)[0];
      expect(second).toContain(themeB.getFgAnsi("accent"));
      expect(second).not.toBe(first);
      expect(visible(second)).toBe(visible(first));

      // The original factory mock (ui with notify only) has no theme: the
      // header still renders its label, uncolored, and nothing throws.
      ui = { notify() {} };
      const third = tool.render(WIDTH)[0];
      expect(visible(third)).toBe(`${FOLDED} ${LABEL} 1 次工具调用`);
      expect(third).not.toContain("\x1b[");
    } finally {
      runtime.onSessionShutdown();
    }
    // Shutdown drops the getter so the process-global runtime cannot pin
    // the dead session's ctx closure.
    expect(runtime.debugHasThemeGetter()).toBe(false);
  });
});
