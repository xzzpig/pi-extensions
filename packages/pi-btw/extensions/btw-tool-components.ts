import {
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  MouseRegion,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  TranscriptToolComponents,
  type NativeToolRenderOptions,
  type TranscriptToolResultPayload,
  type TranscriptTui,
} from "@xzzpig/pi-components/transcript";
import { isBtwProviderToolName } from "./btw-transcript-display";

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
 * One stable presenter-facing tool component. The presenter keeps this slot
 * across provider revisions; `rebuild` swaps the native ToolExecutionComponent
 * underneath without losing the slot's expansion choice.
 *
 * Expansion is tracked from the public mouse path: for the supported built-in
 * tools with the default shell, a handled left click is Pi's native
 * expand/collapse action. Self-rendered provider shells own their internal
 * state and are not assumed to use the native expansion flag.
 */
class BtwToolComponentSlot implements Component {
  readonly toolName: string;
  readonly toolCallId: string;
  args: unknown = {};
  definition: ToolDefinition | undefined;
  result: unknown;
  hasResult = false;
  isError = false;
  streaming = false;
  private started = false;
  expanded: boolean;
  private component: ToolExecutionComponent;
  private readonly create: (
    slot: BtwToolComponentSlot,
  ) => ToolExecutionComponent;

  constructor(
    toolName: string,
    toolCallId: string,
    definition: ToolDefinition | undefined,
    expanded: boolean,
    create: (slot: BtwToolComponentSlot) => ToolExecutionComponent,
  ) {
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    this.definition = definition;
    this.expanded = expanded;
    this.create = create;
    this.component = create(this);
  }

  render(width: number): string[] {
    return this.component.render(width);
  }

  invalidate(): void {
    this.component.invalidate();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const result = this.component.handleMouse(event);
    if (
      result?.handled === true &&
      "target" in result &&
      result.target.component instanceof MouseRegion &&
      event.type === "click" &&
      event.button === "left" &&
      this.tracksExpansion()
    ) {
      this.expanded = !this.expanded;
    }
    return result;
  }

  updateArgs(args: unknown): void {
    this.args = args;
    this.component.updateArgs(args);
  }

  setArgsComplete(): void {
    this.component.setArgsComplete();
  }

  markExecutionStarted(): void {
    this.started = true;
    this.component.markExecutionStarted();
  }

  updateResult(result: unknown, isError: boolean, streaming: boolean): void {
    this.result = result;
    this.hasResult = true;
    this.isError = isError;
    this.streaming = streaming;
    this.component.updateResult(toComponentResult(result, isError), streaming);
  }

  /**
   * Stop a transient provider component (for example the real bash spinner)
   * before its ToolExecutionComponent is replaced or dropped. The renderer's
   * timer closure would otherwise keep the old component's invalidate callback
   * alive and leave the replacement frozen.
   */
  stopTransientState(): void {
    if (!this.started) return;
    this.component.updateResult(
      toComponentResult(this.result, this.isError),
      false,
    );
  }

  rebuild(definition: ToolDefinition | undefined): void {
    this.stopTransientState();
    this.definition = definition;
    this.component = this.create(this);
    this.component.setExpanded(this.expanded);
  }

  private tracksExpansion(): boolean {
    return (
      isBtwProviderToolName(this.toolName) &&
      this.definition?.renderShell !== "self"
    );
  }
}

/**
 * BTW's fork-only tool registry. It mirrors TranscriptToolComponents' event
 * surface but keeps slots stable across provider changes so the presenter's
 * rendered-tool map does not need private host APIs. Provider identity or
 * revision changes rebuild only the seven supported built-ins; custom child
 * tools keep their own renderer instances.
 */
export class BtwToolComponents extends TranscriptToolComponents {
  private readonly slots = new Map<string, BtwToolComponentSlot>();
  private readonly toolOptions: Omit<NativeToolRenderOptions, "tui">;
  private readonly toolForwardedTui: TranscriptTui;
  private toolTui: TranscriptTui | null;
  private requestRenderCallback: (() => void) | undefined;

