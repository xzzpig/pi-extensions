/**
 * Per-message thinking-collapse state machine.
 *
 * Pi's thinking display lives inside `AssistantMessageComponent`: its
 * `updateContent(message, isStreaming)` renders `{type:"thinking"}` content
 * blocks either as italic Markdown (visible) or as a single static label
 * (hidden), driven by the *global* `hideThinkingBlock` flag that `ctrl+t`
 * and the settings UI flip. There is no per-message state in pi.
 *
 * This module patches the two prototype methods that decide that flag:
 *
 * - `updateContent` — computes an *effective* hide flag per message:
 *   1. the global flag (from `ctrl+t` / settings, or the constructor) wins;
 *   2. while streaming (`isStreaming === true`) thinking stays visible;
 *   3. otherwise the message collapses by default, unless a click pinned it
 *      expanded.
 *   The patched wrapper writes the effective flag into the component's own
 *   `hideThinkingBlock` field (the original code reads that field), swaps in
 *   a click-affordance label while collapsed, then calls through. After the
 *   original runs it records which `contentContainer` children are thinking
 *   blocks, so the click handler can hit-test thinking rows without reading
 *   rendered colors.
 * - `setHideThinkingBlock` — records the global flag per component so the
 *   `ctrl+t` / settings fan-out keeps working and stays authoritative; the
 *   `updateContent` wrapper never sees its own effective writes as user
 *   intent.
 *
 * Pins are keyed by the **message object**, not the component: on session
 * rebuilds pi constructs fresh components from the persisted message
 * objects, so a pinned message keeps its choice.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { installPrototypePatch, type PrototypeLike } from "./registry.ts";

export const UPDATE_CONTENT_ADAPTER = "assistant-message-update-content";
export const SET_HIDE_THINKING_ADAPTER = "assistant-message-set-hide-thinking";

/** Pi's own default collapsed label, used as the "unmodified" sentinel. */
const PI_DEFAULT_THINKING_LABEL = "Thinking...";

/** The affordance label shown instead while collapsed. */
export const COLLAPSED_AFFORDANCE_LABEL = "Thinking… (click to expand)";

/** The structural slice of `AssistantMessageComponent` this module reads. */
export interface AssistantMessageLike {
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  lastMessage?: unknown;
  isStreaming?: boolean;
  contentContainer?: { children?: unknown[] };
  invalidate(): void;
  updateContent(message: unknown, isStreaming?: boolean): void;
  setHideThinkingBlock(hide: boolean): void;
}

type ContentPart = { type?: unknown; text?: unknown; thinking?: unknown };

function isVisibleText(part: ContentPart): boolean {
  return (
    part.type === "text" &&
    typeof part.text === "string" &&
    part.text.trim().length > 0
  );
}

function isThinkingBlock(part: ContentPart): boolean {
  return part.type === "thinking" && typeof part.thinking === "string";
}

/**
 * Replicates the child-creation order of pi 0.84.x `updateContent` so the
 * recorded thinking children line up with `contentContainer.children`:
 * one leading `Spacer` when anything is visible, then per content part a
 * `Markdown` (text / expanded thinking run) or `Text` (collapsed thinking
 * run), plus a trailing `Spacer` after a thinking run when visible content
 * follows. Returns the indices of the thinking children.
 */
function thinkingChildIndices(message: unknown): number[] {
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const parts = content as ContentPart[];
  const hasVisible = parts.some(
    (part) => isVisibleText(part) || isThinkingBlock(part),
  );
  const indices: number[] = [];
  let childIndex = hasVisible ? 1 : 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (isVisibleText(part)) {
      childIndex++;
      continue;
    }
    if (!isThinkingBlock(part)) continue;
    const thinkingBlocks: string[] = [];
    for (; i < parts.length; i++) {
      const next = parts[i];
      if (!isThinkingBlock(next)) break;
      if (
        typeof next.thinking === "string" &&
        next.thinking.trim().length > 0
      ) {
        thinkingBlocks.push(next.thinking.trim());
      }
    }
    i--;
    if (thinkingBlocks.length === 0) continue;
    indices.push(childIndex);
    childIndex++;
    const hasVisibleAfter = parts
      .slice(i + 1)
      .some((next) => isVisibleText(next) || isThinkingBlock(next));
    if (hasVisibleAfter) childIndex++;
  }
  return indices;
}

/** The message a component last rendered, when it has one. */
function messageOf(component: AssistantMessageLike): object | undefined {
  const message = component.lastMessage;
  return typeof message === "object" && message !== null ? message : undefined;
}

export class CollapseController {
  /** Per-message pinned expansion. Missing = auto (collapse once done). */
  private readonly pins = new WeakMap<object, boolean>();

  /** Per-component global flag recorded from `setHideThinkingBlock`. */
  private readonly globalHidden = new WeakMap<object, boolean>();

