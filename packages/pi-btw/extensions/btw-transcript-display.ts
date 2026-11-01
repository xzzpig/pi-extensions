import type {
  Theme,
  ToolDefinition,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type {
  ToolComponentLookup,
  TranscriptEntry,
  TranscriptTheme,
  TranscriptTui,
} from "@xzzpig/pi-components/transcript";
import {
  TranscriptPresenter,
  type TranscriptPresenterFrame,
} from "@xzzpig/pi-components/transcript-presenter";

/**
 * Global key of the versioned `pi-tool-display` display API. BTW probes the
 * key directly instead of importing `@xzzpig/pi-tool-display` so a missing
 * display plugin is a normal fallback rather than a required runtime
 * dependency. The shape mirrors the approved
 * `pi-tool-display/tool-display-api-consumer` contract.
 */
const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");

const BUILT_IN_DISPLAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/** Whether the provider may supply display fields for this tool name. */
export function isBtwProviderToolName(toolName: string): boolean {
  return BUILT_IN_DISPLAY_TOOL_NAMES.has(toolName);
}

export interface BtwToolPresentationDisplayCapabilities {
  localWorkspace?: boolean;
  executionMetadata?: boolean;
}

export interface BtwToolPresentationRenderContext {
  args?: Record<string, unknown>;
  toolCallId?: string;
  /** The component this renderer returned for the previous render slot. */
  lastComponent?: Component;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  isError?: boolean;
  capabilities?: BtwToolPresentationDisplayCapabilities;
  [key: string]: unknown;
}

export type BtwToolPresentationRenderCall = (
  args: Record<string, unknown>,
  theme: Theme,
  context: BtwToolPresentationRenderContext,
) => Component;

export type BtwToolPresentationRenderResult = (
  result: {
    content?: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
  context: BtwToolPresentationRenderContext,
) => Component;

export interface BtwToolPresentationSnapshot {
  readonly name: string;
  readonly label?: string;
  readonly renderCall?: BtwToolPresentationRenderCall;
  readonly renderResult?: BtwToolPresentationRenderResult;
  readonly renderShell?: "default" | "self";
}

export interface BtwToolDisplayApi {
  version: 1;
  decorateTool(
    tool: Record<string, unknown>,
    adapter?: Record<string, unknown>,
  ): Record<string, unknown>;
  getToolPresentation?(name: string): BtwToolPresentationSnapshot | undefined;
  readonly presentationRevision?: number;
}

// SAFETY: globalThis is the process-wide object the display plugin installs
// its symbol-keyed API on; the index lookup below validates the shape.
const GLOBAL_OBJECT = globalThis as unknown as Record<PropertyKey, unknown>;

/**
 * Reads the optional display API from a global object. Returns `undefined` for
 * a missing plugin or an unknown API version. A legacy v1 object without the
 * presentation capability is returned as-is; callers probe
 * `getToolPresentation` and fall back to native rendering when it is absent.
 */
export function readBtwToolDisplayApi(
  target: Record<PropertyKey, unknown> = GLOBAL_OBJECT,
): BtwToolDisplayApi | undefined {
  const candidate = target[TOOL_DISPLAY_API_KEY];
  if (!candidate || typeof candidate !== "object") return undefined;
  // SAFETY: the version/decorateTool checks below reject any object that does
  // not expose the version 1 display API; the optional presentation members
  // are probed separately by their callers.
  const api = candidate as Partial<BtwToolDisplayApi> & {
    version?: unknown;
    decorateTool?: unknown;
  };
  if (api.version !== 1 || typeof api.decorateTool !== "function") {
    return undefined;
  }
  return api as BtwToolDisplayApi;
}

export type BtwToolDisplayDiagnosticPhase = "lookup" | "call" | "result";

export interface BtwToolDisplayDiagnostic {
  toolName: string;
  phase: BtwToolDisplayDiagnosticPhase;
  message: string;
}

/**
 * Rate-limits provider diagnostics to one report per tool, phase, and display
 * revision. A renderer that throws on every repaint therefore reports once;
 * a config/registration change (new revision) or an extension reload (new API
 * identity) allows the next report.
 */
export class BtwToolDisplayDiagnostics {
  private readonly reported = new Set<string>();
  private readonly entries: BtwToolDisplayDiagnostic[] = [];
  private lastApi: BtwToolDisplayApi | null = null;
  private lastRevision: number | null = null;

  constructor(
    private readonly onDiagnostic?: (
      diagnostic: BtwToolDisplayDiagnostic,
    ) => void,
  ) {}

  /**
   * Records the provider identity/revision currently in use. A change clears
   * the per-tool rate limit so a new provider/revision can report again.
   */
  observe(api: BtwToolDisplayApi | null, revision: number): void {
    if (api !== this.lastApi || revision !== this.lastRevision) {
      this.lastApi = api;
      this.lastRevision = revision;
      this.reported.clear();
    }
  }

  report(
    api: BtwToolDisplayApi | null,
    revision: number,
    toolName: string,
    phase: BtwToolDisplayDiagnosticPhase,
    error: unknown,
    source: "provider" | "child" = "provider",
  ): void {
    this.observe(api, revision);

    const key = `${toolName}:${phase}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);

    const detail = error instanceof Error ? error.message : String(error);
    const diagnostic: BtwToolDisplayDiagnostic = {
      toolName,
      phase,
      message:
        source === "child"
          ? phase === "lookup"
            ? `BTW could not resolve the ${toolName} tool's own display renderers; showing the display provider or Pi's native tool display instead. ${detail}`
            : `BTW could not render the ${toolName} tool (${phase}) with its own renderer; showing the actual ${phase} text instead. ${detail}`
          : `pi-tool-display could not render the ${toolName} tool (${phase}); showing Pi's native tool display. ${detail}`,
    };
    this.entries.push(diagnostic);
    this.onDiagnostic?.(diagnostic);
  }

  get messages(): readonly BtwToolDisplayDiagnostic[] {
    return this.entries;
  }

  reset(): void {
    this.entries.length = 0;
    this.reported.clear();
    this.lastApi = null;
    this.lastRevision = null;
  }
}

type BtwNativeCallRenderer = (
  args: Record<string, unknown>,
  theme: Theme,
  context: BtwToolPresentationRenderContext,
) => Component;

type BtwNativeResultRenderer = (
  result: Parameters<BtwToolPresentationRenderResult>[0],
  options: Parameters<BtwToolPresentationRenderResult>[1],
  theme: Theme,
  context: BtwToolPresentationRenderContext,
) => Component;

/**
 * Revision key used when the display provider's revision, or the child's own
 * renderer resolution, cannot be read. Sharing one failure identity keeps the
 * rate limiter stable when both lookups fail for the same tool.
 */
const DISPLAY_LOOKUP_FAILURE_REVISION = -2;
const MAX_FALLBACK_CHARS = 240;
const MAX_FALLBACK_RESULT_CHARS = 4000;

function truncateFallback(text: string, limit = MAX_FALLBACK_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function formatFallbackArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return truncateFallback(args);
  try {
    const json = JSON.stringify(args);
    return json && json !== "{}" ? truncateFallback(json) : "";
  } catch {
    return truncateFallback(String(args));
  }
}

function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const text = content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const typed = part as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string"
        ? [typed.text]
        : [];
    })
    .join("\n")
    .trim();
  return truncateFallback(text, MAX_FALLBACK_RESULT_CHARS);
}

