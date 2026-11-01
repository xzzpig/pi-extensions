import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  MouseRegion,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  ensureTranscriptTheme,
  safeTerminalText,
  type NativeToolRenderOptions,
  type ToolComponentLookup,
  type TranscriptEntry,
  type TranscriptNoticeTone,
  type TranscriptTheme,
  type TranscriptToolResultPayload,
  type TranscriptTui,
} from "./transcript.js";

/**
 * Options for the opt-in stateful presenter.
 *
 * The presenter owns user/assistant components; tool components stay owned by
 * the caller's `TranscriptToolComponents` registry so live tool updates keep
 * their existing renderer state. When no registry is supplied, tool calls are
 * rendered through stateless ad-hoc components, exactly like
 * `renderTranscriptLines`.
 */
export interface TranscriptPresenterOptions extends NativeToolRenderOptions {
  theme: TranscriptTheme;
  emptyText?: string;
  assistantLabel?: string;
  /**
   * Collapsed-label text used while thinking is hidden. Defaults to Pi's
   * native `Thinking...` label so collapse patches can replace it with their
   * own expand affordance instead of treating it as a custom label.
   */
  thinkingLabel?: string;
  assistantBadgeBackground?: string;
  assistantBadgeForeground?: string;
  /**
   * Start with the presenter's local thinking preference hidden. When omitted
   * (or false) the presenter starts in `auto`: host patches such as
   * `pi-thinking-collapse` keep deciding per-message visibility until the host
   * calls `setThinkingVisible`/`toggleThinkingVisibility`.
   */
  hideThinkingBlock?: boolean;
  /** Persistent native tool components keyed by tool call id. */
  toolComponents?: ToolComponentLookup;
}

/**
 * A rendered, mouse-addressable component range in the full transcript.
 * `top` is the zero-based line offset including any scroll offset the host has
 * not applied; callers translate visible viewport rows into this space.
 */
export type TranscriptPresenterRow =
  | {
      kind: "user";
      entryId: number;
      top: number;
      height: number;
    }
  | {
      kind: "assistant";
      /** Stable id of the assistant message segment (its first entry id). */
      segmentId: number;
      entryIds: readonly number[];
      top: number;
      height: number;
    }
  | {
      kind: "tool";
      entryId: number;
      toolCallId: string;
      top: number;
      height: number;
    };

/** One rendered frame plus the layout needed to route mouse events. */
export interface TranscriptPresenterFrame {
  lines: string[];
  rows: readonly TranscriptPresenterRow[];
  totalLines: number;
  width: number;
  /**
   * Display revision the lines were rendered at. A component that requests a
   * repaint during rendering can raise the presenter's current revision above
   * this value; callers then re-render instead of reusing the lines.
   */
  revision: number;
}

type PresenterAssistantBlock = {
  kind: "assistant";
  segmentId: number;
  entryIds: number[];
  thinking: string;
  text: string;
  streaming: boolean;
};

type PresenterToolBlock = {
  kind: "tool";
  entryId: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: TranscriptToolResultPayload | null;
  isError: boolean;
  streaming: boolean;
};

type PresenterBlock =
  | { kind: "separator" }
  | { kind: "user"; entryId: number; text: string }
  | PresenterAssistantBlock
  | PresenterToolBlock
  | {
      kind: "notice";
      entryId: number;
      text: string;
      tone: TranscriptNoticeTone;
    };

type PresentationAssistantMessage = NonNullable<
  ConstructorParameters<typeof AssistantMessageComponent>[0]
>;

type NativeToolTui = NonNullable<
  ConstructorParameters<typeof ToolExecutionComponent>[5]
>;

/**
 * Local thinking preference. `auto` preserves host patch behavior (streaming
 * visible, completed collapsed under `pi-thinking-collapse`) until the host
 * asks for an explicit unified state.
 */
type ThinkingPreference = "auto" | "visible" | "hidden";

