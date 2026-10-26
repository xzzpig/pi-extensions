/**
 * Pure grouping model: the member index and contiguous segment division
 * (change task 2.1).
 *
 * This module owns no Pi imports and no I/O. It consumes an ordered stream
 * of *visual* transcript items — the order things appear in the main
 * transcript, not the order events fired — and maintains:
 *
 * - a light member index keyed by stable source identity (tool call id,
 *   message key + thinking run, custom message key, notification key);
 * - the division of selected members into contiguous segments: any *visible
 *   non-member* (assistant text, user message, native diagnostic, kept
 *   tool/message/notification) ends the current segment, while hidden or
 *   display:false items neither count nor split; turn boundaries always
 *   split;
 * - per-segment statistics (tools/thinking/messages counts, failures).
 *
 * Membership decisions come from a `MemberPolicy` compiled from the rule
 * table (see rules.ts). Thinking is always a joining candidate (its own
 * visibility stays with pi's thinking plugins); tools default to joining;
 * special messages and notifications default to staying visible.
 *
 * The model records only identity and statistics — never tool arguments,
 * results, thinking or message bodies.
 */

import type { CompiledRules, NotificationLevel } from "./rules.ts";
import { actionForCandidateCompiled } from "./rules.ts";

/** The member classes the model tracks. */
export type MemberKind = "tool" | "thinking" | "customMessage" | "notification";

export type MemberIdentity = {
  readonly kind: MemberKind;
  /** Stable source key: toolCallId, `${messageKey}#t${run}`, entry key... */
  readonly key: string;
  /** Mutable identity fields: updates re-classify under a new name/type. */
  toolName?: string;
  customType?: string;
  level?: NotificationLevel;
};

export type MemberStatus = "pending" | "settled" | "failed";

export type Member = MemberIdentity & {
  status: MemberStatus;
  /** Content/activity version, bumped by args streaming or updates. */
  version: number;
};

export type Segment = {
  readonly id: number;
  readonly members: readonly Member[];
  readonly turn: number;
};

export type MemberPolicy = CompiledRules;

/**
 * The visual item stream. The lifecycle layer translates Pi events into
 * these, in display order, with deduplication by key.
 */
