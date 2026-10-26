/**
 * Render projection tests (change task 3.1).
 *
 * Pins the host adapter against real components: bound components without
 * a plan pass the predecessor's exact array through; hidden members render
 * nothing; summary projections render in place; mixed assistant messages
 * drop only the hidden thinking runs while text keeps byte-exact lines and
 * OSC 133 markers re-anchor to the visible extent; unbound components
 * (foreign panels) are untouched; uninstall restores the prototypes; and
 * no renderer's returned or cached array is mutated.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  bindComponent,
  installRenderProjection,
  isBound,
  unbindComponent,
  type Projection,
} from "../src/host-adapter.ts";

const WIDTH = 80;
const stripOsc = (line: string) => line.replace(/\x1b\]133;[ABC]\x07/g, "");

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

/** Captured at module load, before any install wraps the prototype. */
const pristineToolRender = ToolExecutionComponent.prototype.render;

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

function mixedComponent(): AssistantMessageComponent {
  const component = new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
  );
  component.updateContent(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "alpha thinking" },
        { type: "text", text: "middle note" },
        { type: "thinking", thinking: "beta thinking" },
        { type: "text", text: "final answer" },
      ],
    } as never,
    false,
  );
  return component;
}

describe("render projection", () => {
  let cleanup: (() => void) | undefined;
  let plan: (projection: Projection | undefined) => void;
  let active: Projection | undefined;

  beforeAll(() => {
    initTheme();
    const install = installRenderProjection((component) => {
      // Only bound components are ever consulted; the plan mirrors the
      // view's current decision for the bound member.
      return isBound(component) ? active : undefined;
    });
    expect(install.available).toBe(true);
    cleanup = install.cleanup;
    plan = (projection: Projection | undefined) => {
      active = projection;
    };
  });

  afterAll(() => {
    cleanup?.();
  });

  test("bound components without a plan render exactly as unbound", () => {
    const tool = toolComponent("t1");
    const baseline = tool.render(WIDTH);
    bindComponent(tool);
    plan(undefined);
    expect(tool.render(WIDTH)).toEqual(baseline);
    unbindComponent(tool);
  });

  test("foreign components sharing the class are untouched", () => {
    const foreign = toolComponent("foreign");
    expect(isBound(foreign)).toBe(false);
    plan({ kind: "hide" });
    // No binding: the hide plan must not apply.
    const lines = foreign.render(WIDTH);
    expect(lines.length).toBeGreaterThan(0);
    expect(stripTerminalSequences(lines.join("\n"))).toContain("echo foreign");
  });

  test("a hidden member renders nothing", () => {
    const tool = toolComponent("t2");
    bindComponent(tool);
    plan({ kind: "hide" });
    expect(tool.render(WIDTH)).toEqual([]);
    plan(undefined);
    expect(tool.render(WIDTH).length).toBeGreaterThan(0);
    unbindComponent(tool);
  });

  test("a summary projection renders its lines in the member's place", () => {
    const custom = new CustomMessageComponent({
      role: "custom",
      customType: "pi-goal-audit-event",
      content: "audit note body",
      display: true,
      timestamp: Date.now(),
    });
    bindComponent(custom);
    plan({ kind: "summary", token: undefined, lineFor: () => "▸ 2 tools" });
    expect(custom.render(WIDTH)).toEqual(["▸ 2 tools"]);
    plan(undefined);
    unbindComponent(custom);
  });

  test("mixed assistant messages hide only the selected thinking runs", () => {
    const component = mixedComponent();
    bindComponent(component);

    plan(undefined);
    const full = component.render(WIDTH).map(stripOsc);
    expect(stripTerminalSequences(full.join("\n"))).toContain("alpha thinking");
    expect(stripTerminalSequences(full.join("\n"))).toContain("beta thinking");

    plan({ kind: "hideThinkingRuns", hiddenRuns: new Set([0]) });
    const filtered = component.render(WIDTH);
    const plain = stripTerminalSequences(filtered.map(stripOsc).join("\n"));
    expect(plain).not.toContain("alpha thinking");
    expect(plain).toContain("beta thinking");
    // The text block keeps its exact rendered line.
    const textLine = full
      .map(stripOsc)
      .find((line) => stripTerminalSequences(line).includes("final answer"));
    expect(textLine).toBeDefined();
    expect(filtered.map(stripOsc)).toContain(textLine);

    // OSC 133 markers anchor the visible extent.
    expect(filtered[0].startsWith("\x1b]133;A\x07")).toBe(true);
    expect(filtered[filtered.length - 1].includes("\x1b]133;B\x07")).toBe(true);
    expect(filtered[filtered.length - 1].includes("\x1b]133;C\x07")).toBe(true);

    plan({ kind: "hideThinkingRuns", hiddenRuns: new Set([0, 1]) });
    const bothHidden = component.render(WIDTH);
    expect(
      stripTerminalSequences(bothHidden.map(stripOsc).join("\n")),
    ).not.toContain("thinking");
    expect(
      stripTerminalSequences(bothHidden.map(stripOsc).join("\n")),
    ).toContain("final answer");

    unbindComponent(component);
  });

  test("rendering through the wrapper leaves the component's cache intact", () => {
    const component = mixedComponent();
    bindComponent(component);
    plan(undefined);
    const before = component.render(WIDTH);
    plan({ kind: "hideThinkingRuns", hiddenRuns: new Set([0]) });
    component.render(WIDTH);
    plan(undefined);
    const after = component.render(WIDTH);
    expect(after).toEqual(before);
    unbindComponent(component);
  });

  test("an expanded group's carrier adds only the title above its own output", () => {
    const tool = toolComponent("t9");
    bindComponent(tool);
    plan(undefined);
    const own = tool.render(WIDTH);

    plan({
      kind: "titled",
      token: undefined,
      titleFor: () => "▾ 2 次工具调用",
    });
    const expanded = tool.render(WIDTH);
    expect(expanded.length).toBe(own.length + 1);
    expect(expanded[0]).toBe("▾ 2 次工具调用");
    // Below the title: byte-identical lines at the same width — no list,
    // no indentation, no re-wrapped borders.
    expect(expanded.slice(1)).toEqual(own);

    // The member's own expansion state is untouched by the group view.
    const expandedField = (tool as unknown as { expanded?: boolean }).expanded;
    plan(undefined);
    expect((tool as unknown as { expanded?: boolean }).expanded).toBe(
      expandedField,
    );
    unbindComponent(tool);
  });

  test("group toggles never touch thinkingVisibilityOverrides", () => {
    const component = mixedComponent();
    bindComponent(component);
    const overrides = (
      component as unknown as {
        thinkingVisibilityOverrides: Map<number, boolean>;
      }
    ).thinkingVisibilityOverrides;
    expect(overrides.size).toBe(0);

    plan({ kind: "hideThinkingRuns", hiddenRuns: new Set([0]) });
    component.render(WIDTH);
    expect(overrides.size).toBe(0);

    plan({ kind: "titled", token: undefined, titleFor: () => "▾ 1 段思考" });
    component.render(WIDTH);
    expect(overrides.size).toBe(0);
    // The renderer's own hiding field is untouched too.
    expect(
      (component as unknown as { hideThinkingBlock?: boolean })
        .hideThinkingBlock,
    ).toBe(false);
    unbindComponent(component);
  });

  test("a renderer-configured hidden output stays hidden under an expanded group", () => {
    // A tool whose own renderer yields a single placeholder line, the way
    // pi-tool-display's hidden mode yields (almost) nothing: the group view
    // must not force the content back on.
    const definition = {
      renderResult: () => new Text("[hidden by renderer]", 1, 0),
    };
    const component = new ToolExecutionComponent(
      "read",
      "r1",
      { path: "/tmp/x" },
      {},
      definition as never,
      stubUi() as never,
      "/tmp",
    );
    component.updateResult(
      { content: [{ type: "text", text: "file body" }], isError: false },
      false,
    );
    const own = component.render(WIDTH);
    expect(stripTerminalSequences(own.join("\n"))).toContain(
      "[hidden by renderer]",
    );
    expect(stripTerminalSequences(own.join("\n"))).not.toContain("file body");

    bindComponent(component);
    plan({
      kind: "titled",
      token: undefined,
      titleFor: () => "▾ 1 次工具调用",
    });
    const expanded = component.render(WIDTH);
    expect(expanded[0]).toBe("▾ 1 次工具调用");
    expect(expanded.slice(1)).toEqual(own);
    expect(stripTerminalSequences(expanded.join("\n"))).not.toContain(
      "file body",
    );
    unbindComponent(component);
  });

  test("uninstalling restores the pristine prototype methods", () => {
    const install = installRenderProjection(() => undefined);
    expect(install.available).toBe(true);
    install.cleanup();
    // Tear down the shared install from beforeAll as well.
    cleanup?.();
    cleanup = undefined;
    expect(ToolExecutionComponent.prototype.render).toBe(pristineToolRender);
  });
});
