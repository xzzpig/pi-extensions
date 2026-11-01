import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
// Test-only cross-package imports: the real provider registration path is
// used so SSH/capability tests exercise the approved renderers, not a mock
// that could silently skip the dangerous local-preview branch.
import { disposeToolPresentationApi } from "../../pi-tool-display/src/tool-presentation";
import { registerToolDisplayOverrides } from "../../pi-tool-display/src/tool-overrides";
import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  type ToolDisplayConfig,
} from "../../pi-tool-display/src/types";

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

type ContextCapture = {
  toolCallId?: string;
  capabilities?: {
    localWorkspace?: boolean;
    executionMetadata?: boolean;
  };
  args?: unknown;
};

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
    getActiveToolNames: vi.fn(() => ["read", "grep", "find", "ls"]),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    extensionRunner: { emit: vi.fn(async () => {}) },
  };
  return { session, emit };
}

function installRealProvider(config: ToolDisplayConfig): {
  api: Record<string, any>;
  actual: Record<string, any>;
  registered: Array<Record<string, any>>;
  contexts: ContextCapture[];
} {
  const registered: Array<Record<string, any>> = [];
  const api = {
    registerTool(tool: Record<string, any>) {
      registered.push(tool);
    },
    on() {},
    getAllTools() {
      return [];
    },
  } as unknown as ExtensionAPI;
  registerToolDisplayOverrides(api, () => config);
  const actual = (globalThis as Record<PropertyKey, unknown>)[
    TOOL_DISPLAY_API_KEY
  ] as Record<string, any>;
  if (!actual) throw new Error("real display provider was not installed");
  const contexts: ContextCapture[] = [];
  const originalGetToolPresentation = actual.getToolPresentation.bind(actual);
  Object.defineProperty(actual, "getToolPresentation", {
    configurable: true,
    value: (name: string) => {
      const snapshot = originalGetToolPresentation(name);
      if (name !== "write" || !snapshot?.renderCall) return snapshot;
      return {
        ...snapshot,
        renderCall: (
          args: Record<string, unknown>,
          theme: unknown,
          context: ContextCapture,
        ) => {
          contexts.push(context);
          return snapshot.renderCall(args, theme, context);
        },
      };
    },
  });
  return { api: actual, actual, registered, contexts };
}

function cleanupProvider(): void {
  const installed = (globalThis as Record<PropertyKey, unknown>)[
    TOOL_DISPLAY_API_KEY
  ];
  if (installed) disposeToolPresentationApi(installed);
  Reflect.deleteProperty(globalThis, TOOL_DISPLAY_API_KEY);
}

function createHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const overlays: any[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
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
    notify: (message: string, type?: "info" | "warning" | "error") => {
      notifications.push({ message, type });
    },
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

  const model = {
    provider: "test-provider",
    id: "test-model",
    api: "openai-responses",
  };
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
  const handlers: Function[] = [];
  btwExtension(api);

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
    model,
    getSystemPrompt: () => "system",
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;

  async function command(name: string, args = "") {
    const command = commands.get(name);
    if (!command) throw new Error(`Missing command ${name}`);
    await command.handler(args, ctx);
  }

  return {
    ctx,
    tui,
    overlays,
    notifications,
    command,
    latestOverlay: () => overlays.at(-1),
  };
}

beforeEach(() => {
  initTheme();
  cleanupProvider();
  mocks.createAgentSession.mockReset();
  mocks.sessionManagerInMemory.mockReset().mockReturnValue({
    appendMessage: vi.fn(),
  });
  mocks.readBtwExtensionSources.mockReset().mockResolvedValue([]);
  mocks.readBtwWorkspaceMode.mockReset().mockResolvedValue("ssh");
  mocks.loadBtwExtensionResources.mockReset();
  mocks.createBtwSshWorkspace.mockReset().mockResolvedValue({
    label: "SSH test:/remote",
    identity: "ssh:test",
    tools: [],
    assertCurrent: vi.fn(),
    dispose: vi.fn(async () => {}),
  });
});

afterEach(() => {
  cleanupProvider();
});

