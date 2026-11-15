// Regression: with fork defaults (frameTools=false, groupTools=false) the
// boundary renderer must treat a thinking+tool-use assistant message as a
// normal message, not as a group carrier. The carrier path renders nothing
// when no group exists, which made the thinking row vanish the moment a tool
// call arrived.

import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { installGroupBoundaries, setGroupingActive } from "../../src/tools/tool-group-view.ts";

initTheme("dark");

const message = {
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
  stopReason: "toolUse" as const,
  content: [
    { type: "thinking" as const, thinking: "plan the tool call" },
    { type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "echo hi" } },
  ],
};

function render(): string[] {
  const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
  component.updateContent(message, false);
  return component.render(60).map((line) => stripTerminalSequences(line));
}

test("grouping off keeps the thinking row on a tool-use assistant message", () => {
  setGroupingActive(() => false);
  installGroupBoundaries();
  const rows = render();
  assert.ok(
    rows.some((row) => row.includes("thinking") && row.includes("plan the tool call")),
    `expected a thinking row, got ${JSON.stringify(rows)}`,
  );
});

test("grouping on would treat the same message as an empty carrier", () => {
  setGroupingActive(() => true);
  installGroupBoundaries();
  assert.deepEqual(render(), []);
});
