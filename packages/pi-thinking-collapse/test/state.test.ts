import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  COLLAPSED_AFFORDANCE_LABEL,
  CollapseController,
  type AssistantMessageLike,
} from "../src/state.ts";

function assistantMessage(thinking: string, text: string): unknown {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
  };
}

/** Duck-typed read of pi's private fields, which the patch itself writes. */
function like(component: AssistantMessageComponent): AssistantMessageLike {
  // SAFETY: the patch reads/writes exactly these fields on real instances.
  return component as unknown as AssistantMessageLike;
}

function stripped(component: AssistantMessageComponent, width = 80): string[] {
  return component.render(width).map(stripTerminalSequences);
}

describe("thinking collapse state machine", () => {
  let controller: CollapseController;

  beforeAll(() => {
    initTheme();
    controller = new CollapseController();
    controller.install();
  });

  afterAll(() => {
    controller.dispose();
  });

  test("streaming keeps thinking visible", () => {
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(message as never, true);

    expect(like(component).hideThinkingBlock).toBe(false);
    const lines = stripped(component).join("\n");
    expect(lines).toContain("checking files");
  });

  test("message_end auto-collapses and shows the affordance label", () => {
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(message as never, true);
    component.updateContent(message as never, false);

    expect(like(component).hideThinkingBlock).toBe(true);
    const lines = stripped(component).join("\n");
    expect(lines).not.toContain("checking files");
    expect(lines).toContain(COLLAPSED_AFFORDANCE_LABEL);
    expect(lines).toContain("done");
  });

  test("click toggle pins a message expanded and back", () => {
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(message as never, true);
    component.updateContent(message as never, false);

    expect(controller.toggle(like(component))).toBe(true);
    expect(stripped(component).join("\n")).toContain("checking files");

    expect(controller.toggle(like(component))).toBe(true);
    expect(stripped(component).join("\n")).not.toContain("checking files");
  });

  test("click is ignored while the message is still streaming", () => {
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(message as never, true);

    expect(controller.toggle(like(component))).toBe(false);
    expect(stripped(component).join("\n")).toContain("checking files");
  });

  test("global hide (ctrl+t) wins over streaming and pins", () => {
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.setHideThinkingBlock(true);
    component.updateContent(message as never, true);

    // Streaming would show, but the user's global toggle hides everything.
    expect(like(component).hideThinkingBlock).toBe(true);
    expect(stripped(component).join("\n")).not.toContain("checking files");

    // Click cannot override the global toggle either.
    expect(controller.toggle(like(component))).toBe(false);

    // Clearing the global toggle restores auto behavior: collapsed when done.
    component.setHideThinkingBlock(false);
    component.updateContent(message as never, false);
    expect(stripped(component).join("\n")).not.toContain("checking files");

    // And streaming shows again.
    component.updateContent(message as never, true);
    expect(stripped(component).join("\n")).toContain("checking files");
  });

  test("pins survive a session rebuild keyed by the message object", () => {
    const message = assistantMessage("checking files", "done");
    const first = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    first.updateContent(message as never, true);
    first.updateContent(message as never, false);
    expect(controller.toggle(like(first))).toBe(true);
    expect(stripped(first).join("\n")).toContain("checking files");

    // Session rebuild constructs a fresh component from the persisted message.
    const rebuilt = new AssistantMessageComponent(
      message as never,
      false,
      getMarkdownTheme(),
    );
    expect(stripped(rebuilt).join("\n")).toContain("checking files");
    expect(like(rebuilt).hideThinkingBlock).toBe(false);
  });

  test("an unpinned rebuild defaults to collapsed", () => {
    const message = assistantMessage("checking files", "done");
    const first = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    first.updateContent(message as never, true);
    first.updateContent(message as never, false);

    const rebuilt = new AssistantMessageComponent(
      message as never,
      false,
      getMarkdownTheme(),
    );
    expect(like(rebuilt).hideThinkingBlock).toBe(true);
    expect(stripped(rebuilt).join("\n")).not.toContain("checking files");
    expect(stripped(rebuilt).join("\n")).toContain(COLLAPSED_AFFORDANCE_LABEL);
  });

  test("a custom hidden label is honored instead of the affordance", () => {
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      "自定义思考",
    );
    component.updateContent(message as never, true);
    component.updateContent(message as never, false);

    const lines = stripped(component).join("\n");
    expect(lines).toContain("自定义思考");
    expect(lines).not.toContain(COLLAPSED_AFFORDANCE_LABEL);
  });

  test("thinking children are recorded for click hit-testing", () => {
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(message as never, false);

    const refs = controller.thinkingChildrenOf(like(component));
    expect(refs).toBeDefined();
    expect(refs!.length).toBe(1);
    expect(refs![0]).toBe(
      (component as unknown as { contentContainer: { children: unknown[] } })
        .contentContainer.children[1],
    );
  });
});
