import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initTheme,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  createTranscriptState,
  type TranscriptState,
} from "@xzzpig/pi-components/transcript";
// Test-only cross-package imports: BTW probes the approved display API at
// runtime and never depends on pi-tool-display. The real registration path
// keeps these tests aligned with the actual built-in renderers.
import { disposeToolPresentationApi } from "../../pi-tool-display/src/tool-presentation";
import { registerToolDisplayOverrides } from "../../pi-tool-display/src/tool-overrides";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../../pi-tool-display/src/types";
import {
  BtwToolDisplayAdapter,
  type BtwToolDisplayApi,
  type BtwToolPresentationRenderContext,
} from "../extensions/btw-transcript-display";
import { applyBtwTranscriptEvent } from "../extensions/btw-transcript-ingestion";
import { BtwToolComponents } from "../extensions/btw-tool-components";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
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

function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function apply(state: TranscriptState, events: AgentSessionEvent[]): void {
  for (const next of events) applyBtwTranscriptEvent(state, next, () => {});
}

function plainLines(component: Component): string[] {
  return component
    .render(120)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((line) => line.length > 0);
}

function toolCall(
  state: TranscriptState,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> = { path: "file.txt" },
  result: unknown = { content: [{ type: "text", text: "tool result" }] },
): void {
  apply(state, [
    event({ type: "turn_start" }),
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

type ProviderCall = {
  name: string;
  kind: "call" | "result";
  component: Component;
};

function installRealProvider(
  config: typeof DEFAULT_TOOL_DISPLAY_CONFIG = DEFAULT_TOOL_DISPLAY_CONFIG,
): {
  api: BtwToolDisplayApi;
  registered: Array<Record<string, unknown>>;
  calls: ProviderCall[];
} {
  const registered: Array<Record<string, unknown>> = [];
  const api = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
    on() {},
    getAllTools() {
      return [];
    },
  } as unknown as ExtensionAPI;
  registerToolDisplayOverrides(api, () => config);
  const installed = (globalThis as Record<PropertyKey, unknown>)[
    TOOL_DISPLAY_API_KEY
  ];
  if (!installed) throw new Error("real display provider was not installed");
  const calls: ProviderCall[] = [];
  const actual = installed as Record<string, any>;
  const originalGetToolPresentation = actual.getToolPresentation.bind(actual);
  Object.defineProperty(actual, "getToolPresentation", {
    configurable: true,
    value: (name: string) => {
      const snapshot = originalGetToolPresentation(name);
      if (!snapshot) return snapshot;
      return {
        ...snapshot,
        ...(snapshot.renderCall
          ? {
              renderCall: (
                args: Record<string, unknown>,
                theme: unknown,
                context: unknown,
              ) => {
                const component = snapshot.renderCall(args, theme, context);
                calls.push({ name, kind: "call", component });
                return component;
              },
            }
          : {}),
        ...(snapshot.renderResult
          ? {
              renderResult: (
                result: unknown,
                options: unknown,
                theme: unknown,
                context: unknown,
              ) => {
                const component = snapshot.renderResult(
                  result,
                  options,
                  theme,
                  context,
                );
                calls.push({ name, kind: "result", component });
                return component;
              },
            }
          : {}),
      };
    },
  });
  return { api: actual as BtwToolDisplayApi, registered, calls };
}

function cleanupRealProvider(): void {
  const installed = (globalThis as Record<PropertyKey, unknown>)[
    TOOL_DISPLAY_API_KEY
  ];
  if (installed) disposeToolPresentationApi(installed);
  Reflect.deleteProperty(globalThis, TOOL_DISPLAY_API_KEY);
}

beforeEach(() => {
  initTheme();
  cleanupRealProvider();
});

afterEach(() => {
  cleanupRealProvider();
});

describe("BTW display isolation", () => {
  it("uses the real seven built-in renderers without executing child tools", () => {
    const provider = installRealProvider({
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      readOutputMode: "preview",
      searchOutputMode: "preview",
    });
    const parentExecutes = provider.registered.map((tool) =>
      vi.spyOn(tool, "execute"),
    );
    const childExecute = vi.fn(() => {
      throw new Error("display must never execute a child tool");
    });
    const childDefinitions = new Map<string, ToolDefinition>();
    for (const name of DISPLAY_TOOL_NAMES) {
      childDefinitions.set(name, {
        name,
        label: name,
        description: `${name} child definition`,
        parameters: {},
        execute: childExecute,
      } as unknown as ToolDefinition);
    }
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) => childDefinitions.get(name),
      getDisplayApi: () => provider.api,
      isLocalWorkspace: () => true,
    });
    const fixtures: Record<
      (typeof DISPLAY_TOOL_NAMES)[number],
      { args: Record<string, unknown>; result: unknown; marker: string }
    > = {
      read: {
        args: { path: "src/file.ts" },
        result: { content: [{ type: "text", text: "export const x = 1;" }] },
        marker: "src/file.ts",
      },
      grep: {
        args: { pattern: "needle", path: "src", glob: "*.ts" },
        result: { content: [{ type: "text", text: "src/a.ts:1:needle" }] },
        marker: "needle",
      },
      find: {
        args: { pattern: "*.ts", path: "src" },
        result: { content: [{ type: "text", text: "src/a.ts" }] },
        marker: "*.ts",
      },
      ls: {
        args: { path: "src" },
        result: { content: [{ type: "text", text: "a.ts\nb.ts" }] },
        marker: "a.ts",
      },
      bash: {
        args: { command: "echo hello" },
        result: { content: [{ type: "text", text: "hello" }] },
        marker: "$ echo hello",
      },
      edit: {
        args: { path: "src/a.ts", oldText: "old", newText: "new" },
        result: { content: [{ type: "text", text: "Edited src/a.ts" }] },
        marker: "src/a.ts",
      },
      write: {
        args: { path: "src/a.ts", content: "new line\n" },
        result: { content: [{ type: "text", text: "Wrote src/a.ts" }] },
        marker: "src/a.ts",
      },
    };
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    for (const name of DISPLAY_TOOL_NAMES) {
      toolCall(
        state,
        `call-${name}`,
        name,
        fixtures[name].args,
        fixtures[name].result,
      );
    }

    for (const name of DISPLAY_TOOL_NAMES) {
      const component = state.toolComponents.get(`call-${name}`);
      expect(component, name).toBeDefined();
      const rendered = plainLines(component!).join("\n");
      expect(rendered, name).toContain(fixtures[name].marker);
      const call = provider.calls
        .filter((entry) => entry.name === name && entry.kind === "call")
        .at(-1);
      const result = provider.calls
        .filter((entry) => entry.name === name && entry.kind === "result")
        .at(-1);
      expect(call, `${name} provider call`).toBeDefined();
      expect(result, `${name} provider result`).toBeDefined();
      const providerCallLines = plainLines(call!.component);
      const providerResultLines = plainLines(result!.component);
      expect(providerCallLines.length, `${name} call output`).toBeGreaterThan(
        0,
      );
      expect(
        providerResultLines.length,
        `${name} result output`,
      ).toBeGreaterThan(0);
      expect(rendered, `${name} uses provider call layout`).toContain(
        providerCallLines[0],
      );
      expect(rendered, `${name} uses provider result layout`).toContain(
        providerResultLines[0],
      );
    }
    expect(childExecute).not.toHaveBeenCalled();
    expect(parentExecutes.every((spy) => spy.mock.calls.length === 0)).toBe(
      true,
    );
    expect(adapter.diagnostics.messages).toEqual([]);
    // The provider itself never exposes execution fields to the consumer.
    for (const name of DISPLAY_TOOL_NAMES) {
      expect(provider.api.getToolPresentation?.(name)).not.toHaveProperty(
        "execute",
      );
    }

    // Negative control: the same transcript with the display adapter disabled
    // must not produce the real provider's bash layout. If the adapter were
    // switched back to native, the marker assertion above would fail.
    const nativeAdapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) => childDefinitions.get(name),
      getDisplayApi: () => undefined,
      isLocalWorkspace: () => true,
    });
    const nativeState = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: nativeAdapter.resolveToolDefinition,
    });
    toolCall(
      nativeState,
      "call-bash-native",
      "bash",
      fixtures.bash.args,
      fixtures.bash.result,
    );
    const nativeBash = plainLines(
      nativeState.toolComponents.get("call-bash-native")!,
    ).join("\n");
    expect(nativeBash).not.toContain("$ echo hello");
  });

  it("stops a real bash spinner before provider rebuild, retainOnly, clear, and dispose", () => {
    vi.useFakeTimers();
    try {
      const provider = installRealProvider();
      const adapter = new BtwToolDisplayAdapter({
        getDisplayApi: () => provider.api,
        isLocalWorkspace: () => false,
      });
      const state = createTranscriptState({
        cwd: "/test/project",
        resolveToolDefinition: adapter.resolveToolDefinition,
      });
      const components = new BtwToolComponents({
        cwd: "/test/project",
        resolveToolDefinition: adapter.resolveToolDefinition,
      });
      state.toolComponents = components;
      let repaints = 0;
      components.setRequestRender(() => {
        repaints += 1;
      });

      apply(state, [
        event({ type: "turn_start" }),
        event({
          type: "tool_execution_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command: "sleep 10" },
        }),
      ]);
      expect(vi.getTimerCount()).toBe(1);

      components.rebuild();
      // The old component's spinner timer must be gone; the rebuilt component
      // starts exactly one replacement.
      expect(vi.getTimerCount()).toBe(1);
      const replacement = components.get("bash-1")!;
      const beforeAdvance = replacement.render(80).join("\n");
      repaints = 0;
      vi.advanceTimersByTime(200);
      const afterAdvance = replacement.render(80).join("\n");
      expect(afterAdvance).not.toBe(beforeAdvance);
      expect(repaints).toBeGreaterThan(0);

      const retained = components.get("bash-1")!;
      components.retainOnly(new Set());
      expect(vi.getTimerCount()).toBe(0);
      const retainedAfterStop = retained.render(80).join("\n");
      repaints = 0;
      vi.advanceTimersByTime(1000);
      expect(repaints).toBe(0);
      expect(retained.render(80).join("\n")).toBe(retainedAfterStop);

      apply(state, [
        event({
          type: "tool_execution_start",
          toolCallId: "bash-2",
          toolName: "bash",
          args: { command: "sleep 10" },
        }),
      ]);
      expect(vi.getTimerCount()).toBe(1);
      const cleared = components.get("bash-2")!;
      components.clear();
      expect(vi.getTimerCount()).toBe(0);
      const clearedAfterStop = cleared.render(80).join("\n");
      repaints = 0;
      vi.advanceTimersByTime(1000);
      expect(repaints).toBe(0);
      expect(cleared.render(80).join("\n")).toBe(clearedAfterStop);

      apply(state, [
        event({
          type: "tool_execution_start",
          toolCallId: "bash-3",
          toolName: "bash",
          args: { command: "sleep 10" },
        }),
      ]);
      expect(vi.getTimerCount()).toBe(1);
      const disposed = components.get("bash-3")!;
      components.dispose();
      expect(vi.getTimerCount()).toBe(0);
      const disposedAfterStop = disposed.render(80).join("\n");
      vi.advanceTimersByTime(1000);
      expect(disposed.render(80).join("\n")).toBe(disposedAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not apply a provider snapshot to a non-built-in or parent-owned tool", () => {
    const childExecute = vi.fn();
    const childDefinition = {
      name: "parent_write",
      label: "parent_write",
      description: "parent tool",
      parameters: {},
      execute: childExecute,
      renderCall: () => new Text("CHILD_PARENT_WRITE"),
    } as unknown as ToolDefinition;
    const providerSnapshot = {
      name: "parent_write",
      renderCall: () => new Text("PROVIDER_PARENT_WRITE"),
    };
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "parent_write" ? childDefinition : undefined,
      getDisplayApi: () =>
        ({
          version: 1,
          decorateTool: (tool) => tool,
          getToolPresentation: () => providerSnapshot,
        }) as BtwToolDisplayApi,
      isLocalWorkspace: () => true,
    });

    const resolved = adapter.resolveToolDefinition("parent_write");
    // Display copy (the child renderer is wrapped in the draw/invalidate/mouse
    // guard); the source definition keeps its renderer and execute function,
    // and the provider snapshot is never applied to a non-built-in tool.
    expect(resolved).not.toBe(childDefinition);
    expect(childDefinition.renderCall).toBeDefined();
    expect(
      resolved
        ?.renderCall?.(
          {},
          plainTheme as never,
          {} as BtwToolPresentationRenderContext,
        )
        .render(80)
        .join("\n"),
    ).toContain("CHILD_PARENT_WRITE");
    expect(adapter.resolveToolDefinition("not_registered")).toBeUndefined();
    expect(childExecute).not.toHaveBeenCalled();
  });

  it("keeps a custom child renderer even when the real provider is installed", () => {
    const provider = installRealProvider();
    const execute = vi.fn();
    const childDefinition = {
      name: "custom_tool",
      label: "custom_tool",
      description: "custom",
      parameters: {},
      execute,
      renderCall: () => new Text("CUSTOM_CHILD_RENDERER"),
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "custom_tool" ? childDefinition : undefined,
      getDisplayApi: () => provider.api,
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    toolCall(state, "custom-call", "custom_tool");

    const output = state.toolComponents
      .get("custom-call")!
      .render(120)
      .join("\n");
    expect(output).toContain("CUSTOM_CHILD_RENDERER");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a same-name child built-in renderer ahead of the real provider", () => {
    const provider = installRealProvider();
    const childExecute = vi.fn();
    const childDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: childExecute,
      renderCall: () => new Text("CHILD_READ_CALL"),
      renderResult: () => new Text("CHILD_READ_RESULT"),
    } as unknown as ToolDefinition;
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) =>
        name === "read" ? childDefinition : undefined,
      getDisplayApi: () => provider.api,
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    toolCall(
      state,
      "child-read",
      "read",
      { path: "src/file.ts" },
      { content: [{ type: "text", text: "export const x = 1;" }] },
    );

    const rendered = plainLines(state.toolComponents.get("child-read")!).join(
      "\n",
    );
    expect(rendered).toContain("CHILD_READ_CALL");
    expect(rendered).toContain("CHILD_READ_RESULT");
    expect(
      provider.calls.filter((entry) => entry.name === "read"),
    ).toHaveLength(0);
    expect(childExecute).not.toHaveBeenCalled();
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("keeps same-name child resolver renderers ahead of the real provider for that tool only", () => {
    const provider = installRealProvider();
    const childDefinitions = new Map<string, ToolDefinition>([
      [
        "read",
        {
          name: "read",
          label: "read",
          description: "read a file",
          parameters: {},
          execute: vi.fn(),
        } as unknown as ToolDefinition,
      ],
      [
        "bash",
        {
          name: "bash",
          label: "bash",
          description: "run a command",
          parameters: {},
          execute: vi.fn(),
        } as unknown as ToolDefinition,
      ],
    ]);
    const adapter = new BtwToolDisplayAdapter({
      getChildToolDefinition: (name) => childDefinitions.get(name),
      // Public extension renderer resolution: only bash is claimed by the
      // child; read must keep the provider styling.
      getChildToolRenderers: (name) =>
        name === "bash"
          ? {
              renderCall: () => new Text("CHILD_BASH_CALL"),
              renderResult: () => new Text("CHILD_BASH_RESULT"),
            }
          : undefined,
      getDisplayApi: () => provider.api,
      isLocalWorkspace: () => true,
    });
    const state = createTranscriptState({
      cwd: "/test/project",
      resolveToolDefinition: adapter.resolveToolDefinition,
    });
    apply(state, [event({ type: "turn_start" })]);
    toolCall(
      state,
      "child-bash",
      "bash",
      { command: "echo hello" },
      { content: [{ type: "text", text: "hello" }] },
    );
    toolCall(
      state,
      "provider-read",
      "read",
      { path: "src/file.ts" },
      { content: [{ type: "text", text: "export const x = 1;" }] },
    );

    const bashRendered = plainLines(
      state.toolComponents.get("child-bash")!,
    ).join("\n");
    expect(bashRendered).toContain("CHILD_BASH_CALL");
    expect(bashRendered).toContain("CHILD_BASH_RESULT");
    expect(
      provider.calls.filter((entry) => entry.name === "bash"),
    ).toHaveLength(0);

    const readComponent = state.toolComponents.get("provider-read")!;
    const readRendered = plainLines(readComponent).join("\n");
    const providerReadCall = provider.calls
      .filter((entry) => entry.name === "read" && entry.kind === "call")
      .at(-1);
    expect(providerReadCall).toBeDefined();
    expect(readRendered).toContain(plainLines(providerReadCall!.component)[0]);
    expect(adapter.diagnostics.messages).toEqual([]);
  });

  it("does not read a local file for an SSH pending write preview", async () => {
    const provider = installRealProvider();
    const dir = await mkdtemp(join(tmpdir(), "btw-ssh-preview-"));
    try {
      await writeFile(join(dir, "remote.txt"), "LOCAL_SECRET_CONTENT\n");
      const adapter = new BtwToolDisplayAdapter({
        getDisplayApi: () => provider.api,
        isLocalWorkspace: () => false,
      });
      const resolved = adapter.resolveToolDefinition("write");
      const renderCall = resolved?.renderCall;
      expect(renderCall).toBeDefined();
      const args = { path: "remote.txt", content: "REMOTE_NEW_CONTENT\n" };
      const component = renderCall!(
        args,
        plainTheme as never,
        {
          args,
          toolCallId: "remote-call",
          cwd: dir,
          argsComplete: true,
          isPartial: true,
        } as BtwToolPresentationRenderContext,
      );
      const output = component.render(120).join("\n");
      expect(output).not.toContain("LOCAL_SECRET_CONTENT");
      expect(output).toContain("write");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("denies parent execution metadata for a coincidentally equal write toolCallId", () => {
    const provider = installRealProvider();
    const adapter = new BtwToolDisplayAdapter({
      getDisplayApi: () => provider.api,
      isLocalWorkspace: () => false,
    });
    const resolved = adapter.resolveToolDefinition("write");
    const result = {
      content: [{ type: "text", text: "REMOTE_WRITE_RESULT" }],
      details: {},
    };
    const options = { expanded: false, isPartial: false };
    const context = {
      args: { path: "remote.txt", content: "REMOTE_NEW_CONTENT\n" },
      toolCallId: "same-call-id",
      cwd: "/remote/workspace",
      argsComplete: true,
      isPartial: false,
      isError: false,
      state: {
        __piToolDisplayWriteExecutionMeta: {
          previousContent: "PARENT_SECRET_CONTENT",
          fileExistedBeforeWrite: true,
        },
      },
    } as BtwToolPresentationRenderContext;
    const output = resolved!.renderResult!(
      result,
      options,
      plainTheme as never,
      context,
    )
      .render(120)
      .join("\n");
    expect(output).not.toContain("PARENT_SECRET_CONTENT");
    expect(output).not.toContain("created");
    expect(output).not.toContain("overwritten");
    expect(output).toContain("REMOTE_WRITE_RESULT");

    // Positive control: the real provider renderer would use the same state
    // when the host grants executionMetadata. BTW's wrapper must not.
    const snapshot = provider.api.getToolPresentation?.("write");
    const direct = snapshot!.renderResult!(
      result,
      options,
      plainTheme as never,
      {
        ...context,
        capabilities: { executionMetadata: true, localWorkspace: false },
      },
    )
      .render(120)
      .join("\n");
    expect(direct).toContain("PARENT_SECRET_CONTENT");
  });

  it("namespaces toolCallIds and keeps renderer state isolated per BTW component", () => {
    const contexts: BtwToolPresentationRenderContext[] = [];
    const renderCall = (
      _args: Record<string, unknown>,
      _theme: unknown,
      context: BtwToolPresentationRenderContext,
    ): Component => {
      contexts.push(context);
      return new Text("ISOLATED_RENDER");
    };
    const api = {
      version: 1,
      decorateTool: (tool: Record<string, unknown>) => tool,
      getToolPresentation: () => ({ name: "read", renderCall }),
    } as BtwToolDisplayApi;
    const firstAdapter = new BtwToolDisplayAdapter({
      namespace: "btwA",
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });
    const secondAdapter = new BtwToolDisplayAdapter({
      namespace: "btwB",
      getDisplayApi: () => api,
      isLocalWorkspace: () => true,
    });
    const first = createTranscriptState({
      resolveToolDefinition: firstAdapter.resolveToolDefinition,
    });
    const second = createTranscriptState({
      resolveToolDefinition: secondAdapter.resolveToolDefinition,
    });
    toolCall(first, "same-id", "read");
    toolCall(second, "same-id", "read");
    first.toolComponents.get("same-id")!.render(80);
    second.toolComponents.get("same-id")!.render(80);

    const firstContext = contexts.find(
      (context) => context.toolCallId === "btwA:same-id",
    );
    const secondContext = contexts.find(
      (context) => context.toolCallId === "btwB:same-id",
    );
    expect(firstContext).toBeDefined();
    expect(secondContext).toBeDefined();
    expect(firstContext!.state).not.toBe(secondContext!.state);
    (firstContext!.state as Record<string, unknown>).ownedBy = "first";
    expect(
      (secondContext!.state as Record<string, unknown>).ownedBy,
    ).toBeUndefined();
  });
});
