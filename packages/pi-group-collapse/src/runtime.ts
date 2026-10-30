/**
 * Runtime assembly (change task 3.4).
 *
 * One process-wide runtime owns the whole pipeline and survives session
 * replacement; every extension factory run reuses it:
 *
 * - `session_start` loads a fresh config snapshot and rebuilds the model
 *   from the current branch under a new epoch;
 * - a recoverable wrap of `InteractiveMode.prototype.handleEvent` syncs the
 *   receiver's chat container after every host event: real components in
 *   display order become model items (tools by call id, assistant content
 *   by message, custom messages by entry identity), unknown visible
 *   children act as conservative boundaries;
 * - Pi lifecycle events feed the turn tracker; the settle callback runs
 *   the fold planner against the live model and applies it to the group
 *   state store;
 * - the notification observer turns proven extension notifications into
 *   members and invalidations into reveals;
 * - the render projection (host-adapter) reads the store per render: folded
 *   groups collapse to one summary line (width-aware), expanded groups keep
 *   a title above byte-identical member output, active turns pass through;
 * - `/group-collapse expand|collapse` provides the mouse-free path, and a
 *   non-TUI mode installs no display behavior at all.
 */

import {
  CustomMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  bindComponent,
  bindNotificationSpacer,
  clearNotificationSpacers,
  forgetNotificationSpacer,
  footerAtRow,
  headerRowAtWidth,
  installRenderProjection,
  managedRunAtRow,
  probeProjectedLines,
  refreshNotificationSpacer,
  type GroupBoundaryEdges,
  type GroupBoundaryGaps,
  type ProjectedComponent,
  type Projection,
  type ShellRole,
} from "./host-adapter.ts";
import {
  loadGroupCollapseConfig,
  type GroupCollapseSnapshot,
} from "./config.ts";
import { TurnTracker } from "./lifecycle.ts";
import {
  GroupingModel,
  summarizeSegment,
  type MemberPolicy,
  type Segment,
  type SegmentSummary,
} from "./model.ts";
import {
  GroupStateStore,
  PendingFoldCollection,
  planFolding,
} from "./fold-state.ts";
import { EpochGuard, rebuildFromBranch, type HistoryEntry } from "./history.ts";
import { compileRules } from "./rules.ts";
import {
  createNotificationObserver,
  type NotificationObserver,
} from "./notification-adapter.ts";
import {
  installPrototypePatch,
  type PatchInstallResult,
} from "./patch-registry.ts";
import { summaryLine } from "./view.ts";
import { groupFooterLine, groupHeaderLine } from "./header-style.ts";
import {
  isValidExpandTarget,
  publishExpandTarget,
  type ExpandTarget,
  type GroupTarget,
} from "./expand-target.ts";

/** The host slice the runtime reads off a live InteractiveMode receiver. */
type HostReceiver = {
  chatContainer: { children: readonly unknown[] };
};

/** The slice of session entries the history mapping consumes. */
type BranchEntry = {
  readonly type: string;
  readonly id: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly {
      readonly type?: string;
      readonly thinking?: string;
      readonly text?: string;
      readonly id?: string;
      readonly name?: string;
    }[];
    readonly stopReason?: string;
  };
  readonly customType?: string;
  readonly display?: boolean;
  readonly content?: string;
};

export type RuntimeContextInput = {
  readonly mode?: string;
  readonly cwd: string;
  readonly getBranch?: () => readonly BranchEntry[];
  /**
   * Live host-theme accessor (`() => ctx.ui.theme`). Called per render, so a
   * theme switch repaints the next frame and no old Theme object is kept.
   * Undefined outside a UI session (or on a host without `ui.theme`): the
   * group header then renders uncolored instead of failing the frame.
   */
  readonly getTheme?: () => Theme | undefined;
};

export type RuntimeNotifications = {
  /** Deduplicated user-facing notices (config issues, degradation). */
  notify: (message: string, level: "info" | "warning" | "error") => void;
};

type InstalledDisplays = {
  render: PatchInstallResult;
  handleEvent: PatchInstallResult;
  renderInitialMessages: PatchInstallResult;
  observer: PatchInstallResult;
  expandObserver: PatchInstallResult;
  customExpandObserver: PatchInstallResult;
};

const identityIds = new WeakMap<object, string>();
let nextIdentity = 1;

function identityOf(value: object): string {
  let id = identityIds.get(value);
  if (id === undefined) {
    id = `i${nextIdentity++}`;
    identityIds.set(value, id);
  }
  return id;
}

/**
 * Cross-copy handoff slot: pi re-imports this package on session
 * replacement, so the runtime that records a chat rebuild
 * (`/reload`'s before-session-start transcript swap) is a *different
 * instance* than the one whose `session_start` follows. The handoff
 * lives in a Symbol.for slot shared by every copy; the WeakRef keeps it
 * invisible to garbage collection of an abandoned host view.
 */
const GLOBAL_SLOTS = Symbol.for("pi-group-collapse.runtime-slots.v1");

function globalSlots(): { rebuildPending?: WeakRef<HostReceiver> } {
  const g = globalThis as {
    [GLOBAL_SLOTS]?: { rebuildPending?: WeakRef<HostReceiver> };
  };
  if (!g[GLOBAL_SLOTS]) {
    Object.defineProperty(g, GLOBAL_SLOTS, {
      value: { rebuildPending: undefined },
      configurable: true,
    });
  }
  return g[GLOBAL_SLOTS] as { rebuildPending?: WeakRef<HostReceiver> };
}

/** Test/probe: the receiver recorded by a between-sessions chat rebuild. */
export function debugRebuildPending(): HostReceiver | undefined {
  return globalSlots().rebuildPending?.deref();
}

/** Test/probe: simulate the chat-rebuild hook's handoff record. */
export function debugSetRebuildPending(receiver: HostReceiver): void {
  globalSlots().rebuildPending = new WeakRef(receiver);
}

export class GroupCollapseRuntime {
  private notifications: RuntimeNotifications;
  private readonly guard = new EpochGuard();
  private policy: MemberPolicy = compileRules([]);
  private model = new GroupingModel(this.policy);
  private store = new GroupStateStore();
  private pending = new PendingFoldCollection();
  private tracker = new TurnTracker({
    onSettled: (settled) => this.applyFolding(settled.turn, settled.outcome),
  });
  private displays: InstalledDisplays | undefined;
  private notificationObserver: NotificationObserver | undefined;
  /** Notification components the model accepted as members. */
  private readonly groupedNotifications = new WeakSet<object>();
  /** The live host receiver, remembered for post-rebuild rescans. */
  private activeReceiver: HostReceiver | undefined;
  private knownComponents = new WeakSet<object>();
  private componentPositions = new WeakMap<
    object,
    { receiver: WeakRef<HostReceiver>; index: number }
  >();
  /** Weak component lookup for jumping over a folded group's hidden members. */
  private componentsByKey = new Map<string, WeakRef<object> | null>();
  private positionReceiver: WeakRef<HostReceiver> | undefined;
  private displayAllowed = false;
  private sessionActive = false;
  private configIssuesNotified = false;
  /** Persisted message object → session entry id, for stable identity. */
  private readonly entryIdsByMessage = new WeakMap<object, string>();
  /** Per-assistant-component streaming state, for incremental rescans. */
  private assistantStates = new WeakMap<
    object,
    {
      message: object;
      streaming: boolean;
      blockCount: number;
      lastBlockType: string;
      signature: string;
      appliedTextBoundaries: Set<number>;
    }
  >();
  /** Receiver pending a post-rebuild rescan (rebind pass). */
  private reboundAfterRebuild: HostReceiver | undefined;
  /**
   * Receiver recorded when the host rebuilt the chat while this runtime
   * was between sessions (`/reload` rebuilds the transcript *before*
   * `session_start` fires, outside every display patch). Consumed at the
   * next session start; a WeakRef so a shutdown with no next session
   * still releases the host tree.
   */
  /**
   * Persistent chat-rebuild hook: unlike the display patches this one
   * survives shutdown, because the reload rebuild happens exactly in the
   * window where the display patches are removed. Its behavior degrades
   * to recording the receiver for the next session start.
   */
  /** Segment ids that fell back to full display at a given width. */
  private readonly widthFallbacks = new Map<number, Set<number>>();
  /** The branch getter from session_start, for post-rebuild replays. */
  private lastGetBranch: RuntimeContextInput["getBranch"];
  /** The live theme accessor from session_start (dropped on shutdown). */
  private lastGetTheme: RuntimeContextInput["getTheme"];
  /** Per-custom-component content signature, for change detection. */
  private customStates = new WeakMap<object, string>();
  /** History custom messages indexed by (customType, display, content). */
  private customHistoryBySignature = new Map<string, string[]>();
  /** History custom keys already claimed by a scanned component. */
  private consumedCustomKeys = new Set<string>();

  constructor(notifications: RuntimeNotifications) {
    this.notifications = notifications;
  }

  /** A new extension factory owns a new queue even when the runtime survives. */
  setNotifications(notifications: RuntimeNotifications): void {
    this.notifications = notifications;
  }

  // ------------------------------------------------------------------
  // Session lifecycle
  // ------------------------------------------------------------------