const DETACHED_TUI: TranscriptTui = { requestRender() {} };

const ESC_SEQUENCE = String.fromCharCode(27);
const BEL_SEQUENCE = String.fromCharCode(7);
const OSC_133_SEQUENCE = new RegExp(
  `${ESC_SEQUENCE}]133;[ABC]${BEL_SEQUENCE}`,
  "g",
);

/** Embedded overlays must not leak Pi's shell-integration zone markers. */
function stripOsc133(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(OSC_133_SEQUENCE, ""));
}

/**
 * A click on the native thinking-block affordance. Pi's thinking `MouseRegion`
 * only inspects type/button; coordinates are irrelevant. The presenter uses
 * this through the public `MouseRegion.handleMouse` path so a unified toggle
 * sets the same per-block override a real click would set.
 */
const THINKING_CLICK_EVENT: TuiMouseEvent = {
  type: "click",
  button: "left",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 1,
  height: 1,
  shift: false,
  alt: false,
  ctrl: false,
  clickCount: 1,
};

/**
 * Collects the public mouse regions Pi's assistant renderer wraps around
 * thinking blocks. Only public `Container.children` is walked (the assistant
 * component's content container and its direct children), so deeper nested
 * regions such as future link affordances are not clicked. The private content
 * container field and region callbacks are never read. `MouseRegion` is a
 * pi-tui peer export, so the host and this package share the same class.
 */
function collectThinkingMouseRegions(component: Container): MouseRegion[] {
  const regions: MouseRegion[] = [];
  for (const child of component.children) {
    if (child instanceof MouseRegion) {
      regions.push(child);
      continue;
    }
    if (!(child instanceof Container)) continue;
    for (const nested of child.children) {
      if (nested instanceof MouseRegion) regions.push(nested);
    }
  }
  return regions;
}

/**
 * Mirrors the segmentation used by `renderTranscriptLines`: a turn is not a
 * message, and a tool call or a repeated content kind starts a new assistant
 * segment. Each segment carries the entry ids that produced it so the
 * presenter can keep one native component per message across updates.
 */
function buildPresenterBlocks(
  entries: readonly TranscriptEntry[],
): PresenterBlock[] {
  const blocks: PresenterBlock[] = [];
  let pendingAssistant: PresenterAssistantBlock | undefined;

  const latestResults = new Map<
    string,
    Extract<TranscriptEntry, { type: "tool-result" }>
  >();
  const finishedTurns = new Set<number>();
  for (const entry of entries) {
    if (entry.type === "tool-result")
      latestResults.set(entry.toolCallId, entry);
    if (entry.type === "turn-boundary" && entry.phase === "end")
      finishedTurns.add(entry.turnId);
  }

  const flushAssistant = (): void => {
    if (!pendingAssistant) return;
    blocks.push(pendingAssistant);
    pendingAssistant = undefined;
  };

  const appendAssistantText = (
    entry: Extract<TranscriptEntry, { type: "thinking" | "assistant-text" }>,
  ): void => {
    const text = safeTerminalText(entry.text);
    if (!text) return;

    const field = entry.type === "thinking" ? "thinking" : "text";
    if (pendingAssistant?.[field]) flushAssistant();
    if (!pendingAssistant) {
      pendingAssistant = {
        kind: "assistant",
        segmentId: entry.id,
        entryIds: [],
        thinking: "",
        text: "",
        streaming: false,
      };
    }
    pendingAssistant[field] = text;
    pendingAssistant.entryIds.push(entry.id);
    pendingAssistant.streaming =
      pendingAssistant.streaming ||
      (entry.streaming && !finishedTurns.has(entry.turnId));
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "turn-boundary":
        flushAssistant();
        if (entry.phase === "start" && blocks.length > 0)
          blocks.push({ kind: "separator" });
        break;
      case "user-message":
        flushAssistant();
        blocks.push({
          kind: "user",
          entryId: entry.id,
          text: safeTerminalText(entry.text),
        });
        break;
      case "thinking":
      case "assistant-text":
        appendAssistantText(entry);
        break;
      case "tool-call": {
        flushAssistant();
        const result = latestResults.get(entry.toolCallId);
        blocks.push({
          kind: "tool",
          entryId: entry.id,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          args: entry.args,
          result: result?.result ?? null,
          isError: result?.isError ?? false,
          streaming:
            (result?.streaming ?? false) && !finishedTurns.has(entry.turnId),
        });
        break;
      }
      case "tool-result":
        break;
      case "notice":
        flushAssistant();
        blocks.push({
          kind: "notice",
          entryId: entry.id,
          text: safeTerminalText(entry.text),
          tone: entry.tone,
        });
        break;
      default:
        break;
    }
  }
  flushAssistant();
  return blocks;
}

