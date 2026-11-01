import type {
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { toRecord } from "./tool-metadata.js";
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  type ToolDisplayConfig,
} from "./types.js";

/**
 * Fork-only read-only display provider for the built-in tool definitions this
 * extension registers (`pi-tool-display.api.v1`).
 *
 * Consumers that draw tool calls outside the main transcript (the BTW overlay)
 * need to know what the main session would draw without borrowing any
 * execution capability. The provider therefore answers exactly one question -
 * "which display fields would the main session use for this tool?" - and only
 * for the built-in tools this extension registers. Snapshots are captured from
 * the definition objects passed to `pi.registerTool`, so renderer identity is
 * the main session's renderer rather than a copy. Renderers read the current
 * effective config through their own closure, so a config change is reflected
 * on the next render without re-registering the tool.
 *
 * The whitelist is `name`, `label`, `renderCall`, `renderResult` and
 * `renderShell`. Execution fields (`execute`, `prepareArguments`,
 * `prepareLoadout`, `parameters`) and prompt metadata are never stored or
 * returned, and nothing here registers a tool or calls a parent-session
 * definition.
 *
 * Each installation owns its own provider instance: its snapshot table and
 * revision are not shared with another installation, so disposing an older
 * provider cannot clear or advance a newer one. Registration is bound to the
 * `ExtensionAPI` instance that owns the installation (`bindToolPresentationOwner`),
 * so a late or re-entrant registration from an older instance can only touch
 * its own table - and a disposed provider refuses further records instead of
 * resurrecting. `presentationRevision` advances when the snapshot table changes
 * (registration, disposal) and when the effective display config changes, so a
 * consumer can invalidate cached rows without a new transcript entry. The
 * counter is monotonic for the lifetime of one provider, so a consumer that
 * survives an extension reload should also compare the API object identity
 * rather than the number alone.
 *
 * The config signature is a JSON serialization of the normalized effective
 * config, which is always a plain JSON object built by `normalizeToolDisplayConfig`
 * and `applyCapabilityConfigGuards`.
 *
 * A missing provider, a name outside the built-in set, a built-in disabled by
 * the `enabled` switch or its per-tool override, or a built-in owned by another
 * extension all resolve to `undefined`, which callers treat as "use Pi's native
 * rendering".
 *
 * Consumers can grant or deny local side effects per render through
 * `ToolPresentationRenderContext.capabilities`: `localWorkspace` controls the
 * pending edit/write previews that read the local filesystem, and
 * `executionMetadata` controls parent-session execution metadata (the write
 * previous-content map keyed by tool call id). Both default to true so the
 * main-session host context keeps its behavior; a remote/SSH consumer must set
 * `localWorkspace: false`, and an embedded consumer must set
 * `executionMetadata: false`. Denying a capability only removes the enhanced
 * preview or previous-content diff; it never fabricates metadata.
 */

export interface ToolPresentationDisplayCapabilities {
  /**
   * Allow renderers to read the local filesystem under `cwd` for pending
   * edit/write previews. Set false when the workspace is remote (SSH) or the
   * cwd is not the workspace the tool acts on.
   */
  localWorkspace?: boolean;
  /**
   * Allow renderers to use execution metadata recorded by the parent session
   * (currently write previous-content snapshots keyed by tool call id). Set
   * false when the consumer renders tool calls it did not execute itself.
   */
  executionMetadata?: boolean;
}

export interface ToolPresentationRenderContext {
  args?: Record<string, unknown>;
  toolCallId?: string;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  isError?: boolean;
  capabilities?: ToolPresentationDisplayCapabilities;
  [key: string]: unknown;
}

export type ToolPresentationRenderCall = (
  args: Record<string, unknown>,
  theme: Theme,
  context: ToolPresentationRenderContext,
) => Component;