  onSessionStart(input: RuntimeContextInput): void {
    this.displayAllowed = input.mode === undefined || input.mode === "tui";
    this.sessionActive = true;
    const snapshot: GroupCollapseSnapshot = loadGroupCollapseConfig({
      cwd: input.cwd,
    });
    this.policy = compileRules([...snapshot.rules]);
    if (snapshot.issues.length > 0 && !this.configIssuesNotified) {
      this.configIssuesNotified = true;
      const first = snapshot.issues[0];
      this.notifications.notify(
        `group-collapse: ignored ${first.file}: ${first.reason}`,
        "warning",
      );
    }

    // Full view rebuild for a fresh session: the model replays the current
    // (compaction-aware) branch and every derived table resets.
    this.lastGetBranch = input.getBranch;
    this.lastGetTheme = input.getTheme;
    this.rebuildView(input.getBranch);

    if (this.displayAllowed && !this.displays) {
      this.installDisplays();
    }

    // A transcript rebuilt between sessions (`/reload`, `/new`) left its
    // replacement components here: bind them to the freshly rebuilt model
    // now, so the reloaded view renders its folds on the first frame.
    const pending = globalSlots().rebuildPending?.deref();
    globalSlots().rebuildPending = undefined;
    if (pending && this.displayAllowed) {
      this.syncReceiver(pending);
    }
  }

  /**
   * Full view rebuild: a new epoch replays the current branch, all derived
   * strong tables reset, and every known component binding is dropped so
   * the next receiver scan re-binds from scratch. Tree navigation and
   * compaction rebuild the transcript the same way, so they share this
   * path instead of accumulating state.
   */
  private rebuildView(
    getBranch?: RuntimeContextInput["getBranch"],
    receiver?: HostReceiver,
  ): void {
    const branch = getBranch?.() ?? [];
    const customSignatures = new Map<string, string[]>();
    const rebuilt = rebuildFromBranch(
      mapBranchEntries(branch, this.entryIdsByMessage, customSignatures),
      this.policy,
      this.guard.invalidate(),
    );
    this.adoptRebuilt(rebuilt);
    this.knownComponents = new WeakSet();
    this.componentPositions = new WeakMap();
    this.componentsByKey = new Map();
    this.positionReceiver = undefined;
    this.assistantStates = new WeakMap();
    // The per-container known count dies with the view: keeping it would
    // make the next scan see "nothing alive but N known" and re-enter this
    // rebuild forever instead of re-binding the fresh components.
    this.knownCounts = new WeakMap();
    this.customStates = new WeakMap();
    this.customHistoryBySignature = customSignatures;
    this.consumedCustomKeys = new Set();
    // Rebuilt views number their history turns from one; an idle tracker
    // re-aligns so the next live turn continues from the model's count
    // instead of diverging from it.
    this.tracker.resync(rebuilt.model.currentTurn() + 1);
    boundKeysClear();
    this.reboundAfterRebuild = receiver;
  }

  /**
   * Tree navigation / compaction: the host rebuilt the visible transcript
   * from a different branch projection. Replay it under a fresh epoch and
   * re-bind the replacement components immediately, so the rebuilt view
   * renders its folds on the host's next frame instead of one event later.
   */
  rebuildCurrentView(getBranch: RuntimeContextInput["getBranch"]): void {
    if (!this.sessionActive || !this.displayAllowed) return;
    this.rebuildView(getBranch, this.activeReceiver);
    if (this.activeReceiver !== undefined) {
      this.syncReceiver(this.activeReceiver);
    }
  }

  /** Adopt a rebuilt view: derived strong tables reset to its scale. */
  private adoptRebuilt(rebuilt: {
    model: GroupingModel;
    store: GroupStateStore;
    pending: PendingFoldCollection;
  }): void {
    this.model = rebuilt.model;
    this.store = rebuilt.store;
    this.pending = rebuilt.pending;
    this.groupHandles.clear();
    this.wasEverFolded.clear();
    this.viewIndex = undefined;
    this.widthFallbacks.clear();
    this.widthFallbackRevision = -1;
    clearNotificationSpacers();
  }

  onSessionShutdown(): void {
    this.uninstallDisplays();
    this.displayAllowed = false;
    this.sessionActive = false;
    this.configIssuesNotified = false;
    // Every semantic index dies with the session: a later rebuild starts
    // from nothing, and stale events or behavior slots cannot reach in.
    this.model = new GroupingModel(this.policy);
    this.store = new GroupStateStore();
    this.pending = new PendingFoldCollection();
    this.groupHandles.clear();
    this.wasEverFolded.clear();
    this.viewIndex = undefined;
    this.widthFallbacks.clear();
    this.widthFallbackRevision = -1;
    this.knownComponents = new WeakSet();
    this.componentPositions = new WeakMap();
    this.componentsByKey = new Map();
    this.positionReceiver = undefined;
    this.assistantStates = new WeakMap();
    this.knownCounts = new WeakMap();
    this.customStates = new WeakMap();
    this.customHistoryBySignature = new Map();
    this.consumedCustomKeys = new Set();
    // The runtime lives in a process-global slot, so any strong reference
    // it keeps to the host view pins the whole component tree. Release the
    // receiver, the branch closure, and the rebind marker with the session.
    this.activeReceiver = undefined;
    this.lastGetBranch = undefined;
    // The getter closes over the session's ctx: drop it with the session so
    // the process-global runtime cannot pin a dead host context.
    this.lastGetTheme = undefined;
    this.reboundAfterRebuild = undefined;
    globalSlots().rebuildPending = undefined;
    boundKeysClear();
    this.tracker = new TurnTracker({
      onSettled: (settled) => this.applyFolding(settled.turn, settled.outcome),
    });
  }

  // ------------------------------------------------------------------
  // Pi event mapping
  // ------------------------------------------------------------------

