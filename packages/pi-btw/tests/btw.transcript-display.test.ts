import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  createTranscriptState,
  type TranscriptState,
} from "@xzzpig/pi-components/transcript";
// Test-only cross-package imports: pi-btw probes the global display API at
// runtime and never depends on pi-tool-display. Using the real provider keeps
// this consumer test aligned with its approved contract.
import { createToolPresentationProvider } from "../../pi-tool-display/src/tool-presentation";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../../pi-tool-display/src/types";
import {
  BtwToolDisplayAdapter,
  BtwTranscriptDisplay,
  readBtwToolDisplayApi,
  type BtwToolDisplayApi,
  type BtwToolPresentationRenderContext,
} from "../extensions/btw-transcript-display";
import { applyBtwTranscriptEvent } from "../extensions/btw-transcript-ingestion";

const DISPLAY_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

// SAFETY: the ingestion/display paths only read type, message, tool-call and
// tool-result fields. These fixtures provide exactly those; transport metadata
// (timestamps, usage, provider response ids) is irrelevant here.
function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function messageEvent(
  type: "message_start" | "message_update" | "message_end",
  role: "user" | "assistant",
  content: Array<Record<string, unknown>>,
): AgentSessionEvent {
  return event({ type, message: { role, content } });
}

function throwingRenderComponent(message: string): Component {
  return {
    render() {
      throw new Error(message);
    },
    invalidate() {},
  };
}

function throwingInvalidateComponent(message: string): Component {
  return {
    render() {
      return ["PRIMARY_OK"];
    },
    invalidate() {
      throw new Error(message);
    },
  };
}

function throwingMouseComponent(message: string): Component {
  return {
    render() {
      return ["PRIMARY_OK"];
    },
    invalidate() {},
    handleMouse() {
      throw new Error(message);
    },
  };
}

const mouseClick: TuiMouseEvent = {
  type: "click",
  button: "left",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 20,
  height: 1,
  shift: false,
  alt: false,
  ctrl: false,
  clickCount: 1,
};

function childDefinitionWithRenderers(
  options: {
    renderCall?: () => Component;
    renderResult?: () => Component;
  } = {},
): ToolDefinition {
  return {
    name: "read",
    label: "read",
    description: "read a file",
    parameters: {},
    execute: vi.fn(),
    ...(options.renderCall ? { renderCall: options.renderCall } : {}),
    ...(options.renderResult ? { renderResult: options.renderResult } : {}),
  } as unknown as ToolDefinition;
}

class StatefulToolComponent implements Component {
  renders = 0;
  invalidations = 0;
  mouseHandled = 0;

  constructor(private readonly output: string) {}

  render(): string[] {
    this.renders++;
    return [this.output];
  }

  invalidate(): void {
    this.invalidations++;
  }

  handleMouse(): { handled: boolean } {
    this.mouseHandled++;
    return { handled: true };
  }
}

function apply(
  state: TranscriptState,
  events: AgentSessionEvent[],
  onMutation: () => void = () => {},
): void {
  for (const next of events) {
    applyBtwTranscriptEvent(state, next, onMutation);
  }
}

function ingestToolCall(
  state: TranscriptState,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> = { path: "package.json" },
  result: unknown = { content: [{ type: "text", text: "tool output" }] },
): void {
  apply(state, [
    event({ type: "tool_execution_start", toolCallId, toolName, args }),
    event({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result,
      isError: false,
    }),
  ]);
}

function displayApi(
  getToolPresentation: (name: string) => unknown,
  revision = (): number => 1,
): BtwToolDisplayApi {
  return {
    version: 1,
    decorateTool: (tool) => tool,
    getToolPresentation: (name) =>
      getToolPresentation(name) as ReturnType<
        NonNullable<BtwToolDisplayApi["getToolPresentation"]>
      >,
    get presentationRevision() {
      return revision();
    },
  };
}

beforeEach(() => {
  initTheme();
});

