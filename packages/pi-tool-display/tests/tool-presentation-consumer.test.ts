import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  decorateToolForDisplay,
  getToolDisplayApi,
  type ToolDisplayApi,
  type ToolPresentationRenderContext as ConsumerRenderContext,
  type ToolPresentationSnapshot as ConsumerSnapshot,
} from "../tool-display-api-consumer.js";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import type {
  ToolPresentationRenderContext as ProviderRenderContext,
  ToolPresentationSnapshot as ProviderSnapshot,
} from "../src/tool-presentation.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  DEFAULT_TOOL_DISPLAY_CONFIG,
  type ToolDisplayConfig,
} from "../src/types.ts";

// Fork-only consumer contract tests: they exercise the documented capability
// probe and native-fallback path of the read-only presentation provider, the
// read-only snapshot boundary, and the local-workspace / execution-metadata
// capability contract. Upstream test files stay byte-stable.

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");

// Compile-time drift guard: the published consumer contract and the provider
// implementation must describe the same snapshot/render-context shape.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type AssertTrue<T extends true> = T;
const CONTRACT_TYPES_MATCH: [
  AssertTrue<MutuallyAssignable<ConsumerSnapshot, ProviderSnapshot>>,
  AssertTrue<MutuallyAssignable<ConsumerRenderContext, ProviderRenderContext>>,
] = [true, true];

const PRESENTATION_FIELDS = new Set([
  "name",
  "label",
  "renderCall",
  "renderResult",
  "renderShell",
]);

interface RegisteredToolLike {
  name: string;
  label?: string;
  description?: string;
  renderShell?: "default" | "self";
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
  execute?: (...args: unknown[]) => unknown;
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

function createExtensionApiStub(): {
  api: ExtensionAPI;
  registeredTools: RegisteredToolLike[];
} {
  const registeredTools: RegisteredToolLike[] = [];
  const api = {
    registerTool(tool: RegisteredToolLike): void {
      registeredTools.push(tool);
    },
    on(): void {},
    getAllTools(): unknown[] {
      return withDefaultReadEditOwners();
    },
  } as unknown as ExtensionAPI;

  return { api, registeredTools };
}

function registerToolDisplay(getConfig: () => ToolDisplayConfig): {
  registeredTools: RegisteredToolLike[];
  displayApi: ToolDisplayApi;
} {
  const { api, registeredTools } = createExtensionApiStub();
  registerToolDisplayOverrides(api, getConfig);
  const installed = getToolDisplayApi();
  assert.ok(installed, "expected the display API to be installed");
  return { registeredTools, displayApi: installed };
}

function createTheme(): Theme {
  // SAFETY: display renderers only call fg/bold on the theme; the host Theme
  // class carries many more members that these code paths never touch.
  return {
    fg: (_color: string, value: string): string => value,
    bold: (value: string): string => value,
  } as unknown as Theme;
}

const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

function renderComponent(component: {
  render(width: number): string[];
}): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(ANSI_PATTERN, "")
    .trim();
}

