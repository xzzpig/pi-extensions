import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  decorateToolForDisplay,
  getToolDisplayApi,
  type ToolDisplayApi,
} from "../tool-display-api-consumer.js";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import {
  disposeToolPresentationApi,
  recordToolPresentation,
  type ToolPresentationApi,
  type ToolPresentationSnapshot,
} from "../src/tool-presentation.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  DEFAULT_TOOL_DISPLAY_CONFIG,
  type ToolDisplayConfig,
} from "../src/types.ts";

// Fork-only test file: covers the read-only tool presentation provider added
// for the BTW transcript presentation work. Upstream test files stay
// byte-stable per the fork-divergence discipline.

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const PRESENTATION_FIELDS = new Set([
  "name",
  "label",
  "renderCall",
  "renderResult",
  "renderShell",
]);
const EXECUTION_FIELDS = [
  "execute",
  "prepareArguments",
  "prepareLoadout",
  "parameters",
  "description",
  "promptSnippet",
  "promptGuidelines",
  "constrainedSampling",
  "outputSchema",
  "defaultActive",
  "executionMode",
  "namespace",
  "annotations",
  "exposure",
] as const;

interface RegisteredToolLike {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  renderShell?: "default" | "self";
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
  execute?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
  session_start?: () => Promise<void> | void;
  before_agent_start?: () => Promise<void> | void;
}

type ToolDisplayConfigOverrides = Omit<
  Partial<ToolDisplayConfig>,
  "registerToolOverrides"
> & {
  registerToolOverrides?: Partial<ToolDisplayConfig["registerToolOverrides"]>;
};

function buildConfig(
  overrides: ToolDisplayConfigOverrides = {},
): ToolDisplayConfig {
  return {
    ...DEFAULT_TOOL_DISPLAY_CONFIG,
    ...overrides,
    registerToolOverrides: {
      ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
      ...overrides.registerToolOverrides,
    },
  };
}