describe("BTW live transcript ingestion", () => {
  it("keeps both assistant messages when a tool call separates them in one turn", () => {
    const state = createTranscriptState();
    let mutations = 0;
    apply(
      state,
      [
        event({ type: "turn_start" }),
        messageEvent("message_start", "user", [
          { type: "text", text: "run the check" },
        ]),
        messageEvent("message_end", "user", [
          { type: "text", text: "run the check" },
        ]),
        messageEvent("message_start", "assistant", [
          { type: "thinking", thinking: "FIRST_THINK" },
          { type: "text", text: "FIRST_ANSWER" },
        ]),
        event({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "a" },
        }),
        event({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "read",
          result: { content: [{ type: "text", text: "A" }] },
          isError: false,
        }),
        messageEvent("message_start", "assistant", [
          { type: "thinking", thinking: "SECOND_THINK" },
          { type: "text", text: "SECOND_ANSWER" },
        ]),
        messageEvent("message_update", "assistant", [
          { type: "thinking", thinking: "SECOND_THINK" },
          { type: "text", text: "SECOND_ANSWER" },
        ]),
        messageEvent("message_end", "assistant", [
          { type: "thinking", thinking: "SECOND_THINK" },
          { type: "text", text: "SECOND_ANSWER" },
        ]),
        event({
          type: "turn_end",
          message: { role: "assistant", content: [], stopReason: "stop" },
          toolResults: [],
        }),
      ],
      () => mutations++,
    );

    expect(state.entries.map((entry) => entry.type)).toEqual([
      "turn-boundary",
      "user-message",
      "thinking",
      "assistant-text",
      "tool-call",
      "tool-result",
      "thinking",
      "assistant-text",
      "turn-boundary",
    ]);
    expect(
      state.entries.flatMap((entry) =>
        entry.type === "thinking" ? [entry.text] : [],
      ),
    ).toEqual(["FIRST_THINK", "SECOND_THINK"]);
    expect(
      state.entries.flatMap((entry) =>
        entry.type === "assistant-text" ? [entry.text] : [],
      ),
    ).toEqual(["FIRST_ANSWER", "SECOND_ANSWER"]);
    expect(state.entries.at(-1)).toMatchObject({
      type: "turn-boundary",
      phase: "end",
      outcome: "completed",
    });
    expect(mutations).toBeGreaterThan(0);
  });

  it("ends the pre-tool segment so a later update cannot overwrite it", () => {
    const state = createTranscriptState();
    apply(state, [
      event({ type: "turn_start" }),
      messageEvent("message_start", "assistant", [
        { type: "thinking", thinking: "PRE_TOOL" },
      ]),
      messageEvent("message_update", "assistant", [
        { type: "thinking", thinking: "PRE_TOOL" },
      ]),
      event({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "a" },
      }),
      event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "A" }] },
        isError: false,
      }),
      // Host omitted a second message_start; the update still belongs to a new
      // assistant message after the tool.
      messageEvent("message_update", "assistant", [
        { type: "thinking", thinking: "POST_TOOL" },
      ]),
    ]);

    expect(
      state.entries.flatMap((entry) =>
        entry.type === "thinking" ? [entry.text] : [],
      ),
    ).toEqual(["PRE_TOOL", "POST_TOOL"]);
    expect(
      state.entries.find((entry) => entry.type === "thinking"),
    ).toMatchObject({
      text: "PRE_TOOL",
      streaming: false,
    });
  });

  it("marks streaming true until each message ends and records the aborted outcome", () => {
    const state = createTranscriptState();
    apply(state, [
      event({ type: "turn_start" }),
      messageEvent("message_start", "user", [{ type: "text", text: "stream" }]),
      messageEvent("message_end", "user", [{ type: "text", text: "stream" }]),
      messageEvent("message_start", "assistant", [
        { type: "thinking", thinking: "LIVE_THINK" },
      ]),
      messageEvent("message_update", "assistant", [
        { type: "thinking", thinking: "LIVE_THINK" },
      ]),
    ]);

    expect(
      state.entries.find((entry) => entry.type === "thinking"),
    ).toMatchObject({
      text: "LIVE_THINK",
      streaming: true,
    });

    apply(state, [
      messageEvent("message_end", "assistant", [
        { type: "thinking", thinking: "LIVE_THINK" },
      ]),
      event({
        type: "turn_end",
        message: { role: "assistant", content: [], stopReason: "aborted" },
        toolResults: [],
      }),
    ]);

    expect(
      state.entries.find((entry) => entry.type === "thinking"),
    ).toMatchObject({
      text: "LIVE_THINK",
      streaming: false,
    });
    expect(state.entries.at(-1)).toMatchObject({
      type: "turn-boundary",
      phase: "end",
      outcome: "aborted",
    });
  });

  it("renders the two same-turn messages as separate presenter components", () => {
    const state = createTranscriptState();
    apply(state, [
      event({ type: "turn_start" }),
      messageEvent("message_start", "assistant", [
        { type: "thinking", thinking: "OLD_THINK" },
        { type: "text", text: "OLD_ANSWER" },
      ]),
      event({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "a" },
      }),
      event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "A" }] },
        isError: false,
      }),
      messageEvent("message_start", "assistant", [
        { type: "thinking", thinking: "NEW_THINK" },
        { type: "text", text: "NEW_ANSWER" },
      ]),
      messageEvent("message_end", "assistant", [
        { type: "thinking", thinking: "NEW_THINK" },
        { type: "text", text: "NEW_ANSWER" },
      ]),
    ]);

    const display = new BtwTranscriptDisplay({
      theme: plainTheme,
      assistantLabel: "Assistant",
      emptyText: "empty",
    });
    const rendered = display.render(state.entries, 100).join("\n");
    expect(rendered).toContain("OLD_THINK");
    expect(rendered).toContain("OLD_ANSWER");
    expect(rendered).toContain("NEW_THINK");
    expect(rendered).toContain("NEW_ANSWER");
    // One assistant component per message segment, not one merged per turn.
    expect(rendered.match(/ Assistant /g)).toHaveLength(2);
    display.dispose();
  });
});