/**
 * Guards a provider-rendered component whose `render`/`invalidate`/`handleMouse`
 * can throw after the factory returned. On the first failure the guard reports
 * once through the adapter's rate limiter and switches to the native fallback
 * (the child session definition) for that phase; if the native component also
 * fails it uses a visible last-resort line. The provider component is never
 * entered again after it fails, so the fallback cannot recurse into it.
 */
class BtwGuardedToolComponent implements Component {
  private primaryFailed = false;
  private fallbackFailed = false;
  private fallbackComponent: Component | undefined;
  private lastResortComponent: Component | undefined;

  constructor(
    readonly phase: "call" | "result",
    private readonly primary: Component,
    private readonly createFallback: () => Component,
    private readonly createLastResort: () => Component,
    private readonly lastResortLine: string,
    private readonly report: (error: unknown) => void,
  ) {}

  /** The provider component this guard still owns, for `lastComponent` reuse. */
  get reusableProviderComponent(): Component | undefined {
    return this.primaryFailed ? undefined : this.primary;
  }

  /** The native fallback component created for this slot, if any. */
  get reusableFallbackComponent(): Component | undefined {
    return this.fallbackFailed ? undefined : this.fallbackComponent;
  }

  get hasProviderFailed(): boolean {
    return this.primaryFailed;
  }

  /**
   * Marks this slot as provider-failed before any render (factory throw or a
   * previous guard that already failed) and records the native fallback for
   * later `lastComponent` reuse. Later updates then never re-enter the provider.
   */
  markProviderFailed(fallback?: Component): void {
    this.primaryFailed = true;
    if (fallback) this.fallbackComponent = fallback;
  }

  render(width: number): string[] {
    if (!this.primaryFailed) {
      try {
        return this.primary.render(width);
      } catch (error) {
        this.report(error);
        this.primaryFailed = true;
      }
    }
    if (!this.fallbackFailed) {
      try {
        this.fallbackComponent ??= this.createFallback();
        return this.fallbackComponent.render(width);
      } catch (error) {
        this.report(error);
        this.fallbackFailed = true;
      }
    }
    try {
      this.lastResortComponent ??= this.createLastResort();
      return this.lastResortComponent.render(width);
    } catch {
      return [this.lastResortLine];
    }
  }

  invalidate(): void {
    if (!this.primaryFailed) {
      try {
        this.primary.invalidate();
      } catch (error) {
        this.report(error);
        this.primaryFailed = true;
      }
    }
    if (!this.fallbackFailed && this.fallbackComponent) {
      try {
        this.fallbackComponent.invalidate();
      } catch (error) {
        this.report(error);
        this.fallbackFailed = true;
      }
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.primaryFailed) {
      try {
        return this.primary.handleMouse?.(event);
      } catch (error) {
        this.report(error);
        this.primaryFailed = true;
      }
    }
    if (!this.fallbackFailed) {
      try {
        return this.fallbackComponent?.handleMouse?.(event);
      } catch (error) {
        this.report(error);
        this.fallbackFailed = true;
      }
    }
    return undefined;
  }
}

