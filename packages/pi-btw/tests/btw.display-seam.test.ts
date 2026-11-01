import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Fork-only seam test: drives the real `btw.ts` extension so the display
 * adapter's child-renderer resolution goes through
 * `AgentSession.extensionRunner.resolveToolRenderers`, against the child's own
 * registered definition, and never through the parent session.
 *
 * The harness is a reduced form of the fork-only `btw.ssh-isolation.test.ts`
 * harness: real `btwExtension(api)`, mocked child-session creation, real
 * transcript/overlay path.
 */
const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionManagerInMemory: vi.fn(),
  readBtwExtensionSources: vi.fn(),
  readBtwWorkspaceMode: vi.fn(),
  loadBtwExtensionResources: vi.fn(),
  createBtwSshWorkspace: vi.fn(),
}));

vi.mock("../extensions/btw-extension-tools", () => ({
  readBtwExtensionSources: mocks.readBtwExtensionSources,
  readBtwWorkspaceMode: mocks.readBtwWorkspaceMode,
  loadBtwExtensionResources: mocks.loadBtwExtensionResources,
}));

vi.mock("../extensions/btw-ssh-workspace", () => ({
  createBtwSshWorkspace: mocks.createBtwSshWorkspace,
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: mocks.createAgentSession,
    buildSessionContext: () => ({ messages: [] }),
    SessionManager: {
      ...actual.SessionManager,
      inMemory: mocks.sessionManagerInMemory,
    },
  };
});

import btwExtension from "../extensions/btw";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");

function makeAssistantMessage(answer: string) {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text: answer }],
    provider: "test-provider",
    model: "test-model",
    api: "openai-responses" as const,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function createMockSession(options: {
  onPrompt: (emit: (event: unknown) => void, session: any) => Promise<void>;
}) {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of listeners) listener(event);
  };
  const session: any = {
    state: { messages: [] },
    isStreaming: false,
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      session.isStreaming = true;
      try {
        await options.onPrompt(emit, session);
      } finally {
        session.isStreaming = false;
      }
    },
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    getToolDefinition: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read", "bash", "edit", "write"]),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    extensionRunner: { emit: vi.fn(async () => {}) },
  };
  return { session, emit };
}

function installFakeProvider(): {
  api: Record<string, unknown>;
  providerCall: ReturnType<typeof vi.fn>;
  providerResult: ReturnType<typeof vi.fn>;
} {
  const providerCall = vi.fn(() => new Text("PARENT_PROVIDER_CALL"));
  const providerResult = vi.fn(() => new Text("PARENT_PROVIDER_RESULT"));
  const api = {
    version: 1,
    decorateTool: (tool: unknown) => tool,
    getToolPresentation: (name: string) =>
      name === "read"
        ? {
            name,
            renderCall: providerCall,
            renderResult: providerResult,
          }
        : undefined,
    presentationRevision: 1,
  };
  (globalThis as Record<PropertyKey, unknown>)[TOOL_DISPLAY_API_KEY] = api;
  return { api, providerCall, providerResult };
}

function cleanupProvider(): void {
  Reflect.deleteProperty(globalThis, TOOL_DISPLAY_API_KEY);
}

function createHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const overlays: any[] = [];
  const tui = {
    requestRender: vi.fn(),
    terminal: { write: vi.fn() },
    mode: "regular",
  };
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    italic: (text: string) => text,
    bold: (text: string) => text,
  };
  const keybindings = { matches: () => false };
  const fakeHandle = {
    focused: true,
    focus() {
      this.focused = true;
    },
    unfocus() {
      this.focused = false;
    },
    isFocused() {
      return this.focused;
    },
    setHidden() {},
    isHidden() {
      return false;
    },
    hide() {},
  };

  const ui = {
    theme,
    notify: () => {},
    setWidget: () => {},
    custom: async (factory: any, options?: any) => {
      let done!: () => void;
      const result = new Promise<void>((resolve) => {
        done = resolve;
      });
      options?.onHandle?.(fakeHandle);
      overlays.push(await factory(tui, theme, keybindings, done));
      return result;
    },
  };

  const handlers: Function[] = [];
  const api: ExtensionAPI = {
    on: ((event: string, handler: Function) => {
      if (event === "session_start") handlers.push(handler);
    }) as any,
    registerCommand: ((name: string, options: any) => {
      commands.set(name, { name, ...options } as RegisteredCommand);
    }) as any,
    registerTool: vi.fn() as any,
    registerShortcut: vi.fn() as any,
    registerFlag: vi.fn() as any,
    getFlag: vi.fn() as any,
    registerMessageRenderer: vi.fn() as any,
    sendMessage: vi.fn() as any,
    sendUserMessage: vi.fn() as any,
    appendEntry: vi.fn() as any,
    setSessionName: vi.fn() as any,
    getSessionName: vi.fn() as any,
    setLabel: vi.fn() as any,
    exec: vi.fn() as any,
    getActiveTools: vi.fn(() => []) as any,
    getAllTools: vi.fn(() => []) as any,
    setActiveTools: vi.fn() as any,
    getCommands: vi.fn(() => []) as any,
    setModel: vi.fn(async () => true) as any,
    getThinkingLevel: vi.fn(() => "off") as any,
    setThinkingLevel: vi.fn() as any,
    registerProvider: vi.fn() as any,
  } as unknown as ExtensionAPI;
  btwExtension(api);

  const entries: any[] = [];
  const sessionManager = {
    getEntries: () => entries,
    getLeafId: () => "leaf",
    getBranch: () => entries,
    appendMessage: (message: unknown) => {
      entries.push(message);
      return `entry-${entries.length}`;
    },
  };
  const ctx = {
    cwd: "/test/project",
    isProjectTrusted: () => true,
    hasUI: true,
    mode: "tui",
    ui: ui as any,
    sessionManager: sessionManager as any,
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "test-key",
      })),
      hasConfiguredAuth: vi.fn(() => true),
      getRegisteredNativeProvider: vi.fn(() => undefined),
      getRegisteredProviderConfig: vi.fn(() => undefined),
      getProviderAuthStatus: vi.fn(() => ({
        configured: true,
        source: "test",
      })),
      find: vi.fn((provider: string, id: string) => ({
        provider,
        id,
        api: "openai-responses",
      })),
    },
    model: {
      provider: "test-provider",
      id: "test-model",
      api: "openai-responses",
    },
    getSystemPrompt: () => "system",
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;

  async function command(name: string, args = "") {
    const registered = commands.get(name);
    if (!registered) throw new Error(`Missing command ${name}`);
    await registered.handler(args, ctx);
  }

  async function sessionStart() {
    for (const handler of handlers) await handler({}, ctx);
  }

  return {
    api,
    ctx,
    overlays,
    command,
    sessionStart,
    latestOverlay: () => overlays.at(-1),
  };
}