  handlePiEvent(event: { type: string } & Record<string, unknown>): void {
    // Epoch guard in practice: after a shutdown (or a view rebuild that
    // has not re-armed) no event may touch the model — late events from a
    // replaced view are dropped instead of mutating the new one.
    if (!this.sessionActive) return;
    switch (event.type) {
      case "agent_start": {
        // Retries and continuations restart the loop without closing the
        // turn. The tracker owns the logical turn: only when it opens a
        // new one does the model advance — otherwise the two diverge and
        // the still-active turn's earlier segments become foldable.
        const wasRunning = this.tracker.isRunning();
        this.tracker.apply({ type: "agent_start" });
        if (!wasRunning) this.model.apply({ type: "turnBegin" });
        break;
      }
      case "agent_end": {
        const messages = (event.messages ?? []) as {
          role?: string;
          stopReason?: string;
        }[];
        this.tracker.apply({
          type: "agent_end",
          assistantStopReasons: messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.stopReason),
        });
        break;
      }
      case "agent_before_settle":
        this.tracker.apply({
          type: "agent_before_settle",
          outcome: event.outcome as
            | "completed"
            | "aborted"
            | "error"
            | undefined,
        });
        break;
      case "agent_settled":
        // Close the model's turn before classifying: the fold planner and
        // the render projection must both see the turn as finished.
        this.model.apply({ type: "turnEnd" });
        this.tracker.apply({
          type: "agent_settled",
          aborted: event.aborted as boolean | undefined,
        });
        break;
      case "tool_execution_update": {
        const toolCallId = event.toolCallId as string;
        if (typeof toolCallId === "string") {
          this.model.apply({ type: "toolArgs", toolCallId });
        }
        break;
      }
      case "tool_execution_end": {
        const toolCallId = event.toolCallId as string;
        if (typeof toolCallId === "string") {
          this.model.apply({
            type: "toolResult",
            toolCallId,
            isError: event.isError === true,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------
  // Receiver sync (component binding + visual items)
  // ------------------------------------------------------------------

  /**
   * Scan the receiver's chat container after a host event. Children appear
   * in display order; each new component becomes model items and a render
   * binding. Unknown visible children are conservative boundaries.
   *
   * Streaming assistant components are **re-scanned whenever their content
   * changes**: pi creates an empty assistant component and grows it via
   * repeated `updateContent`, so a scan-once model would miss later
   * thinking runs, the final text boundary, and the message end. All
   * model applications are idempotent per key, so re-walking a message is
   * safe. Structural boundaries are the exception: a user message or
   * unknown visible child applies **once, at its first sight** — replaying
   * it on every scan would re-close the accumulating group and split
   * consecutive members that belong together. A shrinking child set (tree
   * navigation, compaction, reload) triggers a full view rebuild whose
   * replacement components re-bind **in the same pass**, followed by one
   * repaint request — the rebuilt view must not sit raw on screen until
   * an unrelated render.
   */
  syncReceiver(receiver: HostReceiver): void {
    if (!this.sessionActive) return;
    this.activeReceiver = receiver;
    const children = receiver.chatContainer.children;
    // Shrink detection: components that left the view mean the host
    // rebuilt the transcript (tree navigation, compaction, reload) —
    // replay the current branch instead of patching the old model. The
    // replacement components re-bind **in this same pass**: deferring the
    // rebind to the next scan would leave the view showing raw, unfolded
    // content until an unrelated render happens.
    let alive = 0;
    for (const child of children) {
      if (this.knownComponents.has(child as object)) alive += 1;
    }
    const knownCount = this.knownCountFor(receiver);
    const freshView = knownCount === 0 && children.length > 0;
    let rebuilt = false;
    if (knownCount > 0 && alive < knownCount) {
      this.rebuildViewFromLastBranch(receiver);
      rebuilt = true;
    }
    const receiverRef =
      this.positionReceiver?.deref() === receiver
        ? this.positionReceiver
        : new WeakRef(receiver);
    this.positionReceiver = receiverRef;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (typeof child !== "object" || child === null) continue;
      const position = this.componentPositions.get(child);
      if (
        !position ||
        position.receiver !== receiverRef ||
        position.index !== index
      ) {
        this.componentPositions.set(child, { receiver: receiverRef, index });
      }
      refreshNotificationSpacer(child, children[index + 1], receiver, index);
      // First sight vs re-scan: member classes re-classify idempotently,
      // structural boundaries apply only once, at their display position.
      const isNew = !this.knownComponents.has(child);
      this.knownComponents.add(child);
      this.classifyAndApply(child, isNew);
      const key = boundKeyOf(child);
      if (key !== undefined) {
        const existing = this.componentsByKey.get(key);
        if (existing === undefined)
          this.componentsByKey.set(key, new WeakRef(child));
        else if (existing !== null && existing.deref() !== child)
          this.componentsByKey.set(key, null);
      }
    }
    this.setKnownCountFor(receiver, children.length);
    // Repaint once when bindings changed underneath an already-rendered
    // frame: a rebuilt or rebound view otherwise keeps showing the raw
    // pre-bind content until some unrelated render happens.
    const rebindRender = this.reboundAfterRebuild === receiver;
    if (rebindRender) this.reboundAfterRebuild = undefined;
    if (rebuilt || rebindRender || (freshView && this.hasFoldedSegments())) {
      this.requestHostRender(receiver);
    }
  }

  /** Whether any segment is currently folded (repaint relevance). */
  private hasFoldedSegments(): boolean {
    for (const segment of this.model.currentSegments()) {
      if (this.store.isFolded(segment.id)) return true;
    }
    return false;
  }

  /**
   * One repaint after a rebuilt view re-bound: the host keeps its frame
   * until something asks for a render, and the binding itself does not.
   * Reads the host's own render request through the runtime-public field.
   */
  private requestHostRender(receiver: HostReceiver): void {
    const ui = (receiver as { ui?: { requestRender?: () => void } }).ui;
    if (typeof ui?.requestRender === "function") ui.requestRender();
  }

  private knownCounts = new WeakMap<object, number>();

  private knownCountFor(receiver: HostReceiver): number {
    return this.knownCounts.get(receiver.chatContainer) ?? 0;
  }

  private setKnownCountFor(receiver: HostReceiver, count: number): void {
    this.knownCounts.set(receiver.chatContainer, count);
  }

  /** Rebuild using the branch getter the session started with. */
  private rebuildViewFromLastBranch(receiver: HostReceiver): void {
    this.rebuildView(this.lastGetBranch, receiver);
  }

  private classifyAndApply(child: object, isNew: boolean): void {
    // Every bound component carries the explicit-target protocol; the
    // resolver itself decides per call whether this component currently
    // renders a group shell (carriers only, shell rows only). Installed
    // once per component — re-creating the resolver on every scan is pure
    // allocation, and the closure reads live state when it is called.
    if (isNew) {
      publishExpandTarget(child, (localRow, width) => {
        const key = boundKeyOf(child) ?? "";
        const footer = footerAtRow(child, localRow, width);
        if (footer !== undefined) {
          if (!this.isCurrentComponent(child)) return undefined;
          const memberKey =
            footer.run === undefined ? key : `${key}#t${footer.run}`;
          return this.localExpandTarget(memberKey, 0, width, "footer");
        }
        const headerRow = headerRowAtWidth(child, width);
        if (headerRow !== undefined) {
          return localRow === headerRow
            ? this.localExpandTarget(key, 0, width)
            : undefined;
        }
        // A managed thinking row of an assistant message resolves to that
        // row's own group, not to the carrier chain.
        const run = managedRunAtRow(child, localRow);
        if (run !== undefined) {
          return this.localExpandTarget(`${key}#t${run}`, 0, width);
        }
        return this.localExpandTarget(key, localRow, width);
      });
    }
    const tool = readToolIdentity(child);
    if (tool) {
      if (boundKeyOf(child) !== tool.toolCallId) {
        bindComponentWithKey(child, tool.toolCallId);
        this.model.apply({
          type: "toolCall",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
        });
      }
      return;
    }
    const shape = readAssistantShape(child);
    if (shape) {
      // Stable identity: a rebuilt view binds the persisted entry id via
      // the message object; a live-streamed message falls back to the
      // component identity. Both produce the same member keys.
      const messageKey =
        this.entryIdsByMessage.get(shape.messageRef) ?? identityOf(child);
      bindComponentWithKey(child, messageKey);
      // Incremental rescan: pi streams one assistant component through
      // repeated updateContent calls. A completed message that did not
      // change since its last walk is skipped from the cheap shape alone
      // (message ref, streaming flag, block count) — no block contents are
      // read, so unchanged history costs no thinking/text field access.
      // A streaming message is re-read: it is the current message, and
      // its blocks can flip nonEmpty without changing the count.
      const state = this.assistantStates.get(child);
      if (
        state &&
        state.message === shape.messageRef &&
        !state.streaming &&
        !shape.streaming &&
        state.blockCount === shape.blockCount &&
        state.lastBlockType === shape.lastBlockType
      ) {
        return; // completed and unchanged
      }
      const blocks = assistantBlocksOf(shape.messageRef);
      const signature =
        blocks.map((b) => b.type + (b.nonEmpty ? ":1" : ":0")).join(",") +
        (shape.streaming ? "/s" : "/e");
      if (
        state &&
        state.message === shape.messageRef &&
        state.signature === signature
      ) {
        return; // streaming frame with no visible change
      }
      // Consecutive thinking blocks merge into one native run, exactly as
      // the host renderer builds one MouseRegion per contiguous run — and
      // an all-empty group renders as nothing (no MouseRegion, no run
      // number), so the numbering must skip it. Content streams in order,
      // so a group only fills before later runs exist: indexes stay stable.
      const visual: {
        kind: "thinking" | "text";
        nonEmpty: boolean;
        blockIndex: number;
      }[] = [];
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.type === "thinking") {
          const last = visual[visual.length - 1];
          if (last !== undefined && last.kind === "thinking") {
            last.nonEmpty = last.nonEmpty || block.nonEmpty;
          } else {
            visual.push({
              kind: "thinking",
              nonEmpty: block.nonEmpty,
              blockIndex: index,
            });
          }
        } else if (block.type === "text") {
          visual.push({
            kind: "text",
            nonEmpty: block.nonEmpty,
            blockIndex: index,
          });
        }
      }
      const appliedBoundaries =
        state?.appliedTextBoundaries ?? new Set<number>();
      let runIndex = 0;
      let previousWasThinking = false;
      for (const block of visual) {
        if (block.kind === "thinking") {
          if (!previousWasThinking && block.nonEmpty) {
            this.model.apply({
              type: "thinkingRun",
              messageKey,
              runIndex: runIndex++,
              nonEmpty: true,
            });
          }
          previousWasThinking = true;
        } else {
          previousWasThinking = false;
          // Text boundaries are per block position, applied once: a
          // message may interleave thinking and text (A · text1 · B ·
          // text2 · C) and every independent text block splits its own
          // run. Re-walking a grown or completed message must not
          // re-apply a boundary the model already has.
          if (block.nonEmpty && !appliedBoundaries.has(block.blockIndex)) {
            appliedBoundaries.add(block.blockIndex);
            this.model.apply({
              type: "assistantText",
              messageKey,
              nonEmpty: true,
            });
          }
        }
      }
      if (!shape.streaming) {
        this.model.apply({ type: "messageEnd", messageKey });
      }
      this.assistantStates.set(child, {
        message: shape.messageRef,
        streaming: shape.streaming,
        blockCount: shape.blockCount,
        lastBlockType: shape.lastBlockType,
        signature,
        appliedTextBoundaries: appliedBoundaries,
      });
      return;
    }
    const custom = readCustomMessage(child);
    if (custom) {
      const key = this.customMessageKey(custom);
      const signature = customSignature(
        custom.customType,
        custom.display,
        custom.content,
      );
      if (boundKeyOf(child) !== key) {
        bindComponentWithKey(child, key);
        this.customStates.set(child, signature);
        this.model.apply({
          type: "customMessage",
          key,
          customType: custom.customType,
          display: custom.display,
        });
      } else if (this.customStates.get(child) !== signature) {
        // The provider updated an already-bound message: reveal the
        // affected group first (member updates always surface), then
        // re-classify, then join the deferred candidates so the next
        // normal settle re-folds it. Unchanged re-scans are not updates.
        this.customStates.set(child, signature);
        this.revealSegmentOf(key);
        this.model.apply({
          type: "customMessageUpdate",
          key,
          customType: custom.customType,
          display: custom.display,
        });
        this.recollectSegmentOf(key);
      }
      return;
    }
    if (isUserMessage(child)) {
      if (isNew) this.model.apply({ type: "userMessage" });
      return;
    }
    if (this.groupedNotifications.has(child)) {
      // Bound notification member: already applied by the observer.
      return;
    }
    if (isInertChild(child)) {
      // Spacers and other padding never split a run.
      return;
    }
    // Anything else visible on screen that we cannot classify stays as a
    // conservative boundary (native diagnostics, summaries, bash blocks) —
    // applied once, like every structural boundary.
    if (isNew) this.model.apply({ type: "nativeDiagnostic" });
  }

  // ------------------------------------------------------------------
  // Folding
  // ------------------------------------------------------------------

  private applyFolding(
    turn: number,
    outcome: "normal" | "abnormal" | "unknown",
  ): void {
    const segments = this.model.currentSegments();
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    const segmentsOfTurn = segments.filter((segment) => segment.turn === turn);
    const pendingSegments = [...this.pendingIdsAsSegments(byId)];
    const postSettleSegments = this.model
      .postSettleSegmentIds()
      .map((id) => byId.get(id))
      .filter((segment): segment is Segment => segment !== undefined);
    const decision = planFolding({
      turn,
      outcome,
      segmentsOfTurn,
      pendingSegments,
      postSettleSegments,
      isQuiet: (segment) => this.model.segmentIsQuiet(segment),
    });
    this.store.applyAutoFold(decision.foldNow);
    for (const id of decision.foldNow) this.wasEverFolded.add(id);
    this.pending.consume(decision.foldNow);
    this.pending.add(decision.stillPending);
    this.model.noteSettled();
  }

  private *pendingIdsAsSegments(
    byId: Map<number, Segment>,
  ): IterableIterator<Segment> {
    for (const id of this.pending.ids()) {
      const segment = byId.get(id);
      if (segment !== undefined) yield segment;
    }
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  /** `/group-collapse expand`: mouse-free recovery of folded content. */
  expandAll(): number {
    const activeTurn = this.model.isTurnActive()
      ? this.model.currentTurn()
      : undefined;
    let opened = 0;
    for (const segment of this.model.currentSegments()) {
      if (segment.turn === activeTurn) continue;
      if (this.store.isFolded(segment.id)) {
        opened += 1;
        // Reconstructed groups are already folded, but adoption clears the
        // transient history set. Preserve their group controls when opened.
        this.wasEverFolded.add(segment.id);
      }
      this.store.open(segment.id);
    }
    if (opened > 0 && this.activeReceiver !== undefined) {
      this.requestHostRender(this.activeReceiver);
    }
    return opened;
  }

  /**
   * `/group-collapse collapse`: fold every settled, quiet group. Active or
   * unresolved segments keep their display — the user asked for tidiness,
   * not for hiding running work.
   */
  collapseAll(): number {
    const activeTurn = this.model.isTurnActive()
      ? this.model.currentTurn()
      : undefined;
    let closed = 0;
    for (const segment of this.model.currentSegments()) {
      if (segment.turn === activeTurn) continue;
      if (!this.model.segmentIsQuiet(segment)) continue;
      if (!this.store.isFolded(segment.id)) closed += 1;
      this.store.close(segment.id);
      this.wasEverFolded.add(segment.id);
    }
    if (closed > 0 && this.activeReceiver !== undefined) {
      this.requestHostRender(this.activeReceiver);
    }
    return closed;
  }

  // ------------------------------------------------------------------
  // Display installation
  // ------------------------------------------------------------------

  /**
   * Test/probe helper: swap the rule table and start a fresh (empty) view
   * under it. Real flows load rules at session_start only.
   */
  debugApplyPolicyRules(rules: readonly import("./rules.ts").Rule[]): void {
    this.policy = compileRules([...rules]);
    this.adoptRebuilt(
      rebuildFromBranch([], this.policy, this.guard.invalidate()),
    );
  }

  /**
   * A notification the observer proved came from the extension entry (or
   * the test fixture driving the same path). A repeated component is the
   * host reusing the line: reveal the new content first, then
   * re-classify it under its current text/level.
   */
  observeNotification(
    component: object,
    level: "info" | "warning" | "error",
    text: string,
  ): void {
    const key = identityOf(component);
    // Bind before applying: the projection consults the binding when the
    // group folds, and the scan must recognize the carrier.
    bindComponentWithKey(component, key);
    if (this.model.member(key)) {
      // Reveal first: the reused line's new content must be visible
      // before the group's classification is recomputed.
      this.revealSegmentOf(key);
      this.model.apply({
        type: "notificationUpdate",
        key,
        level,
        text,
      });
      // The update revealed its group: join the deferred candidates so
      // the next normal settle re-folds it.
      this.recollectSegmentOf(key);
    } else {
      this.model.apply({ type: "notification", key, level, text });
    }
    if (this.model.member(key)) {
      this.groupedNotifications.add(component);
    } else {
      // Re-classification dropped it (e.g. a keep-identity update): the
      // line renders through and is not a group member anymore.
      this.groupedNotifications.delete(component);
    }
  }

  /**
   * A bound notification line lost the status tail and may now render a newer
   * *proven* notification version: the host appends a new status pair instead
   * of reusing the old line, and every info line's builder reads the shared
   * `lastStatusMessage`, so a later invalidate repaints this line from that
   * field. A tail move is a state-change signal, not a verdict:
   *
   * - the line's own visible text has not changed, so this is not an update
   *   to reveal; it is a re-classification of the version the line may render
   *   next;
   * - if the current policy still selects `group` for that version the line
   *   stays exactly where it is (a moved tail must never split a run, which
   *   is what fragmented one settled turn into four groups);
   * - if the version is `keep` the member leaves and its segment splits at
   *   the hole, so the line shows up as the visible boundary it now is;
   * - nothing here ever turns a currently-visible non-member into a hidden
   *   member: a `keep` line that becomes group-eligible stays visible, so
   *   group positions and boundaries cannot be rewritten retroactively.
   *
   * Only notification members are reconsidered; any other key is untouched.
   *
   * One host status change can move the tail over *every* tracked line, so
   * this takes the whole batch: the model drops the members a batch
   * re-classifies in a single transcript pass. A single entry keeps the
   * per-item behavior exactly.
   */
  private reclassifyNotifications(
    versions: readonly {
      readonly component: unknown;
      readonly level: "info" | "warning" | "error";
      readonly text: string;
    }[],
  ): void {
    const updates: {
      key: string;
      level: "info" | "warning" | "error";
      text: string;
      component: object;
    }[] = [];
    for (const version of versions) {
      const component = version.component as object;
      const key = identityOf(component);
      const member = this.model.member(key);
      // Only notification members are reconsidered; a currently-visible
      // non-member is never retroactively hidden.
      if (!member || member.kind !== "notification") continue;
      updates.push({
        key,
        level: version.level,
        text: version.text,
        component,
      });
    }
    if (updates.length === 0) return;
    // `notificationUpdate` re-applies the policy to the current version and
    // removes the member when it is no longer a candidate. Unlike a real
    // content update this neither reveals nor re-collects: the group's
    // visibility was already correct for the text on screen.
    this.model.reclassifyNotifications(
      updates.map(({ key, level, text }) => ({ key, level, text })),
    );
    // Keep the carrier index in sync with the model, exactly like the
    // invalidation path: a dropped member must not stay "already applied"
    // for later scans. (The split itself already happened in the model.)
    for (const { key, component } of updates) {
      if (this.model.member(key)) this.groupedNotifications.add(component);
      else {
        this.groupedNotifications.delete(component);
        if (component instanceof Text) forgetNotificationSpacer(component);
      }
    }
  }

  /**
   * One host status change invalidated these lines (overwritten in place or
   * tail-moved): the members leave their groups. Batched for the same reason
   * as `reclassifyNotifications` — the model removes them in one pass.
   */
  private invalidateNotifications(
    invalidations: readonly { readonly component: unknown }[],
  ): void {
    if (invalidations.length === 0) return;
    const keys: string[] = [];
    for (const invalidation of invalidations) {
      const component = invalidation.component as object;
      keys.push(identityOf(component));
      this.groupedNotifications.delete(component);
      if (component instanceof Text) forgetNotificationSpacer(component);
    }
    this.model.invalidateMembers(keys);
  }

  /**
   * Test/probe helper: register a notification component exactly as the
   * observer would when the host shows it.
   */
  debugRegisterNotification(
    component: object,
    level: "info" | "warning" | "error",
    text: string,
  ): void {
    this.observeNotification(component, level, text);
  }

  isDisplayInstalled(): boolean {
    return this.displays !== undefined;
  }

  /** Test/probe helper: current segment count (growth regression). */
  /** Test/probe helper: the live segments (review regression checks). */
  currentSegmentsForTest() {
    return this.model.currentSegments();
  }

  debugSegmentCount(): number {
    return this.model.currentSegments().length;
  }

  /**
   * Test/probe helper: cost of member removal (segment/member visits).
   * One host status change that drops k members must cost one pass over the
   * transcript, not k passes.
   */
  debugRemovalScanCounts(): { segmentVisits: number; memberVisits: number } {
    return this.model.debugRemovalScanCounts();
  }

  /** Test/probe helper: current deferred-candidate count. */
  debugPendingCount(): number {
    return this.pending.ids().length;
  }

  /** Test/probe helper: adopt a pre-built policy (counting tests). */
  debugAdoptPolicy(policy: import("./rules.ts").CompiledRules): void {
    this.policy = policy;
    this.adoptRebuilt(
      rebuildFromBranch([], this.policy, this.guard.invalidate()),
    );
  }

  /** Test/probe helper: how many times the view index has been rebuilt. */
  debugIndexBuilds(): number {
    return this.indexBuildCount;
  }

  /** Test/probe helper: live group-handle count (strong table scale). */
  debugGroupHandleCount(): number {
    return this.groupHandles.size;
  }

  /** Test/probe helper: folded segment ids as the store sees them. */
  debugFoldedIds(): readonly number[] {
    return this.model
      .currentSegments()
      .filter((segment) => this.store.isFolded(segment.id))
      .map((segment) => segment.id);
  }

  /** Test/probe helper: whether a session theme getter is still installed. */
  debugHasThemeGetter(): boolean {
    return this.lastGetTheme !== undefined;
  }

  private installDisplays(): void {
    const render = installRenderProjection(
      (component, width) => this.projectionFor(component, width),
      {
        onSummaryClick: (component, width, run, role) =>
          this.toggleAtShellRow(component, width, run, role),
        resolveSummaryTarget: (component, width, run, role) =>
          this.resolveShellTarget(component, width, run, role)?.component,
        isNotificationReceiver: (receiver) => receiver === this.activeReceiver,
        groupBoundary: (component, width, edges) =>
          this.groupBoundary(component, width, edges),
        onNotificationSpacerUnavailable: () => {
          this.notifications.notify(
            "group-collapse: notification spacing unavailable; original spacing will remain visible",
            "warning",
          );
        },
        onUnfittable: (component, width) => {
          const key = boundKeyOf(component);
          const segment =
            key === undefined ? undefined : this.index().byMember.get(key);
          if (segment !== undefined)
            this.recordWidthFallback(segment.id, width);
        },
      },
    );
    const handleEvent = installPrototypePatch(
      // SAFETY: the registry probes callable host methods before wrapping them.
      InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>,
      "handleEvent",
      "runtime-receiver-sync",
      ({ predecessor, receiver, args }) => {
        const result = predecessor.apply(receiver, args);
        if (this.displayAllowed && isHostReceiver(receiver)) {
          this.syncReceiver(receiver as HostReceiver);
        }
        return result;
      },
    );
    // Pi's startup path emits `session_start` from
    // `rebindCurrentSession()` and only then renders the restored transcript
    // with `renderInitialMessages()`. Without this seam the components of
    // that first frame are never bound: the history model is folded while
    // the screen shows the raw history until a model event or `/reload`.
    // Session-scoped on purpose — `session_shutdown` restores the host
    // method, and the persistent chat-rebuild hook below still covers the
    // between-sessions window used by `/reload`.
    const renderInitialMessages = installPrototypePatch(
      // SAFETY: the registry probes callable host methods before wrapping them.
      InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>,
      "renderInitialMessages",
      "runtime-initial-render-sync",
      ({ predecessor, receiver, args }) => {
        const result = predecessor.apply(receiver, args);
        if (this.displayAllowed && isHostReceiver(receiver)) {
          this.syncReceiver(receiver as HostReceiver);
        }
        return result;
      },
    );
    // The chat-rebuild hook is persistent on purpose: `/reload` rebuilds
    // the transcript while the display patches are removed (between
    // session_shutdown and session_start), so this is the only seam that
    // sees the replacement components. While inactive it only records the
    // receiver (WeakRef); an active rebuild syncs immediately.
    installPrototypePatch(
      // SAFETY: the registry probes callable host methods before wrapping them.
      InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>,
      "rebuildChatFromMessages",
      "runtime-chat-rebuild-sync",
      ({ predecessor, receiver, args }) => {
        const result = predecessor.apply(receiver, args);
        if (isHostReceiver(receiver)) {
          if (this.sessionActive && this.displayAllowed) {
            this.syncReceiver(receiver as HostReceiver);
          } else {
            globalSlots().rebuildPending = new WeakRef(
              receiver as HostReceiver,
            );
          }
        }
        return result;
      },
    );
    // In-session session replacement (`/resume`, `/fork`) hands over too:
    // `teardownCurrent` awaits `session_shutdown` and only then
    // `rebindCurrentSession({ renderBeforeBind: true })` renders the new
    // branch through `renderCurrentSessionState()` — before the new
    // `session_start` exists. The session-scoped `renderInitialMessages`
    // seam above is already uninstalled in that window, so without this
    // hook the replacement frame is never bound: the model replays the new
    // branch while the screen keeps showing it raw.
    //
    // Persistent for the same reason as the chat-rebuild hook above, and
    // with the same contract: the wrapper is a pure pass-through (it calls
    // the predecessor first and returns its result unchanged); while a
    // session is active it binds immediately, otherwise it only records the
    // receiver in the WeakRef handoff slot for the next `session_start` to
    // consume. It keeps no strong reference, so an abandoned view, a quit
    // with no next session, or a re-imported runtime copy that replaces this
    // behavior slot all release the host tree. Session-scoped state is still
    // dropped by `onSessionShutdown`.
    installPrototypePatch(
      // SAFETY: the registry probes callable host methods before wrapping them.
      InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>,
      "renderCurrentSessionState",
      "runtime-session-replacement-sync",
      ({ predecessor, receiver, args }) => {
        const result = predecessor.apply(receiver, args);
        if (isHostReceiver(receiver)) {
          if (this.sessionActive && this.displayAllowed) {
            this.syncReceiver(receiver as HostReceiver);
          } else {
            globalSlots().rebuildPending = new WeakRef(
              receiver as HostReceiver,
            );
          }
        }
        return result;
      },
    );
    this.notificationObserver = createNotificationObserver({
      onNotification: (notification) => {
        const component = notification.component;
        if (typeof component !== "object" || component === null) return;
        this.observeNotification(
          component,
          notification.level,
          notification.text,
        );
        if (!(component instanceof Text)) return;
        forgetNotificationSpacer(component);
        const receiver = notification.receiver;
        const spacer = notification.spacer;
        if (!spacer || !isHostReceiver(receiver)) return;
        if (!this.model.member(identityOf(component))) return;
        const children = receiver.chatContainer.children;
        const index = children.length - 2;
        if (children[index] === spacer && children[index + 1] === component) {
          bindNotificationSpacer(spacer, component, receiver, index);
        }
      },
      // The batch callbacks are what this runtime uses: one host status
      // change can touch every tracked line, and the model must drop or
      // re-classify them in one transcript pass. The per-item callbacks stay
      // wired to the same handlers so a consumer that only offers the
      // single-item contract keeps working unchanged.
      onInvalidated: (invalidation) =>
        this.invalidateNotifications([invalidation]),
      onInvalidations: (invalidations) =>
        this.invalidateNotifications(invalidations),
      onContentVersion: (version) => this.reclassifyNotifications([version]),
      onContentVersions: (versions) => this.reclassifyNotifications(versions),
    });
    const observer = this.notificationObserver.install();
    if (!observer.available) {
      // Displays install once per session and are removed on shutdown.
      // Consume this adapter's result directly rather than claiming the
      // registry's process-global diagnostic listener from other copies.
      this.notifications.notify(
        "group-collapse: notification source unavailable; notifications will remain visible",
        "warning",
      );
    }
    // Composable setExpanded observer: the native global expand
    // (ctrl+o) fans out setExpanded(true) over every member; a member of
    // a hidden group must first make its quiet group reachable, then run
    // the original method. setExpanded(false) collapses the member only —
    // never the group. The wrapper never touches thinking visibility, so
    // ctrl+t keeps its native meaning, and it never calls back into
    // setExpanded, so there is no loop and no pointerDepth-style guessing.
    const expandObserver = installPrototypePatch(
      // SAFETY: only the callable setExpanded method is observed, not replaced.
      ToolExecutionComponent.prototype as unknown as Record<
        PropertyKey,
        unknown
      >,
      "setExpanded",
      "runtime-member-expand-observer",
      ({ predecessor, receiver, args }) => {
        if (args[0] === true) this.revealGroupOf(receiver);
        return predecessor.apply(receiver, args);
      },
    );
    const customExpandObserver = installPrototypePatch(
      // SAFETY: only the callable setExpanded method is observed, not replaced.
      CustomMessageComponent.prototype as unknown as Record<
        PropertyKey,
        unknown
      >,
      "setExpanded",
      "runtime-member-expand-observer",
      ({ predecessor, receiver, args }) => {
        if (args[0] === true) this.revealGroupOf(receiver);
        return predecessor.apply(receiver, args);
      },
    );
    this.displays = {
      render,
      handleEvent,
      renderInitialMessages,
      observer,
      expandObserver,
      customExpandObserver,
    };
  }

  /** Make a member's folded group visible without user-open immunity. */
  private revealGroupOf(component: unknown): void {
    if (typeof component !== "object" || component === null) return;
    const key = boundKeyOf(component);
    if (key === undefined) return;
    this.revealSegmentOf(key);
  }

  /**
   * Unfold the group holding `key` (content-update first-reveal). Unlike
   * a user open this grants no immunity — a later normal settle may fold
   * the re-classified group again. Quiet-check free on purpose: an update
   * arriving for a still-running member must reveal too.
   */
  private revealSegmentOf(key: string): void {
    const segment = this.index().byMember.get(key);
    if (segment === undefined) return;
    if (!this.store.isFolded(segment.id)) return;
    this.wasEverFolded.add(segment.id);
    this.store.reveal([segment.id]);
  }

  /**
   * A content update revealed its group: the revealed segment joins the
   * deferred candidates so the next normal settle re-folds it ("update
   * first-reveal, collect at the next settle"). User opens never go
   * through here — and the store's user-open immunity would protect them
   * even if they did. A still-active turn's segments are skipped: they
   * fold with their own turn's settle.
   */
  private recollectSegmentOf(key: string): void {
    const segment = this.index().byMember.get(key);
    if (segment === undefined) return;
    const activeTurn = this.model.isTurnActive()
      ? this.model.currentTurn()
      : undefined;
    if (segment.turn === activeTurn) return;
    this.pending.add([segment.id]);
  }

  /**
   * Stable key for a custom message component: the persisted entry id when
   * the component carries the branch's own message object, a signature
   * match against history custom members when Pi re-created the object
   * (sessionEntryToContextMessages for persisted custom_message entries),
   * else the message object's transient identity.
   */
  private customMessageKey(custom: {
    message: object;
    customType: string;
    display: boolean;
    content: string;
  }): string {
    return (
      this.entryIdsByMessage.get(custom.message) ??
      this.unclaimedHistoryCustomKey(
        custom.customType,
        custom.display,
        custom.content,
      ) ??
      identityOf(custom.message)
    );
  }

  /**
   * First unclaimed history custom member with an identical signature.
   * Components bind in container order, so equal-content messages claim
   * their entries in entry order; the claim dies with the next rebuild.
   */
  private unclaimedHistoryCustomKey(
    customType: string,
    display: boolean,
    content: string,
  ): string | undefined {
    const candidates = this.customHistoryBySignature.get(
      customSignature(customType, display, content),
    );
    if (candidates === undefined) return undefined;
    for (const key of candidates) {
      if (!this.consumedCustomKeys.has(key)) {
        this.consumedCustomKeys.add(key);
        return key;
      }
    }
    return undefined;
  }

  private uninstallDisplays(): void {
    if (!this.displays) return;
    this.displays.render.cleanup();
    this.displays.handleEvent.cleanup();
    this.displays.renderInitialMessages.cleanup();
    this.displays.observer.cleanup();
    this.displays.expandObserver.cleanup();
    this.displays.customExpandObserver.cleanup();
    this.displays = undefined;
    this.notificationObserver = undefined;
  }

  // ------------------------------------------------------------------
  // Projection plan
  // ------------------------------------------------------------------

  /**
   * Derived per-revision index: member key → segment, segment id →
   * segment, per-segment summaries, and — for the assistant projection —
   * each message's managed thinking runs (run → segment), so a stable
   * render queries only the index instead of scanning every folded group
   * per component (the scale regression's quadratic path).
   */
  private viewIndex:
    | {
        revision: number;
        byMember: Map<string, Segment>;
        byId: Map<number, Segment>;
        summaries: Map<number, ReturnType<typeof summarizeSegment>>;
        /** messageKey → (run → segment id) for thinking members. */
        messageThinking: Map<string, Map<number, number>>;
      }
    | undefined;
  private indexBuildCount = 0;

  private index(): NonNullable<GroupCollapseRuntime["viewIndex"]> {
    const revision = this.model.revision();
    if (this.viewIndex?.revision === revision) return this.viewIndex;
    const byMember = new Map<string, Segment>();
    const byId = new Map<number, Segment>();
    const summaries = new Map<number, ReturnType<typeof summarizeSegment>>();
    const messageThinking = new Map<string, Map<number, number>>();
    for (const segment of this.model.currentSegments()) {
      byId.set(segment.id, segment);
      summaries.set(segment.id, summarizeSegment(segment));
      for (const member of segment.members) {
        byMember.set(member.key, segment);
        if (member.kind === "thinking") {
          const match = /^(.+)#t(\d+)$/.exec(member.key);
          if (match) {
            let runs = messageThinking.get(match[1]);
            if (!runs) {
              runs = new Map();
              messageThinking.set(match[1], runs);
            }
            runs.set(Number(match[2]), segment.id);
          }
        }
      }
    }
    this.viewIndex = { revision, byMember, byId, summaries, messageThinking };
    this.indexBuildCount += 1;
    return this.viewIndex;
  }

  private summaryOf(segment: Segment): ReturnType<typeof summarizeSegment> {
    return this.index().summaries.get(segment.id) ?? summarizeSegment(segment);
  }

  private projectionFor(
    component: object,
    width?: number,
  ): Projection | undefined {
    const key = boundKeyOf(component);
    if (key === undefined) return undefined;
    const activeTurn = this.model.isTurnActive()
      ? this.model.currentTurn()
      : undefined;

    // Thinking runs of this message inside folded segments hide, whatever
    // else the component carries — the assistant itself need not be a
    // member for its thinking to belong to a group. Runs of an
    // ever-folded group that are expanded keep a collapsible title row.
    if (isAssistantComponent(component)) {
      const messageKey = key;
      const runSegments = this.index().messageThinking.get(messageKey);
      if (runSegments && runSegments.size > 0) {
        const hiddenRuns = new Set<number>();
        for (const [run, segmentId] of runSegments) {
          const segment = this.index().byId.get(segmentId);
          if (segment === undefined) continue;
          if (segment.turn === activeTurn) continue;
          if (!this.store.isFolded(segment.id)) continue;
          // Group-wide fallback is decided here, before any member
          // projection exists: a carrier summary that cannot fit this
          // width restores the whole group's display for this frame, so
          // the run renders through instead of vanishing without an
          // entry point.
          if (width !== undefined && !this.summaryFits(segment, width)) {
            this.recordWidthFallback(segment.id, width);
            continue;
          }
          hiddenRuns.add(run);
        }
        // Managed only while something is hidden or an expanded run still
        // owes its collapsible title. A run kept visible by the width
        // fallback manages nothing and renders through with the group.
        const managed =
          hiddenRuns.size > 0 ||
          [...runSegments.values()].some((segmentId) => {
            const segment = this.index().byId.get(segmentId);
            return (
              segment !== undefined &&
              segment.turn !== activeTurn &&
              !this.store.isFolded(segment.id) &&
              this.everFolded(segment)
            );
          });
        if (managed) {
          return {
            kind: "hideThinkingRuns",
            hiddenRuns,
            // The message content that feeds row heights is final once
            // projected; the revision identifies it for the geometry cache.
            geometryToken: `${this.model.revision()}`,
            summaryForRun: (run, w) => {
              // A hidden run that is its group's carrier renders the
              // summary in its place.
              const segmentId = runSegments.get(run);
              const runSegment =
                segmentId === undefined
                  ? undefined
                  : this.index().byId.get(segmentId);
              if (runSegment === undefined) return undefined;
              if (runSegment.turn === activeTurn) return undefined;
              if (!this.store.isFolded(runSegment.id)) return undefined;
              if (runSegment.members[0]?.key !== `${messageKey}#t${run}`) {
                return undefined;
              }
              // The one decorated header row shared by every projection
              // path: arrow + `分组` label in accent, counts muted, neutral
              // theme background across the available width.
              return this.headerLine(this.summaryOf(runSegment), w);
            },
            titleForRun: (run, w) => {
              // An expanded run of an ever-folded group keeps the group
              // title above its content so it can be collapsed again. Its
              // arrow points down because the group itself is open.
              const segmentId = runSegments.get(run);
              const runSegment =
                segmentId === undefined
                  ? undefined
                  : this.index().byId.get(segmentId);
              if (runSegment === undefined) return undefined;
              if (runSegment.turn === activeTurn) return undefined;
              if (this.store.isFolded(runSegment.id)) return undefined;
              if (!this.everFolded(runSegment)) return undefined;
              if (runSegment.members[0]?.key !== `${messageKey}#t${run}`) {
                return undefined;
              }
              return this.headerLine(this.summaryOf(runSegment), w, true);
            },
            footerForRun: (run, w) => {
              const segmentId = runSegments.get(run);
              const runSegment =
                segmentId === undefined
                  ? undefined
                  : this.index().byId.get(segmentId);
              if (
                !runSegment ||
                runSegment.turn === activeTurn ||
                this.store.isFolded(runSegment.id)
              )
                return undefined;
              if (
                !this.isCurrentComponent(component) ||
                !this.everFolded(runSegment) ||
                !this.summaryFits(runSegment, w)
              )
                return undefined;
              if (runSegment.members.at(-1)?.key !== `${messageKey}#t${run}`)
                return undefined;
              return this.footerLine(w);
            },
          };
        }
      }
    }

    const segment = this.index().byMember.get(key);
    if (segment === undefined) return undefined;
    // The running turn always renders through untouched.
    if (segment.turn === activeTurn) return undefined;

    // Group-wide width fallback: once the summary could not fit this
    // width, every member of the group renders transparent until the
    // model changes or the width changes.
    if (width !== undefined && this.hasWidthFallback(segment.id, width)) {
      return undefined;
    }

    const folded = this.store.isFolded(segment.id);
    // Decided before any member projection: a folded group whose summary
    // cannot fit this width restores its full display — carrier and
    // members alike, deterministically in the same frame, regardless of
    // which member renders first.
    if (folded && width !== undefined && !this.summaryFits(segment, width)) {
      this.recordWidthFallback(segment.id, width);
      return undefined;
    }
    const carrier = segment.members[0]?.key === key;
    const lastMember = segment.members.at(-1)?.key === key;
    const token = { segmentId: segment.id };
    const footerFor = (w: number) =>
      this.isCurrentComponent(component) && this.summaryFits(segment, w)
        ? this.footerLine(w)
        : undefined;

    if (folded && carrier) {
      return {
        kind: "summary",
        token,
        lineFor: (w: number) => this.headerLine(this.summaryOf(segment), w),
      };
    }
    if (folded) return { kind: "hide" };
    // An expanded group keeps its title so it can be collapsed again; the
    // arrow points down because the group itself is open.
    if (carrier && this.everFolded(segment)) {
      return {
        kind: "titled",
        token,
        titleFor: (w: number) =>
          this.headerLine(this.summaryOf(segment), w, true),
        footerFor: lastMember ? footerFor : undefined,
      };
    }
    if (lastMember && this.everFolded(segment)) {
      return { kind: "footer", footerFor };
    }
    return undefined;
  }

  /**
   * The group's decorated header row for this frame: the host theme is read
   * through the session's live getter on every call, so a theme switch
   * repaints without caching a colored string. No getter (non-UI session, or
   * a host without `ui.theme`) renders the header uncolored.
   */
  private headerLine(
    summary: SegmentSummary,
    width: number,
    expanded = false,
  ): string | undefined {
    return groupHeaderLine(summary, {
      width,
      expanded,
      theme: this.currentTheme(),
    });
  }

  private footerLine(width: number): string | undefined {
    return groupFooterLine({ width, theme: this.currentTheme() });
  }

  /** A footer must still belong to the currently indexed main view. */
  private isCurrentComponent(component: unknown): boolean {
    if (typeof component !== "object" || component === null) return false;
    const position = this.componentPositions.get(component);
    const host = position?.receiver.deref();
    return (
      position !== undefined &&
      host !== undefined &&
      host === this.activeReceiver &&
      host.chatContainer.children[position.index] === component
    );
  }

  /** Resolve group-edge gaps from proven neighboring main-transcript rows. */
  private groupBoundary(
    component: ProjectedComponent,
    width: number,
    edges: GroupBoundaryEdges,
  ): GroupBoundaryGaps {
    const position = this.componentPositions.get(component);
    const host = position?.receiver.deref();
    const children = host?.chatContainer.children;
    if (
      !position ||
      !host ||
      host !== this.activeReceiver ||
      !children ||
      children[position.index] !== component
    ) {
      return { before: undefined, after: false };
    }
    type Adjacent =
      | { kind: "found"; lines: string[]; startsWithGroup: boolean }
      | { kind: "none" | "unknown" };
    const adjacent = (from: number, direction: -1 | 1): Adjacent => {
      for (
        let index = from + direction;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const candidate = children[index];
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          this.projectionFor(candidate, width)?.kind === "hide"
        )
          continue;
        const probe = probeProjectedLines(candidate, width);
        // An unknown or failing component is not proof of a tight boundary.
        if (probe === undefined) return { kind: "unknown" };
        if (probe.lines.length > 0) return { kind: "found", ...probe };
      }
      return { kind: "none" };
    };
    const blank = (line: string) => stripTerminalSequences(line).trim() === "";
    const previous = edges.start
      ? adjacent(position.index, -1)
      : ({ kind: "none" } as const);
    let endIndex = position.index;
    let endCandidate: Adjacent | undefined;
    if (edges.end) {
      const componentKey = boundKeyOf(component);
      const memberKey =
        componentKey && edges.endRun !== undefined
          ? `${componentKey}#t${edges.endRun}`
          : componentKey;
      const segment =
        memberKey === undefined
          ? undefined
          : this.index().byMember.get(memberKey);
      const last = segment?.members.at(-1);
      if (segment && last && this.store.isFolded(segment.id)) {
        const lastComponentKey =
          last.kind === "thinking" ? last.key.replace(/#t\d+$/, "") : last.key;
        const lastComponent = this.componentsByKey
          .get(lastComponentKey)
          ?.deref();
        const lastPosition =
          lastComponent === undefined
            ? undefined
            : this.componentPositions.get(lastComponent);
        if (
          lastComponent &&
          boundKeyOf(lastComponent) === lastComponentKey &&
          lastPosition?.receiver.deref() === host &&
          children[lastPosition.index] === lastComponent &&
          lastPosition.index >= position.index
        ) {
          endIndex = lastPosition.index;
          // The final member can share an assistant component with visible
          // text. Inspect that projected component before jumping past it.
          if (
            lastComponent !== component &&
            this.projectionFor(lastComponent, width)?.kind !== "hide"
          ) {
            const probe = probeProjectedLines(lastComponent, width);
            if (probe === undefined) endCandidate = { kind: "unknown" };
            else if (probe.lines.length > 0)
              endCandidate = { kind: "found", ...probe };
          }
        }
      }
    }
    const next = edges.end
      ? (endCandidate ?? adjacent(endIndex, 1))
      : ({ kind: "none" } as const);
    return {
      before:
        previous.kind === "unknown"
          ? undefined
          : previous.kind === "found" &&
            !blank(previous.lines[previous.lines.length - 1]),
      // Adjacent groups share one gap, owned by the second group's header.
      after:
        next.kind === "found" && !blank(next.lines[0]) && !next.startsWithGroup,
    };
  }

  private currentTheme(): Theme | undefined {
    const getTheme = this.lastGetTheme;
    if (getTheme === undefined) return undefined;
    try {
      return getTheme();
    } catch {
      // A torn-down host context must not fail the frame.
      return undefined;
    }
  }

  /**
   * Group-wide width fallbacks are scoped to the model revision that
   * produced them: content or classification changes re-evaluate the fit
   * instead of pinning a stale decision to the segment id.
   */
  private widthFallbackRevision = -1;

  private refreshWidthFallbackEpoch(): void {
    const revision = this.model.revision();
    if (this.widthFallbackRevision !== revision) {
      this.widthFallbackRevision = revision;
      this.widthFallbacks.clear();
    }
  }

  private hasWidthFallback(segmentId: number, width: number): boolean {
    this.refreshWidthFallbackEpoch();
    return this.widthFallbacks.get(segmentId)?.has(width) ?? false;
  }

  private recordWidthFallback(segmentId: number, width: number): void {
    this.refreshWidthFallbackEpoch();
    let widths = this.widthFallbacks.get(segmentId);
    if (!widths) {
      widths = new Set();
      this.widthFallbacks.set(segmentId, widths);
    }
    widths.add(width);
  }

  /** Whether the group's summary line fits `width` (never overflows). */
  private summaryFits(segment: Segment, width: number): boolean {
    return summaryLine(this.summaryOf(segment), { width }) !== undefined;
  }

  private everFolded(segment: Segment): boolean {
    return (
      this.store.isFolded(segment.id) || this.wasEverFolded.has(segment.id)
    );
  }

  private readonly wasEverFolded = new Set<number>();

  // ------------------------------------------------------------------
  // Explicit expand-target protocol
  // ------------------------------------------------------------------

  private readonly groupHandles = new Map<number, GroupTarget>();

  /**
   * The independent group object for a segment: one stable identity per
   * segment id, carrying only the group shell's own expansion. Toggling it
   * never touches any member's `setExpanded`.
   */
  private groupHandle(segmentId: number): GroupTarget {
    let handle = this.groupHandles.get(segmentId);
    if (handle) return handle;
    const runtime = this;
    handle = {
      get expanded() {
        return !runtime.store.isFolded(segmentId);
      },
      setExpanded: (expanded: boolean) => {
        // A user toggle both records the shell and pins the choice.
        runtime.wasEverFolded.add(segmentId);
        if (expanded) {
          runtime.store.open(segmentId);
        } else {
          runtime.store.close(segmentId);
        }
      },
    };
    this.groupHandles.set(segmentId, handle);
    return handle;
  }

  /**
   * Resolve a local row of a bound component against the group shell it
   * renders. Read-only; only the summary/title row of a carrier hits.
   */
  private localExpandTarget(
    key: string,
    localRow: number,
    width: number,
    role: ShellRole = "header",
  ): ExpandTarget | undefined {
    if (localRow !== 0) return undefined;
    const segment = this.index().byMember.get(key);
    if (segment === undefined) return undefined;
    const activeTurn = this.model.isTurnActive()
      ? this.model.currentTurn()
      : undefined;
    if (segment.turn === activeTurn) return undefined;
    if (!this.everFolded(segment)) return undefined;
    const folded = this.store.isFolded(segment.id);
    if (role === "footer") {
      if (folded || segment.members.at(-1)?.key !== key) return undefined;
      if (
        !this.summaryFits(segment, width) ||
        this.footerLine(width) === undefined
      )
        return undefined;
    } else {
      if (segment.members[0]?.key !== key) return undefined;
      // Only a summary/title that fits the width renders a row to hit.
      const line = summaryLine(this.summaryOf(segment), {
        width,
        expanded: !folded,
      });
      if (line === undefined) return undefined;
    }
    const handle = this.groupHandle(segment.id);
    // `expanded` is the direction a plain click sets, not the state.
    return { component: handle, expanded: !handle.expanded };
  }

  /**
   * A plain click landed on a carrier's shell row: flip the group once.
   * Returns false when there is nothing to toggle so the event falls back
   * to the component's own handling. Assistant carriers toggle through
   * their thinking-run members when the message itself is not a member.
   */
  /**
   * Resolve the expand target a shell-row click would toggle, without
   * toggling. Assistant carriers resolve through their thinking-run member
   * keys when the message itself is not a member.
   */
  private resolveShellTarget(
    component: object,
    width: number,
    run?: number,
    role: ShellRole = "header",
  ): ExpandTarget | undefined {
    if (role === "footer" && !this.isCurrentComponent(component))
      return undefined;
    const key = boundKeyOf(component);
    if (key === undefined) return undefined;
    // A click on a managed thinking row resolves to that row's own group;
    // otherwise the carrier chain applies.
    if (run !== undefined) {
      const target = this.localExpandTarget(`${key}#t${run}`, 0, width, role);
      if (target && isValidExpandTarget(target)) return target;
      return undefined;
    }
    const candidates = [key];
    if (isAssistantComponent(component)) {
      // Index-backed: only runs that actually manage a shell row.
      for (const runId of this.index().messageThinking.get(key)?.keys() ?? []) {
        candidates.push(`${key}#t${runId}`);
      }
    }
    for (const candidate of candidates) {
      const target = this.localExpandTarget(candidate, 0, width, role);
      if (target && isValidExpandTarget(target)) return target;
    }
    return undefined;
  }

  private toggleAtShellRow(
    component: object,
    width: number,
    run?: number,
    role: ShellRole = "header",
  ): boolean {
    const target = this.resolveShellTarget(component, width, run, role);
    if (!target) return false;
    target.component.setExpanded(target.expanded);
    return true;
  }
}

// ----------------------------------------------------------------------
// Structural readers (runtime-public fields; TS-private on the host types)
// ----------------------------------------------------------------------

function readToolIdentity(
  value: object,
): { toolCallId: string; toolName: string } | undefined {
  const candidate = value as { toolName?: unknown; toolCallId?: unknown };
  if (
    typeof candidate.toolName === "string" &&
    typeof candidate.toolCallId === "string"
  ) {
    return { toolCallId: candidate.toolCallId, toolName: candidate.toolName };
  }
  return undefined;
}

/**
 * Cheap assistant shape read: identity, streaming flag, and block count —
 * everything needed to skip an unchanged completed message without
 * touching (or mapping) its block contents.
 */
function readAssistantShape(value: object):
  | {
      messageRef: object;
      streaming: boolean;
      blockCount: number;
      lastBlockType: string;
    }
  | undefined {
  const candidate = value as {
    contentContainer?: unknown;
    lastMessage?: {
      role?: string;
      content?: readonly { type?: string }[];
    } | null;
    isStreaming?: boolean;
  };
  if (!candidate.contentContainer || !candidate.lastMessage) return undefined;
  if (candidate.lastMessage.role !== "assistant") return undefined;
  const content = candidate.lastMessage.content ?? [];
  return {
    messageRef: candidate.lastMessage as object,
    streaming: candidate.isStreaming === true,
    blockCount: content.length,
    // A cheap structural signal: reading the last block's type (never its
    // thinking/text body) catches in-place structural swaps at equal count.
    lastBlockType: content[content.length - 1]?.type ?? "",
  };
}

/** Map the message's content blocks (reads thinking/text fields). */
function assistantBlocksOf(
  messageRef: object,
): readonly { type: string; nonEmpty: boolean }[] {
  const message = messageRef as {
    content?: readonly {
      type?: string;
      thinking?: string;
      text?: string;
    }[];
  };
  return (message.content ?? []).map((block) => ({
    type: block.type ?? "",
    nonEmpty:
      (block.thinking !== undefined ? block.thinking.trim() : undefined) !== ""
        ? true
        : (block.text !== undefined ? block.text.trim() : "") !== "",
  }));
}

function readCustomMessage(value: object):
  | {
      message: object;
      customType: string;
      display: boolean;
      content: string;
    }
  | undefined {
  const candidate = value as {
    message?: {
      role?: string;
      customType?: string;
      display?: boolean;
      content?: unknown;
    };
  };
  if (!candidate.message || candidate.message.role !== "custom")
    return undefined;
  if (typeof candidate.message.customType !== "string") return undefined;
  return {
    message: candidate.message as object,
    customType: candidate.message.customType,
    display: candidate.message.display !== false,
    content:
      typeof candidate.message.content === "string"
        ? candidate.message.content
        : "",
  };
}

/**
 * Identity signature of a custom message: the fields that survive the
 * entry → context-message conversion unchanged, used to bind a re-created
 * message object back to its persisted entry id.
 */
function customSignature(
  customType: string,
  display: boolean,
  content: string,
): string {
  return `${customType}\u0000${display ? "1" : "0"}\u0000${content}`;
}

/** Index a history custom member by signature (entry order preserved). */
function noteCustomSignature(
  customSignatures: Map<string, string[]> | undefined,
  customType: string,
  display: boolean,
  content: string,
  key: string,
): void {
  if (!customSignatures) return;
  const signature = customSignature(customType, display, content);
  const keys = customSignatures.get(signature);
  if (keys) {
    keys.push(key);
  } else {
    customSignatures.set(signature, [key]);
  }
}

function isUserMessage(value: object): boolean {
  const candidate = value as { text?: unknown; markdownTheme?: unknown };
  return typeof candidate.text === "string" && "markdownTheme" in candidate;
}

function isInertChild(value: object): boolean {
  const name = value.constructor?.name;
  return name === "Spacer";
}

function isAssistantComponent(value: object): boolean {
  return value.constructor?.name === "AssistantMessageComponent";
}

function isHostReceiver(value: unknown): value is HostReceiver {
  const candidate = value as { chatContainer?: { children?: unknown } };
  return (
    !!candidate &&
    !!candidate.chatContainer &&
    Array.isArray(candidate.chatContainer.children)
  );
}

let boundKeys: WeakMap<object, string> = new WeakMap();

/** Drops every component binding (view rebuild / shutdown). */
function boundKeysClear(): void {
  // WeakMap has no clear(); a fresh map reclaims the old entries.
  boundKeys = new WeakMap();
}

function boundKeyOf(component: object): string | undefined {
  return boundKeys.get(component);
}

function bindComponentWithKey(component: object, key: string): void {
  boundKeys.set(component, key);
  bindComponent(component);
}

/** Map persisted branch entries onto the history projection. */
export function mapBranchEntries(
  entries: readonly BranchEntry[],
  entryIdsByMessage?: WeakMap<object, string>,
  customSignatures?: Map<string, string[]>,
): HistoryEntry[] {
  const mapped: HistoryEntry[] = [];
  for (const entry of entries) {
    // Record the persisted message object → entry id so a later component
    // binding can reuse the same stable identity the history model used.
    if (entryIdsByMessage && entry.type === "message" && entry.message) {
      entryIdsByMessage.set(entry.message as object, entry.id);
    }
    if (entry.type === "message" && entry.message) {
      const role = entry.message.role;
      if (role === "user") {
        mapped.push({ type: "user" });
      } else if (role === "assistant") {
        type ContentBlock =
          | { kind: "thinking"; nonEmpty: boolean }
          | { kind: "text"; nonEmpty: boolean }
          | { kind: "toolCall"; toolCallId: string; toolName: string };
        const rawBlocks: ContentBlock[] = (entry.message.content ?? []).flatMap(
          (block: {
            type?: string;
            thinking?: string;
            text?: string;
            id?: string;
            name?: string;
          }): ContentBlock[] => {
            if (block.type === "thinking") {
              return [
                {
                  kind: "thinking",
                  nonEmpty: (block.thinking ?? "").trim() !== "",
                },
              ];
            }
            if (block.type === "text") {
              return [
                {
                  kind: "text",
                  nonEmpty: (block.text ?? "").trim() !== "",
                },
              ];
            }
            if (block.type === "toolCall" && typeof block.id === "string") {
              return [
                {
                  kind: "toolCall",
                  toolCallId: block.id,
                  toolName: block.name ?? "",
                },
              ];
            }
            return [];
          },
        );
        // Contiguous thinking blocks are one native run in the renderer;
        // merge them so history run indexes match the live scan.
        const blocks: ContentBlock[] = [];
        for (const block of rawBlocks) {
          const previous = blocks[blocks.length - 1];
          if (
            block.kind === "thinking" &&
            previous?.kind === "thinking" &&
            (block.nonEmpty || !previous.nonEmpty)
          ) {
            previous.nonEmpty = previous.nonEmpty || block.nonEmpty;
            continue;
          }
          blocks.push({ ...block });
        }
        mapped.push({
          type: "assistant",
          messageKey: entry.id,
          blocks,
          stopReason: entry.message.stopReason,
        });
      } else if (role === "toolResult") {
        // SAFETY: the role was checked; identity and status are validated below.
        const toolResult = entry.message as unknown as {
          toolCallId?: string;
          isError?: boolean;
        };
        if (typeof toolResult.toolCallId === "string") {
          mapped.push({
            type: "toolResult",
            toolCallId: toolResult.toolCallId,
            isError: toolResult.isError === true,
          });
        }
      } else if (role === "custom") {
        // SAFETY: the role was checked; each custom field is validated below.
        const custom = entry.message as unknown as {
          customType?: string;
          display?: boolean;
          content?: string;
        };
        if (typeof custom.customType === "string") {
          mapped.push({
            type: "customMessage",
            key: entry.id,
            customType: custom.customType,
            display: custom.display !== false,
          });
          noteCustomSignature(
            customSignatures,
            custom.customType,
            custom.display !== false,
            typeof custom.content === "string" ? custom.content : "",
            entry.id,
          );
        }
      }
    } else if (entry.type === "custom_message") {
      mapped.push({
        type: "customMessage",
        key: entry.id,
        customType: entry.customType ?? "",
        display: entry.display !== false,
      });
      noteCustomSignature(
        customSignatures,
        entry.customType ?? "",
        entry.display !== false,
        entry.content ?? "",
        entry.id,
      );
    } else if (
      entry.type === "compaction" ||
      entry.type === "branchSummary" ||
      entry.type === "branch_summary"
    ) {
      mapped.push({ type: "diagnostic" });
    }
  }
  return mapped;
}