export interface BtwToolDisplayAdapterOptions {
  /** The BTW child session's own registered definition lookup. */
  getChildToolDefinition?: (toolName: string) => ToolDefinition | undefined;
  /**
   * The child session's public renderer resolution: extension
   * `registerToolRenderer` resolvers in load order. `baseDefinition` is the
   * child session's own registered definition for this tool (the same one
   * `getChildToolDefinition` returned), so a resolver that wraps `next()` sees
   * the child's renderers instead of the parent session's. A resolver's output
   * is child display state and wins the phases it supplies. Hosts without the
   * public method omit this option and keep the registered-definition behavior.
   */
  getChildToolRenderers?: (
    toolName: string,
    baseDefinition: ToolDefinition | undefined,
  ) => ToolRenderers | undefined;
  /** False for an SSH/remote workspace, where local previews must not run. */
  isLocalWorkspace: () => boolean;
  getDisplayApi?: () => BtwToolDisplayApi | undefined;
  onDiagnostic?: (diagnostic: BtwToolDisplayDiagnostic) => void;
  /** Stable per-instance prefix for renderer-local tool call ids. */
  namespace?: string;
}

let nextAdapterId = 0;

function readPresentationRevision(api: BtwToolDisplayApi): number {
  const revision = api.presentationRevision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : -1;
}

/**
 * Read-only bridge between BTW's tool components and the main session's
 * `pi-tool-display` renderers.
 *
 * Resolution order, per renderer field:
 * 1. the child session's own display renderers — the public extension
 *    renderer resolvers, then the fields carried by the registered definition.
 *    An ordinary built-in definition carries no renderer, so the provider
 *    still supplies the known built-in styling; a definition that does carry
 *    one is a child customization and keeps that phase;
 * 2. for the seven supported built-ins the child does not draw itself, the
 *    display provider's renderers overlaid on a copy of the child definition;
 * 3. the child definition / Pi's native fallback.
 *
 * The adapter never exposes provider execution fields: it copies only
 * `renderCall`, `renderResult` and `renderShell`, and every render context is
 * scoped with `capabilities.executionMetadata: false` (plus
 * `localWorkspace: false` for SSH). Tool call ids handed to the renderers are
 * namespaced so a renderer's own module-level state cannot collide with a
 * parent-session call that happens to share the id; the transcript's own
 * component keys keep the unmodified id.
 */
/**
 * Copies only the renderer fields a child resolver may return. Resolver output
 * is child display state; anything else it carries (a spread definition can
 * include `name`, `parameters` or `execute`) is not forwarded.
 */
function copyToolRenderers(
  renderers: ToolRenderers | undefined,
): ToolRenderers | undefined {
  if (!renderers || typeof renderers !== "object") return undefined;
  const renderShell =
    renderers.renderShell === "default" || renderers.renderShell === "self"
      ? renderers.renderShell
      : undefined;
  const renderCall =
    typeof renderers.renderCall === "function"
      ? renderers.renderCall
      : undefined;
  const renderResult =
    typeof renderers.renderResult === "function"
      ? renderers.renderResult
      : undefined;
  if (renderShell === undefined && !renderCall && !renderResult) {
    return undefined;
  }
  return {
    ...(renderShell === undefined ? {} : { renderShell }),
    ...(renderCall === undefined ? {} : { renderCall }),
    ...(renderResult === undefined ? {} : { renderResult }),
  };
}

interface BtwToolDisplayProvider {
  api: BtwToolDisplayApi;
  revision: number;
  getToolPresentation(name: string): BtwToolPresentationSnapshot | undefined;
}

export class BtwToolDisplayAdapter {
  private readonly namespace: string;
  readonly diagnostics: BtwToolDisplayDiagnostics;

  constructor(private readonly options: BtwToolDisplayAdapterOptions) {
    this.namespace = options.namespace ?? `btw${++nextAdapterId}`;
    this.diagnostics = new BtwToolDisplayDiagnostics(options.onDiagnostic);
  }

  /**
   * Current provider identity and revision. Hosts compare both before reusing
   * cached rows; a revision change means renderers or their config changed.
   */
  get displayProvider(): BtwToolDisplayProvider | undefined {
    return this.readDisplayProvider();
  }

  private readDisplayProvider(
    toolName = "tool-display",
  ): BtwToolDisplayProvider | undefined {
    let api: BtwToolDisplayApi | undefined;
    try {
      api = this.options.getDisplayApi?.();
    } catch (error) {
      // A broken global probe has no provider identity to key on; the null
      // identity plus the failure revision still rate-limits repeated probes.
      this.diagnostics.report(
        null,
        DISPLAY_LOOKUP_FAILURE_REVISION,
        toolName,
        "lookup",
        error,
      );
      return undefined;
    }
    if (!api || typeof api !== "object") return undefined;

    let getToolPresentation: unknown;
    try {
      getToolPresentation = api.getToolPresentation;
    } catch (error) {
      this.diagnostics.report(
        api,
        DISPLAY_LOOKUP_FAILURE_REVISION,
        toolName,
        "lookup",
        error,
      );
      return undefined;
    }
    if (typeof getToolPresentation !== "function") return undefined;

    let revision: number;
    try {
      revision = readPresentationRevision(api);
    } catch (error) {
      // The revision getter itself can throw; the failure key must not depend
      // on having read a revision successfully.
      this.diagnostics.report(
        api,
        DISPLAY_LOOKUP_FAILURE_REVISION,
        toolName,
        "lookup",
        error,
      );
      return undefined;
    }

    this.diagnostics.observe(api, revision);
    return {
      api,
      revision,
      getToolPresentation: (name) =>
        (
          getToolPresentation as (
            this: BtwToolDisplayApi,
            name: string,
          ) => BtwToolPresentationSnapshot | undefined
        ).call(api, name),
    };
  }