function findRegisteredTool(
  tools: RegisteredToolLike[],
  name: string,
): RegisteredToolLike {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected '${name}' to be registered`);
  return tool;
}

async function withTempDir(
  name: string,
  run: (dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  const installed = Reflect.get(globalThis, TOOL_DISPLAY_API_KEY);
  if (installed) {
    disposeAll();
  }
  Reflect.deleteProperty(globalThis, TOOL_DISPLAY_API_KEY);
  resetDisposed();
});

test("capability probe resolves the seven supported tools and rejects unsupported names", () => {
  const { displayApi } = registerToolDisplay(() => DEFAULT_TOOL_DISPLAY_CONFIG);

  assert.equal(displayApi.version, 1);
  assert.equal(typeof displayApi.decorateTool, "function");
  assert.equal(typeof displayApi.getToolPresentation, "function");
  assert.equal(typeof displayApi.presentationRevision, "number");

  for (const name of BUILT_IN_TOOL_OVERRIDE_NAMES) {
    const snapshot = displayApi.getToolPresentation?.(name);
    assert.ok(snapshot, `expected a snapshot for '${name}'`);
    assert.equal(snapshot.name, name);
    assert.equal(typeof snapshot.renderCall, "function");
    assert.equal(typeof snapshot.renderResult, "function");
    for (const key of Object.keys(snapshot)) {
      assert.ok(
        PRESENTATION_FIELDS.has(key),
        `${name} exposes only the documented whitelist (saw '${key}')`,
      );
    }
    assert.equal("execute" in snapshot, false);
    assert.equal("prepareArguments" in snapshot, false);
    assert.equal("parameters" in snapshot, false);
  }

  assert.equal(displayApi.getToolPresentation?.("mcp"), undefined);
  assert.equal(displayApi.getToolPresentation?.("unknown-tool"), undefined);
  assert.deepEqual(CONTRACT_TYPES_MATCH, [true, true]);
});

test("a missing provider degrades to native rendering", () => {
  const probe = (api: ToolDisplayApi | undefined) =>
    typeof api?.getToolPresentation === "function"
      ? api.getToolPresentation("read")
      : undefined;

  assert.equal(getToolDisplayApi(), undefined);
  assert.equal(probe(getToolDisplayApi()), undefined);
});

test("a legacy version 1 API keeps decorateTool and degrades the new probe", () => {
  const legacyApi = {
    version: 1 as const,
    decorateTool<T extends Record<string, unknown>>(tool: T): T {
      return { ...tool, renderCall: () => "legacy" };
    },
  };
  Reflect.set(globalThis, TOOL_DISPLAY_API_KEY, legacyApi);

  const detected = getToolDisplayApi();
  assert.equal(detected, legacyApi);
  const probe =
    typeof detected?.getToolPresentation === "function"
      ? detected.getToolPresentation("read")
      : undefined;
  assert.equal(probe, undefined);
  assert.equal(detected?.presentationRevision, undefined);

  const decorated = decorateToolForDisplay(
    { name: "legacy-tool" } as Record<string, unknown>,
    { kind: "read" },
  );
  assert.equal(typeof decorated.renderCall, "function");
});

test("identity and revision drive cache invalidation and renderers use the current config", () => {
  let config = buildConfig({ readOutputMode: "summary" });
  const { displayApi } = registerToolDisplay(() => config);

  const revisionBefore = displayApi.presentationRevision ?? 0;
  const snapshot = displayApi.getToolPresentation?.("read");
  assert.ok(snapshot?.renderResult);
  const render = () =>
    renderComponent(
      snapshot.renderResult!(
        { content: [{ type: "text", text: "alpha\nbeta\n" }], details: {} },
        { isPartial: false, expanded: false },
        createTheme(),
        {},
      ),
    );

  assert.equal(render(), "↳ loaded 2 lines • Ctrl+O to expand");

  config = buildConfig({ readOutputMode: "preview", previewLines: 8 });

  assert.equal(
    getToolDisplayApi(),
    displayApi,
    "the provider object identity stays stable across a config change",
  );
  assert.ok(
    (displayApi.presentationRevision ?? 0) > revisionBefore,
    "the documented revision advances on a config change",
  );
  assert.equal(
    render(),
    "alpha\nbeta",
    "the same renderer uses the current config after the revision change",
  );
});

test("SSH-style consumers deny local workspace previews for edit and write", async () => {
  await withTempDir("pi-tool-display-ssh-preview-", (dir) => {
    writeFileSync(join(dir, "sample.txt"), "alpha\n", "utf8");
    const { displayApi } = registerToolDisplay(
      () => DEFAULT_TOOL_DISPLAY_CONFIG,
    );
    const theme = createTheme();

    const editSnapshot = displayApi.getToolPresentation?.("edit");
    assert.ok(editSnapshot?.renderCall);
    const editArgs = { path: "sample.txt", oldText: "alpha", newText: "beta" };
    const editContext: ConsumerRenderContext = {
      args: editArgs,
      toolCallId: "btw-edit-1",
      cwd: dir,
      argsComplete: true,
      isPartial: true,
    };
    const editWithLocal = renderComponent(
      editSnapshot.renderCall(editArgs, theme, editContext),
    );
    assert.match(
      editWithLocal,
      /alpha/,
      "the default main-session context still shows the local pending preview",
    );

    const editDenied = renderComponent(
      editSnapshot.renderCall(editArgs, theme, {
        ...editContext,
        capabilities: { localWorkspace: false },
      }),
    );
    assert.doesNotMatch(
      editDenied,
      /alpha|beta/,
      "a remote workspace must not leak the local file content",
    );
    assert.match(editDenied, /sample\.txt/, "the call summary stays visible");

    const writeSnapshot = displayApi.getToolPresentation?.("write");
    assert.ok(writeSnapshot?.renderCall);
    const writeArgs = { path: "sample.txt", content: "gamma\n" };
    const writeContext: ConsumerRenderContext = {
      args: writeArgs,
      toolCallId: "btw-write-1",
      cwd: dir,
      argsComplete: true,
      isPartial: true,
    };
    const writeWithLocal = renderComponent(
      writeSnapshot.renderCall(writeArgs, theme, writeContext),
    );
    assert.match(
      writeWithLocal,
      /alpha/,
      "the default main-session context still reads the previous local content",
    );

    const writeDenied = renderComponent(
      writeSnapshot.renderCall(writeArgs, theme, {
        ...writeContext,
        capabilities: { localWorkspace: false },
      }),
    );
    assert.doesNotMatch(
      writeDenied,
      /alpha/,
      "a remote workspace must not read the local previous content",
    );
    assert.match(writeDenied, /sample\.txt/);
  });
});

test("embedded consumers refuse parent execution metadata on a toolCallId collision", async () => {
  await withTempDir("pi-tool-display-exec-meta-", async (dir) => {
    writeFileSync(join(dir, "note.txt"), "old-content\n", "utf8");
    const { displayApi, registeredTools } = registerToolDisplay(
      () => DEFAULT_TOOL_DISPLAY_CONFIG,
    );
    const writeTool = findRegisteredTool(registeredTools, "write");
    assert.equal(typeof writeTool.execute, "function");

    await writeTool.execute?.(
      "collision-1",
      { path: "note.txt", content: "new-content\n" },
      undefined,
      undefined,
      { cwd: dir },
    );

    const snapshot = displayApi.getToolPresentation?.("write");
    assert.ok(snapshot?.renderResult);
    const result = {
      content: [
        { type: "text", text: "Successfully wrote 12 bytes to note.txt" },
      ],
      details: {},
    };
    const options = { isPartial: false, expanded: false };
    const context: ConsumerRenderContext = {
      toolCallId: "collision-1",
      args: { path: "note.txt", content: "new-content\n" },
    };
    const theme = createTheme();

    const parentMeta = renderComponent(
      snapshot.renderResult(result, options, theme, context),
    );
    assert.match(
      parentMeta,
      /old-content/,
      "the main-session path still uses the recorded previous content",
    );
    assert.match(
      parentMeta,
      /overwritten/,
      "the main-session path still shows the real overwrite",
    );

    const refused = renderComponent(
      snapshot.renderResult(result, options, theme, {
        ...context,
        capabilities: { executionMetadata: false },
      }),
    );
    assert.match(
      refused,
      /Successfully wrote 12 bytes to note\.txt/,
      "the denied path falls back to the real result text",
    );
    assert.doesNotMatch(
      refused,
      /old-content/,
      "a colliding toolCallId must not leak parent execution metadata",
    );
    assert.doesNotMatch(
      refused,
      /created|overwritten/,
      "the denied path must not fabricate an inferred create/overwrite header",
    );
    assert.doesNotMatch(
      refused,
      /new-content/,
      "the denied path must not render args content as a fabricated diff",
    );

    const sshRefused = renderComponent(
      snapshot.renderResult(result, options, theme, {
        ...context,
        capabilities: { localWorkspace: false, executionMetadata: false },
      }),
    );
    assert.match(
      sshRefused,
      /Successfully wrote 12 bytes to note\.txt/,
      "an SSH consumer gets the same result-text fallback",
    );
    assert.doesNotMatch(
      sshRefused,
      /old-content|created|overwritten|new-content/,
    );

    const neutral = renderComponent(
      snapshot.renderResult(
        { content: [{ type: "text", text: "" }], details: {} },
        options,
        theme,
        { ...context, capabilities: { executionMetadata: false } },
      ),
    );
    assert.equal(
      neutral,
      "↳ write completed",
      "an empty result text falls back to the neutral completion line",
    );
  });
});

test("rendering through the provider never invokes the registered execute", () => {
  const { displayApi, registeredTools } = registerToolDisplay(
    () => DEFAULT_TOOL_DISPLAY_CONFIG,
  );
  let executeCalls = 0;
  for (const tool of registeredTools) {
    tool.execute = async () => {
      executeCalls += 1;
      return { content: [] };
    };
  }

  const theme = createTheme();
  const readSnapshot = displayApi.getToolPresentation?.("read");
  assert.ok(readSnapshot?.renderCall && readSnapshot.renderResult);
  renderComponent(
    readSnapshot.renderCall({ path: "a.txt" }, theme, {
      args: { path: "a.txt" },
      toolCallId: "read-1",
      cwd: process.cwd(),
    }),
  );
  renderComponent(
    readSnapshot.renderResult(
      { content: [{ type: "text", text: "alpha\n" }], details: {} },
      { isPartial: false, expanded: false },
      theme,
      {},
    ),
  );

  const editSnapshot = displayApi.getToolPresentation?.("edit");
  assert.ok(editSnapshot?.renderCall && editSnapshot.renderResult);
  renderComponent(
    editSnapshot.renderCall(
      { path: "a.txt", oldText: "a", newText: "b" },
      theme,
      {
        args: { path: "a.txt", oldText: "a", newText: "b" },
        toolCallId: "edit-1",
        cwd: process.cwd(),
      },
    ),
  );
  renderComponent(
    editSnapshot.renderResult(
      { content: [{ type: "text", text: "edited" }], details: {} },
      { isPartial: false, expanded: false },
      theme,
      { args: { path: "a.txt" }, toolCallId: "edit-1" },
    ),
  );

  const writeSnapshot = displayApi.getToolPresentation?.("write");
  assert.ok(writeSnapshot?.renderCall && writeSnapshot.renderResult);
  renderComponent(
    writeSnapshot.renderCall({ path: "a.txt", content: "next\n" }, theme, {
      args: { path: "a.txt", content: "next\n" },
      toolCallId: "write-1",
      cwd: process.cwd(),
    }),
  );
  renderComponent(
    writeSnapshot.renderResult(
      { content: [{ type: "text", text: "wrote" }], details: {} },
      { isPartial: false, expanded: false },
      theme,
      { args: { path: "a.txt", content: "next\n" }, toolCallId: "write-1" },
    ),
  );

  assert.equal(
    executeCalls,
    0,
    "display rendering must never borrow the tool execution path",
  );
});