function blockIdentity(block: PresenterBlock): string {
  switch (block.kind) {
    case "separator":
      return "separator";
    case "user":
      return `user:${block.entryId}`;
    case "assistant":
      return `assistant:${block.segmentId}`;
    case "tool":
      return `tool:${block.toolCallId}:${block.toolName}`;
    case "notice":
      return `notice:${block.entryId}:${block.tone}:${block.text}`;
  }
}

function createAssistantMessage(
  thinking: string,
  text: string,
): PresentationAssistantMessage {
  const content = [
    ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
  // Pi's renderer reads only role/content. A transcript segment can combine
  // streamed updates that have no single provider response.
  return { role: "assistant", content } as PresentationAssistantMessage;
}

function noticeToneColor(tone: TranscriptNoticeTone): string {
  switch (tone) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    default:
      return "dim";
  }
}

function toComponentResult(
  value: unknown,
  isError: boolean,
): {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  details?: unknown;
  isError: boolean;
} {
  const payload =
    value && typeof value === "object"
      ? (value as TranscriptToolResultPayload)
      : {};
  const content = Array.isArray(payload.content)
    ? payload.content.map((part) => ({
        type: part?.type ?? "text",
        text: part?.text,
        data: part?.data,
        mimeType: part?.mimeType,
      }))
    : [];
  return { content, details: payload.details, isError };
}

/**
 * Stateless fallback for tool blocks rendered without a live registry. The
 * component is rebuilt per frame, so callers that need persistent tool
 * expansion state should pass `toolComponents`.
 */
function createAdHocToolComponent(
  block: PresenterToolBlock,
  options: NativeToolRenderOptions,
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    block.toolName,
    block.toolCallId,
    block.args ?? {},
    {
      showImages: options.showImages,
      imageWidthCells: options.imageWidthCells,
    },
    options.resolveToolDefinition?.(block.toolName),
    DETACHED_TUI as NativeToolTui,
    options.cwd ?? process.cwd(),
  );
  component.setArgsComplete();
  component.markExecutionStarted();
  if (block.result) {
    component.updateResult(
      toComponentResult(block.result, block.isError),
      block.streaming,
    );
  }
  return component;
}

/**
 * Opt-in stateful transcript presenter.
 *
 * It consumes the same `TranscriptEntry` values as `renderTranscriptLines`,
 * but keeps one native `UserMessageComponent` per user entry and one native
 * `AssistantMessageComponent` per assistant message segment. Assistant
 * components are constructed empty and receive content through
 * `updateContent(message, streaming)`, so a host-side thinking-collapse patch
 * observes the real streaming state instead of an already-finished message.
 *
 * The presenter owns its display revision: entry changes, thinking toggles,
 * theme invalidation, width changes, and component-initiated repaint requests
 * all raise it. `render` reuses its line cache only while that revision and
 * the width are unchanged; content is never re-assigned on a pure repaint or
 * resize.
 *
 * Mouse handling is normalized: pass a `TuiMouseEvent` whose `y` is a row in
 * the full transcript (visible row + scroll offset). The presenter maps it to
 * the owning component and forwards it through the component's public
 * `handleMouse`, so Pi's native thinking-block and tool-expansion click paths
 * keep working without private fields.
 */
