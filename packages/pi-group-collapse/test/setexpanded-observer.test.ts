/**
 * Composable setExpanded observer tests (change task 4.5).
 *
 * Pins: the native global expand (setExpanded(true) fanned out by ctrl+o)
 * makes a hidden member's quiet group reachable *before* running the
 * original method; setExpanded(false) collapses the member only and never
 * the group; ctrl+t's thinking hiding keeps its native meaning next to the
 * group view; and the observer never calls setExpanded itself, so nothing
 * feeds back.
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";

const WIDTH = 80;

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function toolComponent(id: string): ToolExecutionComponent {
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
    { content: [{ type: "text", text: `done ${id}` }], isError: false },
    false,
  );
  return component;
}

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

describe("setExpanded observer", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };
  let tool: ToolExecutionComponent;

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    tool = toolComponent("t1");
    receiver.chatContainer.addChild(tool);
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      isError: false,
    });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
  });

  test("native global expand reaches a member inside a hidden group", () => {
    expect(tool.render(WIDTH).length).toBe(1); // folded: content hidden

    // ctrl+o fans setExpanded(true) out to every member.
    tool.setExpanded(true);
    // The group became reachable first, then the member expanded.
    const lines = tool.render(WIDTH);
    expect(lines.length).toBeGreaterThan(1);
    expect(plain(lines)).toContain("echo t1");
    expect((tool as unknown as { expanded?: boolean }).expanded).toBe(true);
  });

  test("collapsing the member never collapses the group", () => {
    tool.setExpanded(true); // group reachable, member expanded
    tool.setExpanded(false); // native collapse of this member only
    const lines = tool.render(WIDTH);
    // The group is still open (content reachable), the member itself is
    // collapsed — its own state field says so.
    expect((tool as unknown as { expanded?: boolean }).expanded).toBe(false);
    expect(lines.length).toBeGreaterThan(1);
    expect(plain(lines)).toContain("echo t1");
  });

  test("member toggles do not re-fold the group (no feedback loop)", () => {
    tool.setExpanded(true);
    for (let index = 0; index < 5; index++) {
      tool.setExpanded(index % 2 === 0);
    }
    // Whatever the member did to itself, the group stayed open.
    expect(tool.render(WIDTH).length).toBeGreaterThan(1);
    expect(plain(tool.render(WIDTH))).toContain("echo t1");
  });

  test("ctrl+t thinking hiding keeps its native meaning", () => {
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "visible thinking" },
          { type: "text", text: "final answer" },
        ],
      } as never,
      false,
    );
    receiver.chatContainer.addChild(component);
    runtime.syncReceiver(receiver);

    // The renderer's own global hide still works on a bound component.
    component.setHideThinkingBlock(true);
    expect(plain(component.render(WIDTH)).includes("visible thinking")).toBe(
      false,
    );
    expect(plain(component.render(WIDTH))).toContain("final answer");

    // And restoring it works the same way.
    component.setHideThinkingBlock(false);
    expect(plain(component.render(WIDTH))).toContain("visible thinking");
  });
});