  /** Resolver accepted by `createTranscriptState` and the presenter. */
  resolveToolDefinition = (toolName: string): ToolDefinition | undefined => {
    const childDefinition = this.options.getChildToolDefinition?.(toolName);
    const provider = this.readDisplayProvider(toolName);
    const childRenderers = this.readChildRenderers(
      toolName,
      childDefinition,
      provider,
    );
    const api = provider?.api ?? null;
    const revision = provider?.revision ?? -1;
    if (!provider || !BUILT_IN_DISPLAY_TOOL_NAMES.has(toolName)) {
      return this.childDisplayDefinition(
        toolName,
        childDefinition,
        childRenderers,
        api,
        revision,
      );
    }

    const { api: providerApi, revision: providerRevision } = provider;
    let snapshot: BtwToolPresentationSnapshot | undefined;
    try {
      snapshot = provider.getToolPresentation(toolName);
    } catch (error) {
      this.diagnostics.report(
        providerApi,
        providerRevision,
        toolName,
        "lookup",
        error,
      );
      return this.childDisplayDefinition(
        toolName,
        childDefinition,
        childRenderers,
        providerApi,
        providerRevision,
      );
    }
    if (!snapshot || typeof snapshot !== "object") {
      return this.childDisplayDefinition(
        toolName,
        childDefinition,
        childRenderers,
        providerApi,
        providerRevision,
      );
    }

    const providerRenderCall =
      typeof snapshot.renderCall === "function"
        ? snapshot.renderCall
        : undefined;
    const providerRenderResult =
      typeof snapshot.renderResult === "function"
        ? snapshot.renderResult
        : undefined;
    const providerRenderShell =
      snapshot.renderShell === "default" || snapshot.renderShell === "self"
        ? snapshot.renderShell
        : undefined;

    // A real child customization (public resolver output, or a definition that
    // carries its own renderer) keeps its phase; the provider only supplies the
    // phases the ordinary built-in definition leaves to Pi's default display.
    const childRenderCall =
      childRenderers?.renderCall ?? childDefinition?.renderCall;
    const childRenderResult =
      childRenderers?.renderResult ?? childDefinition?.renderResult;

    const renderCall = childRenderCall
      ? this.wrapChildRenderCall(
          toolName,
          // SAFETY: same renderer contract as the child display copy; only the
          // definition's own renderer fields are forwarded.
          childRenderCall as unknown as BtwNativeCallRenderer,
          providerApi,
          providerRevision,
        )
      : providerRenderCall
        ? this.wrapRenderCall(
            providerApi,
            providerRevision,
            toolName,
            providerRenderCall,
            childDefinition,
          )
        : undefined;
    const renderResult = childRenderResult
      ? this.wrapChildRenderResult(
          toolName,
          // SAFETY: same renderer contract as the child display copy; only the
          // definition's own renderer fields are forwarded.
          childRenderResult as unknown as BtwNativeResultRenderer,
          providerApi,
          providerRevision,
        )
      : providerRenderResult
        ? this.wrapRenderResult(
            providerApi,
            providerRevision,
            toolName,
            providerRenderResult,
            childDefinition,
          )
        : undefined;
    const renderShell =
      childRenderers?.renderShell ??
      childDefinition?.renderShell ??
      providerRenderShell;

    const display: ToolRenderers = {
      ...(renderShell === undefined ? {} : { renderShell }),
      ...(renderCall === undefined ? {} : { renderCall }),
      ...(renderResult === undefined ? {} : { renderResult }),
    };

    if (childDefinition) {
      // Display copy, never a mutation of the child or provider definition.
      return { ...childDefinition, ...display };
    }

    // SAFETY: the transcript API types the resolver as a full ToolDefinition,
    // but ToolExecutionComponent only reads the renderer fields. Returning the
    // renderer-only object keeps the display path free of a fabricated execute
    // function or parameter schema.
    return display as unknown as ToolDefinition;
  };

  /**
   * The child session's own display renderers: the public extension renderer
   * resolvers first, then the fields carried by the registered definition.
   * Resolution is field-level, so a resolver that supplies one phase keeps the
   * definition's other phase. A resolver that throws must not escape into the
   * transcript: the provider/native definition takes over and the failure is
   * reported once per tool and display identity.
   */
  private readChildRenderers(
    toolName: string,
    childDefinition: ToolDefinition | undefined,
    provider: BtwToolDisplayProvider | undefined,
  ): ToolRenderers | undefined {
    const resolve = this.options.getChildToolRenderers;
    if (!resolve) return undefined;
    let resolved: ToolRenderers | undefined;
    try {
      resolved = resolve(toolName, childDefinition);
    } catch (error) {
      this.diagnostics.report(
        provider?.api ?? null,
        provider?.revision ?? DISPLAY_LOOKUP_FAILURE_REVISION,
        toolName,
        "lookup",
        error,
        "child",
      );
      return undefined;
    }
    return copyToolRenderers(resolved);
  }