function transcriptText(overlay: any): string {
  (process.stdout as any).rows = 100;
  overlay.refresh();
  return overlay.render(200).join("\n");
}

beforeEach(() => {
  initTheme();
  cleanupProvider();
  mocks.createAgentSession.mockReset();
  mocks.sessionManagerInMemory.mockReset().mockReturnValue({
    appendMessage: vi.fn(),
  });
  mocks.readBtwExtensionSources.mockReset().mockResolvedValue([]);
  mocks.readBtwWorkspaceMode.mockReset().mockResolvedValue("local");
  mocks.loadBtwExtensionResources.mockReset();
  mocks.createBtwSshWorkspace.mockReset();
});

afterEach(() => {
  cleanupProvider();
});

describe("BTW display seam", () => {
  it("resolves same-name child renderers through the child runner with the child definition as base", async () => {
    const harness = createHarness();
    const { providerCall, providerResult } = installFakeProvider();
    const childExecute = vi.fn();
    const readDefinition = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: childExecute,
      renderCall: () => new Text("BASE_CHILD_CALL"),
      renderResult: () => new Text("BASE_CHILD_RESULT"),
    } as unknown as ToolDefinition;
    const seenBase: Array<ToolDefinition | undefined> = [];
    const resolveToolRenderers = vi.fn(
      (name: string, next: () => ToolDefinition | undefined) => {
        const base = next();
        seenBase.push(base);
        if (name !== "read") return base;
        // A legitimate resolver builds on the child session's own renderers.
        return {
          ...base,
          renderCall: () => new Text("WRAPPED_CHILD_CALL"),
          renderResult: () => new Text("WRAPPED_CHILD_RESULT"),
        };
      },
    );
    let childSession: any;
    let promptCalls = 0;
    mocks.createAgentSession.mockImplementation(async () => {
      const { session } = createMockSession({
        async onPrompt(emit) {
          promptCalls += 1;
          emit({ type: "turn_start" });
          emit({
            type: "tool_execution_start",
            toolCallId: "read-call",
            toolName: "read",
            args: { path: "package.json" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "read-call",
            toolName: "read",
            result: { content: [{ type: "text", text: "read result text" }] },
            isError: false,
          });
          const message = makeAssistantMessage("Read it.");
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
          emit({ type: "turn_end", message, toolResults: [] });
          session.state.messages.push(message);
        },
      });
      // The BTW child session exposes these public members; the extension seam
      // must read the renderer chain from the child runner, not the parent.
      session.getToolDefinition = vi.fn(() => readDefinition);
      session.extensionRunner = {
        emit: vi.fn(async () => {}),
        resolveToolRenderers,
      };
      childSession = session;
      return {
        session,
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    });

    await harness.sessionStart();
    await harness.command("btw", "read package metadata");

    const overlay = harness.latestOverlay();
    expect(overlay).toBeDefined();
    const transcript = transcriptText(overlay);
    expect(transcript).toContain("WRAPPED_CHILD_CALL");
    expect(transcript).toContain("WRAPPED_CHILD_RESULT");
    expect(transcript).not.toContain("BASE_CHILD_CALL");
    expect(transcript).not.toContain("PROVIDER_READ_CALL");
    expect(providerCall).not.toHaveBeenCalled();
    expect(providerResult).not.toHaveBeenCalled();
    expect(childExecute).not.toHaveBeenCalled();
    expect(resolveToolRenderers).toHaveBeenCalled();
    const [resolvedName, base] = resolveToolRenderers.mock.calls[0];
    expect(resolvedName).toBe("read");
    // The child runner resolves with the child's own definition as the base,
    // never the parent session or the provider.
    expect(base()).toBe(readDefinition);
    expect(seenBase.length).toBeGreaterThan(0);
    expect(seenBase.every((entry) => entry === readDefinition)).toBe(true);
    // No extra child session, no extra extension factory run, and the child's
    // execution allowlist is unchanged: only display resolution is consulted.
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(promptCalls).toBe(1);
    expect(childSession.getActiveToolNames()).toEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
  });
});
