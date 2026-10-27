/**
 * Disclosure arrow contract (bugfix: an expanded group kept ▸).
 *
 * The summary/title row is the group's only state indicator, so the arrow
 * must follow the *group* state, not the render path:
 *
 * - a folded group's summary carries ▸;
 * - an expanded group's title row carries ▾;
 * - collapsing again restores ▸;
 * - the arrow is derived from the group's own folded state only — never
 *   from a member component's `expanded`, and never from the explicit
 *   expand-target's toggle direction (that boolean is where the click is
 *   going, not where the group is);
 * - counts, failure markers, and the width fallback stay unchanged, and
 *   the arrow never depends on how often something re-rendered.
 *
 * The runtime tests drive real components through real events: a folded
 * tool carrier toggled by a synthesized click, the `/group-collapse`
 * commands, and two thinking groups living inside one assistant message
 * (only the clicked group may change its arrow).
 */

import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import { summaryCacheKey, summaryLine } from "../src/view.ts";
import type { SegmentSummary } from "../src/model.ts";

const WIDTH = 80;
const FOLDED = "▸";
const EXPANDED = "▾";

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

const text = (component: { render(w: number): string[] }, w = WIDTH): string =>
  plain(component.render(w));

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

const start = (): {
  runtime: GroupCollapseRuntime;
  receiver: { chatContainer: Container };
} => {
  initTheme();
  const runtime = new GroupCollapseRuntime({ notify: () => {} });
  const receiver = { chatContainer: new Container() };
  runtime.onSessionStart({
    mode: "tui",
    cwd: "/tmp/no-config-disclosure",
    getBranch: () => [],
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

/** The disclosure arrow at the head of a rendered line, if any. */
const arrowOf = (line: string): string | undefined => {
  const head = stripTerminalSequences(line).trimStart()[0];
  return head === FOLDED || head === EXPANDED ? head : undefined;
};

const arrowsIn = (lines: readonly string[]): (string | undefined)[] =>
  lines.map(arrowOf).filter((arrow) => arrow !== undefined);

const rowsWith = (lines: readonly string[], needle: string): number[] =>
  lines
    .map((line, row) => ({ row, text: stripTerminalSequences(line) }))
    .filter((entry) => entry.text.includes(needle))
    .map((entry) => entry.row);

describe("summaryLine disclosure state", () => {
  test("a folded summary shows ▸ and an expanded one shows ▾", () => {
    const counts = summary({ tools: 4, thinking: 3, messages: 2 });
    expect(summaryLine(counts, { width: WIDTH })).toBe(
      "▸ 4 次工具调用 · 3 段思考 · 2 条消息",
    );
    expect(summaryLine(counts, { width: WIDTH, expanded: true })).toBe(
      "▾ 4 次工具调用 · 3 段思考 · 2 条消息",
    );
  });

  test("the folded state stays the default", () => {
    const counts = summary({ tools: 1 });
    expect(summaryLine(counts, { width: WIDTH, expanded: false })).toBe(
      summaryLine(counts, { width: WIDTH }),
    );
  });

  test("failure and warning markers survive both states", () => {
    expect(
      summaryLine(summary({ tools: 2, failed: 1 }), {
        width: WIDTH,
        expanded: true,
      }),
    ).toBe("▾ ✗ 2 次工具调用");
    expect(
      summaryLine(summary({ messages: 1, warnings: 1 }), {
        width: WIDTH,
        expanded: true,
      }),
    ).toBe("▾ ⚠ 1 条消息");
  });

  test("the summary cache key covers the disclosure state", () => {
    const counts = summary({ tools: 1 });
    expect(summaryCacheKey(counts, true)).not.toBe(summaryCacheKey(counts));
    expect(summaryCacheKey(counts, false)).toBe(summaryCacheKey(counts));
  });

  test("both states measure and degrade identically across widths", () => {
    const counts = summary({
      tools: 123,
      thinking: 45,
      messages: 6,
      warnings: 1,
    });
    for (let width = 1; width <= 40; width++) {
      const folded = summaryLine(counts, { width });
      const expanded = summaryLine(counts, { width, expanded: true });
      // The same widths fit, and a fitting line keeps the same cell count:
      // only the marker glyph differs, never the layout.
      expect(expanded === undefined).toBe(folded === undefined);
      if (folded !== undefined && expanded !== undefined) {
        expect(visibleWidth(expanded)).toBe(visibleWidth(folded));
        expect(expanded.slice(1)).toBe(folded.slice(1));
      }
    }
  });
});

describe("runtime disclosure: tool carriers", () => {
  test("a clicked group shows ▾ while open and ▸ again when closed", () => {
    const { runtime, receiver } = start();
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1", "t2"]);

      expect(arrowsIn(tool.render(WIDTH))).toEqual([FOLDED]);
      expect(text(tool)).toContain("2 次工具调用");

      click(tool, 0);
      expect(arrowsIn(tool.render(WIDTH))).toEqual([EXPANDED]);
      expect(text(tool)).toContain("2 次工具调用");
      // The member body really came back below the title.
      expect(text(tool)).toContain("echo t1");

      click(tool, 0);
      expect(arrowsIn(tool.render(WIDTH))).toEqual([FOLDED]);
      expect(text(tool)).toContain("2 次工具调用");
      expect(text(tool)).not.toContain("echo t1");
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("the failure marker and counts are unchanged by the arrow", () => {
    const { runtime, receiver } = start();
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["f1"], true);
      expect(text(tool)).toContain("▸ ✗ 分组 1 次工具调用");

      click(tool, 0);
      expect(text(tool)).toContain("▾ ✗ 分组 1 次工具调用");
    } finally {
      runtime.onSessionShutdown();
    }
  });
});

describe("runtime disclosure: /group-collapse commands", () => {
  test("expandAll titles show ▾ and collapseAll restores ▸", () => {
    const { runtime, receiver } = start();
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1"]);
      expect(arrowsIn(tool.render(WIDTH))).toEqual([FOLDED]);

      expect(runtime.expandAll()).toBe(1);
      expect(arrowsIn(tool.render(WIDTH))).toEqual([EXPANDED]);

      expect(runtime.collapseAll()).toBe(1);
      expect(arrowsIn(tool.render(WIDTH))).toEqual([FOLDED]);
    } finally {
      runtime.onSessionShutdown();
    }
  });
});

describe("runtime disclosure: thinking-run titles", () => {
  test("one message with two groups: only the clicked group flips", () => {
    const { runtime, receiver } = start();
    try {
      runtime.handlePiEvent({ type: "agent_start" });
      // Two thinking runs split into two groups by the visible text
      // between them, both inside the same assistant message.
      const assistant = makeAssistant([
        { type: "thinking", thinking: "ALPHA-THOUGHT" },
        { type: "text", text: "middle answer" },
        { type: "thinking", thinking: "BETA-THOUGHT" },
      ]);
      receiver.chatContainer.addChild(assistant);
      runtime.syncReceiver(receiver);
      runtime.handlePiEvent({ type: "agent_start" });
      settled(runtime);
      expect(runtime.debugFoldedIds().length).toBe(2);

      // Both groups folded: two ▸ summary rows, no thinking bodies.
      const folded = assistant.render(WIDTH);
      expect(arrowsIn(folded)).toEqual([FOLDED, FOLDED]);
      expect(plain(folded)).not.toContain("ALPHA-THOUGHT");
      expect(plain(folded)).not.toContain("BETA-THOUGHT");

      // Expand the first group only.
      const [firstSummaryRow] = rowsWith(folded, "1 段思考");
      click(assistant, firstSummaryRow);
      const oneOpen = assistant.render(WIDTH);
      expect(arrowsIn(oneOpen)).toEqual([EXPANDED, FOLDED]);
      expect(plain(oneOpen)).toContain("ALPHA-THOUGHT");
      expect(plain(oneOpen)).not.toContain("BETA-THOUGHT");

      // Collapse it again: back to the folded pair.
      click(assistant, rowsWith(oneOpen, "段思考")[0]);
      const refolded = assistant.render(WIDTH);
      expect(arrowsIn(refolded)).toEqual([FOLDED, FOLDED]);
      expect(plain(refolded)).not.toContain("ALPHA-THOUGHT");

      // Now the second group: its ▸ becomes ▾, the first stays ▸.
      click(assistant, rowsWith(refolded, "1 段思考")[1]);
      const otherOpen = assistant.render(WIDTH);
      expect(arrowsIn(otherOpen)).toEqual([FOLDED, EXPANDED]);
      expect(plain(otherOpen)).not.toContain("ALPHA-THOUGHT");
      expect(plain(otherOpen)).toContain("BETA-THOUGHT");
    } finally {
      runtime.onSessionShutdown();
    }
  });
});

describe("runtime disclosure: repaints and narrow widths", () => {
  test("repeated renders keep the arrow, never flip the group", () => {
    const { runtime, receiver } = start();
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1"]);
      click(tool, 0);
      for (let pass = 0; pass < 20; pass++) {
        runtime.syncReceiver(receiver);
        expect(arrowsIn(tool.render(WIDTH))).toEqual([EXPANDED]);
      }
      expect(arrowsIn(tool.render(WIDTH))).toEqual([EXPANDED]);
    } finally {
      runtime.onSessionShutdown();
    }
  });

  test("a too-narrow render falls back without changing the arrow state", () => {
    const { runtime, receiver } = start();
    try {
      const [tool] = foldedToolGroup(runtime, receiver, ["t1", "t2"]);
      click(tool, 0);
      expect(arrowsIn(tool.render(WIDTH))).toEqual([EXPANDED]);

      // Width 5 cannot fit the title: the member output renders through
      // and no arrow is drawn.
      expect(arrowsIn(tool.render(5))).toEqual([]);

      // The wide frame is unchanged: still open, still ▾.
      expect(arrowsIn(tool.render(WIDTH))).toEqual([EXPANDED]);
      expect(text(tool)).toContain("echo t1");

      // Same for the folded side: a narrow frame does not leave the
      // group stuck behind a summary, and the wide frame still reads ▸.
      const [second] = foldedToolGroup(runtime, receiver, ["t3"]);
      expect(arrowsIn(second.render(5))).toEqual([]);
      expect(arrowsIn(second.render(WIDTH))).toEqual([FOLDED]);
    } finally {
      runtime.onSessionShutdown();
    }
  });
});
