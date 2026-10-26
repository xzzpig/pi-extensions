/**
 * Combination matrix with the original beautification plugins
 * (change tasks 6.1 + 3.3 closure).
 *
 * Drives the real sibling packages in-process:
 *
 * - pi-thinking-collapse's actual CollapseController (its prototype state
 *   machine) alongside this package's runtime, in both install orders and
 *   across repeated reload cycles — coexistence, not replacement;
 * - pi-tool-display's actual renderers (bash call with tail semantics,
 *   edit diff result, write diff result) as the toolDefinition behind
 *   ToolExecutionComponents, rendered through this package's projection —
 *   folded summaries, byte-identical expanded content, hidden-mode output
 *   staying hidden, and the custom message's own expand interaction
 *   untouched.
 *
 * Existing suites of the sibling packages keep passing unchanged
 * (starline 981, thinking-collapse, tool-display) — nothing here loosens
 * them; this file only adds coexistence evidence.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  CollapseController,
  COLLAPSED_AFFORDANCE_LABEL,
} from "@xzzpig/pi-thinking-collapse/src/state.ts";
// pi-tool-display's exports map hides its sources from package imports;
// the composition matrix drives the real renderer modules by path.
import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  type ToolDisplayConfig,
} from "../../pi-tool-display/src/types.ts";
import { renderBashCall } from "../../pi-tool-display/src/bash-display.ts";
import {
  renderEditDiffResult,
  renderWriteDiffResult,
} from "../../pi-tool-display/src/diff-renderer.ts";
import { GroupCollapseRuntime } from "../src/runtime.ts";

const WIDTH = 80;

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
};

const config: ToolDisplayConfig = { ...DEFAULT_TOOL_DISPLAY_CONFIG };

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

function toolWith(
  toolName: string,
  toolCallId: string,
  args: unknown,
  toolDefinition: unknown,
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    toolName,
    toolCallId,
    args,
    {},
    toolDefinition as never,
    stubUi() as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: "result body" }], isError: false },
    false,
  );
  return component;
}

const bashDefinition = {
  renderCall: (args: unknown, t: unknown, context: unknown) =>
    renderBashCall(args as never, t as never, context as never, config),
};

const editDefinition = {
  renderResult: (
    result: { details?: unknown },
    options: { expanded: boolean },
  ) =>
    renderEditDiffResult(
      result.details,
      { ...options, filePath: "/tmp/demo.ts" },
      config,
      theme,
      "result body",
    ),
};

const writeDefinition = {
  renderResult: (
    result: { content?: { text?: string }[] },
    options: { expanded: boolean; filePath?: string },
  ) =>
    renderWriteDiffResult(
      result.content?.[0]?.text,
      { ...options, filePath: "/tmp/new.ts", fileExistedBeforeWrite: false },
      config,
      theme,
      "result body",
    ),
};

describe("combination matrix", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };
  let controller: CollapseController;
  let pristineToolRender: unknown;
  let pristineAssistantRender: unknown;

  beforeAll(() => {
    initTheme();
    pristineToolRender = ToolExecutionComponent.prototype.render;
    pristineAssistantRender = AssistantMessageComponent.prototype.render;
  });

  const startRuntime = () => {
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
  };

  const stopRuntime = () => runtime.onSessionShutdown();

  const settleOneTool = (tool: ToolExecutionComponent) => {
    runtime.handlePiEvent({ type: "agent_start" });
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
  };

  test("runtime first, controller second: both behaviors coexist", () => {
    startRuntime();
    controller = new CollapseController();
    controller.install();
    try {
      // Our folding works…
      const tool = toolWith(
        "bash",
        "t1",
        { command: "echo hi" },
        bashDefinition,
      );
      settleOneTool(tool);
      expect(tool.render(WIDTH).length).toBe(1);

      // …and the controller's message_end auto-collapse works on a fresh
      // assistant message.
      const assistant = new AssistantMessageComponent(
        undefined,
        false,
        getMarkdownTheme(),
      );
      const message = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "some thinking" },
          { type: "text", text: "answer" },
        ],
      };
      assistant.updateContent(message as never, true);
      assistant.updateContent(message as never, false);
      expect(
        (assistant as unknown as { hideThinkingBlock?: boolean })
          .hideThinkingBlock,
      ).toBe(true);
      expect(plain(assistant.render(WIDTH))).toContain(
        COLLAPSED_AFFORDANCE_LABEL,
      );
      expect(plain(assistant.render(WIDTH))).toContain("answer");
    } finally {
      controller.dispose();
      stopRuntime();
    }
  });

  test("controller first, runtime second: same coexistence", () => {
    controller = new CollapseController();
    controller.install();
    startRuntime();
    try {
      const assistant = new AssistantMessageComponent(
        undefined,
        false,
        getMarkdownTheme(),
      );
      const message = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "more thinking" },
          { type: "text", text: "answer two" },
        ],
      };
      assistant.updateContent(message as never, true);
      assistant.updateContent(message as never, false);
      expect(plain(assistant.render(WIDTH))).toContain(
        COLLAPSED_AFFORDANCE_LABEL,
      );

      const tool = toolWith(
        "bash",
        "t1",
        { command: "echo two" },
        bashDefinition,
      );
      settleOneTool(tool);
      expect(tool.render(WIDTH).length).toBe(1);
    } finally {
      stopRuntime();
      controller.dispose();
    }
  });

  test("consecutive reload cycles keep exactly one wrapper and both behaviors", () => {
    startRuntime();
    try {
      for (let cycle = 0; cycle < 4; cycle++) {
        stopRuntime();
        // After uninstall the prototype is byte-back to the pristine method.
        expect(ToolExecutionComponent.prototype.render).toBe(
          pristineToolRender,
        );
        expect(AssistantMessageComponent.prototype.render).toBe(
          pristineAssistantRender,
        );
        startRuntime();
      }
      // Everything still works after the last reinstall.
      const tool = toolWith(
        "bash",
        "t1",
        { command: "echo again" },
        bashDefinition,
      );
      settleOneTool(tool);
      expect(tool.render(WIDTH).length).toBe(1);
    } finally {
      stopRuntime();
    }
  });

  describe("pi-tool-display real renderers under the projection", () => {
    beforeAll(() => {
      startRuntime();
    });

    afterAll(() => {
      stopRuntime();
    });

    test("bash call with tail semantics folds to a summary and restores byte-identically", () => {
      const tool = toolWith(
        "bash",
        "t1",
        { command: "echo hello" },
        bashDefinition,
      );
      settleOneTool(tool);
      const own = tool.render(WIDTH);
      expect(own.length).toBe(1); // folded summary
      expect(plain(own)).toContain("1 次工具调用");

      // Expand: the real bash renderer's output comes back unchanged.
      dispatchToggle(tool);
      const expanded = tool.render(WIDTH);
      expect(expanded.length).toBeGreaterThan(1);
      expect(plain(expanded)).toContain("echo hello");
      // Collapse again through the same shell row.
      dispatchToggle(tool);
      expect(tool.render(WIDTH).length).toBe(1);
    });

    test("edit diff result keeps its real rendering under a group title", () => {
      const details = {
        diff: [
          "--- a/demo.ts",
          "+++ b/demo.ts",
          "@@ -1,2 +1,2 @@",
          "-old line",
          "+new line",
        ].join("\n"),
      };
      const tool = toolWith(
        "edit",
        "t1",
        { file_path: "/tmp/demo.ts" },
        editDefinition,
      );
      // Seed the result the way the host would: details ride the result.
      tool.updateResult(
        {
          content: [{ type: "text", text: "result body" }],
          details,
          isError: false,
        },
        false,
      );
      settleOneTool(tool);
      const own = tool.render(WIDTH);
      expect(own.length).toBe(1);

      dispatchToggle(tool);
      const expanded = tool.render(WIDTH);
      const text = plain(expanded);
      expect(text).toContain("new line");
      expect(text).toContain("old line");
      // Title row added exactly one line above the real diff rendering.
      expect(expanded[0]).toContain("1 次工具调用");
      dispatchToggle(tool);
      expect(tool.render(WIDTH).length).toBe(1);
    });

    test("write diff result renders its real content under a group title", () => {
      const tool = toolWith(
        "write",
        "t1",
        { file_path: "/tmp/new.ts" },
        writeDefinition,
      );
      tool.updateResult(
        {
          content: [{ type: "text", text: "const value = 42;\n" }],
          isError: false,
        },
        false,
      );
      settleOneTool(tool);
      expect(tool.render(WIDTH).length).toBe(1);
      dispatchToggle(tool);
      const expanded = tool.render(WIDTH);
      expect(plain(expanded)).toContain("const value = 42;");
      dispatchToggle(tool);
      expect(tool.render(WIDTH).length).toBe(1);
    });

    test("a renderer-declared hidden output stays hidden under the group", () => {
      // pi-tool-display's hidden mode: the renderer yields an empty body.
      const hiddenDefinition = {
        renderResult: () => ({ render: (width: number) => [] as string[] }),
      };
      const tool = toolWith("read", "t1", { path: "/tmp/x" }, hiddenDefinition);
      settleOneTool(tool);
      expect(tool.render(WIDTH).length).toBe(1);
      dispatchToggle(tool);
      const expanded = tool.render(WIDTH);
      // Title added above the call shell; the hidden body stays empty —
      // the group never forces content back on.
      expect(expanded[0]).toContain("1 次工具调用");
      expect(plain(expanded)).not.toContain("result body");
    });

    test("a custom message's own expand interaction survives the group view", () => {
      runtime.debugApplyPolicyRules([
        {
          kind: "customMessage",
          customType: "pi-goal-audit-event",
          action: "group",
        },
      ]);
      runtime.handlePiEvent({ type: "agent_start" });
      const custom = new CustomMessageComponent(
        {
          role: "custom",
          customType: "pi-goal-audit-event",
          content: "audit body",
          display: true,
          timestamp: Date.now(),
        },
        undefined,
        getMarkdownTheme(),
      );
      receiver.chatContainer.addChild(custom);
      runtime.syncReceiver(receiver);
      runtime.handlePiEvent({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      runtime.handlePiEvent({ type: "agent_settled", aborted: false });
      expect(custom.render(WIDTH).length).toBe(1);

      // Group expand first: title row plus the provider's own content.
      dispatchToggle(custom);
      const expanded = custom.render(WIDTH);
      expect(plain(expanded)).toContain("audit body");
      expect(plain(expanded)).toContain("1 条消息");

      // The member's own expand state keeps functioning under the open
      // group: collapsing the member truncates its body while the group
      // title stays.
      custom.setExpanded(false);
      const memberCollapsed = custom.render(WIDTH);
      expect(memberCollapsed[0]).toContain("1 条消息");
      // And re-expanding it restores the body — the group view did not
      // take over the member's own interaction.
      custom.setExpanded(true);
      expect(plain(custom.render(WIDTH))).toContain("audit body");
    });
  });
});

/** Plain click on the shell row via the component's own mouse path. */
function dispatchToggle(component: object): void {
  const handler = (
    component as unknown as {
      handleMouse(event: unknown): unknown;
    }
  ).handleMouse;
  const event = (type: string): unknown => ({
    type,
    x: 2,
    y: 0,
    button: "left",
    width: WIDTH,
    height: 24,
    screenX: 2,
    screenY: 0,
    shift: false,
    alt: false,
    ctrl: false,
  });
  handler.call(component, event("press"));
  handler.call(component, event("release"));
}