export class TranscriptPresenter {
  private readonly options: TranscriptPresenterOptions;
  private readonly assistantComponents = new Map<
    number,
    AssistantMessageComponent
  >();
  private readonly assistantContent = new Map<
    number,
    { thinking: string; text: string; streaming: boolean }
  >();
  private readonly userComponents = new Map<number, UserMessageComponent>();
  private readonly userText = new Map<number, string>();
  private readonly toolState = new Map<
    string,
    {
      args: unknown;
      result: TranscriptToolResultPayload | null;
      isError: boolean;
      streaming: boolean;
    }
  >();
  private blocks: PresenterBlock[] = [];
  private blockIdentities: string[] = [];
  private rows: TranscriptPresenterRow[] = [];
  private renderedToolComponents = new Map<string, Component>();
  private cachedFrame: TranscriptPresenterFrame | null = null;
  private renderedWidth = 0;
  private renderedRevision = -1;
  private revisionValue = 0;
  private thinkingPreference: ThinkingPreference;
  private readonly expandedSegments = new Set<number>();
  private attachedTui: TranscriptTui | null;
  private disposed = false;

  constructor(options: TranscriptPresenterOptions) {
    ensureTranscriptTheme();
    this.options = options;
    this.thinkingPreference =
      options.hideThinkingBlock === true ? "hidden" : "auto";
    this.attachedTui = options.tui ?? null;
  }

  /** Latest display revision. */
  get revision(): number {
    return this.revisionValue;
  }

  /** Retained presenter-owned message components (user + assistant). */
  get componentCount(): number {
    return this.assistantComponents.size + this.userComponents.size;
  }

  /**
   * The presenter's local thinking preference. This is not the host patch's
   * effective per-message state: in `auto` a collapse patch may still hide a
   * completed message while the preference remains "visible".
   */
  get thinkingVisible(): boolean {
    return this.thinkingPreference !== "hidden";
  }

  /** Wires the host TUI that receives repaint requests. */
  attachTui(tui: TranscriptTui): void {
    this.attachedTui = tui;
  }

  /** Stops forwarding repaint requests without discarding retained state. */
  detachTui(): void {
    this.attachedTui = null;
  }

  /**
   * Marks the display dirty and asks the attached TUI to repaint. Hosts wire
   * tool components' repaint requests here so renderer-driven invalidations
   * bypass the presenter's line cache.
   */
  requestRender(): void {
    if (this.disposed) return;
    this.revisionValue++;
    this.attachedTui?.requestRender();
  }