  constructor(options: NativeToolRenderOptions = {}) {
    // Strip the TUI before handing options to the base registry or retaining
    // them: detachTui must be able to release every host-TUI reference.
    const { tui, ...sanitized } = options;
    super(sanitized);
    this.toolOptions = sanitized;
    this.toolTui = tui ?? null;
    this.toolForwardedTui = {
      requestRender: () => this.requestToolRender(),
    };
    if (tui) super.attachTui(tui);
  }

  override attachTui(tui: TranscriptTui): void {
    this.toolTui = tui;
    super.attachTui(tui);
  }

  /** Drops the host TUI reference while preserving slot/expansion state. */
  detachTui(): void {
    this.toolTui = null;
    super.attachTui({ requestRender: () => {} });
  }

  /**
   * Routes component-initiated repaints through the presenter (via the
   * display), so they raise the display revision and invalidate line caches.
   */
  setRequestRender(callback: (() => void) | undefined): void {
    this.requestRenderCallback = callback;
  }

  override get size(): number {
    return this.slots.size;
  }

  override has(toolCallId: string): boolean {
    return this.slots.has(toolCallId);
  }

  override get(toolCallId: string): ToolExecutionComponent | undefined {
    // SAFETY: the presenter only uses the Component surface (render,
    // invalidate, handleMouse). The slot deliberately is not a
    // ToolExecutionComponent because it must survive a component rebuild.
    return this.slots.get(toolCallId) as unknown as
      | ToolExecutionComponent
      | undefined;
  }

  override handleStart(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): void {
    const slot = this.ensureSlot(toolCallId, toolName);
    slot.updateArgs(args);
    slot.setArgsComplete();
    slot.markExecutionStarted();
    this.requestToolRender();
  }

  override handleUpdate(
    toolCallId: string,
    toolName: string,
    partialResult: unknown,
  ): void {
    const slot = this.ensureSlot(toolCallId, toolName);
    slot.updateResult(partialResult, false, true);
    this.requestToolRender();
  }

  override handleEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    const slot = this.ensureSlot(toolCallId, toolName);
    slot.updateResult(result, isError, false);
    this.requestToolRender();
  }

  override retainOnly(aliveToolCallIds: ReadonlySet<string>): void {
    for (const [toolCallId, slot] of this.slots) {
      if (!aliveToolCallIds.has(toolCallId)) {
        slot.stopTransientState();
        this.slots.delete(toolCallId);
      }
    }
  }

  override clear(): void {
    for (const slot of this.slots.values()) slot.stopTransientState();
    this.slots.clear();
  }

  /** Re-resolves and rebuilds supported built-in tool components. */
  rebuild(): void {
    for (const slot of this.slots.values()) {
      if (!isBtwProviderToolName(slot.toolName)) continue;
      slot.rebuild(this.toolOptions.resolveToolDefinition?.(slot.toolName));
    }
  }

  dispose(): void {
    this.clear();
    this.detachTui();
    this.requestRenderCallback = undefined;
  }

  private ensureSlot(
    toolCallId: string,
    toolName: string,
  ): BtwToolComponentSlot {
    const existing = this.slots.get(toolCallId);
    if (existing) return existing;
    const slot = new BtwToolComponentSlot(
      toolName,
      toolCallId,
      this.toolOptions.resolveToolDefinition?.(toolName),
      this.toolOptions.expanded === true,
      (next) => this.createComponent(next),
    );
    this.slots.set(toolCallId, slot);
    return slot;
  }

  private createComponent(slot: BtwToolComponentSlot): ToolExecutionComponent {
    const component = new ToolExecutionComponent(
      slot.toolName,
      slot.toolCallId,
      slot.args ?? {},
      {
        showImages: this.toolOptions.showImages,
        imageWidthCells: this.toolOptions.imageWidthCells,
      },
      slot.definition,
      // SAFETY: ToolExecutionComponent only calls requestRender on this object;
      // the forwardedTui shape is the documented display-only TUI subset.
      this.toolForwardedTui as unknown as TUI,
      this.toolOptions.cwd ?? process.cwd(),
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    if (slot.hasResult) {
      component.updateResult(
        toComponentResult(slot.result, slot.isError),
        slot.streaming,
      );
    }
    if (slot.expanded) component.setExpanded(true);
    return component;
  }

  private requestToolRender(): void {
    if (this.requestRenderCallback) {
      this.requestRenderCallback();
      return;
    }
    this.toolTui?.requestRender();
  }
}