function withDefaultReadEditOwners(tools: unknown[] = []): unknown[] {
  const names = new Set(
    tools
      .map((tool) => (tool as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string"),
  );
  const defaults = ["read", "edit"]
    .filter((name) => !names.has(name))
    .map((name) => ({
      name,
      sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
    }));
  return [...defaults, ...tools];
}

function createExtensionApiStub(allTools: unknown[] = []): {
  api: ExtensionAPI;
  registeredTools: RegisteredToolLike[];
  eventHandlers: ToolEventHandlers;
} {
  const registeredTools: RegisteredToolLike[] = [];
  const eventHandlers: ToolEventHandlers = {};
  const api = {
    registerTool(tool: RegisteredToolLike): void {
      registeredTools.push(tool);
    },
    on(
      event: keyof ToolEventHandlers,
      handler: () => Promise<void> | void,
    ): void {
      eventHandlers[event] = handler;
    },
    getAllTools(): unknown[] {
      return withDefaultReadEditOwners(allTools);
    },
  } as unknown as ExtensionAPI;

  return { api, registeredTools, eventHandlers };
}

function registerBuiltIns(getConfig: () => ToolDisplayConfig): {
  owner: ExtensionAPI;
  registeredTools: RegisteredToolLike[];
  presentationApi: ToolDisplayApi & ToolPresentationApi;
} {
  const { api, registeredTools } = createExtensionApiStub();
  registerToolDisplayOverrides(api, getConfig);
  const installed = getToolDisplayApi();
  assert.ok(installed, "expected the display API to be installed");
  return {
    owner: api,
    registeredTools,
    presentationApi: installed as ToolDisplayApi & ToolPresentationApi,
  };
}

function createRejectingRegisterApi(failingName: string): {
  api: ExtensionAPI;
  registeredTools: RegisteredToolLike[];
} {
  const registeredTools: RegisteredToolLike[] = [];
  const api = {
    registerTool(tool: RegisteredToolLike): void {
      if (tool.name === failingName) {
        throw new Error(`registration refused for '${tool.name}'`);
      }
      registeredTools.push(tool);
    },
    on(): void {},
    getAllTools(): unknown[] {
      return withDefaultReadEditOwners();
    },
  } as unknown as ExtensionAPI;

  return { api, registeredTools };
}

function createTheme(): Theme {
  // SAFETY: display renderers only call fg/bold on the theme; the host Theme
  // class carries many more members that these code paths never touch.
  return {
    fg: (_color: string, value: string): string => value,
    bold: (value: string): string => value,
  } as unknown as Theme;
}

function renderSnapshotResult(
  snapshot: ToolPresentationSnapshot | undefined,
  text: string,
): string {
  assert.ok(snapshot?.renderResult, "expected a renderResult in the snapshot");
  const component = snapshot.renderResult(
    { content: [{ type: "text", text }], details: {} },
    { isPartial: false, expanded: false },
    createTheme(),
    {},
  );
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function findRegisteredTool(
  tools: RegisteredToolLike[],
  name: string,
): RegisteredToolLike {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected '${name}' to be registered for the main session`);
  return tool;
}

// Each test starts from a fresh global API slot, a disposed provider and an
// empty cleanup list, so state from an earlier installation cannot mask a
// missing snapshot or a stale revision.
beforeEach(() => {
  const installed = Reflect.get(globalThis, TOOL_DISPLAY_API_KEY);
  if (installed) {
    disposeToolPresentationApi(installed);
  }
  Reflect.deleteProperty(globalThis, TOOL_DISPLAY_API_KEY);
  resetDisposed();
});

test("exposes the renderers of the seven built-in tools exactly as registered for the main session", () => {
  const { registeredTools, presentationApi } = registerBuiltIns(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );
  assert.equal(BUILT_IN_TOOL_OVERRIDE_NAMES.length, 7);
  assert.equal(typeof presentationApi.presentationRevision, "number");

  for (const name of BUILT_IN_TOOL_OVERRIDE_NAMES) {
    const registered = findRegisteredTool(registeredTools, name);
    const presentation = presentationApi.getToolPresentation(name);
    assert.ok(presentation, `expected a presentation snapshot for '${name}'`);
    assert.equal(presentation.name, name);
    assert.equal(
      presentation.label,
      registered.label,
      `${name} label matches the registered definition`,
    );
    assert.equal(
      presentation.renderCall,
      registered.renderCall,
      `${name} renderCall is the registered renderer`,
    );
    assert.equal(
      presentation.renderResult,
      registered.renderResult,
      `${name} renderResult is the registered renderer`,
    );
    assert.equal(
      presentation.renderShell,
      registered.renderShell,
      `${name} renderShell matches the registration`,
    );
    assert.equal(typeof presentation.renderCall, "function");
    assert.equal(typeof presentation.renderResult, "function");
  }

  assert.equal(
    presentationApi.getToolPresentation("edit")?.renderShell,
    "default",
  );
});

test("returns a fresh copy so mutating it cannot change the registered definition", () => {
  const { registeredTools, presentationApi } = registerBuiltIns(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );
  const registeredRead = findRegisteredTool(registeredTools, "read");
  const originalRenderCall = registeredRead.renderCall;
  const originalLabel = registeredRead.label;

  const first = presentationApi.getToolPresentation("read");
  assert.ok(first);
  const mutable = first as unknown as Record<string, unknown>;
  mutable.label = "mutated-by-consumer";
  mutable.renderCall = undefined;
  mutable.execute = () => "borrowed execution";

  const second = presentationApi.getToolPresentation("read");
  assert.ok(second);
  assert.equal(second.label, originalLabel);
  assert.equal(second.renderCall, originalRenderCall);
  assert.equal(
    (second as unknown as Record<string, unknown>).execute,
    undefined,
  );
  assert.equal(registeredRead.label, originalLabel);
  assert.equal(registeredRead.renderCall, originalRenderCall);
  assert.notEqual(first, second, "each lookup returns a new object");
});

test("never stores execution or registration fields", () => {
  const { registeredTools, presentationApi } = registerBuiltIns(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );

  for (const name of BUILT_IN_TOOL_OVERRIDE_NAMES) {
    const registered = findRegisteredTool(registeredTools, name);
    const presentation = presentationApi.getToolPresentation(name);
    assert.ok(presentation);

    for (const key of Object.keys(presentation)) {
      assert.ok(
        PRESENTATION_FIELDS.has(key),
        `${name} exposes only whitelisted field '${key}'`,
      );
    }
    for (const field of EXECUTION_FIELDS) {
      assert.equal(
        field in presentation,
        false,
        `${name} must not expose '${field}'`,
      );
    }

    // The registered definition does carry execution fields; the snapshot filters them.
    assert.equal(
      typeof registered.execute,
      "function",
      `expected '${name}' to be executable in the main session`,
    );
    assert.equal(typeof registered.description, "string");
  }
});

test("resolves names outside the built-in set to undefined", () => {
  const { presentationApi } = registerBuiltIns(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );

  assert.equal(
    presentationApi.getToolPresentation("mcp"),
    undefined,
    "MCP tools are outside the built-in display provider",
  );
  assert.equal(presentationApi.getToolPresentation(""), undefined);
  assert.equal(
    presentationApi.getToolPresentation(undefined as unknown as string),
    undefined,
  );
});

test("publishes nothing when every per-tool override is disabled at load", () => {
  const disabledConfig = buildConfig({
    registerToolOverrides: {
      read: false,
      grep: false,
      find: false,
      ls: false,
      bash: false,
      edit: false,
      write: false,
    },
  });
  const { registeredTools, presentationApi } = registerBuiltIns(
    () => disabledConfig,
  );

  assert.deepEqual(registeredTools, []);
  assert.equal(
    presentationApi.getToolPresentation("read"),
    undefined,
    "disabled built-in has no presentation",
  );
});

test("does not capture an externally owned built-in", () => {
  const { api, registeredTools } = createExtensionApiStub([
    {
      name: "read",
      sourceInfo: {
        source: "local",
        path: "agent/extensions/example-read/src/read.ts",
      },
    },
  ]);
  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  const installed = getToolDisplayApi();
  assert.ok(installed);
  const presentationApi = installed as ToolDisplayApi & ToolPresentationApi;

  assert.equal(
    presentationApi.getToolPresentation("read"),
    undefined,
    "externally owned built-in is not captured",
  );
  const bash = findRegisteredTool(registeredTools, "bash");
  assert.equal(
    presentationApi.getToolPresentation("bash")?.renderCall,
    bash.renderCall,
  );
});

test("respects per-tool overrides changed at runtime without re-registering", () => {
  let config = buildConfig();
  const { presentationApi } = registerBuiltIns(() => config);
  assert.ok(presentationApi.getToolPresentation("read"));

  const revisionBefore = presentationApi.presentationRevision;
  config = buildConfig({ registerToolOverrides: { read: false } });
  assert.equal(
    presentationApi.getToolPresentation("read"),
    undefined,
    "a disabled per-tool override hides the presentation",
  );
  assert.ok(
    presentationApi.getToolPresentation("bash"),
    "other built-ins stay available",
  );
  assert.ok(
    presentationApi.presentationRevision > revisionBefore,
    "the override change advances the revision",
  );

  config = buildConfig({ registerToolOverrides: { read: true } });
  assert.ok(
    presentationApi.getToolPresentation("read"),
    "re-enabling the override restores the presentation",
  );
});

test("respects the enabled switch changed at runtime", () => {
  let config = buildConfig();
  const { presentationApi } = registerBuiltIns(() => config);
  const revisionBefore = presentationApi.presentationRevision;

  config = { ...config, enabled: false };
  assert.equal(presentationApi.getToolPresentation("read"), undefined);
  assert.equal(presentationApi.getToolPresentation("bash"), undefined);
  assert.ok(
    presentationApi.presentationRevision > revisionBefore,
    "disabling advances the revision",
  );

  config = { ...config, enabled: true };
  assert.ok(presentationApi.getToolPresentation("read"));
});

test("advances the revision on a display config change and renders with the current config", () => {
  let config = buildConfig({ readOutputMode: "summary" });
  const { presentationApi } = registerBuiltIns(() => config);
  const snapshot = presentationApi.getToolPresentation("read");
  assert.equal(
    renderSnapshotResult(snapshot, "alpha\nbeta\n"),
    "↳ loaded 2 lines • Ctrl+O to expand",
  );

  const revisionBefore = presentationApi.presentationRevision;
  config = buildConfig({ readOutputMode: "preview", previewLines: 8 });

  assert.ok(
    presentationApi.presentationRevision > revisionBefore,
    "config changes advance the revision without a transcript entry update",
  );
  assert.equal(
    renderSnapshotResult(snapshot, "alpha\nbeta\n"),
    "alpha\nbeta",
    "the same renderer uses the current config instead of the install-time snapshot",
  );
});

test("publishes no snapshot when pi.registerTool rejects the definition", () => {
  const { api, registeredTools } = createRejectingRegisterApi("bash");

  assert.throws(
    () => registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG),
    /registration refused for 'bash'/,
  );

  const installed = getToolDisplayApi();
  assert.ok(installed);
  const presentationApi = installed as ToolDisplayApi & ToolPresentationApi;

  assert.deepEqual(
    registeredTools.map((tool) => tool.name),
    BUILT_IN_TOOL_OVERRIDE_NAMES.filter((name) => name !== "bash"),
  );
  assert.equal(
    presentationApi.getToolPresentation("bash"),
    undefined,
    "a rejected definition must not be published",
  );
  assert.equal(
    presentationApi.presentationRevision,
    registeredTools.length,
    "the revision counts only successfully registered tools",
  );
  for (const tool of registeredTools) {
    assert.equal(
      presentationApi.getToolPresentation(tool.name)?.renderCall,
      tool.renderCall,
    );
  }
});

test("keeps the version 1 consumer API and its decorateTool path working", () => {
  const { presentationApi } = registerBuiltIns(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );
  assert.equal(presentationApi.version, 1);
  assert.equal(typeof presentationApi.decorateTool, "function");
  assert.equal(typeof presentationApi.getToolPresentation, "function");
  assert.equal(typeof presentationApi.presentationRevision, "number");

  const tool: Record<string, unknown> = {
    name: "consumer-tool",
    label: "Consumer",
    execute: () => "ran",
  };
  const decorated = decorateToolForDisplay(tool, { kind: "read" }) as Record<
    string,
    unknown
  >;
  assert.notEqual(decorated, tool);
  assert.equal(typeof decorated.renderCall, "function");
  assert.equal(typeof decorated.renderResult, "function");
  assert.equal(
    tool.renderCall,
    undefined,
    "decorateTool does not mutate the source tool",
  );
});

test("degrades to the legacy version 1 API object without the presentation members", () => {
  const legacyApi = {
    version: 1 as const,
    decorateTool<T extends Record<string, unknown>>(tool: T): T {
      return { ...tool, renderCall: () => "legacy" };
    },
  };
  Reflect.set(globalThis, TOOL_DISPLAY_API_KEY, legacyApi);

  const detected = getToolDisplayApi();
  assert.equal(detected, legacyApi);
  const probe = detected as ToolDisplayApi & Partial<ToolPresentationApi>;
  assert.equal(
    probe.getToolPresentation,
    undefined,
    "a legacy API has no presentation lookup",
  );
  assert.equal(probe.presentationRevision, undefined);

  const decorated = decorateToolForDisplay(
    { name: "legacy-tool" } as Record<string, unknown>,
    { kind: "read" },
  );
  assert.equal(typeof decorated.renderCall, "function");
});

test("reports no provider when the extension is not installed", () => {
  assert.equal(getToolDisplayApi(), undefined);
  assert.equal(recordToolPresentation({}, { name: "read" }), false);
  assert.equal(recordToolPresentation(undefined, { name: "read" }), false);
  assert.equal(disposeToolPresentationApi(undefined), false);
  assert.equal(disposeToolPresentationApi({}), false);
  assert.equal(disposeToolPresentationApi(null), false);
});

test("ignores malformed definitions and survives a throwing renderer", () => {
  const { owner, presentationApi } = registerBuiltIns(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );
  const revisionBefore = presentationApi.presentationRevision;

  for (const malformed of [
    null,
    undefined,
    "read",
    [],
    {},
    { name: 42 },
    { name: "not-a-builtin" },
  ]) {
    assert.equal(recordToolPresentation(owner, malformed), false);
  }
  assert.equal(
    presentationApi.presentationRevision,
    revisionBefore,
    "rejected definitions do not advance the revision",
  );

  const throwingDefinition = {
    name: "bash",
    label: "bash",
    renderCall(): never {
      throw new Error("renderCall boom");
    },
    renderResult(): never {
      throw new Error("renderResult boom");
    },
  };
  assert.equal(recordToolPresentation(owner, throwingDefinition), true);
  const snapshot = presentationApi.getToolPresentation("bash");
  assert.ok(snapshot);
  assert.throws(
    () => snapshot.renderCall?.({}, createTheme(), {}),
    /renderCall boom/,
  );
  assert.throws(
    () =>
      snapshot.renderResult?.(
        { content: [], details: {} },
        { isPartial: false, expanded: false },
        createTheme(),
        {},
      ),
    /renderResult boom/,
  );
  assert.ok(
    presentationApi.getToolPresentation("read"),
    "the other snapshots survive a throwing renderer",
  );
  assert.equal(
    presentationApi.presentationRevision,
    revisionBefore + 1,
    "a throwing renderer does not change the revision",
  );
});

test("binds registrations to their owning installation and keeps the newer provider intact", () => {
  const first = registerBuiltIns(() =>
    buildConfig({ readOutputMode: "summary" }),
  );
  const ownerA = first.owner;
  const apiA = first.presentationApi;
  const firstRead = findRegisteredTool(first.registeredTools, "read");

  const second = registerBuiltIns(() =>
    buildConfig({ readOutputMode: "preview" }),
  );
  const ownerB = second.owner;
  const apiB = second.presentationApi;
  const secondRead = findRegisteredTool(second.registeredTools, "read");
  assert.notEqual(apiA, apiB);

  assert.equal(
    apiA.getToolPresentation("read")?.renderCall,
    firstRead.renderCall,
    "the older API keeps its own snapshot",
  );
  assert.equal(
    apiB.getToolPresentation("read")?.renderCall,
    secondRead.renderCall,
  );

  const revisionB = apiB.presentationRevision;
  const lateA = {
    name: "read",
    label: "late-A",
    renderCall: () => "late-A",
    renderResult: () => "late-A",
  };
  assert.equal(
    recordToolPresentation(ownerA, lateA),
    true,
    "a late registration is bound to its own installation",
  );
  assert.equal(
    apiA.getToolPresentation("read")?.renderCall,
    lateA.renderCall,
    "the late registration lands in the older provider",
  );
  assert.equal(
    apiB.getToolPresentation("read")?.renderCall,
    secondRead.renderCall,
    "the newer snapshot is not overwritten by the older owner",
  );
  assert.equal(
    apiB.presentationRevision,
    revisionB,
    "the newer revision is not advanced by the older owner",
  );

  const revisionA = apiA.presentationRevision;
  disposeToolPresentationApi(apiA);
  assert.equal(apiA.getToolPresentation("read"), undefined);
  assert.ok(
    apiA.presentationRevision > revisionA,
    "only the older provider's revision advances on its dispose",
  );
  const revisionAAfterDispose = apiA.presentationRevision;

  assert.equal(
    recordToolPresentation(ownerA, {
      name: "bash",
      label: "ghost",
      renderCall: () => "ghost",
    }),
    false,
    "a disposed installation refuses registrations",
  );
  assert.equal(
    apiA.getToolPresentation("bash"),
    undefined,
    "a disposed installation cannot be revived",
  );
  assert.equal(apiA.presentationRevision, revisionAAfterDispose);

  assert.equal(disposeToolPresentationApi(apiA), true);
  assert.equal(
    apiA.presentationRevision,
    revisionAAfterDispose,
    "dispose is idempotent",
  );

  const revisionBBeforeLate = apiB.presentationRevision;
  assert.equal(
    recordToolPresentation(ownerB, {
      name: "bash",
      label: "B-bash",
      renderCall: () => "B-bash",
    }),
    true,
    "the newer installation keeps accepting registrations",
  );
  assert.ok(apiB.getToolPresentation("bash"));
  assert.equal(
    apiB.presentationRevision,
    revisionBBeforeLate + 1,
    "only the newer provider's revision advances",
  );
});

test("withdraws the provider and advances the revision on extension dispose", () => {
  const { presentationApi } = registerBuiltIns(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );
  const revisionBefore = presentationApi.presentationRevision;

  disposeAll();

  assert.equal(
    getToolDisplayApi(),
    undefined,
    "dispose withdraws the provider",
  );
  assert.equal(presentationApi.getToolPresentation("read"), undefined);
  assert.ok(
    presentationApi.presentationRevision > revisionBefore,
    "dispose advances the revision",
  );
  resetDisposed();
});