  /**
   * Display copy of a child definition whose own renderers are wrapped in the
   * same factory + draw/invalidate/mouse fault boundary the provider path
   * uses. Public resolver fields win over the registered definition field by
   * field. The source definition is never mutated and is returned unchanged
   * when the child has no renderer to guard (nothing can throw).
   *
   * The fallback for a failing child renderer is the visible actual
   * args/result text, not the child renderer again, so a component that throws
   * while drawing cannot be re-entered by its own fallback.
   */
  private childDisplayDefinition(
    toolName: string,
    childDefinition: ToolDefinition | undefined,
    childRenderers: ToolRenderers | undefined,
    api: BtwToolDisplayApi | null,
    revision: number,
  ): ToolDefinition | undefined {
    // SAFETY: the child renderers come from the same Pi tool contract the
    // provider renderers use; the adapter only forwards the render context and
    // never reads renderer-private fields.
    const renderCall = (childRenderers?.renderCall ??
      childDefinition?.renderCall) as unknown as
      | BtwNativeCallRenderer
      | undefined;
    // SAFETY: same contract as the call renderer above; only the display
    // fields are copied, the source definition keeps its own function.
    const renderResult = (childRenderers?.renderResult ??
      childDefinition?.renderResult) as unknown as
      | BtwNativeResultRenderer
      | undefined;
    const renderShell =
      childRenderers?.renderShell ?? childDefinition?.renderShell;

    const display: ToolRenderers = {
      ...(renderShell === undefined ? {} : { renderShell }),
      ...(renderCall
        ? {
            renderCall: this.wrapChildRenderCall(
              toolName,
              renderCall,
              api,
              revision,
            ),
          }
        : {}),
      ...(renderResult
        ? {
            renderResult: this.wrapChildRenderResult(
              toolName,
              renderResult,
              api,
              revision,
            ),
          }
        : {}),
    };

    if (!childDefinition) {
      // SAFETY: a public resolver may draw a tool the child session does not
      // register; the transcript only reads renderer fields, so this stays a
      // renderer-only object without a fabricated execute or parameter schema.
      return Object.keys(display).length === 0
        ? undefined
        : (display as unknown as ToolDefinition);
    }
    if (Object.keys(display).length === 0) return childDefinition;
    return { ...childDefinition, ...display };
  }

  private wrapChildRenderCall(
    toolName: string,
    renderCall: BtwNativeCallRenderer,
    api: BtwToolDisplayApi | null,
    revision: number,
  ): NonNullable<ToolRenderers["renderCall"]> {
    const wrapped = (
      args: unknown,
      theme: Theme,
      context: unknown,
    ): Component => {
      const source =
        context && typeof context === "object"
          ? (context as Record<string, unknown>)
          : {};
      const rawLast = source.lastComponent;
      const previousGuard =
        rawLast instanceof BtwGuardedToolComponent && rawLast.phase === "call"
          ? rawLast
          : undefined;
      const opaqueGuard =
        rawLast instanceof BtwGuardedToolComponent && !previousGuard;
      const report = (error: unknown): void =>
        this.diagnostics.report(
          api,
          revision,
          toolName,
          "call",
          error,
          "child",
        );
      const createFallback = (): Component =>
        this.createLastResortCall(toolName, args, theme);
      if (previousGuard?.hasProviderFailed) {
        // Never re-enter a child renderer that already failed while drawing:
        // keep the actual-args fallback for later updates of this slot.
        const fallback = createFallback();
        const guard = new BtwGuardedToolComponent(
          "call",
          fallback,
          createFallback,
          createFallback,
          `${toolName} call (child renderer fallback)`,
          report,
        );
        guard.markProviderFailed(fallback);
        return guard;
      }
      const childLast = previousGuard
        ? previousGuard.reusableProviderComponent
        : opaqueGuard
          ? undefined
          : (rawLast as Component | undefined);

      let primary: Component;
      try {
        primary = renderCall(
          args as Record<string, unknown>,
          theme,
          this.scopedRenderContext(context, childLast),
        );
      } catch (error) {
        report(error);
        const guard = new BtwGuardedToolComponent(
          "call",
          createFallback(),
          createFallback,
          createFallback,
          `${toolName} call (child renderer fallback)`,
          report,
        );
        guard.markProviderFailed();
        return guard;
      }
      return new BtwGuardedToolComponent(
        "call",
        primary,
        createFallback,
        createFallback,
        `${toolName} call (child renderer fallback)`,
        report,
      );
    };
    return wrapped as NonNullable<ToolRenderers["renderCall"]>;
  }