  /**
   * Synchronizes the presenter with the current entries. Components are
   * created or updated only when their segment/content actually changed; a
   * repeated sync of unchanged entries leaves the display revision alone.
   */
  sync(entries: readonly TranscriptEntry[]): number {
    if (this.disposed) return this.revisionValue;

    const blocks = buildPresenterBlocks(entries);
    const identities = blocks.map(blockIdentity);
    let changed =
      identities.length !== this.blockIdentities.length ||
      identities.some(
        (identity, index) => identity !== this.blockIdentities[index],
      );

    const seenAssistant = new Set<number>();
    const seenUser = new Set<number>();
    const seenTools = new Set<string>();

    for (const block of blocks) {
      if (block.kind === "assistant") {
        seenAssistant.add(block.segmentId);
        const component = this.ensureAssistantComponent(block.segmentId);
        const previous = this.assistantContent.get(block.segmentId);
        if (
          !previous ||
          previous.thinking !== block.thinking ||
          previous.text !== block.text ||
          previous.streaming !== block.streaming
        ) {
          component.updateContent(
            createAssistantMessage(block.thinking, block.text),
            block.streaming,
          );
          this.assistantContent.set(block.segmentId, {
            thinking: block.thinking,
            text: block.text,
            streaming: block.streaming,
          });
          changed = true;
        }
        if (this.thinkingPreference === "visible") {
          if (!block.thinking) {
            this.expandedSegments.delete(block.segmentId);
          } else if (!this.expandedSegments.has(block.segmentId)) {
            this.expandThinking(component);
            this.expandedSegments.add(block.segmentId);
            changed = true;
          }
        }
        continue;
      }

      if (block.kind === "user") {
        seenUser.add(block.entryId);
        const previousText = this.userText.get(block.entryId);
        if (previousText === undefined || previousText !== block.text) {
          this.userComponents.set(
            block.entryId,
            new UserMessageComponent(block.text, getMarkdownTheme(), 1),
          );
          this.userText.set(block.entryId, block.text);
          changed = true;
        }
        continue;
      }

      if (block.kind === "tool") {
        seenTools.add(block.toolCallId);
        const previous = this.toolState.get(block.toolCallId);
        if (
          !previous ||
          previous.args !== block.args ||
          previous.result !== block.result ||
          previous.isError !== block.isError ||
          previous.streaming !== block.streaming
        ) {
          this.toolState.set(block.toolCallId, {
            args: block.args,
            result: block.result,
            isError: block.isError,
            streaming: block.streaming,
          });
          changed = true;
        }
      }
    }

    for (const segmentId of this.assistantComponents.keys()) {
      if (seenAssistant.has(segmentId)) continue;
      this.assistantComponents.delete(segmentId);
      this.assistantContent.delete(segmentId);
      this.expandedSegments.delete(segmentId);
    }
    for (const entryId of this.userComponents.keys()) {
      if (seenUser.has(entryId)) continue;
      this.userComponents.delete(entryId);
      this.userText.delete(entryId);
    }
    for (const toolCallId of this.toolState.keys()) {
      if (!seenTools.has(toolCallId)) this.toolState.delete(toolCallId);
    }

    this.blocks = blocks;
    this.blockIdentities = identities;
    if (changed) {
      // The previous row ranges may reference removed/replaced components;
      // refuse hits until the next render rebuilds the layout.
      this.rows = [];
      this.renderedToolComponents.clear();
      this.requestRender();
    }
    return this.revisionValue;
  }

  /**
   * Renders the synced entries at `width`. When nothing changed since the last
   * frame, the cached frame is returned unchanged.
   */
  render(width: number): TranscriptPresenterFrame {
    const targetWidth = Math.max(1, width);
    if (this.disposed) {
      return {
        lines: [],
        rows: [],
        totalLines: 0,
        width: targetWidth,
        revision: this.revisionValue,
      };
    }

    if (targetWidth !== this.renderedWidth) {
      this.renderedWidth = targetWidth;
      this.revisionValue++;
      this.cachedFrame = null;
    }

    const startRevision = this.revisionValue;
    if (
      this.cachedFrame &&
      this.cachedFrame.width === targetWidth &&
      this.renderedRevision === startRevision
    ) {
      return this.cachedFrame;
    }

    const rendered = this.renderBlocks(targetWidth);
    this.rows = rendered.rows;
    this.renderedToolComponents = rendered.toolComponents;
    this.renderedRevision = startRevision;
    const frame: TranscriptPresenterFrame = {
      lines: rendered.lines,
      rows: rendered.rows,
      totalLines: rendered.lines.length,
      width: targetWidth,
      revision: startRevision,
    };
    this.cachedFrame = frame;
    return frame;
  }

