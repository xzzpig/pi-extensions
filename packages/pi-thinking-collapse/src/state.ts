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
 *   3. otherwise the message collapses by default.
 *   The patched wrapper writes the effective flag into the component's own
 *   `hideThinkingBlock` field (the original code reads that field), swaps in
 *   the affordance label while collapsed, then calls through.
 * - `setHideThinkingBlock` — records the global flag per component so the
 *   `ctrl+t` / settings fan-out keeps working and stays authoritative; the
 *   `updateContent` wrapper never sees its own effective writes as user
 *   intent.
 *
 * That second level — per-message automatic collapse — is the whole of this
 * package's job. Toggling an individual block by clicking it is Pi's own
 * feature (the renderer wraps thinking blocks in `MouseRegion` and flips a
 * per-run override on click), so this module registers no mouse handling and
 * keeps no per-message override state of its own.
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
  isStreaming?: boolean;
  updateContent(message: unknown, isStreaming?: boolean): void;
  setHideThinkingBlock(hide: boolean): void;
}

export class CollapseController {
  /** Per-component global flag recorded from `setHideThinkingBlock`. */
  private readonly globalHidden = new WeakMap<object, boolean>();

  private installed = false;
  private cleanups: (() => void)[] = [];

  /**
   * Effective hide flag for a component at `isStreaming`: the user's global
   * toggle wins, then streaming keeps thinking visible, else collapse.
   */
  resolveCollapsed(
    component: AssistantMessageLike,
    isStreaming: boolean,
  ): boolean {
    if (this.isGloballyHidden(component)) return true;
    if (isStreaming) return false;
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

  /** The collapsed label to render for `component`, honoring custom labels. */
  collapsedLabelFor(component: AssistantMessageLike): string {
    return component.hiddenThinkingLabel === PI_DEFAULT_THINKING_LABEL
      ? COLLAPSED_AFFORDANCE_LABEL
      : component.hiddenThinkingLabel;
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
          const [, explicitStreaming] = args as [unknown, boolean | undefined];
          const isStreaming =
            explicitStreaming ?? component.isStreaming === true;
          const effective = this.resolveCollapsed(component, isStreaming);
          component.hideThinkingBlock = effective;

          const savedLabel = component.hiddenThinkingLabel;
          if (effective)
            component.hiddenThinkingLabel = this.collapsedLabelFor(component);
          try {
            return predecessor.apply(receiver, args);
          } finally {
            component.hiddenThinkingLabel = savedLabel;
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
