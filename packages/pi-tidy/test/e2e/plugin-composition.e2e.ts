import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { hoverIsTracked } from "../../src/hover.ts";
import {
  createHostHarness,
  createIsolatedEnvironment,
  createTuiContext,
  PLUGIN_ORDER,
} from "./harness.ts";

test("all five real extensions compose with pi-tidy as the sole active user renderer", async () => {
  const environment = createIsolatedEnvironment();
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const tui = await import("@earendil-works/pi-tui");
    const host = createHostHarness();
    const originalUserRender = sdk.UserMessageComponent.prototype.render;
    let afterToolDisplay: typeof originalUserRender | undefined;
    let afterTidy: typeof originalUserRender | undefined;
    let beforeTidy: PrototypeSnapshot | undefined;
    for (const name of PLUGIN_ORDER) {
      if (name === "pi-tidy") beforeTidy = snapshotPrototypes(sdk, tui);
      await host.load(name);
      if (name === "pi-tool-display") afterToolDisplay = sdk.UserMessageComponent.prototype.render;
      if (name === "pi-tidy") afterTidy = sdk.UserMessageComponent.prototype.render;
    }
    assert.ok(beforeTidy, "prototype state was captured before pi-tidy loaded");
    assert.deepEqual(host.loadedPlugins, PLUGIN_ORDER);

    assert.ok(afterToolDisplay);
    assert.notEqual(afterToolDisplay, originalUserRender, "pi-tool-display installs its configured wrapper");
    assert.ok(afterTidy);
    assert.notEqual(afterTidy, afterToolDisplay, "pi-tidy installs its user-message frame");

    const ctx = await createTuiContext(environment.home);
    await host.fire("session_start", ctx);
    await host.fire("before_agent_start", ctx);

    const userPrototype = sdk.UserMessageComponent.prototype as typeof sdk.UserMessageComponent.prototype & {
      __piUserMessageNativePatched?: boolean;
      __toolboxFramed?: boolean;
      [key: symbol]: unknown;
    };
    const starlineRegistry = userPrototype[Symbol.for("pi-starline.prototype-patch-registry")] as Map<string, unknown> | undefined;
    assert.notEqual(starlineRegistry?.has("user-message-render"), true, "pi-starline no longer patches the user-message renderer");
    assert.equal(userPrototype.__piUserMessageNativePatched, true, "pi-tool-display's disabled pass-through wrapper is installed");
    assert.equal(userPrototype.__toolboxFramed, true, "pi-tidy installs the frame wrapper");
    assert.equal(sdk.UserMessageComponent.prototype.render, afterTidy, "session_start leaves pi-tidy as the only active renderer");

    const toolPrototype = sdk.ToolExecutionComponent.prototype as typeof sdk.ToolExecutionComponent.prototype & {
      __toolboxFramed?: boolean;
    };
    assert.notEqual(toolPrototype.__toolboxFramed, true, "frameTools=false leaves ToolExecutionComponent unframed by pi-tidy");
    assert.equal(hoverIsTracked(), true, "hover tracking remains installed for code-block copy controls");

    const toolDisplayConfig = JSON.parse(
      readFileSync(join(environment.agentDir, "extensions", "pi-tool-display", "config.json"), "utf-8"),
    ) as { enableNativeUserMessageBox?: boolean };
    assert.equal(toolDisplayConfig.enableNativeUserMessageBox, false);

    const snapshot = {
      pluginsLoadedInOrder: host.loadedPlugins,
      piToolDisplayUserMessageBox: "disabled-pass-through",
      activeUserMessageRenderers: ["pi-tidy"],
      piTidyToolFrames: toolPrototype.__toolboxFramed === true,
      piTidyHoverTracking: hoverIsTracked(),
    };
    const expected = JSON.parse(
      readFileSync(new URL("./fixtures/user-message-patch-chain.after.json", import.meta.url), "utf-8"),
    );
    assert.deepEqual(snapshot, expected, "post-Starline-removal owner-chain expectation");

    const groupModule = host.modules.get("pi-group-collapse");
    const groupRuntime = groupModule.getGroupCollapseRuntime(() => {});
    assert.equal(groupRuntime.isDisplayInstalled(), true, "group-collapse installed its real TUI display patches");
    const { Container, stripTerminalSequences } = tui;
    const thinkingMessage = {
      role: "assistant",
      provider: "test-provider",
      model: "e2e-model",
      timestamp: 1950,
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "private reasoning that should collapse" },
        { type: "text", text: "Running the two tool calls." },
        { type: "toolCall", id: "e2e-a", name: "bash", arguments: { command: "echo e2e-a" } },
        { type: "toolCall", id: "e2e-b", name: "bash", arguments: { command: "echo e2e-b" } },
      ],
    };
    const thinking = new sdk.AssistantMessageComponent(undefined, false, sdk.getMarkdownTheme());
    thinking.updateContent(thinkingMessage as any, true);
    thinking.updateContent(thinkingMessage as any, false);
    const turnState = await import("../../src/turns/turn-state.ts");
    const finalMessage = {
      role: "assistant",
      provider: "test-provider",
      model: "e2e-model",
      timestamp: 2000,
      durationMs: 50,
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "framed reply private reasoning" },
        { type: "text", text: "The final answer is ready." },
      ],
    };
    const store = new turnState.TurnStore();
    turnState.turnStore.set(store);
    store.begin(1900);
    store.note({ role: "user", content: "Please finish", timestamp: 1900 });
    store.note(thinkingMessage as any);
    store.note(finalMessage as any);
    store.settle(false, 2100);
    const answer = new sdk.AssistantMessageComponent(finalMessage as any, false);
    answer.updateContent(finalMessage as any, false);
    const collapsedAnswer = stripTerminalSequences(answer.render(80).join("\n"));
    assert.match(collapsedAnswer, /Thinking… \(click to expand\)/, "the collapsed thinking affordance survives outside the reply frame");
    assert.match(collapsedAnswer, /e2e-model/, "the final reply frame remains visible beside the thinking row");
    assert.match(collapsedAnswer, /The final answer is ready\./);
    assert.doesNotMatch(collapsedAnswer, /framed reply private reasoning/);

    const expandedThinking = answer.handleMouse({
      type: "click",
      button: "left",
      x: 1,
      y: 0,
      screenX: 1,
      screenY: 1,
      width: 80,
      height: collapsedAnswer.split("\n").length,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.equal(expandedThinking?.handled, true, "the native thinking row click expands the block");
    const expandedAnswer = stripTerminalSequences(answer.render(80).join("\n"));
    assert.match(expandedAnswer, /framed reply private reasoning/);
    assert.match(expandedAnswer, /e2e-model/, "expanding thinking does not remove the final reply frame");
    answer.handleMouse({
      type: "click",
      button: "left",
      x: 1,
      y: 0,
      screenX: 1,
      screenY: 1,
      width: 80,
      height: expandedAnswer.split("\n").length,
      shift: false,
      alt: false,
      ctrl: false,
    });

    const receiver = { chatContainer: new Container() };
    receiver.chatContainer.addChild(thinking);
    const makeTool = (id: string) => {
      const tool = new sdk.ToolExecutionComponent(
        "bash",
        id,
        { command: `echo ${id}` },
        {},
        undefined,
        { requestRender() {} } as never,
        environment.home,
      );
      tool.updateResult({ content: [{ type: "text", text: `done ${id}` }], isError: false, durationMs: 1 }, false);
      return tool;
    };
    groupRuntime.handlePiEvent({ type: "agent_start" });
    receiver.chatContainer.addChild(makeTool("e2e-a"));
    receiver.chatContainer.addChild(makeTool("e2e-b"));
    receiver.chatContainer.addChild(answer);
    groupRuntime.syncReceiver(receiver);
    groupRuntime.handlePiEvent({ type: "tool_execution_end", toolCallId: "e2e-a", isError: false });
    groupRuntime.handlePiEvent({ type: "tool_execution_end", toolCallId: "e2e-b", isError: false });
    groupRuntime.handlePiEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    groupRuntime.handlePiEvent({ type: "agent_settled", aborted: false });
    const groupLines = receiver.chatContainer.children.flatMap((child: any) => child.render(80));
    const combined = stripTerminalSequences(groupLines.join("\n"));
    assert.match(combined, /2 次工具调用|2 calls/, "group-collapse folds the completed tool run");
    assert.match(combined, /段思考|thought/, "the summary carries the folded thinking count");
    assert.match(combined, /e2e-model/, "pi-tidy draws the settled final reply frame");
    assert.match(combined, /The final answer is ready\./);
    assert.match(
      combined,
      /Thinking… \(click to expand\)/,
      "the earlier tool-use message keeps the native collapsed thinking affordance",
    );
    assert.doesNotMatch(
      combined,
      /framed reply private reasoning/,
      "the final reply's thinking stays collapsed outside its frame",
    );

    // A retry error must render one frame even though this composition puts
    // pi-group-collapse's render projection between tidy's boundary installs.
    // Nested boundary wrappers used to duplicate the first row (`error ×2`
    // drawn twice); only the outermost wrapper may restyle.
    const errorChat = new Container();
    const { installErrorLines } = await import("../../src/messages/error-lines.ts");
    installErrorLines(errorChat as never);
    const errorMessage = {
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
      timestamp: Date.now(),
      stopReason: "error" as const,
      errorMessage: "429: controlled rate limit",
      content: [],
    };
    const makeError = () => {
      const component = new sdk.AssistantMessageComponent(undefined, false, sdk.getMarkdownTheme());
      errorChat.addChild(component);
      component.updateContent(errorMessage, false);
      return component;
    };
    makeError();
    makeError();
    const errorRows = stripTerminalSequences(errorChat.render(80).join("\n"));
    assert.equal(
      errorRows.split("\n").filter((line) => line.includes("╭─ error ×2")).length,
      1,
      "two identical retry errors draw exactly one error ×2 frame in the five-plugin composition",
    );
    assert.equal(
      errorRows.split("\n").filter((line) => line.includes("│ Error: 429")).length,
      1,
      "the retry frame carries one error body",
    );

    const { tidyEnabled } = await import("../../src/live.ts");
    tidyEnabled.set(false);
    const afterTidyDisabled = receiver.chatContainer.children.flatMap((child: any) => child.render(80));
    assert.match(stripTerminalSequences(afterTidyDisabled.join("\n")), /2 次工具调用|2 calls/, "group-collapse remains active when tidy is disabled");
    assert.equal(groupRuntime.isDisplayInstalled(), true);

    // A reload that does not load pi-tidy leaves the four other plugins'
    // prototypes in place and none of pi-tidy's. Restoring the captured
    // pre-tidy descriptors is that state; render again to prove the patch
    // chain falls back to the predecessors without throwing.
    restorePrototypes(beforeTidy);
    assert.equal(
      sdk.UserMessageComponent.prototype.render,
      beforeTidy.get(sdk.UserMessageComponent.prototype)?.get("render")?.value,
      "pi-tidy's user-message patch is removed on reload without it",
    );
    assert.equal(
      sdk.ToolExecutionComponent.prototype.render,
      beforeTidy.get(sdk.ToolExecutionComponent.prototype)?.get("render")?.value,
      "pi-tidy's tool-box patch is removed on reload without it",
    );
    assert.equal(
      Object.hasOwn(
        sdk.AssistantMessageComponent.prototype.render as object,
        Symbol.for("pi-tidy:fork-thinking-row-render"),
      ),
      false,
      "pi-tidy's thinking-row render wrapper is gone",
    );
    assert.equal(
      (sdk.AssistantMessageComponent.prototype as { render: unknown }).render,
      beforeTidy.get(sdk.AssistantMessageComponent.prototype)?.get("render")?.value,
      "pi-tidy's assistant render patch is removed",
    );

    // A reload re-runs every surviving extension's session_start. pi-tidy is
    // not there to do so, but group-collapse reinstalls its projection.
    (groupRuntime as unknown as { installDisplays(): void }).installDisplays();
    assert.equal(groupRuntime.isDisplayInstalled(), true);

    const afterUnloadLines = receiver.chatContainer.children.flatMap((child: any) => child.render(80));
    const afterUnload = stripTerminalSequences(afterUnloadLines.join("\n"));
    assert.match(afterUnload, /2 次工具调用|2 calls/, "group-collapse folding survives pi-tidy's removal");
    assert.match(afterUnload, /The final answer is ready\./, "the settled reply renders through the remaining chain");

    await host.fire("session_shutdown", ctx, { reason: "reload" });
  } finally {
    environment.cleanup();
  }
});