export interface ToolPresentationResult {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export type ToolPresentationRenderResult = (
  result: ToolPresentationResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolPresentationRenderContext,
) => Component;

export interface ToolPresentationSnapshot {
  readonly name: string;
  readonly label?: string;
  readonly renderCall?: ToolPresentationRenderCall;
  readonly renderResult?: ToolPresentationRenderResult;
  readonly renderShell?: "default" | "self";
}

export interface ToolPresentationApi {
  getToolPresentation(name: string): ToolPresentationSnapshot | undefined;
  readonly presentationRevision: number;
}

export interface ToolPresentationProvider extends ToolPresentationApi {
  /** Capture a definition this installation registered; false when filtered. */
  record(tool: unknown): boolean;
  /** Drop this provider's snapshots; other providers are untouched. */
  dispose(): void;
}

export type ToolPresentationConfigGetter = () => ToolDisplayConfig;

const SUPPORTED_TOOL_NAMES: ReadonlySet<string> = new Set(
  BUILT_IN_TOOL_OVERRIDE_NAMES,
);
const PROVIDER_KEY = Symbol("pi-tool-display.presentationProvider");

// SAFETY: `attachToolPresentationApi` defines the provider under this symbol;
// the cast only gives that symbol key a typed shape for a direct property read.
interface ToolPresentationProviderCarrier {
  readonly [PROVIDER_KEY]?: ToolPresentationProvider;
}

const providerByOwner = new WeakMap<object, ToolPresentationProvider>();

export function resolveToolPresentationCapabilities(
  context: unknown,
): Required<ToolPresentationDisplayCapabilities> {
  const capabilities = toRecord(toRecord(context).capabilities);
  return {
    localWorkspace: capabilities.localWorkspace !== false,
    executionMetadata: capabilities.executionMetadata !== false,
  };
}

function readStringField(
  source: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = source[field];
  return typeof value === "string" ? value : undefined;
}

function readFunctionField<T>(
  source: Record<string, unknown>,
  field: string,
): T | undefined {
  const value = source[field];
  return typeof value === "function" ? (value as T) : undefined;
}

function readConfigSignature(getConfig: ToolPresentationConfigGetter): string {
  try {
    return JSON.stringify(getConfig());
  } catch {
    return "";
  }
}

function isToolPresentationEnabled(
  config: ToolDisplayConfig,
  name: string,
): boolean {
  if (config.enabled === false) {
    return false;
  }
  // SAFETY: a normalized config always has the seven built-in keys; the cast
  // only widens the lookup to a string-keyed map, and a missing key is not
  // treated as disabled (`!== false`).
  const ownership = config.registerToolOverrides as unknown as
    | Partial<Record<string, boolean>>
    | undefined;
  return ownership?.[name] !== false;
}

function buildSnapshot(
  name: string,
  source: Record<string, unknown>,
): ToolPresentationSnapshot {
  const label = readStringField(source, "label");
  const renderCall = readFunctionField<ToolPresentationRenderCall>(
    source,
    "renderCall",
  );
  const renderResult = readFunctionField<ToolPresentationRenderResult>(
    source,
    "renderResult",
  );
  const renderShell =
    source.renderShell === "default" || source.renderShell === "self"
      ? source.renderShell
      : undefined;

  return {
    name,
    ...(label !== undefined ? { label } : {}),
    ...(renderCall !== undefined ? { renderCall } : {}),
    ...(renderResult !== undefined ? { renderResult } : {}),
    ...(renderShell !== undefined ? { renderShell } : {}),
  };
}

/**
 * Create one installation-scoped provider. The config getter is read on every
 * lookup, so `enabled`, per-tool overrides and display options are always the
 * current effective ones rather than a snapshot from installation time.
 */
export function createToolPresentationProvider(
  getConfig: ToolPresentationConfigGetter,
): ToolPresentationProvider {
  const presentations = new Map<string, ToolPresentationSnapshot>();
  let revision = 0;
  let disposed = false;
  let configSignature = readConfigSignature(getConfig);

  const syncConfigRevision = (): void => {
    const signature = readConfigSignature(getConfig);
    if (signature === configSignature) {
      return;
    }
    configSignature = signature;
    revision += 1;
  };

  return {
    record(tool: unknown): boolean {
      if (disposed) {
        return false;
      }

      const source = toRecord(tool);
      const name = readStringField(source, "name");
      if (!name || !SUPPORTED_TOOL_NAMES.has(name)) {
        return false;
      }

      presentations.set(name, Object.freeze(buildSnapshot(name, source)));
      revision += 1;
      return true;
    },
    getToolPresentation(name: string): ToolPresentationSnapshot | undefined {
      if (disposed) {
        return undefined;
      }

      syncConfigRevision();
      if (!isToolPresentationEnabled(getConfig(), name)) {
        return undefined;
      }
      const snapshot =
        typeof name === "string" ? presentations.get(name) : undefined;
      return snapshot ? { ...snapshot } : undefined;
    },
    get presentationRevision(): number {
      if (!disposed) {
        syncConfigRevision();
      }
      return revision;
    },
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      presentations.clear();
      revision += 1;
    },
  };
}

/**
 * Bind an installation's provider to the `ExtensionAPI` object that registers
 * its tools. Registrations look the provider up by that owner, never by
 * "whichever provider was installed last".
 */
export function bindToolPresentationOwner(
  owner: unknown,
  api: unknown,
): boolean {
  if (typeof owner !== "object" || owner === null) {
    return false;
  }
  if (typeof api !== "object" || api === null) {
    return false;
  }

  const provider = (api as ToolPresentationProviderCarrier)[PROVIDER_KEY];
  if (!provider) {
    return false;
  }

  providerByOwner.set(owner, provider);
  return true;
}

/**
 * Capture the display whitelist of a definition this extension registers.
 * Seam-only helper: the registration path calls it once per built-in tool with
 * the `ExtensionAPI` instance that owns the installation.
 */
export function recordToolPresentation(owner: unknown, tool: unknown): boolean {
  if (typeof owner !== "object" || owner === null) {
    return false;
  }

  return providerByOwner.get(owner)?.record(tool) ?? false;
}

/**
 * Attach a fresh provider to the existing version 1 display API object without
 * changing `version`, `decorateTool`, `registerAdapter` or `unregisterAdapter`.
 * The revision is a getter so a consumer holding the API object sees changes.
 */
export function attachToolPresentationApi<T extends object>(
  api: T,
  getConfig: ToolPresentationConfigGetter,
): T & ToolPresentationApi {
  const provider = createToolPresentationProvider(getConfig);
  Object.defineProperty(api, "getToolPresentation", {
    configurable: true,
    enumerable: true,
    value: (name: string) => provider.getToolPresentation(name),
  });
  Object.defineProperty(api, "presentationRevision", {
    configurable: true,
    enumerable: true,
    get: () => provider.presentationRevision,
  });
  Object.defineProperty(api, PROVIDER_KEY, {
    configurable: true,
    enumerable: false,
    value: provider,
  });
  return api as T & ToolPresentationApi;
}

/**
 * Dispose the provider attached to one API object. Only that installation's
 * snapshots and revision are touched; a newer provider stays installed and
 * keeps receiving registrations. The provider refuses later records, so a
 * disposed installation cannot be revived.
 */
export function disposeToolPresentationApi(api: unknown): boolean {
  if (typeof api !== "object" || api === null) {
    return false;
  }

  const provider = (api as ToolPresentationProviderCarrier)[PROVIDER_KEY];
  if (!provider) {
    return false;
  }

  provider.dispose();
  return true;
}
