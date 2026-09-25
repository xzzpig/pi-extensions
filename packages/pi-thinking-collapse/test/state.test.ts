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

/**
 * Pi's per-run thinking visibility overrides, written by the renderer's own
 * `MouseRegion` click handler (`set(runIndex, !hidden)`). A TS-private field
 * that exists at runtime — the state the native click path owns, which this
 * package's removed click handler used to duplicate.
 */
function overridesOf(
  component: AssistantMessageComponent,
): Map<number, boolean> {
  // SAFETY: `AssistantMessageComponent` stores this as a plain instance field
  // (TS `private` is erased in the compiled output), as pi-tui >= 0.85 does.
  return (
    component as unknown as {
      thinkingVisibilityOverrides: Map<number, boolean>;
    }
  ).thinkingVisibilityOverrides;
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

  test("global hide (ctrl+t) wins over streaming", () => {
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

    // Clearing the global toggle restores auto behavior: collapsed when done.
    component.setHideThinkingBlock(false);
    component.updateContent(message as never, false);
    expect(stripped(component).join("\n")).not.toContain("checking files");

    // And streaming shows again.
    component.updateContent(message as never, true);
    expect(stripped(component).join("\n")).toContain("checking files");
  });

  test("a rebuilt message component defaults to collapsed", () => {
    const message = assistantMessage("checking files", "done");

    // Session rebuild constructs a fresh component from the persisted message.
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

  test("Pi's own click toggle still works, and auto-collapse does not clobber it", () => {
    // Clicking a thinking block is Pi's feature: the renderer wraps the block
    // in a `MouseRegion` whose handler flips a per-run entry in the
    // component's own `thinkingVisibilityOverrides` map, and that map takes
    // precedence over the global `hideThinkingBlock` flag this package
    // writes. Removing this package's competing click handler must leave the
    // native path intact — and the automatic collapse must not undo it.
    const message = assistantMessage("checking files", "done");
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );

    component.updateContent(message as never, false);
    expect(stripped(component).join("\n")).not.toContain("checking files");

    // Pi's click: unhide run 0, then re-render — exactly what the
    // `MouseRegion` handler does with `set(runIndex, !hidden)`.
    overridesOf(component).set(0, false);
    component.updateContent(message as never, false);
    expect(stripped(component).join("\n")).toContain("checking files");

    // A later automatic pass respects that choice: the effective flag stays
    // collapsed, yet the per-run override wins in Pi's own read
    // (`overrides.get(runIndex) ?? hideThinkingBlock`).
    expect(like(component).hideThinkingBlock).toBe(true);
    expect(stripped(component).join("\n")).toContain("checking files");

    // `ctrl+t` still wins over everything: Pi's global toggle clears the
    // per-run overrides and hides the text again.
    component.setHideThinkingBlock(true);
    expect(stripped(component).join("\n")).not.toContain("checking files");
  });
});