describe("BTW tool display adapter", () => {
  it("probes the global display API and rejects unknown versions", () => {
    const key = Symbol.for("pi-tool-display.api.v1");
    const legacy = { version: 1, decorateTool: (tool: unknown) => tool };
    expect(readBtwToolDisplayApi({ [key]: legacy })).toMatchObject({
      version: 1,
    });
    expect(
      readBtwToolDisplayApi({ [key]: { ...legacy, version: 2 } }),
    ).toBeUndefined();
    expect(readBtwToolDisplayApi({})).toBeUndefined();
  });

  it("uses the provider renderers for all seven supported built-in tools", () => {
    const provider = createToolPresentationProvider(
      () => DEFAULT_TOOL_DISPLAY_CONFIG,
    );
    const execute = vi.fn(() => {
      throw new Error("display must never execute a tool");
    });
    for (const name of DISPLAY_TOOL_NAMES) {
      provider.record({
        name,
        label: name,
        parameters: {},
        execute,
        renderShell: "default",
        renderCall: vi.fn(() => new Text(`PROVIDER_CALL_${name}`)),
        renderResult: vi.fn(() => new Text(`PROVIDER_RESULT_${name}`)),
      });
    }

    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () =>
        displayApi(
          (name) => provider.getToolPresentation(name),
          () => provider.presentationRevision,
        ),
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    for (const name of DISPLAY_TOOL_NAMES) {
      ingestToolCall(state, `call-${name}`, name, { path: `${name}.txt` });
    }

    for (const name of DISPLAY_TOOL_NAMES) {
      const component = state.toolComponents.get(`call-${name}`);
      expect(component, name).toBeDefined();
      const output = component!.render(120).join("\n");
      expect(output).toContain(`PROVIDER_CALL_${name}`);
      expect(output).toContain(`PROVIDER_RESULT_${name}`);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("keeps a custom child-session renderer instead of a provider snapshot", () => {
    const childRender = vi.fn(() => new Text("CHILD_RENDERER"));
    const childDefinition = {
      name: "my_tool",
      label: "my_tool",
      description: "custom",
      parameters: {},
      execute: vi.fn(),
      renderCall: childRender,
    } as unknown as ToolDefinition;
    const providerSnapshot = {
      name: "my_tool",
      renderCall: vi.fn(() => new Text("PROVIDER_RENDERER")),
    };
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "my_tool" ? childDefinition : undefined,
      getDisplayApi: () => displayApi(() => providerSnapshot),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("my_tool");
    // The adapter hands the transcript a display copy so the child renderer
    // can be wrapped in the draw/invalidate/mouse guard. The source definition
    // itself keeps its renderer, and the copy still delegates to it, so a
    // whitelisted tool's own renderer stays first priority over the provider.
    expect(resolved).not.toBe(childDefinition);
    expect(childDefinition.renderCall).toBe(childRender);
    expect(resolved?.renderCall).not.toBe(childRender);
    const component = resolved?.renderCall?.(
      {},
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );
    expect(component?.render(80).join("\n")).toContain("CHILD_RENDERER");
    expect(childRender).toHaveBeenCalledTimes(1);
    expect(providerSnapshot.renderCall).not.toHaveBeenCalled();
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("keeps a same-name child definition renderer ahead of the provider phase", () => {
    // Auditor probe regression: a child `read` definition that carries its own
    // renderer is a customization, not the ordinary built-in default, so the
    // provider must not replace that phase.
    const childRender = vi.fn(() => new Text("CUSTOM_CHILD_READ"));
    const childResult = vi.fn(() => new Text("CUSTOM_CHILD_READ_RESULT"));
    const childExecute = vi.fn();
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: childExecute,
      renderCall: childRender,
      renderResult: childResult,
    } as unknown as ToolDefinition;
    const providerCall = vi.fn(() => new Text("PARENT_PROVIDER_READ"));
    const providerResult = vi.fn(() => new Text("PARENT_PROVIDER_READ_RESULT"));
    const providerSnapshot = Object.freeze({
      name: "read",
      renderCall: providerCall,
      renderResult: providerResult,
    });
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "read" ? childDefinition : undefined,
      getDisplayApi: () => displayApi(() => providerSnapshot),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved).not.toBe(childDefinition);
    expect(resolved?.renderCall).not.toBe(childRender);
    expect(
      resolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CUSTOM_CHILD_READ");
    expect(
      resolved
        ?.renderResult?.(
          { content: [{ type: "text", text: "x" }] },
          { expanded: false },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CUSTOM_CHILD_READ_RESULT");
    expect(providerCall).not.toHaveBeenCalled();
    expect(providerResult).not.toHaveBeenCalled();
    expect(childExecute).not.toHaveBeenCalled();
    // Source definitions stay untouched (the adapter only copies display fields).
    expect(childDefinition.renderCall).toBe(childRender);
    expect(childDefinition.renderResult).toBe(childResult);
    expect(providerSnapshot.renderCall).toBe(providerCall);
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("overlays provider renderers on a child built-in definition that draws nothing", () => {
    // The ordinary built-in definition carries no renderer, so the provider
    // still supplies the known built-in styling and shell.
    const childExecute = vi.fn();
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: childExecute,
    } as unknown as ToolDefinition;
    const providerRender = () => new Text("PROVIDER_READ");
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "read" ? childDefinition : undefined,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: providerRender,
          renderShell: "self",
        })),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved).not.toBe(childDefinition);
    expect(resolved?.renderShell).toBe("self");
    expect(resolved?.renderCall).not.toBe(providerRender);
    expect(
      resolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("PROVIDER_READ");
    // The child definition itself stays untouched.
    expect(childDefinition.renderCall).toBeUndefined();
    expect(childDefinition.renderShell).toBeUndefined();
    expect(childExecute).not.toHaveBeenCalled();
  });

  it("keeps same-name child resolver renderers ahead of the provider", () => {
    // The child session's public renderer resolution (`registerToolRenderer`
    // in a whitelisted BTW extension) is child display state: for a built-in
    // name it must win the same phase the provider would otherwise supply.
    const childCall = vi.fn(() => new Text("CHILD_BASH_CALL"));
    const childResult = vi.fn(() => new Text("CHILD_BASH_RESULT"));
    const resolveToolRenderers = vi.fn((toolName: string) =>
      toolName === "bash"
        ? { renderCall: childCall, renderResult: childResult }
        : undefined,
    );
    const childDefinition = {
      name: "bash",
      label: "bash",
      description: "run a command",
      parameters: {},
      execute: vi.fn(),
    } as unknown as ToolDefinition;
    const providerCall = vi.fn(() => new Text("PROVIDER_BASH_CALL"));
    const providerResult = vi.fn(() => new Text("PROVIDER_BASH_RESULT"));
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getChildToolRenderers: resolveToolRenderers,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "bash",
          renderCall: providerCall,
          renderResult: providerResult,
        })),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("bash");
    // The child resolver resolves against the child session's own definition.
    expect(resolveToolRenderers).toHaveBeenCalledWith("bash", childDefinition);
    expect(
      resolved
        ?.renderCall?.(
          { command: "echo hi" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CHILD_BASH_CALL");
    expect(
      resolved
        ?.renderResult?.(
          { content: [{ type: "text", text: "hi" }] },
          { expanded: false },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CHILD_BASH_RESULT");
    expect(providerCall).not.toHaveBeenCalled();
    expect(providerResult).not.toHaveBeenCalled();
    expect(childDefinition.renderCall).toBeUndefined();
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("keeps the provider when a child resolver forwards next() unchanged", () => {
    // The base is the child's registered definition: an ordinary built-in
    // definition carries no renderer, so a resolver that forwards `next()`
    // unchanged still leaves the provider in charge of that phase.
    const providerCall = vi.fn(() => new Text("PROVIDER_READ_CALL"));
    const providerResult = vi.fn(() => new Text("PROVIDER_READ_RESULT"));
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: vi.fn(),
    } as unknown as ToolDefinition;
    const seenBase: Array<ToolDefinition | undefined> = [];
    const forwarded = vi.fn(
      (_toolName: string, next: () => ToolDefinition | undefined) => {
        const base = next();
        seenBase.push(base);
        return base;
      },
    );
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getChildToolRenderers: (toolName, baseDefinition) =>
        forwarded(toolName, () => baseDefinition),
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: providerCall,
          renderResult: providerResult,
        })),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("read");
    expect(forwarded).toHaveBeenCalledTimes(1);
    // The resolver sees the child session's own definition, not the provider.
    expect(seenBase).toEqual([childDefinition]);
    expect(
      resolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("PROVIDER_READ_CALL");
    expect(
      resolved
        ?.renderResult?.(
          { content: [{ type: "text", text: "x" }] },
          { expanded: false },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("PROVIDER_READ_RESULT");
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("keeps a resolver wrapper that builds on the child definition's renderer", () => {
    // A legitimate resolver reads `next()` and wraps the child's own renderer;
    // the wrapped result is the child's display and must beat the provider.
    const childCall = vi.fn(() => new Text("BASE_CHILD_CALL"));
    const childResult = vi.fn(() => new Text("BASE_CHILD_RESULT"));
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: vi.fn(),
      renderCall: childCall,
      renderResult: childResult,
    } as unknown as ToolDefinition;
    const providerCall = vi.fn(() => new Text("PARENT_PROVIDER_CALL"));
    const providerResult = vi.fn(() => new Text("PARENT_PROVIDER_RESULT"));
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getChildToolRenderers: (toolName, baseDefinition) => {
        const base = baseDefinition as ToolDefinition | undefined;
        if (toolName !== "read" || !base?.renderCall || !base.renderResult) {
          return base;
        }
        return {
          ...base,
          renderCall: () => new Text("WRAPPED_CHILD_CALL"),
          renderResult: () => new Text("WRAPPED_CHILD_RESULT"),
        };
      },
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: providerCall,
          renderResult: providerResult,
        })),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("read");
    expect(
      resolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("WRAPPED_CHILD_CALL");
    expect(
      resolved
        ?.renderResult?.(
          { content: [{ type: "text", text: "x" }] },
          { expanded: false },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("WRAPPED_CHILD_RESULT");
    expect(providerCall).not.toHaveBeenCalled();
    expect(providerResult).not.toHaveBeenCalled();
    // The display copy keeps the child definition's own execute function
    // untouched (it is never called for display) and only replaces renderers.
    expect(resolved?.execute).toBe(childDefinition.execute);
    expect(childDefinition.renderCall).toBe(childCall);
  });

  it("composes a partial child resolver phase with the provider per field", () => {
    const childResult = vi.fn(() => new Text("CHILD_READ_RESULT"));
    const providerCall = vi.fn(() => new Text("PROVIDER_READ_CALL"));
    const providerResult = vi.fn(() => new Text("PROVIDER_READ_RESULT"));
    const adapter = new BtwToolDisplayAdapter({
      getChildToolRenderers: () => ({ renderResult: childResult }),
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: providerCall,
          renderResult: providerResult,
        })),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("read");
    expect(
      resolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("PROVIDER_READ_CALL");
    expect(
      resolved
        ?.renderResult?.(
          { content: [{ type: "text", text: "x" }] },
          { expanded: false },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CHILD_READ_RESULT");
    expect(providerResult).not.toHaveBeenCalled();
  });

  it("draws a tool the child session does not register from its resolver only", () => {
    // A public resolver may draw tools that are not registered; the adapter
    // returns renderer fields only and never a fabricated execute/schema.
    const childCall = vi.fn(() => new Text("RESOLVER_ONLY_CALL"));
    const adapter = new BtwToolDisplayAdapter({
      getChildToolRenderers: (toolName) =>
        toolName === "resolver_only" ? { renderCall: childCall } : undefined,
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("resolver_only");
    expect(resolved).toBeDefined();
    expect(resolved).not.toHaveProperty("execute");
    expect(resolved).not.toHaveProperty("parameters");
    expect(
      resolved
        ?.renderCall?.(
          { value: "x" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("RESOLVER_ONLY_CALL");
    expect(
      adapter.resolveToolDefinition("nothing_claims_this"),
    ).toBeUndefined();
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("guards a child resolver renderer that throws while drawing", () => {
    const childCall = vi.fn(() =>
      throwingRenderComponent("resolver draw exploded"),
    );
    const adapter = new BtwToolDisplayAdapter({
      getChildToolRenderers: () => ({ renderCall: childCall }),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("read");
    const component = resolved?.renderCall?.(
      { path: "a" },
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );
    const output = component?.render(80).join("\n") ?? "";
    expect(output).toContain("read");
    expect(output).toContain('"path":"a"');
    expect(childCall).toHaveBeenCalledTimes(1);
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "call",
    });
    component?.render(80);
    expect(childCall).toHaveBeenCalledTimes(1);
  });

  it("falls back and rate-limits when the child renderer resolver throws", () => {
    let revision = 1;
    let throws = true;
    const resolverError = () => {
      if (throws) throw new Error("resolver exploded");
      return { renderCall: () => new Text("CHILD_READ") } as const;
    };
    const providerCall = vi.fn(() => new Text("PROVIDER_READ_CALL"));
    const providerApi = () =>
      displayApi(
        () => ({ name: "read", renderCall: providerCall }),
        () => revision,
      );
    const api = providerApi();
    const adapter = new BtwToolDisplayAdapter({
      getChildToolRenderers: resolverError,
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });

    const first = adapter.resolveToolDefinition("read");
    expect(
      first
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("PROVIDER_READ_CALL");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "lookup",
    });
    expect(adapter.diagnostics.messages[0].message).toContain(
      "could not resolve the read tool's own display renderers",
    );

    adapter.resolveToolDefinition("read");
    expect(adapter.diagnostics.messages).toHaveLength(1);

    revision = 2;
    adapter.resolveToolDefinition("read");
    expect(adapter.diagnostics.messages).toHaveLength(2);

    throws = false;
    const recovered = adapter.resolveToolDefinition("read");
    expect(
      recovered
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CHILD_READ");
  });

  it("keeps the provider when the host exposes no public child resolver", () => {
    // Legacy hosts (or a session without extension resources) have no public
    // `resolveToolRenderers`; resolution must keep working without a warning.
    // A host whose resolver chain claims nothing returns undefined as well.
    const providerCall = () => new Text("PROVIDER_READ_CALL");
    const legacy = new BtwToolDisplayAdapter({
      getChildToolDefinition: () =>
        ({
          name: "read",
          label: "read",
          description: "read a file",
          parameters: {},
          execute: vi.fn(),
        }) as unknown as ToolDefinition,
      getChildToolRenderers: () => undefined,
      getDisplayApi: () =>
        displayApi(() => ({ name: "read", renderCall: providerCall })),
      isLocalWorkspace: () => true,
    });
    const resolved = legacy.resolveToolDefinition("read");
    expect(
      resolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("PROVIDER_READ_CALL");
    expect(legacy.diagnostics.messages).toEqual([]);
  });

  it("falls back to the child definition for a missing or legacy provider without diagnostics", () => {
    const childRender = vi.fn(() => new Text("CHILD_READ"));
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: vi.fn(),
      renderCall: childRender,
    } as unknown as ToolDefinition;

    const missing = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () => undefined,
      isLocalWorkspace: () => true,
    });
    const missingResolved = missing.resolveToolDefinition("read");
    expect(missingResolved).not.toBe(childDefinition);
    expect(childDefinition.renderCall).toBe(childRender);
    expect(
      missingResolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CHILD_READ");
    expect(missing.diagnostics.messages).toEqual([]);

    const legacy = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () => displayApi(() => undefined),
      isLocalWorkspace: () => true,
    });
    const legacyResolved = legacy.resolveToolDefinition("read");
    expect(legacyResolved).not.toBe(childDefinition);
    expect(
      legacyResolved
        ?.renderCall?.(
          { path: "a" },
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CHILD_READ");
    expect(legacy.diagnostics.messages).toEqual([]);
  });

  it("guards a non-built-in child renderer that throws while drawing and shows the actual args", () => {
    const childRender = vi.fn(() =>
      throwingRenderComponent("child draw exploded"),
    );
    const childDefinition = {
      name: "e2e_probe",
      label: "e2e_probe",
      description: "custom",
      parameters: {},
      execute: vi.fn(),
      renderCall: childRender,
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "e2e_probe" ? childDefinition : undefined,
      getDisplayApi: () => undefined,
      isLocalWorkspace: () => true,
    });

    const component = adapter
      .resolveToolDefinition("e2e_probe")
      ?.renderCall?.(
        { value: "alpha" },
        plainTheme as never,
        {} as BtwToolPresentationRenderContext,
      );
    const first = component?.render(80).join("\n") ?? "";
    // Visible actual-args fallback, never a blank line and never the failed
    // child component again.
    expect(first).toContain("e2e_probe");
    expect(first).toContain('"value":"alpha"');
    expect(first).not.toContain("child draw exploded");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "e2e_probe",
      phase: "call",
    });
    expect(adapter.diagnostics.messages[0].message).toContain("own renderer");

    // Repeated repaints reuse the fallback: no re-entry, no duplicate report.
    expect(component?.render(80).join("\n")).toContain("e2e_probe");
    expect(childRender).toHaveBeenCalledTimes(1);
    expect(adapter.diagnostics.messages).toHaveLength(1);

    // A later update of the same slot hands the failed guard back as
    // lastComponent; the wrapper must not re-enter the failed child renderer.
    const updated = adapter.resolveToolDefinition("e2e_probe")?.renderCall?.(
      { value: "alpha" },
      plainTheme as never,
      {
        lastComponent: component,
      } as unknown as BtwToolPresentationRenderContext,
    );
    expect(updated?.render(80).join("\n")).toContain('"value":"alpha"');
    expect(childRender).toHaveBeenCalledTimes(1);
    expect(adapter.diagnostics.messages).toHaveLength(1);
    // The source definition keeps its own renderer and execute function.
    expect(childDefinition.renderCall).toBe(childRender);
  });

  it("guards child invalidate and mouse failures without disabling other tool entries", () => {
    const badDefinition = {
      name: "e2e_probe",
      label: "e2e_probe",
      description: "custom",
      parameters: {},
      execute: vi.fn(),
      renderCall: () => ({
        render: () => ["BAD_PRIMARY"],
        invalidate: () => {
          throw new Error("child invalidate exploded");
        },
        handleMouse: () => {
          throw new Error("child mouse exploded");
        },
      }),
    } as unknown as ToolDefinition;
    const goodRender = vi.fn(() => new Text("GOOD_CHILD"));
    const goodDefinition = {
      name: "e2e_ok",
      label: "e2e_ok",
      description: "custom ok",
      parameters: {},
      execute: vi.fn(),
      renderCall: goodRender,
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "e2e_probe"
          ? badDefinition
          : name === "e2e_ok"
            ? goodDefinition
            : undefined,
      getDisplayApi: () => undefined,
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    ingestToolCall(state, "call-bad", "e2e_probe", { value: "alpha" });
    ingestToolCall(state, "call-good", "e2e_ok", { value: "beta" });

    const bad = state.toolComponents.get("call-bad");
    const good = state.toolComponents.get("call-good");
    expect(bad?.render(80).join("\n")).toContain("BAD_PRIMARY");

    // Exercise the guard directly: a child component that throws from
    // invalidate/handleMouse must not escape to the transcript.
    const guard = adapter
      .resolveToolDefinition("e2e_probe")
      ?.renderCall?.(
        { value: "alpha" },
        plainTheme as never,
        {} as BtwToolPresentationRenderContext,
      );
    expect(guard?.render(80).join("\n")).toContain("BAD_PRIMARY");
    expect(() => guard?.invalidate()).not.toThrow();
    expect(guard?.handleMouse?.(mouseClick)).toBeUndefined();
    expect(() => bad?.invalidate()).not.toThrow();
    expect(bad?.handleMouse?.(mouseClick)).toBeUndefined();
    expect(adapter.diagnostics.messages.map((entry) => entry.phase)).toEqual(
      expect.arrayContaining(["call"]),
    );
    // Another tool entry keeps rendering with its own child renderer.
    expect(good?.render(80).join("\n")).toContain("GOOD_CHILD");
    expect(goodRender).toHaveBeenCalled();
  });

  it("falls back to the actual result text when a child result renderer throws while drawing", () => {
    const childDefinition = {
      name: "e2e_probe",
      label: "e2e_probe",
      description: "custom",
      parameters: {},
      execute: vi.fn(),
      renderResult: () => throwingRenderComponent("child result exploded"),
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "e2e_probe" ? childDefinition : undefined,
      getDisplayApi: () => undefined,
      isLocalWorkspace: () => true,
    });

    const component = adapter
      .resolveToolDefinition("e2e_probe")
      ?.renderResult?.(
        { content: [{ type: "text", text: "probe-ok:alpha" }] },
        { expanded: false },
        plainTheme as never,
        {} as BtwToolPresentationRenderContext,
      );
    expect(component?.render(80).join("\n")).toContain("probe-ok:alpha");
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "e2e_probe",
      phase: "result",
    });
  });

  it("falls back when a child renderer factory throws before returning a component", () => {
    const childDefinition = {
      name: "e2e_probe",
      label: "e2e_probe",
      description: "custom",
      parameters: {},
      execute: vi.fn(),
      renderCall: () => {
        throw new Error("child factory exploded");
      },
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "e2e_probe" ? childDefinition : undefined,
      getDisplayApi: () => undefined,
      isLocalWorkspace: () => true,
    });

    const component = adapter
      .resolveToolDefinition("e2e_probe")
      ?.renderCall?.(
        { value: "alpha" },
        plainTheme as never,
        {} as BtwToolPresentationRenderContext,
      );
    const output = component?.render(80).join("\n") ?? "";
    expect(output).toContain("e2e_probe");
    expect(output).toContain('"value":"alpha"');
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0].phase).toBe("call");
  });

  it("falls back when the provider does not support a tool, without diagnosing", () => {
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: vi.fn(),
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () => displayApi(() => undefined),
      isLocalWorkspace: () => true,
    });

    expect(adapter.resolveToolDefinition("read")).toBe(childDefinition);
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("guards a built-in child renderer for a phase the provider does not supply", () => {
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: vi.fn(),
      renderCall: () => throwingRenderComponent("builtin child draw exploded"),
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderResult: () => new Text("PROVIDER_RESULT"),
        })),
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("read");
    // The provider has no call renderer, so the child call renderer is used —
    // but only through the same draw guard as every other child renderer.
    expect(resolved?.renderCall).not.toBe(childDefinition.renderCall);
    const component = resolved?.renderCall?.(
      { path: "a" },
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );
    const output = component?.render(80).join("\n") ?? "";
    expect(output).toContain("read");
    expect(output).toContain('"path":"a"');
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "call",
    });
    // The provider result renderer still wins for the phase it does supply.
    const result = resolved?.renderResult?.(
      { content: [{ type: "text", text: "x" }] },
      { expanded: false },
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );
    expect(result?.render(80).join("\n")).toContain("PROVIDER_RESULT");
  });

  it("rate-limits a throwing lookup per tool and display revision", () => {
    let revision = 1;
    const lookup = vi.fn(() => {
      throw new Error("lookup exploded");
    });
    const api = displayApi(lookup, () => revision);
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });

    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "lookup",
    });

    revision = 2;
    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.diagnostics.messages).toHaveLength(2);
  });

  it("rate-limits a throwing renderer and lets the native component fallback draw", () => {
    let revision = 1;
    const providerCall = vi.fn(() => {
      throw new Error("render exploded");
    });
    const api = displayApi(
      () => ({ name: "read", renderCall: providerCall }),
      () => revision,
    );
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    ingestToolCall(state, "call-1", "read");

    const component = state.toolComponents.get("call-1");
    expect(component).toBeDefined();
    expect(providerCall).toHaveBeenCalledTimes(1);
    const output = component!.render(120).join("\n");
    expect(output).toContain("read");
    expect(output).not.toContain("PROVIDER");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "call",
    });

    component!.setExpanded(true);
    component!.render(120);
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(adapter.diagnostics.messages).toHaveLength(1);

    revision = 2;
    const rerendered = adapter.resolveToolDefinition("read");
    expect(rerendered?.renderCall).toBeDefined();
    const fallback = rerendered!.renderCall!(
      { path: "a" },
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );
    expect(fallback.render(80).join("\n")).toContain("read");
    expect(adapter.diagnostics.messages).toHaveLength(2);
  });

  it("scopes render context capabilities and the display-side toolCallId", () => {
    const contexts: BtwToolPresentationRenderContext[] = [];
    const renderCall = (
      _args: Record<string, unknown>,
      _theme: unknown,
      context: BtwToolPresentationRenderContext,
    ) => {
      contexts.push(context);
      return new Text("SCOPED_CALL");
    };
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => displayApi(() => ({ name: "read", renderCall })),
      isLocalWorkspace: () => false,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    ingestToolCall(state, "call-1", "read", { path: "remote.txt" });
    state.toolComponents.get("call-1")?.render(120);

    expect(contexts.length).toBeGreaterThan(0);
    const context = contexts.at(-1)!;
    expect(context.toolCallId).toMatch(/^btw\d+:call-1$/);
    expect(context.args).toEqual({ path: "remote.txt" });
    expect(context.cwd).toBe("/test/project");
    expect(context.capabilities).toEqual({
      executionMetadata: false,
      localWorkspace: false,
    });

    const localContexts: BtwToolPresentationRenderContext[] = [];
    const localAdapter = new BtwToolDisplayAdapter({
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: (_args, _theme, renderContext) => {
            localContexts.push(renderContext);
            return new Text("LOCAL_CALL");
          },
        })),
      isLocalWorkspace: () => true,
    });
    const localState = createTranscriptState({
      resolveToolDefinition: localAdapter.resolveToolDefinition,
    });
    apply(localState, [event({ type: "turn_start" })]);
    ingestToolCall(localState, "call-2", "read");
    expect(localContexts.at(-1)?.capabilities?.localWorkspace).toBe(true);
  });

  it("exposes the provider identity and revision for future cache invalidation", () => {
    const api = displayApi(
      () => undefined,
      () => 7,
    );
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });
    expect(adapter.displayProvider).toMatchObject({ api, revision: 7 });
    expect(adapter.displayProvider?.getToolPresentation).toEqual(
      expect.any(Function),
    );

    const noRevision = new BtwToolDisplayAdapter({
      getDisplayApi: () => ({
        version: 1,
        decorateTool: (tool) => tool,
        getToolPresentation: () => undefined,
      }),
      isLocalWorkspace: () => true,
    });
    expect(noRevision.displayProvider?.revision).toBe(-1);
  });

  it("falls back to the actual call text when a provider component render throws", () => {
    // The child definition is the ordinary built-in default (no renderer), so
    // the provider supplies this phase and the guard's fallback is the visible
    // actual call text rather than a plugin renderer.
    const childDefinition = childDefinitionWithRenderers();
    const providerCall = vi.fn(() =>
      throwingRenderComponent("call render exploded"),
    );
    const providerResult = vi.fn(() => new Text("PROVIDER_RESULT"));
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: providerCall,
          renderResult: providerResult,
        })),
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    ingestToolCall(state, "call-1", "read");

    const component = state.toolComponents.get("call-1");
    expect(component).toBeDefined();
    const output = component!.render(120).join("\n");
    expect(output).toContain("read");
    expect(output).toContain("package.json");
    expect(output).toContain("(display fallback)");
    expect(output).toContain("PROVIDER_RESULT");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "call",
    });

    // Once the provider component failed while drawing, later updates keep the
    // actual-call fallback and never build another provider component.
    const callsAfterFallback = providerCall.mock.calls.length;
    component!.render(120);
    component!.setExpanded(true);
    component!.render(120);
    expect(providerCall).toHaveBeenCalledTimes(callsAfterFallback);
    expect(adapter.diagnostics.messages).toHaveLength(1);
  });

  it("falls back to the actual result text when a provider result component render throws", () => {
    const childDefinition = childDefinitionWithRenderers();
    const providerResult = vi.fn(() =>
      throwingRenderComponent("result render exploded"),
    );
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: () => new Text("PROVIDER_CALL"),
          renderResult: providerResult,
        })),
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    ingestToolCall(state, "call-1", "read");

    const component = state.toolComponents.get("call-1");
    expect(component).toBeDefined();
    const output = component!.render(120).join("\n");
    expect(output).toContain("PROVIDER_CALL");
    expect(output).toContain("tool output");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "result",
    });

    component!.render(120);
    expect(adapter.diagnostics.messages).toHaveLength(1);
  });

  it("keeps other transcript entries rendering when one tool component fails", () => {
    const childDefinition = childDefinitionWithRenderers();
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "read" ? childDefinition : undefined,
      getDisplayApi: () =>
        displayApi((name) => {
          if (name === "read") {
            return {
              name,
              renderCall: () => throwingRenderComponent("read exploded"),
            };
          }
          if (name === "bash") {
            return { name, renderCall: () => new Text("PROVIDER_BASH_CALL") };
          }
          return undefined;
        }),
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [
      event({ type: "turn_start" }),
      messageEvent("message_start", "user", [{ type: "text", text: "BEFORE" }]),
      messageEvent("message_end", "user", [{ type: "text", text: "BEFORE" }]),
      event({
        type: "tool_execution_start",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "a" },
      }),
      event({
        type: "tool_execution_end",
        toolCallId: "call-read",
        toolName: "read",
        result: { content: [{ type: "text", text: "R" }] },
        isError: false,
      }),
      event({
        type: "tool_execution_start",
        toolCallId: "call-bash",
        toolName: "bash",
        args: { command: "echo ok" },
      }),
      event({
        type: "tool_execution_end",
        toolCallId: "call-bash",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      }),
      messageEvent("message_start", "assistant", [
        { type: "text", text: "AFTER" },
      ]),
      messageEvent("message_end", "assistant", [
        { type: "text", text: "AFTER" },
      ]),
    ]);

    const display = new BtwTranscriptDisplay({
      theme: plainTheme,
      toolComponents: state.toolComponents,
      assistantLabel: "Assistant",
    });
    const rendered = display.render(state.entries, 120).join("\n");
    expect(rendered).toContain("BEFORE");
    expect(rendered).toContain("(display fallback)");
    expect(rendered).toContain("PROVIDER_BASH_CALL");
    expect(rendered).toContain("AFTER");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    display.dispose();
  });

  it("does not let a provider component invalidate throw escape the display boundary", () => {
    const childDefinition = childDefinitionWithRenderers();
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: () => throwingInvalidateComponent("invalidate exploded"),
        })),
      isLocalWorkspace: () => true,
    });
    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved?.renderCall).toBeDefined();
    const guarded = resolved!.renderCall!(
      { path: "a" },
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );

    expect(() => guarded.invalidate()).not.toThrow();
    expect(guarded.render(80).join("\n")).toContain("(display fallback)");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "call",
    });
  });

  it("does not let a provider component handleMouse throw escape the display boundary", () => {
    const childDefinition = childDefinitionWithRenderers();
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: () => throwingMouseComponent("mouse exploded"),
        })),
      isLocalWorkspace: () => true,
    });
    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved?.renderCall).toBeDefined();
    const guarded = resolved!.renderCall!(
      { path: "a" },
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );

    expect(guarded.handleMouse?.(mouseClick)).toBeUndefined();
    expect(guarded.render(80).join("\n")).toContain("(display fallback)");
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "call",
    });
  });

  it("falls back and rate-limits when the provider revision getter throws, then recovers", () => {
    let throws = true;
    const api: BtwToolDisplayApi = {
      version: 1,
      decorateTool: (tool) => tool,
      getToolPresentation: () => ({
        name: "read",
        renderCall: () => new Text("PROVIDER_READ"),
      }),
      get presentationRevision(): number {
        if (throws) throw new Error("revision exploded");
        return 4;
      },
    };
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });

    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "lookup",
    });

    throws = false;
    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved?.renderCall).toBeDefined();
    const component = resolved!.renderCall!(
      { path: "a" },
      plainTheme as never,
      {} as BtwToolPresentationRenderContext,
    );
    expect(component.render(80).join("\n")).toContain("PROVIDER_READ");

    throws = true;
    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.diagnostics.messages).toHaveLength(2);
  });

  it("falls back and rate-limits when the display API probe throws, then recovers", () => {
    let throws = true;
    const api = displayApi(
      () => ({ name: "read", renderCall: () => new Text("PROVIDER_READ") }),
      () => 3,
    );
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => {
        if (throws) throw new Error("probe exploded");
        return api;
      },
      isLocalWorkspace: () => true,
    });

    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "lookup",
    });

    throws = false;
    expect(adapter.resolveToolDefinition("read")?.renderCall).toBeDefined();

    throws = true;
    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.diagnostics.messages).toHaveLength(2);
  });

  it("falls back and rate-limits when the capability probe getter throws", () => {
    const api: BtwToolDisplayApi = {
      version: 1,
      decorateTool: (tool) => tool,
      get getToolPresentation() {
        throw new Error("capability exploded");
      },
    };
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });

    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.resolveToolDefinition("read")).toBeUndefined();
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(adapter.diagnostics.messages[0]).toMatchObject({
      toolName: "read",
      phase: "lookup",
    });
  });

  it("forwards the provider's own previous component instead of the guard wrapper", () => {
    const stateful = new StatefulToolComponent("PROVIDER_STATEFUL");
    const seenLast: Array<Component | undefined> = [];
    const renderCall = (
      _args: Record<string, unknown>,
      _theme: unknown,
      context: BtwToolPresentationRenderContext,
    ) => {
      seenLast.push(context.lastComponent);
      return stateful;
    };
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => displayApi(() => ({ name: "read", renderCall })),
      isLocalWorkspace: () => true,
    });
    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved?.renderCall).toBeDefined();
    const context = {
      toolCallId: "call-1",
      cwd: "/test/project",
    } as BtwToolPresentationRenderContext;

    const first = resolved!.renderCall!(
      { path: "a" },
      plainTheme as never,
      context,
    );
    expect(first.render(80).join("\n")).toContain("PROVIDER_STATEFUL");
    const second = resolved!.renderCall!({ path: "a" }, plainTheme as never, {
      ...context,
      lastComponent: first,
    });
    expect(second.render(80).join("\n")).toContain("PROVIDER_STATEFUL");

    expect(seenLast[0]).toBeUndefined();
    expect(seenLast[1]).toBe(stateful);
    expect(seenLast[1]).not.toBe(first);
    expect(second.handleMouse?.(mouseClick)).toEqual({ handled: true });
    expect(stateful.mouseHandled).toBe(1);
    expect(stateful.renders).toBeGreaterThanOrEqual(2);
  });

  it("does not re-enter a failed provider on later updates", () => {
    const childDefinition = childDefinitionWithRenderers();
    const providerCalls = vi.fn(() =>
      throwingRenderComponent("provider render exploded"),
    );
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () =>
        displayApi(() => ({ name: "read", renderCall: providerCalls })),
      isLocalWorkspace: () => true,
    });
    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved?.renderCall).toBeDefined();
    const context = {
      toolCallId: "call-1",
      cwd: "/test/project",
    } as BtwToolPresentationRenderContext;

    const first = resolved!.renderCall!(
      { path: "a" },
      plainTheme as never,
      context,
    );
    expect(first.render(80).join("\n")).toContain("(display fallback)");
    expect(providerCalls).toHaveBeenCalledTimes(1);

    const second = resolved!.renderCall!({ path: "a" }, plainTheme as never, {
      ...context,
      lastComponent: first,
    });
    expect(second.render(80).join("\n")).toContain("(display fallback)");
    expect(providerCalls).toHaveBeenCalledTimes(1);
    expect(adapter.diagnostics.messages).toHaveLength(1);
    expect(second.handleMouse?.(mouseClick)).toBeUndefined();
  });

  it("does not hand an unrelated phase guard to the child or provider renderer", () => {
    const seenCallLast: Array<Component | undefined> = [];
    const seenResultLast: Array<Component | undefined> = [];
    // The child draws the call phase (custom renderer wins) and the provider
    // draws the result phase, so both wrappers are exercised at once.
    const childDefinition = childDefinitionWithRenderers({
      renderCall: (_args, _theme, context) => {
        seenCallLast.push(context.lastComponent);
        return new Text("CHILD_CALL");
      },
    });
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: () => childDefinition,
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderResult: (_result, _options, _theme, context) => {
            seenResultLast.push(context.lastComponent);
            return new Text("PROVIDER_RESULT");
          },
        })),
      isLocalWorkspace: () => true,
    });
    const resolved = adapter.resolveToolDefinition("read");
    expect(resolved?.renderCall).toBeDefined();
    expect(resolved?.renderResult).toBeDefined();

    const resultGuard = resolved!.renderResult!(
      { content: [] },
      { expanded: false, isPartial: false },
      plainTheme as never,
      { toolCallId: "call-1" } as BtwToolPresentationRenderContext,
    );
    const callGuard = resolved!.renderCall!(
      { path: "a" },
      plainTheme as never,
      { toolCallId: "call-1", lastComponent: resultGuard },
    );
    expect(callGuard.render(80).join("\n")).toContain("CHILD_CALL");
    expect(resultGuard.render(80).join("\n")).toContain("PROVIDER_RESULT");

    // The result guard belongs to another phase and is never handed to the
    // child call renderer as its own lastComponent.
    expect(seenCallLast).toEqual([undefined]);
    expect(seenResultLast).toEqual([undefined]);
  });

  it("preserves provider lastComponent reuse through real ToolExecutionComponent updates", () => {
    const statefulCall = new StatefulToolComponent("PROVIDER_CALL");
    const statefulResult = new StatefulToolComponent("PROVIDER_RESULT");
    const callLast: Array<Component | undefined> = [];
    const resultLast: Array<Component | undefined> = [];
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () =>
        displayApi(() => ({
          name: "read",
          renderCall: (_args, _theme, context) => {
            callLast.push(context.lastComponent);
            return statefulCall;
          },
          renderResult: (_result, _options, _theme, context) => {
            resultLast.push(context.lastComponent);
            return statefulResult;
          },
        })),
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    ingestToolCall(state, "call-1", "read");

    const component = state.toolComponents.get("call-1");
    expect(component).toBeDefined();
    component!.render(120);
    component!.setExpanded(true);
    component!.render(120);
    component!.updateResult(
      { content: [{ type: "text", text: "more" }], isError: false },
      false,
    );
    component!.invalidate();

    // The first slot is empty; every later slot must be the provider's own
    // stateful component, never this module's guard wrapper.
    expect(callLast[0]).toBeUndefined();
    expect(callLast.slice(1).every((last) => last === statefulCall)).toBe(true);
    expect(resultLast[0]).toBeUndefined();
    expect(resultLast.slice(1).every((last) => last === statefulResult)).toBe(
      true,
    );
    expect(statefulCall.renders).toBeGreaterThan(1);
    expect(statefulResult.renders).toBeGreaterThan(1);
  });
});