  private wrapChildRenderResult(
    toolName: string,
    renderResult: BtwNativeResultRenderer,
    api: BtwToolDisplayApi | null,
    revision: number,
  ): NonNullable<ToolRenderers["renderResult"]> {
    const wrapped = (
      result: unknown,
      options: unknown,
      theme: Theme,
      context: unknown,
    ): Component => {
      const source =
        context && typeof context === "object"
          ? (context as Record<string, unknown>)
          : {};
      const rawLast = source.lastComponent;
      const previousGuard =
        rawLast instanceof BtwGuardedToolComponent && rawLast.phase === "result"
          ? rawLast
          : undefined;
      const opaqueGuard =
        rawLast instanceof BtwGuardedToolComponent && !previousGuard;
      const report = (error: unknown): void =>
        this.diagnostics.report(
          api,
          revision,
          toolName,
          "result",
          error,
          "child",
        );
      const createFallback = (): Component =>
        this.createLastResortResult(toolName, result, theme);
      if (previousGuard?.hasProviderFailed) {
        // Same rule as the call phase: a child result renderer that already
        // failed is not re-entered; the actual result text stays visible.
        const fallback = createFallback();
        const guard = new BtwGuardedToolComponent(
          "result",
          fallback,
          createFallback,
          createFallback,
          `${toolName} result (child renderer fallback)`,
          report,
        );
        guard.markProviderFailed(fallback);
        return guard;
      }
      const childLast = previousGuard
        ? previousGuard.reusableProviderComponent
        : opaqueGuard
          ? undefined
          : (rawLast as Component | undefined);

      let primary: Component;
      try {
        primary = renderResult(
          result as Parameters<BtwToolPresentationRenderResult>[0],
          options as Parameters<BtwToolPresentationRenderResult>[1],
          theme,
          this.scopedRenderContext(context, childLast),
        );
      } catch (error) {
        report(error);
        const guard = new BtwGuardedToolComponent(
          "result",
          createFallback(),
          createFallback,
          createFallback,
          `${toolName} result (child renderer fallback)`,
          report,
        );
        guard.markProviderFailed();
        return guard;
      }
      return new BtwGuardedToolComponent(
        "result",
        primary,
        createFallback,
        createFallback,
        `${toolName} result (child renderer fallback)`,
        report,
      );
    };
    return wrapped as NonNullable<ToolRenderers["renderResult"]>;
  }

  private wrapRenderCall(
    api: BtwToolDisplayApi,
    revision: number,
    toolName: string,
    renderCall: BtwToolPresentationRenderCall,
    childDefinition: ToolDefinition | undefined,
  ): NonNullable<ToolRenderers["renderCall"]> {
    const wrapped = (
      args: unknown,
      theme: Theme,
      context: unknown,
    ): Component => {
      const source =
        context && typeof context === "object"
          ? (context as Record<string, unknown>)
          : {};
      const rawLast = source.lastComponent;
      const previousGuard =
        rawLast instanceof BtwGuardedToolComponent && rawLast.phase === "call"
          ? rawLast
          : undefined;
      // A guard from another phase is opaque; never hand it to the provider or
      // the native fallback as their own previous component.
      const opaqueGuard =
        rawLast instanceof BtwGuardedToolComponent && !previousGuard;
      const report = (error: unknown): void =>
        this.diagnostics.report(api, revision, toolName, "call", error);
      const createLastResort = (): Component =>
        this.createLastResortCall(toolName, args, theme);
      const nativeLast = previousGuard?.reusableFallbackComponent;
      const createNative = (): Component =>
        this.createNativeCall(
          childDefinition,
          args,
          theme,
          this.scopedRenderContext(context, nativeLast),
          report,
          createLastResort,
        );

      if (previousGuard?.hasProviderFailed) {
        // Do not re-enter a provider component that already failed. Keep the
        // native fallback (and its own lastComponent state) for later updates.
        const native = createNative();
        const guard = new BtwGuardedToolComponent(
          "call",
          native,
          createLastResort,
          createLastResort,
          `${toolName} call (display fallback)`,
          report,
        );
        guard.markProviderFailed(native);
        return guard;
      }

      // ToolExecutionComponent passes this module's guard back as
      // context.lastComponent on the next render; forward the provider's own
      // primary so renderers that reuse their previous component keep state.
      const providerLast = previousGuard
        ? previousGuard.reusableProviderComponent
        : opaqueGuard
          ? undefined
          : (rawLast as Component | undefined);
      let primary: Component;
      try {
        primary = renderCall(
          args as Record<string, unknown>,
          theme,
          this.scopedRenderContext(context, providerLast),
        );
      } catch (error) {
        report(error);
        const native = createNative();
        const guard = new BtwGuardedToolComponent(
          "call",
          native,
          createLastResort,
          createLastResort,
          `${toolName} call (display fallback)`,
          report,
        );
        guard.markProviderFailed(native);
        return guard;
      }
      return new BtwGuardedToolComponent(
        "call",
        primary,
        createNative,
        createLastResort,
        `${toolName} call (display fallback)`,
        report,
      );
    };
    return wrapped as NonNullable<ToolRenderers["renderCall"]>;
  }