/**
 * A snapshot of every own property on the prototypes pi-tidy patches (plus the
 * pi-tui containers its frame wrapping touches). Restoring it simulates a Pi
 * reload that does not load pi-tidy: the four other extensions' patches stay,
 * pi-tidy's are gone, and the chain must fall back to them.
 */
type PrototypeSnapshot = Map<object, Map<PropertyKey, PropertyDescriptor>>;

function prototypeTargets(sdk: any, tui: any): object[] {
  const classes = [
    sdk.UserMessageComponent,
    sdk.AssistantMessageComponent,
    sdk.ToolExecutionComponent,
    sdk.CustomMessageComponent,
    sdk.BashExecutionComponent,
    sdk.InteractiveMode,
    tui.TuiAltScreen,
    tui.Container,
    tui.Box,
    tui.Text,
    tui.Markdown,
  ];
  return [...new Set(classes.filter(Boolean).map((cls: any) => cls.prototype))];
}

function snapshotPrototypes(sdk: any, tui: any): PrototypeSnapshot {
  const snapshot: PrototypeSnapshot = new Map();
  for (const proto of prototypeTargets(sdk, tui)) {
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (descriptor) descriptors.set(key, descriptor);
    }
    snapshot.set(proto, descriptors);
  }
  return snapshot;
}

function restorePrototypes(snapshot: PrototypeSnapshot): void {
  for (const [proto, descriptors] of snapshot) {
    for (const key of Reflect.ownKeys(proto)) {
      if (!descriptors.has(key)) Reflect.deleteProperty(proto, key);
    }
    for (const [key, descriptor] of descriptors) {
      Object.defineProperty(proto, key, descriptor);
    }
  }
}