export type VisualItem =
  | { readonly type: "turnBegin" }
  | { readonly type: "turnEnd" }
  | { readonly type: "userMessage" }
  | { readonly type: "nativeDiagnostic" }
  | {
      readonly type: "assistantText";
      readonly messageKey: string;
      readonly nonEmpty: boolean;
    }
  | {
      readonly type: "thinkingRun";
      readonly messageKey: string;
      readonly runIndex: number;
      readonly nonEmpty: boolean;
    }
  | {
      /** The assistant message ended: its thinking runs are final. */
      readonly type: "messageEnd";
      readonly messageKey: string;
    }
  | {
      readonly type: "toolCall";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | { readonly type: "toolArgs"; readonly toolCallId: string }
  | {
      readonly type: "toolResult";
      readonly toolCallId: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "customMessage";
      readonly key: string;
      readonly customType: string;
      readonly display: boolean;
    }
  | {
      readonly type: "notification";
      readonly key: string;
      readonly level: NotificationLevel;
      readonly text: string;
    }
  | {
      /** An already-included custom message changed identity/content. */
      readonly type: "customMessageUpdate";
      readonly key: string;
      readonly customType: string;
      readonly display: boolean;
    }
  | {
      /** An already-included notification changed content or level. */
      readonly type: "notificationUpdate";
      readonly key: string;
      readonly level: NotificationLevel;
      readonly text: string;
    }
  | {
      /**
       * The host invalidated a bound notification line (tail overwritten
       * or moved): the member leaves its group and the content shows again.
       */
      readonly type: "memberInvalidated";
      readonly key: string;
    };

export class GroupingModel {
  private readonly policy: MemberPolicy;
  private turn = 0;
  private turnOpen = false;
  private nextSegmentId = 1;
  private readonly membersByKey = new Map<string, Member>();
  private segments: Segment[] = [];
  private current: Member[] | null = null;
  /**
   * Results that arrived for calls the model never saw (and may never see).
   * A result without its call is missing-evidence: it must block folding of
   * the affected turn rather than be silently dropped.
   */
  private readonly orphanResults = new Map<string, { isError: boolean }>();
  /**
   * Bumped by every applied item that changes the *derived view index*:
   * membership, segment topology, or statistics (failed counts, warning/
   * error levels). Activity-only updates — tool argument streaming,
   * message ends, successful results, same-level notification text — do
   * not touch it, so the index is not rebuilt for changes it cannot see.
   */
  private revisionCounter = 0;

  /** Monotonic model revision for derived-index invalidation. */
  revision(): number {
    return this.revisionCounter;
  }
  /**
   * How many closed segments existed when the last turn settled. Members
   * arriving after that boundary are "settled-after" items: they wait for
   * the *next* normal settle instead of riding the old evidence.
   */
  private settleBoundary = 0;

  constructor(policy: MemberPolicy) {
    this.policy = policy;
  }

  /** Apply one visual item. Idempotent per key where keys identify items. */
  apply(item: VisualItem): void {
    switch (item.type) {
      case "turnBegin":
        this.turn += 1;
        this.turnOpen = true;
        this.closeSegment();
        break;
      case "turnEnd":
        this.turnOpen = false;
        this.closeSegment();
        break;
      case "userMessage":
      case "nativeDiagnostic":
        // Always-visible boundaries.
        this.closeSegment();
        break;
      case "assistantText":
        // Whitespace-only text is neither a member nor a boundary.
        if (item.nonEmpty) this.closeSegment();
        break;
      case "thinkingRun": {
        if (!item.nonEmpty) break;
        const key = `${item.messageKey}#t${item.runIndex}`;
        if (this.membersByKey.has(key)) break;
        this.addMember({
          kind: "thinking",
          key,
        });
        this.revisionCounter += 1;
        break;
      }
      case "messageEnd": {
        // A thinking run is quiet exactly when its message stopped
        // streaming; the run itself has no completion event of its own.
        // Status is not part of the derived index (only fold planning
        // reads quiet), so the revision stays put.
        const prefix = `${item.messageKey}#t`;
        for (const member of this.membersByKey.values()) {
          if (member.kind === "thinking" && member.key.startsWith(prefix)) {
            member.status = "settled";
          }
        }
        break;
      }
      case "toolCall": {
        if (this.membersByKey.has(item.toolCallId)) break;
        // Nested calls (`<parentId>/<n>`) never appear as transcript
        // entries; defensively refuse them so they can neither count nor
        // block the enclosing turn.
        if (item.toolCallId.includes("/")) break;
        const action = actionForCandidateCompiled(this.policy, {
          kind: "tool",
          name: item.toolName,
        });
        if (action === "keep") {
          // A kept tool is a visible non-member: it splits the run.
          this.closeSegment();
          break;
        }
        const orphan = this.orphanResults.get(item.toolCallId);
        this.addMember({
          kind: "tool",
          key: item.toolCallId,
          toolName: item.toolName,
          status: orphan ? (orphan.isError ? "failed" : "settled") : "pending",
        });
        if (orphan) this.orphanResults.delete(item.toolCallId);
        this.revisionCounter += 1;
        break;
      }
      case "toolArgs": {
        // Activity only: the member's version moves, the segment and its
        // statistics do not — no index invalidation for streaming args.
        const member = this.membersByKey.get(item.toolCallId);
        if (member) member.version += 1;
        break;
      }
      case "toolResult": {
        const member = this.membersByKey.get(item.toolCallId);
        if (member) {
          // Idempotent pairing: the first result wins; duplicate end events
          // must not resurrect a settled call or overwrite its outcome.
          if (member.status !== "pending") break;
          member.status = item.isError ? "failed" : "settled";
          member.version += 1;
          // Only a failure changes the derived statistics (the failed
          // count); a successful result only moves quiet state.
          if (item.isError) this.revisionCounter += 1;
          break;
        }
        if (!item.toolCallId.includes("/")) {
          this.orphanResults.set(item.toolCallId, {
            isError: item.isError,
          });
        }
        break;
      }
      case "customMessage": {
        if (!item.display) break;
        if (this.membersByKey.has(item.key)) break;
        const action = actionForCandidateCompiled(this.policy, {
          kind: "customMessage",
          customType: item.customType,
        });
        if (action === "keep") {
          this.closeSegment();
          break;
        }
        this.addMember({
          kind: "customMessage",
          key: item.key,
          customType: item.customType,
          // Special messages have no streaming lifecycle of their own;
          // later activity arrives as explicit update items.
          status: "settled",
        });
        this.revisionCounter += 1;
        break;
      }
      case "notification": {
        if (this.membersByKey.has(item.key)) break;
        const action = actionForCandidateCompiled(this.policy, {
          kind: "notification",
          text: item.text,
          level: item.level,
        });
        if (action === "keep") {
          this.closeSegment();
          break;
        }
        this.addMember({
          kind: "notification",
          key: item.key,
          level: item.level,
          status: "settled",
        });
        this.revisionCounter += 1;
        break;
      }
      case "customMessageUpdate": {
        const member = this.membersByKey.get(item.key);
        if (!member || member.kind !== "customMessage") {
          // An update for an item we never included is just a fresh item.
          this.apply({
            type: "customMessage",
            key: item.key,
            customType: item.customType,
            display: item.display,
          });
          break;
        }
        member.version += 1;
        const action = actionForCandidateCompiled(this.policy, {
          kind: "customMessage",
          customType: item.customType,
        });
        member.customType = item.customType;
        if (action === "keep") {
          this.removeMemberAndSplit(item.key);
          this.revisionCounter += 1;
        }
        break;
      }
      case "notificationUpdate": {
        const member = this.membersByKey.get(item.key);
        if (!member || member.kind !== "notification") {
          this.apply({
            type: "notification",
            key: item.key,
            level: item.level,
            text: item.text,
          });
          break;
        }
        member.version += 1;
        const levelChanged = member.level !== item.level;
        member.level = item.level;
        const action = actionForCandidateCompiled(this.policy, {
          kind: "notification",
          text: item.text,
          level: item.level,
        });
        // A level change alters the summary's warning/error statistics; a
        // keep action removes the member (topology). Both invalidate the
        // derived index — only the text alone is activity.
        if (action === "keep") this.removeMemberAndSplit(item.key);
        if (action === "keep" || levelChanged) this.revisionCounter += 1;
        break;
      }
      case "memberInvalidated": {
        // The host overwrote or moved the line: the member leaves its
        // group. That is a topology change even when the key was absent.
        const existed = this.membersByKey.has(item.key);
        this.removeMemberAndSplit(item.key);
        if (existed) this.revisionCounter += 1;
        break;
      }
    }
  }

  applyAll(items: readonly VisualItem[]): void {
    for (const item of items) this.apply(item);
  }

  /** Segments of the current view, in order, including the open one. */
  currentSegments(): readonly Segment[] {
    if (this.current === null) return this.segments;
    if (this.current.length === 0) return this.segments;
    return [
      ...this.segments,
      { id: this.nextSegmentId, members: [...this.current], turn: this.turn },
    ];
  }

  member(key: string): Member | undefined {
    return this.membersByKey.get(key);
  }

  /** Whether an open turn is still running (no final settle yet). */
  isTurnActive(): boolean {
    return this.turnOpen;
  }

  currentTurn(): number {
    return this.turn;
  }

  /**
   * A segment is quiet when every one of its members has stopped: no
   * pending tool call, no streaming member. Quiet is a precondition for
   * folding, never a trigger — the turn-level result decides that.
   */
  segmentIsQuiet(segment: Segment): boolean {
    return segment.members.every((member) => member.status !== "pending");
  }

  /** Unpaired results currently blocking conservative fold decisions. */
  unpairedResultCount(): number {
    return this.orphanResults.size;
  }

  /**
   * Record that a turn settled: members arriving after this boundary are
   * deferred items (they wait for the *next* normal settle, never the
   * evidence that just completed).
   */
  noteSettled(): void {
    this.settleBoundary = this.segments.length;
  }

  /**
   * Segment ids created after the last settle — new notifications and
   * post-settle updates. The caller folds them only on a later normal
   * settle; an abnormal settle keeps deferring them.
   */
  postSettleSegmentIds(): readonly number[] {
    const ids: number[] = [];
    for (
      let index = this.settleBoundary;
      index < this.segments.length;
      index++
    ) {
      ids.push(this.segments[index].id);
    }
    if (this.current !== null && this.current.length > 0) {
      ids.push(this.nextSegmentId);
    }
    return ids;
  }

  /**
   * Remove a member and split its segment at the hole: the members before
   * and after it become separate segments, because the removed item is (or
   * became) a visible non-member boundary. An emptied segment disappears.
   */
  private removeMemberAndSplit(key: string): void {
    const member = this.membersByKey.get(key);
    if (!member) return;
    this.membersByKey.delete(key);

    // An open (still-growing) segment splits at the removed member: the
    // members before it close as their own segment, the members after it
    // stay open, and everything arriving later joins only the latter.
    // The member may belong to an *earlier* segment while a new one is
    // open — only a hit in the open segment ends the search.
    if (this.current !== null) {
      const index = this.current.indexOf(member);
      if (index >= 0) {
        const after = this.current.slice(index + 1);
        this.current = this.current.slice(0, index);
        this.closeSegment();
        this.current = after.length > 0 ? after : null;
        return;
      }
    }

    for (let sIndex = 0; sIndex < this.segments.length; sIndex++) {
      const segment = this.segments[sIndex];
      const mIndex = segment.members.indexOf(member);
      if (mIndex < 0) continue;
      const before = segment.members.slice(0, mIndex);
      const after = segment.members.slice(mIndex + 1);
      const replacement: Segment[] = [];
      if (before.length > 0) {
        replacement.push({ ...segment, members: before });
      }
      if (after.length > 0) {
        replacement.push({
          id: this.nextSegmentId++,
          members: after,
          turn: segment.turn,
        });
      }
      this.segments.splice(sIndex, 1, ...replacement);
      if (this.settleBoundary > sIndex) {
        // Boundary bookkeeping: the split may add a segment.
        this.settleBoundary += replacement.length - 1;
      }
      return;
    }
  }

  private addMember(
    identity: MemberIdentity & { status?: MemberStatus },
  ): void {
    const member: Member = {
      ...identity,
      status: identity.status ?? "pending",
      version: 1,
    };
    this.membersByKey.set(member.key, member);
    if (this.current === null) this.current = [];
    this.current.push(member);
  }

  private closeSegment(): void {
    if (this.current === null) return;
    if (this.current.length > 0) {
      this.segments.push({
        id: this.nextSegmentId++,
        members: [...this.current],
        turn: this.turn,
      });
    }
    this.current = null;
  }
}

/** Segment summary used by the two-level group view. */
export type SegmentSummary = {
  readonly tools: number;
  readonly thinking: number;
  readonly messages: number;
  readonly failed: number;
  /** Included notifications at warning / error level. */
  readonly warnings: number;
  readonly errors: number;
};

export function summarizeSegment(segment: Segment): SegmentSummary {
  let tools = 0;
  let thinking = 0;
  let messages = 0;
  let failed = 0;
  let warnings = 0;
  let errors = 0;
  for (const member of segment.members) {
    switch (member.kind) {
      case "tool":
        tools += 1;
        if (member.status === "failed") failed += 1;
        break;
      case "thinking":
        thinking += 1;
        break;
      case "customMessage":
        messages += 1;
        break;
      case "notification":
        messages += 1;
        if (member.level === "warning") warnings += 1;
        if (member.level === "error") errors += 1;
        break;
    }
  }
  return { tools, thinking, messages, failed, warnings, errors };
}