  private wrapRenderResult(
    api: BtwToolDisplayApi,
    revision: number,
    toolName: string,
    renderResult: BtwToolPresentationRenderResult,
    childDefinition: ToolDefinition | undefined,
  ): NonNullable<ToolRenderers["renderResult"]> {
    const wrapped = (
      result: unknown,
      options: unknown,
      theme: Theme,
      context: unknown,
    ): Component => {
      const source =
        context && typeof context === "object"
          ? (context as Record<string, unknown>)
          : {};
      const rawLast = source.lastComponent;
      const previousGuard =
        rawLast instanceof BtwGuardedToolComponent && rawLast.phase === "result"
          ? rawLast
          : undefined;
      const opaqueGuard =
        rawLast instanceof BtwGuardedToolComponent && !previousGuard;
      const typedResult =
        result as Parameters<BtwToolPresentationRenderResult>[0];
      const typedOptions =
        options as Parameters<BtwToolPresentationRenderResult>[1];
      const report = (error: unknown): void =>
        this.diagnostics.report(api, revision, toolName, "result", error);
      const createLastResort = (): Component =>
        this.createLastResortResult(toolName, typedResult, theme);
      const nativeLast = previousGuard?.reusableFallbackComponent;
      const createNative = (): Component =>
        this.createNativeResult(
          childDefinition,
          typedResult,
          typedOptions,
          theme,
          this.scopedRenderContext(context, nativeLast),
          report,
          createLastResort,
        );

      if (previousGuard?.hasProviderFailed) {
        const native = createNative();
        const guard = new BtwGuardedToolComponent(
          "result",
          native,
          createLastResort,
          createLastResort,
          `${toolName} result (display fallback)`,
          report,
        );
        guard.markProviderFailed(native);
        return guard;
      }

      // Same guard unwrap as the call slot: the provider result renderer gets
      // its own previous component, never the wrapper or another phase's slot.
      const providerLast = previousGuard
        ? previousGuard.reusableProviderComponent
        : opaqueGuard
          ? undefined
          : (rawLast as Component | undefined);
      let primary: Component;
      try {
        primary = renderResult(
          typedResult,
          typedOptions,
          theme,
          this.scopedRenderContext(context, providerLast),
        );
      } catch (error) {
        report(error);
        const native = createNative();
        const guard = new BtwGuardedToolComponent(
          "result",
          native,
          createLastResort,
          createLastResort,
          `${toolName} result (display fallback)`,
          report,
        );
        guard.markProviderFailed(native);
        return guard;
      }
      return new BtwGuardedToolComponent(
        "result",
        primary,
        createNative,
        createLastResort,
        `${toolName} result (display fallback)`,
        report,
      );
    };
    return wrapped as NonNullable<ToolRenderers["renderResult"]>;
  }

  private createNativeCall(
    childDefinition: ToolDefinition | undefined,
    args: unknown,
    theme: Theme,
    context: BtwToolPresentationRenderContext,
    report: (error: unknown) => void,
    createLastResort: () => Component,
  ): Component {
    // SAFETY: ToolExecutionComponent supplies a full ToolRenderContext; the
    // scoped copy keeps every field and only adds capabilities / rewrites the
    // display-side tool call id.
    const renderCall = childDefinition?.renderCall as unknown as
      | BtwNativeCallRenderer
      | undefined;
    if (!renderCall) return createLastResort();
    try {
      return renderCall(args as Record<string, unknown>, theme, context);
    } catch (error) {
      report(error);
      return createLastResort();
    }
  }

  private createNativeResult(
    childDefinition: ToolDefinition | undefined,
    result: Parameters<BtwToolPresentationRenderResult>[0],
    options: Parameters<BtwToolPresentationRenderResult>[1],
    theme: Theme,
    context: BtwToolPresentationRenderContext,
    report: (error: unknown) => void,
    createLastResort: () => Component,
  ): Component {
    // SAFETY: same scoped-context invariant as createNativeCall.
    const renderResult = childDefinition?.renderResult as unknown as
      | BtwNativeResultRenderer
      | undefined;
    if (!renderResult) return createLastResort();
    try {
      return renderResult(result, options, theme, context);
    } catch (error) {
      report(error);
      return createLastResort();
    }
  }

  private createLastResortCall(
    toolName: string,
    args: unknown,
    theme: Theme,
  ): Component {
    const summary = formatFallbackArgs(args);
    return new Text(
      theme.fg(
        "toolOutput",
        `${toolName}${summary ? ` ${summary}` : ""} (display fallback)`,
      ),
      0,
      0,
    );
  }

  private createLastResortResult(
    toolName: string,
    result: unknown,
    theme: Theme,
  ): Component {
    const text =
      extractResultText(result) || `${toolName} result (display fallback)`;
    return new Text(theme.fg("toolOutput", text), 0, 0);
  }

  private scopedRenderContext(
    context: unknown,
    lastComponent: Component | undefined,
  ): BtwToolPresentationRenderContext {
    const source =
      context && typeof context === "object"
        ? (context as Record<string, unknown>)
        : {};
    const existingCapabilities =
      source.capabilities && typeof source.capabilities === "object"
        ? (source.capabilities as BtwToolPresentationDisplayCapabilities)
        : {};
    const toolCallId = source.toolCallId;
    return {
      ...source,
      // Never forward this module's guard wrapper as a renderer's own
      // lastComponent; callers pass the unwrapped primary/fallback component.
      lastComponent,
      ...(typeof toolCallId === "string" && toolCallId
        ? { toolCallId: `${this.namespace}:${toolCallId}` }
        : {}),
      capabilities: {
        ...existingCapabilities,
        // BTW renders calls it did not execute: parent execution metadata
        // (write previous-content snapshots keyed by tool call id) must never
        // leak into the child display.
        executionMetadata: false,
        localWorkspace: this.options.isLocalWorkspace(),
      },
    };
  }
}

export interface BtwTranscriptDisplayProvider {
  readonly api: BtwToolDisplayApi;
  readonly revision: number;
}