describe("BTW SSH display isolation", () => {
  it("keeps the SSH workspace non-local after the session closes and the provider changes", async () => {
    const config: ToolDisplayConfig = {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      registerToolOverrides: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
      },
      customToolOverrides: {},
    };
    const provider = installRealProvider(config);
    const parentWrite = provider.registered.find(
      (tool) => tool.name === "write",
    );
    expect(parentWrite).toBeDefined();
    const parentExecute = vi.spyOn(parentWrite!, "execute");
    const harness = createHarness();
    let promptCount = 0;
    let sessionOptions: any;
    mocks.createAgentSession.mockImplementation(async (options: any) => {
      sessionOptions = options;
      const { session } = createMockSession({
        async onPrompt(emit) {
          promptCount += 1;
          if (promptCount > 1) throw new Error("remote failure after close");
          emit({ type: "turn_start" });
          emit({
            type: "tool_execution_start",
            toolCallId: "same-call-id",
            toolName: "write",
            args: { path: "remote.txt", content: "REMOTE_CONTENT\n" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "same-call-id",
            toolName: "write",
            result: {
              content: [{ type: "text", text: "REMOTE_WRITE_RESULT" }],
            },
            isError: false,
          });
          const message = makeAssistantMessage("remote answer");
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
          emit({ type: "turn_end", message, toolResults: [] });
          session.state.messages.push(message);
        },
      });
      return {
        session,
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    });

    await harness.command("btw", "remote question");
    const overlay = harness.latestOverlay();
    expect(overlay).toBeDefined();
    expect(sessionOptions.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(sessionOptions.customTools).toEqual([]);
    expect(mocks.loadBtwExtensionResources).not.toHaveBeenCalled();
    overlay.render(120);
    expect(provider.contexts.length).toBeGreaterThan(0);
    expect(provider.contexts.at(-1)?.capabilities?.localWorkspace).toBe(false);
    expect(parentExecute).not.toHaveBeenCalled();

    // A failed follow-up disposes the live session while leaving the overlay
    // and the retained SSH transcript on screen.
    await harness.command("btw", "fail this turn");
    expect(mocks.createBtwSshWorkspace).toHaveBeenCalled();
    expect(
      harness.notifications.some((entry) =>
        entry.message.includes("remote failure"),
      ),
    ).toBe(true);

    // A provider revision change must rebuild the retained write component;
    // activeBtwSession is now null, so this is the exact stale-live-session
    // path that used to flip localWorkspace back to true.
    config.diffWordWrap = !config.diffWordWrap;
    const before = provider.contexts.length;
    overlay.render(120);
    const rebuilt = provider.contexts.slice(before);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(
      rebuilt.every(
        (context) => context.capabilities?.localWorkspace === false,
      ),
    ).toBe(true);
    expect(
      rebuilt.every(
        (context) => context.capabilities?.executionMetadata === false,
      ),
    ).toBe(true);

    // Reopening the same retained thread creates a new SSH session and reuses
    // the thread-owned display/components; the capability must still be false.
    overlay.handleInput("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.command("btw", "");
    const reopened = harness.latestOverlay();
    expect(reopened).not.toBe(overlay);
    config.diffWordWrap = !config.diffWordWrap;
    const beforeReopen = provider.contexts.length;
    reopened.render(120);
    const reopenedContexts = provider.contexts.slice(beforeReopen);
    expect(reopenedContexts.length).toBeGreaterThan(0);
    expect(
      reopenedContexts.every(
        (context) => context.capabilities?.localWorkspace === false,
      ),
    ).toBe(true);
  });

  it("binds allowlisted extensions once while the display provider is active", async () => {
    const config: ToolDisplayConfig = {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      registerToolOverrides: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
      },
      customToolOverrides: {},
    };
    const provider = installRealProvider(config);
    const harness = createHarness();
    const extensionsResult = {
      extensions: [
        { path: "/btw/web.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [] as Array<{ path: string; error: string }>,
      runtime: {},
    };
    mocks.readBtwExtensionSources.mockResolvedValue(["npm:pi-web"]);
    mocks.loadBtwExtensionResources.mockResolvedValue({
      getExtensions: () => extensionsResult,
    });
    let options: any;
    let activeTools: string[] = [];
    const bindExtensions = vi.fn(async () => {});
    mocks.createAgentSession.mockImplementation(async (sessionOptions: any) => {
      options = sessionOptions;
      const { session } = createMockSession({
        async onPrompt(emit) {
          emit({ type: "turn_start" });
          const message = makeAssistantMessage("extension answer");
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
          emit({ type: "turn_end", message, toolResults: [] });
        },
      });
      session.bindExtensions = bindExtensions;
      session.setActiveToolsByName.mockImplementation((names: string[]) => {
        activeTools = names;
      });
      session.getActiveToolNames.mockImplementation(() => activeTools);
      return { session, extensionsResult };
    });

    await harness.command("btw", "look this up");

    expect(mocks.readBtwExtensionSources).toHaveBeenCalledTimes(1);
    expect(mocks.loadBtwExtensionResources).toHaveBeenCalledTimes(1);
    expect(bindExtensions).toHaveBeenCalledTimes(1);
    expect(options.noTools).toBe("builtin");
    expect(activeTools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "web_search",
    ]);
  });

  it("keeps remote tool components conservative after a local child replaces a failed SSH session", async () => {
    const config: ToolDisplayConfig = {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      registerToolOverrides: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
      },
      customToolOverrides: {},
    };
    const provider = installRealProvider(config);
    const harness = createHarness();
    let createCount = 0;
    let localOptions: any;
    mocks.createAgentSession.mockImplementation(async (sessionOptions: any) => {
      createCount += 1;
      const isRemote = createCount === 1;
      if (!isRemote) localOptions = sessionOptions;
      const { session } = createMockSession({
        async onPrompt(emit) {
          emit({ type: "turn_start" });
          if (isRemote) {
            emit({
              type: "tool_execution_start",
              toolCallId: "remote-write",
              toolName: "write",
              args: { path: "remote.txt", content: "REMOTE_CONTENT\n" },
            });
            emit({
              type: "tool_execution_end",
              toolCallId: "remote-write",
              toolName: "write",
              result: {
                content: [{ type: "text", text: "REMOTE_WRITE_RESULT" }],
              },
              isError: false,
            });
            throw new Error("remote turn failed");
          }
          const message = makeAssistantMessage("local answer");
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
          emit({ type: "turn_end", message, toolResults: [] });
          session.state.messages.push(message);
        },
      });
      return {
        session,
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    });

    await harness.command("btw", "remote question");
    const overlay = harness.latestOverlay();
    expect(overlay).toBeDefined();
    expect(
      harness.notifications.some((entry) =>
        entry.message.includes("remote turn failed"),
      ),
    ).toBe(true);
    expect(mocks.createBtwSshWorkspace).toHaveBeenCalledTimes(1);
    const remoteWorkspace =
      await mocks.createBtwSshWorkspace.mock.results[0].value;
    expect(remoteWorkspace.dispose).toHaveBeenCalledTimes(1);

    // The same retained transcript now starts a LOCAL child. The remote tool
    // slot is still present, so the display must remain conservative until a
    // real thread reset/restore discards it.
    mocks.readBtwWorkspaceMode.mockResolvedValue("local");
    await harness.command("btw", "local follow-up");
    expect(createCount).toBe(2);
    expect(localOptions.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(localOptions.customTools).toBeUndefined();
    expect(mocks.createBtwSshWorkspace).toHaveBeenCalledTimes(1);

    config.diffWordWrap = !config.diffWordWrap;
    const before = provider.contexts.length;
    overlay.render(120);
    const rebuilt = provider.contexts.slice(before);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(
      rebuilt.every(
        (context) => context.capabilities?.localWorkspace === false,
      ),
    ).toBe(true);
    expect(
      rebuilt.every(
        (context) => context.capabilities?.executionMetadata === false,
      ),
    ).toBe(true);
  });

  it("does not load extensions or add tools in read-only SSH mode despite the display provider", async () => {
    const config: ToolDisplayConfig = {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      registerToolOverrides: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
      },
      customToolOverrides: {},
    };
    const provider = installRealProvider(config);
    const harness = createHarness();
    let options: any;
    mocks.createAgentSession.mockImplementation(async (sessionOptions: any) => {
      options = sessionOptions;
      const { session } = createMockSession({
        async onPrompt(emit) {
          emit({ type: "turn_start" });
          const message = makeAssistantMessage("read-only answer");
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
          emit({ type: "turn_end", message, toolResults: [] });
        },
      });
      session.getActiveToolNames.mockReturnValue([
        "read",
        "grep",
        "find",
        "ls",
      ]);
      return {
        session,
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    });

    await harness.command("btw:ask", "safe remote question");

    expect(mocks.readBtwExtensionSources).not.toHaveBeenCalled();
    expect(mocks.loadBtwExtensionResources).not.toHaveBeenCalled();
    expect(options.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(options.customTools).toEqual([]);
    expect(options.noTools).toBeUndefined();
  });
});