  /**
   * Routes a normalized mouse event (transcript-space `y`) to the component
   * whose row contains it. Returns whether the component handled the event.
   */
  handleMouse(event: TuiMouseEvent): boolean {
    if (this.disposed) return false;
    const row = this.rows.find(
      (candidate) =>
        event.y >= candidate.top && event.y < candidate.top + candidate.height,
    );
    if (!row) return false;

    const component = this.componentForRow(row);
    if (!component?.handleMouse) return false;

    const localEvent: TuiMouseEvent = {
      ...event,
      y: event.y - row.top,
      width: this.renderedWidth,
      height: row.height,
    };
    const result = component.handleMouse(localEvent);
    if (!result) return false;
    const handled = result.handled === true || "target" in result;
    if (handled) this.requestRender();
    return handled;
  }

  /**
   * Applies the presenter's local thinking preference to every retained
   * assistant component.
   *
   * Hiding uses the public `setHideThinkingBlock(true)`, which also clears
   * native per-block overrides. Showing first forces the known collapsed state
   * through the same public setter, then dispatches the native thinking-block
   * click through `MouseRegion.handleMouse`. That sets the same per-block
   * override a user click sets, so completed messages expand even while a
   * host collapse patch keeps auto-collapsing them. No private component field
   * is read and the streaming flag is never faked.
   */
  setThinkingVisible(visible: boolean): void {
    if (this.disposed) return;
    this.thinkingPreference = visible ? "visible" : "hidden";
    if (visible) {
      for (const [segmentId, component] of this.assistantComponents) {
        this.expandThinking(component);
        if (this.assistantContent.get(segmentId)?.thinking) {
          this.expandedSegments.add(segmentId);
        } else {
          this.expandedSegments.delete(segmentId);
        }
      }
    } else {
      this.expandedSegments.clear();
      for (const component of this.assistantComponents.values()) {
        component.setHideThinkingBlock(true);
      }
    }
    this.requestRender();
  }

  /** Flips the local thinking preference and returns the new visibility. */
  toggleThinkingVisibility(): boolean {
    const nextVisible = !this.thinkingVisible;
    this.setThinkingVisible(nextVisible);
    return nextVisible;
  }

  /**
   * Invalidates native components for a theme change and raises the display
   * revision. The host's global theme is never re-initialized here.
   */
  invalidate(): void {
    if (this.disposed) return;
    const invalidated = new Set<Component>();
    const invalidate = (component: Component): void => {
      if (invalidated.has(component)) return;
      invalidated.add(component);
      component.invalidate();
    };
    for (const component of this.assistantComponents.values())
      invalidate(component);
    for (const component of this.userComponents.values()) invalidate(component);
    for (const component of this.renderedToolComponents.values())
      invalidate(component);
    this.requestRender();
  }

  /** Drops retained message components and rendered layout. */
  clear(): void {
    if (this.disposed) return;
    this.dropRetainedState();
    this.requestRender();
  }

  /**
   * Releases every retained component and detaches the TUI. Idempotent; later
   * calls to `sync`, `render`, and `handleMouse` degrade to no-ops.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropRetainedState();
    this.attachedTui = null;
    this.cachedFrame = null;
    this.renderedRevision = -1;
    this.revisionValue++;
  }

  private dropRetainedState(): void {
    this.assistantComponents.clear();
    this.assistantContent.clear();
    this.expandedSegments.clear();
    this.userComponents.clear();
    this.userText.clear();
    this.toolState.clear();
    this.renderedToolComponents.clear();
    this.blocks = [];
    this.blockIdentities = [];
    this.rows = [];
    this.cachedFrame = null;
    this.renderedRevision = -1;
  }

  private ensureAssistantComponent(
    segmentId: number,
  ): AssistantMessageComponent {
    const existing = this.assistantComponents.get(segmentId);
    if (existing) return existing;
    const component = new AssistantMessageComponent(
      undefined,
      this.thinkingPreference === "hidden",
      getMarkdownTheme(),
      this.options.thinkingLabel ?? "Thinking...",
      1,
    );
    this.assistantComponents.set(segmentId, component);
    return component;
  }

  /**
   * Expands every thinking block in `component` through the native public
   * click path. When the host has no thinking `MouseRegion` (an older Pi), it
   * degrades to the public visibility setter.
   */
  private expandThinking(component: AssistantMessageComponent): void {
    if (collectThinkingMouseRegions(component).length === 0) {
      component.setHideThinkingBlock(false);
      return;
    }

    // Force a known collapsed render first so each region's click handler
    // records "expand" as its override. Clicking while already expanded would
    // collapse the block instead.
    component.setHideThinkingBlock(true);
    const count = collectThinkingMouseRegions(component).length;
    for (let index = 0; index < count; index++) {
      // The click rebuilds the component's content, so re-collect the current
      // region for this run instead of holding a detached instance.
      collectThinkingMouseRegions(component)[index]?.handleMouse(
        THINKING_CLICK_EVENT,
      );
    }
  }