  /** Per-component thinking children refs recorded after `updateContent`. */
  private readonly thinkingChildren = new WeakMap<object, readonly unknown[]>();

  /** Components that rendered through the patched `updateContent`. */
  private readonly patchedComponents = new WeakSet<object>();

  private installed = false;
  private cleanups: (() => void)[] = [];

  /**
   * Effective hide flag for a component rendering `message` at
   * `isStreaming`. Exposed for the click handler to read direction.
   */
  resolveCollapsed(
    component: AssistantMessageLike,
    message: unknown,
    isStreaming: boolean,
  ): boolean {
    if (this.isGloballyHidden(component)) return true;
    if (isStreaming) return false;
    if (message && typeof message === "object") {
      const pinned = this.pins.get(message as object);
      if (pinned !== undefined) return !pinned;
    }
    return true;
  }

  /** True while the user's global toggle (ctrl+t / settings) hides everything. */
  isGloballyHidden(component: AssistantMessageLike): boolean {
    const recorded = this.globalHidden.get(component);
    if (recorded !== undefined) return recorded;
    // First sight of the component: the constructor (or a previous
    // setHideThinkingBlock fan-out) already stored the global flag in the
    // field. Record it now, before this module's own effective writes start
    // overwriting the field.
    const initial = component.hideThinkingBlock === true;
    this.globalHidden.set(component, initial);
    return initial;
  }

  /**
   * Pin a message to the opposite of its current effective state and
   * re-render. Returns false when a click cannot toggle right now (global
   * hide, or the message is still streaming).
   */
  toggle(component: AssistantMessageLike): boolean {
    const message = messageOf(component);
    if (!message) return false;
    if (component.isStreaming) return false;
    if (this.isGloballyHidden(component)) return false;
    const current = this.resolveCollapsed(component, message, false);
    this.pins.set(message, current); // pin to the opposite of current
    component.invalidate();
    return true;
  }

  /** Thinking children of a component, as recorded by the last `updateContent`. */
  thinkingChildrenOf(
    component: AssistantMessageLike,
  ): readonly unknown[] | undefined {
    return this.thinkingChildren.get(component);
  }

  /** True for components that rendered through the patched `updateContent`. */
  isPatchedComponent(component: unknown): boolean {
    return (
      typeof component === "object" &&
      component !== null &&
      this.patchedComponents.has(component)
    );
  }

  /** The collapsed label to render for `component`, honoring custom labels. */
  collapsedLabelFor(component: AssistantMessageLike): string {
    return component.hiddenThinkingLabel === PI_DEFAULT_THINKING_LABEL
      ? COLLAPSED_AFFORDANCE_LABEL
      : component.hiddenThinkingLabel;
  }

  private recordThinkingChildren(
    component: AssistantMessageLike,
    message: unknown,
  ): void {
    const container = component.contentContainer;
    const children = container?.children;
    if (!Array.isArray(children)) return;
    const indices = thinkingChildIndices(message);
    const refs = indices
      .map((index) => children[index])
      .filter(
        (child): child is object => typeof child === "object" && child !== null,
      );
    this.thinkingChildren.set(component, refs);
  }

  /** Patch `AssistantMessageComponent.prototype`. Idempotent across reloads. */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    // SAFETY: AssistantMessageComponent.prototype is a plain object we patch
    // by method name; PrototypeLike is the documented shape for registry
    // targets and pi's class is not assignable to it directly.
    const prototype =
      AssistantMessageComponent.prototype as unknown as PrototypeLike;

    this.cleanups.push(
      installPrototypePatch(
        prototype,
        "updateContent",
        UPDATE_CONTENT_ADAPTER,
        ({ receiver, args, predecessor }) => {
          const component = receiver as AssistantMessageLike;
          this.patchedComponents.add(receiver as object);
          const [message, explicitStreaming] = args as [
            unknown,
            boolean | undefined,
          ];
          const isStreaming =
            explicitStreaming ?? component.isStreaming === true;
          const effective = this.resolveCollapsed(
            component,
            message,
            isStreaming,
          );
          component.hideThinkingBlock = effective;

          const savedLabel = component.hiddenThinkingLabel;
          if (effective)
            component.hiddenThinkingLabel = this.collapsedLabelFor(component);
          try {
            return predecessor.apply(receiver, args);
          } finally {
            component.hiddenThinkingLabel = savedLabel;
            this.recordThinkingChildren(component, message);
          }
        },
      ),
    );

    this.cleanups.push(
      installPrototypePatch(
        prototype,
        "setHideThinkingBlock",
        SET_HIDE_THINKING_ADAPTER,
        ({ receiver, args, predecessor }) => {
          const component = receiver as AssistantMessageLike;
          const [hide] = args as [boolean];
          this.globalHidden.set(component, hide === true);
          return predecessor.apply(receiver, args);
        },
      ),
    );
  }

  /** Restore the pristine prototype methods. */
  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.installed = false;
  }
}
