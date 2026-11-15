// nativeThinking: the fork leaves thinking to Pi (and pi-thinking-collapse).
// The boundary renderer must not restyle it, and the framed final reply must
// restore the settled rows outside its border even when Pi shows them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { installGroupBoundaries, setGroupingActive, setNativeThinking } from "../../src/tools/tool-group-view.ts";

initTheme("dark");

const base = {
  role: "assistant" as const,
  api: "openai-completions" as const,
  provider: "e2e",
  model: "e2e-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: 1,
};

function render(stopReason: "stop" | "toolUse", content: unknown[], width = 60): string[] {
  const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
  component.updateContent({ ...base, stopReason, content } as never, false);
  return component.render(width).map((line) => stripTerminalSequences(line));
}

test("nativeThinking leaves the thinking text as Pi renders it", () => {
  setGroupingActive(() => false);
  setNativeThinking(() => true);
  installGroupBoundaries();
  const rows = render("toolUse", [
    { type: "thinking", thinking: "native thinking text" },
    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } },
  ]);
  assert.ok(rows.some((row) => row.includes("native thinking text")), JSON.stringify(rows));
  assert.ok(!rows.some((row) => row.includes("thinking  native")), "tidy's labelled row must not appear");
});

test("nativeThinking can be switched back to tidy's own row", () => {
  setGroupingActive(() => false);
  setNativeThinking(() => false);
  installGroupBoundaries();
  const rows = render("toolUse", [
    { type: "thinking", thinking: "tidy thinking text" },
    { type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo hi" } },
  ]);
  assert.ok(rows.some((row) => /thinking\s+tidy thinking text/.test(row)), JSON.stringify(rows));
});