  private componentForRow(row: TranscriptPresenterRow): Component | undefined {
    switch (row.kind) {
      case "user":
        return this.userComponents.get(row.entryId);
      case "assistant":
        return this.assistantComponents.get(row.segmentId);
      case "tool":
        return this.renderedToolComponents.get(row.toolCallId);
    }
  }

  private renderBlocks(width: number): {
    lines: string[];
    rows: TranscriptPresenterRow[];
    toolComponents: Map<string, Component>;
  } {
    const theme = this.options.theme;
    const lines: string[] = [];
    const rows: TranscriptPresenterRow[] = [];
    const toolComponents = new Map<string, Component>();

    if (this.blocks.length === 0) {
      return {
        lines: [
          theme.fg("dim", this.options.emptyText ?? "No transcript yet."),
        ],
        rows,
        toolComponents,
      };
    }

    const assistantBadge = theme.bg(
      this.options.assistantBadgeBackground ?? "customMessageBg",
      theme.fg(
        this.options.assistantBadgeForeground ?? "success",
        theme.bold(` ${this.options.assistantLabel ?? "Assistant"} `),
      ),
    );
    const separator = theme.fg(
      "borderMuted",
      "────────────────────────────────────────",
    );
    const blankBefore = (): void => {
      if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    };

    for (const block of this.blocks) {
      switch (block.kind) {
        case "separator":
          blankBefore();
          lines.push(separator);
          break;
        case "user": {
          const component = this.userComponents.get(block.entryId);
          if (!component) break;
          const rendered = stripOsc133(component.render(width));
          rows.push({
            kind: "user",
            entryId: block.entryId,
            top: lines.length,
            height: rendered.length,
          });
          lines.push(...rendered);
          break;
        }
        case "assistant": {
          const component = this.assistantComponents.get(block.segmentId);
          if (!component) break;
          blankBefore();
          lines.push(assistantBadge);
          const rendered = stripOsc133(component.render(width));
          rows.push({
            kind: "assistant",
            segmentId: block.segmentId,
            entryIds: block.entryIds,
            top: lines.length,
            height: rendered.length,
          });
          lines.push(...rendered);
          break;
        }
        case "tool": {
          blankBefore();
          const component =
            this.options.toolComponents?.get(block.toolCallId) ??
            createAdHocToolComponent(block, this.options);
          toolComponents.set(block.toolCallId, component);
          const rendered = component.render(width);
          rows.push({
            kind: "tool",
            entryId: block.entryId,
            toolCallId: block.toolCallId,
            top: lines.length,
            height: rendered.length,
          });
          lines.push(...rendered);
          break;
        }
        case "notice": {
          blankBefore();
          const color = noticeToneColor(block.tone);
          for (const noticeLine of block.text.split("\n")) {
            const colored = theme.fg(color, noticeLine);
            lines.push(
              visibleWidth(colored) > width
                ? truncateToWidth(colored, width, "")
                : colored,
            );
          }
          break;
        }
      }
    }

    return { lines, rows, toolComponents };
  }
}
