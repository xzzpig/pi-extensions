import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ORDER = [
  "pi-tool-display",
  "pi-group-collapse",
  "pi-thinking-collapse",
  "pi-starline",
  "pi-tidy",
] as const;

export type PluginName = (typeof PLUGIN_ORDER)[number];
export type EventHandler = (event: Record<string, unknown>, ctx: any) => unknown;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHARED_PI_MODULES = new Map([
  ["@earendil-works/pi-coding-agent", import.meta.resolve("@earendil-works/pi-coding-agent")],
  ["@earendil-works/pi-tui", import.meta.resolve("@earendil-works/pi-tui")],
]);
let sharedRuntimeResolutionRegistered = false;

function registerSharedRuntimeResolution(): void {
  if (sharedRuntimeResolutionRegistered) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const sharedUrl = SHARED_PI_MODULES.get(specifier);
      return sharedUrl ? nextResolve(sharedUrl, context) : nextResolve(specifier, context);
    },
  });
  sharedRuntimeResolutionRegistered = true;
}

const ENTRY_PATHS: Record<PluginName, string> = {
  "pi-tool-display": "packages/pi-tool-display/src/index.ts",
  "pi-group-collapse": "packages/pi-group-collapse/index.ts",
  "pi-thinking-collapse": "packages/pi-thinking-collapse/index.ts",
  "pi-starline": "packages/pi-starline/extensions/starline/index.ts",
  "pi-tidy": "packages/pi-tidy/src/index.ts",
};

export interface IsolatedEnvironment {
  home: string;
  agentDir: string;
  cleanup(): void;
}

export interface HostHarness {
  pi: any;
  tools: Map<string, any>;
  commands: Map<string, any>;
  toolRenderers: Array<{ owner: string; resolver: Function }>;
  markdownTransformers: Array<{ owner: string; transformer: Function }>;
  handlers: Map<string, Array<{ owner: string; handler: EventHandler }>>;
  modules: Map<PluginName, any>;
  loadedPlugins: PluginName[];
  load(name: PluginName): Promise<void>;
  fire(eventName: string, ctx: any, event?: Record<string, unknown>): Promise<void>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function createIsolatedEnvironment(): IsolatedEnvironment {
  registerSharedRuntimeResolution();
  const home = mkdtempSync(join(tmpdir(), "pi-tidy-e2e-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeJson(join(agentDir, "settings.json"), {
    tidy: {
      enabled: true,
      frameTools: false,
      frameMessages: true,
      userMessageStyle: "frame",
      collapseTurns: "off",
      groupTools: false,
      splitDiff: false,
      highlightBash: false,
      backgroundJobs: false,
      cleanCopy: false,
      toolColors: {},
      dedupeErrors: true,
      hexSwatches: true,
      finalReplyStyle: "frame",
      codeBlocks: true,
    },
  });
  writeJson(join(agentDir, "extensions", "pi-tool-display", "config.json"), {
    enableNativeUserMessageBox: false,
    registerToolOverrides: {
      bash: false,
      read: false,
      grep: false,
      find: false,
      ls: false,
      edit: false,
      write: false,
    },
  });
  writeJson(join(agentDir, "starline.json"), {
    features: { editor: true, statusLine: false, copyFriendly: false },
    mouse: { enabled: false },
  });

  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let cleaned = false;
  return {
    home,
    agentDir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function createHostHarness(): HostHarness {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const toolRenderers: HostHarness["toolRenderers"] = [];
  const markdownTransformers: HostHarness["markdownTransformers"] = [];
  const handlers: HostHarness["handlers"] = new Map();
  const modules = new Map<PluginName, any>();
  const loadedPlugins: PluginName[] = [];
  let currentOwner = "unknown";

  const api = {
    on(eventName: string, handler: EventHandler) {
      const registrations = handlers.get(eventName) ?? [];
      registrations.push({ owner: currentOwner, handler });
      handlers.set(eventName, registrations);
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, { owner: currentOwner, definition });
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    registerToolRenderer(resolver: Function) {
      toolRenderers.push({ owner: currentOwner, resolver });
    },
    registerMarkdownTransformer(transformer: Function) {
      markdownTransformers.push({ owner: currentOwner, transformer });
    },
    registerMessageRenderer() {},
    getAllTools() {
      return [...tools.values()];
    },
    getCommands() {
      return [...commands.keys()];
    },
    getActiveTools() {
      return [];
    },
    getThinkingLevel() {
      return "off";
    },
    getModel() {
      return undefined;
    },
    events: undefined,
  };
  const pi = new Proxy(api, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return undefined;
    },
  });

  return {
    pi,
    tools,
    commands,
    toolRenderers,
    markdownTransformers,
    handlers,
    modules,
    loadedPlugins,
    async load(name) {
      const entry = pathToFileURL(join(REPO_ROOT, ENTRY_PATHS[name])).href;
      const module = await import(entry);
      modules.set(name, module);
      if (typeof module.default !== "function") throw new Error(`${name} entry has no default extension`);
      currentOwner = name;
      module.default(pi);
      currentOwner = "unknown";
      loadedPlugins.push(name);
    },
    async fire(eventName, ctx, event = {}) {
      for (const { handler } of handlers.get(eventName) ?? []) {
        await handler({ type: eventName, ...event }, ctx);
      }
    },
  };
}

export async function createTuiContext(home: string): Promise<any> {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const theme = initTheme("dark");
  const branch: any[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  let editorFactory: unknown;
  return {
    mode: "tui",
    hasUI: true,
    cwd: home,
    model: { contextWindow: 128_000 },
    getContextUsage: () => ({ percent: 0, contextWindow: 128_000 }),
    sessionManager: {
      buildContextEntries: () => [...branch],
      getBranch: () => [...branch],
      getCwd: () => home,
      getRoot: () => home,
      getHeader: () => ({ timestamp: "2026-01-01T00:00:00.000Z" }),
      getSessionId: () => "pi-tidy-e2e-session",
    },
    notifications,
    ui: new Proxy(
      {
        theme,
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
        getEditorComponent() {
          return editorFactory;
        },
        setEditorComponent(factory: unknown) {
          editorFactory = factory;
        },
        getFooter() {
          return undefined;
        },
        setFooter() {},
        setStatus() {},
        setWidget() {},
        setTitle() {},
        onTerminalInput() {
          return () => {};
        },
      },
      {
        get(target, property, receiver) {
          if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
          return () => undefined;
        },
      },
    ),
  };
}

export async function loadPluginsInOrder(host: HostHarness, names: readonly PluginName[] = PLUGIN_ORDER): Promise<void> {
  for (const name of names) await host.load(name);
}