export interface BtwTranscriptDisplayOptions {
  theme: TranscriptTheme;
  /** Live registry so tool renderer state survives frames. */
  toolComponents?: ToolComponentLookup;
  resolveToolDefinition?: (toolName: string) => ToolDefinition | undefined;
  emptyText?: string;
  assistantLabel?: string;
  tui?: TranscriptTui;
  /**
   * Current display-provider identity/revision. BTW checks this before every
   * cache decision; a change rebuilds affected tool components and raises the
   * presenter revision.
   */
  getDisplayProvider?: () => BtwTranscriptDisplayProvider | undefined;
  /** Rebuilds tool components after the provider identity/revision changed. */
  rebuildToolComponents?: () => void;
}

/**
 * BTW's opt-in stateful transcript display. It keeps the shared presenter
 * behind a fork-only seam so the overlay can opt into real streaming and
 * native message components without importing the presenter directly.
 *
 * The instance is owned by the BTW thread, not by one overlay window: closing
 * and reopening the overlay detaches/attaches the TUI but keeps message and
 * tool components (and their expansion choices). Theme changes flow through a
 * stable proxy and invalidate components; they never reset the host theme.
 */
export class BtwTranscriptDisplay {
  private readonly presenter: TranscriptPresenter;
  private readonly options: Omit<BtwTranscriptDisplayOptions, "tui">;
  private currentTheme: TranscriptTheme;
  private readonly themeProxy: TranscriptTheme;
  private providerApi: BtwToolDisplayApi | null = null;
  private providerRevision = -1;

  constructor(options: BtwTranscriptDisplayOptions) {
    // Never retain the raw options object: it can contain the host TUI. The
    // TUI is attached below and only lives in the presenter's detachable slot.
    const { tui, ...sanitized } = options;
    this.options = sanitized;
    this.currentTheme = sanitized.theme;
    this.themeProxy = {
      fg: (color, text) => this.currentTheme.fg(color, text),
      bg: (color, text) => this.currentTheme.bg(color, text),
      bold: (text) => this.currentTheme.bold(text),
    };
    this.presenter = new TranscriptPresenter({
      theme: this.themeProxy,
      ...(sanitized.toolComponents
        ? { toolComponents: sanitized.toolComponents }
        : {}),
      ...(sanitized.resolveToolDefinition
        ? { resolveToolDefinition: sanitized.resolveToolDefinition }
        : {}),
      ...(sanitized.emptyText === undefined
        ? {}
        : { emptyText: sanitized.emptyText }),
      ...(sanitized.assistantLabel === undefined
        ? {}
        : { assistantLabel: sanitized.assistantLabel }),
    });
    if (tui) this.presenter.attachTui(tui);
  }

  get revision(): number {
    return this.presenter.revision;
  }

  /** Retained presenter-owned message components. */
  get componentCount(): number {
    return this.presenter.componentCount;
  }

  /**
   * Updates the theme proxy without touching the host theme or reassigning
   * message content. The presenter invalidates retained components so the next
   * frame uses the new palette while preserving click/expansion choices.
   */
  setTheme(theme: TranscriptTheme): void {
    if (theme === this.currentTheme) return;
    this.currentTheme = theme;
    this.presenter.invalidate();
  }

  /**
   * Reads the current provider identity/revision and rebuilds affected tool
   * components when it changed. Returns the presenter revision to include in
   * the caller's line-cache key.
   */
  refresh(): number {
    this.refreshProvider();
    return this.presenter.revision;
  }

  private refreshProvider(): void {
    if (!this.options.getDisplayProvider) return;
    const provider = this.options.getDisplayProvider();
    const api = provider?.api ?? null;
    const revision = provider?.revision ?? -1;
    if (api === this.providerApi && revision === this.providerRevision) return;
    this.providerApi = api;
    this.providerRevision = revision;
    this.options.rebuildToolComponents?.();
    this.presenter.requestRender();
  }

  /** Whether retained thinking blocks are currently shown. */
  get thinkingVisible(): boolean {
    return this.presenter.thinkingVisible;
  }

  /** Flips the local thinking preference and returns the new visibility. */
  toggleThinkingVisibility(): boolean {
    return this.presenter.toggleThinkingVisibility();
  }

  /**
   * Routes a presenter-space mouse event (see `mapBtwOverlayTranscriptMouse`).
   * Returns whether a retained component handled it.
   */
  handleMouse(event: TuiMouseEvent): boolean {
    return this.presenter.handleMouse(event);
  }

  /**
   * Renders a frame and returns its layout/revision. Callers cache the frame
   * revision, not the current revision: a component that requests a repaint
   * during rendering leaves the current revision higher, forcing one more
   * frame instead of caching stale lines.
   */
  renderFrame(
    entries: readonly TranscriptEntry[],
    width: number,
  ): TranscriptPresenterFrame {
    this.refreshProvider();
    this.presenter.sync(entries);
    return this.presenter.render(width);
  }

  render(entries: readonly TranscriptEntry[], width: number): string[] {
    return this.renderFrame(entries, width).lines;
  }

  /** Raises the presenter revision and requests a host repaint. */
  requestRender(): void {
    this.presenter.requestRender();
  }

  /** Invalidates retained components without resetting the host theme. */
  invalidate(): void {
    this.presenter.invalidate();
  }

  /** Drops retained message/tool layout; the display can be reused. */
  clear(): void {
    this.presenter.clear();
  }

  attachTui(tui: TranscriptTui): void {
    this.presenter.attachTui(tui);
  }

  detachTui(): void {
    this.presenter.detachTui();
  }

  dispose(): void {
    this.presenter.dispose();
  }
}
