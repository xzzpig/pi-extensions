import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { agentRunning } from "../../src/live.ts";
import { getTheme } from "../../src/theme-access.ts";
import { patchToolBoxFrames } from "../../src/tools/tool-frame.ts";
import { renderGroupedTool } from "../../src/tools/tool-group-view.ts";
import { closeGroup, openGroup, resetGroups } from "../../src/tools/tool-groups.ts";

initTheme("dark");
const cwd = process.cwd();
const ui = { requestRender() {} };
const definition = createBashToolDefinition(cwd);
const options = { icons: false, pinned: false, highlight: false, rowLines: 1 };
const frameBox = () => [];
const plain = (rows: readonly string[]) => rows.join("\n").replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");

function finishedTool(id: string, command: string): ToolExecutionComponent {
  const tool = new ToolExecutionComponent("bash", id, { command }, {}, definition as any, ui as any, cwd);
  tool.setExpanded(false);
  tool.setArgsComplete();
  tool.markExecutionStarted();
  tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false, durationMs: 10 } as any, false);
  return tool;
}

test("agent activity keeps settled history cached while a partial tool still redraws", () => {
  const theme = getTheme()!;
  patchToolBoxFrames({ groupTools: true, groupOpen: false, backgroundJobs: false });
  resetGroups();
  agentRunning.set(false);
  try {
    const history = finishedTool("history", "echo stable history");
    const first = renderGroupedTool(history as any, 90, theme, options, frameBox)!;
    assert.ok(plain(first).includes("1 call"), plain(first));

    agentRunning.set(true);
    const duringNewTurn = renderGroupedTool(history as any, 90, theme, options, frameBox)!;
    assert.strictEqual(duringNewTurn, first, "a completed historical group reuses its exact rows during another run");
    assert.deepEqual(duringNewTurn, first);

    openGroup(history as any);
    const openedRow = renderGroupedTool(history as any, 90, theme, options, frameBox)!;
    assert.ok(plain(openedRow).includes("echo stable history"), plain(openedRow));
    history.setExpanded(true);
    const expanded = renderGroupedTool(history as any, 90, theme, options, () => ["historical-result-body"] )!;
    assert.ok(plain(expanded).includes("historical-result-body"), plain(expanded));
    closeGroup(history as any);
    history.setExpanded(false);
    const foldedAgain = renderGroupedTool(history as any, 90, theme, options, frameBox)!;
    assert.ok(plain(foldedAgain).includes("1 call"), plain(foldedAgain));
    assert.ok(!plain(foldedAgain).includes("echo stable history"), plain(foldedAgain));

    patchToolBoxFrames({ groupTools: true, groupOpen: true, backgroundJobs: false });
    resetGroups();
    const partial = new ToolExecutionComponent("bash", "active", { command: "echo before" }, {}, definition as any, ui as any, cwd);
    partial.setExpanded(false);
    partial.markExecutionStarted();
    partial.updateArgs({ command: "echo before" });
    const renderMixedFrame = () => [
      renderGroupedTool(history as any, 90, theme, options, frameBox)!,
      renderGroupedTool(partial as any, 90, theme, options, frameBox)!,
    ];
    const before = renderMixedFrame();
    assert.strictEqual(before[0], foldedAgain, "settled history retains its cache beside an active group");
    assert.ok(plain(before[1]!).includes("echo before"), plain(before[1]!));

    partial.updateArgs({ command: "echo after" });
    const after = renderMixedFrame();
    assert.strictEqual(after[0], foldedAgain, "updating the active group does not invalidate settled history");
    assert.notStrictEqual(after[1], before[1], "a partial tool does not reuse a live row");
    assert.ok(plain(after[1]!).includes("echo after"), plain(after[1]!));
  } finally {
    agentRunning.set(false);
    patchToolBoxFrames({ groupTools: true, groupOpen: false, backgroundJobs: false });
    resetGroups();
  }
});

test("a live group opens and updates beside collapsed historical groups", () => {
  const originalAgentRunning = agentRunning.get();
  patchToolBoxFrames({ groupTools: true, groupOpen: false, backgroundJobs: false });
  resetGroups();
  agentRunning.set(true);
  try {
    const history = finishedTool("history-mixed", "echo history stays folded");
    const boundary = new AssistantMessageComponent({
      role: "assistant", timestamp: 3000, stopReason: "stop",
      content: [{ type: "text", text: "A later task is running." }],
    } as any, true);
    const active = new ToolExecutionComponent("bash", "active-mixed", { command: "echo before" }, {}, definition as any, ui as any, cwd);
    active.setExpanded(false);
    active.markExecutionStarted();
    active.updateArgs({ command: "echo before" });
    const chat = new Container();
    chat.addChild(history);
    chat.addChild(boundary);
    chat.addChild(active);

    const render = () => chat.render(90).map((line) => stripVTControlCharacters(line));
    const first = render();
    const headers = first.map((line, index) => ({ line, index })).filter(({ line }) => line.includes("1 call"));
    assert.equal(headers.length, 2, first.join("\n"));
    assert.ok(first.some((line) => line.includes("A later task is running.")), first.join("\n"));

    const target = headers[1]!;
    chat.handleMouse({
      type: "click", button: "left", x: 4, y: target.index,
      screenX: 4, screenY: target.index, width: 90, height: first.length,
      shift: false, alt: false, ctrl: false,
    });
    const opened = render();
    assert.ok(opened.some((line) => line.includes("echo before")), opened.join("\n"));
    assert.ok(opened.some((line) => line.includes("echo history stays folded")) === false, "the historical group's body remains hidden");

    active.updateArgs({ command: "echo after" });
    const updated = render();
    assert.ok(updated.some((line) => line.includes("echo after")), updated.join("\n"));
    assert.ok(updated.some((line) => line.includes("1 call")), "the historical summary remains visible beside the updated active group");

    const openHeader = updated.findIndex((line) => line.includes("▾") && line.includes("1 call"));
    assert.ok(openHeader >= 0, updated.join("\n"));
    chat.handleMouse({
      type: "click", button: "left", x: 4, y: openHeader, screenX: 4, screenY: openHeader,
      width: 90, height: updated.length, shift: false, alt: false, ctrl: false,
    });
    const closed = render();
    assert.ok(!closed.some((line) => line.includes("echo after")), closed.join("\n"));
    assert.ok(closed.some((line) => line.includes("1 call")), "folding the active group leaves historical summaries visible");
  } finally {
    agentRunning.set(originalAgentRunning);
    patchToolBoxFrames({ groupTools: true, groupOpen: false, backgroundJobs: false });
    resetGroups();
  }
});
