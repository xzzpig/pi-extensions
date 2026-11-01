import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export type RuntimeToolDefinition = Record<string, unknown>;

export interface ToolDisplayAdapter {
  kind?: "read" | "edit" | "bash" | "mcp" | "generic";
  overrideExistingRenderers?: boolean;
}

/**
 * Capabilities a consumer grants to the read-only presentation renderers for
 * one render. Both default to true so the main-session host context keeps its
 * behavior. A remote/SSH consumer must set `localWorkspace: false`; a consumer
 * rendering tool calls it did not execute itself must set
 * `executionMetadata: false`.
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

/**
 * Read-only display whitelist for one supported built-in tool. It never
 * contains `execute`, `prepareArguments`, `prepareLoadout`, `parameters` or
 * prompt metadata, and the renderer references are the main session's own
 * renderers rather than copies.
 */
export interface ToolPresentationSnapshot {
  readonly name: string;
  readonly label?: string;
  readonly renderCall?: ToolPresentationRenderCall;
  readonly renderResult?: ToolPresentationRenderResult;
  readonly renderShell?: "default" | "self";
}

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter | Record<string, unknown>): T;
  /**
   * Optional read-only presentation capability. Probe with
   * `typeof api.getToolPresentation === "function"`; when absent, fall back to
   * Pi's native tool rendering. Supported names are `read`, `bash`, `edit`,
   * `write`, `grep`, `find` and `ls`; any other name, a disabled built-in or a
   * built-in owned by another extension returns `undefined`. See
   * `docs/tool-presentation-provider.md` in the package for the full contract.
   */
  getToolPresentation?(name: string): ToolPresentationSnapshot | undefined;
  /**
   * Optional display revision. Compare the API object identity and this number
   * before every draw/cache decision; a change means the snapshot table or the
   * effective display config changed and cached rows must be re-rendered.
   */
  readonly presentationRevision?: number;
}

export interface DecorateToolForDisplayOptions {
  suppressDecorateErrors?: boolean;
}

export declare function getToolDisplayApi(): ToolDisplayApi | undefined;

export declare function queueToolDisplayDecoration<T extends RuntimeToolDefinition>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
): void;

export declare function decorateToolForDisplay<T extends object>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
  options?: DecorateToolForDisplayOptions,
): T;

export declare function decorateMcpToolForDisplay<T extends RuntimeToolDefinition>(tool: T): T;
