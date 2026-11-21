import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Member } from "./model.ts";

export type Interval = { readonly start: number; readonly end: number };

type ToolTiming = { readonly start: number; end?: number };
type ThinkingBlock = ToolTiming & { text?: string };

/** Current-view evidence only. A rebuild replaces the collector altogether. */
export class GroupTiming {
  active = false;
  private readonly tools = new Map<string, ToolTiming>();
  private liveTools = new WeakSet<Member>();
  private thinking = new WeakMap<
    AssistantMessageComponent,
    Map<number, ThinkingBlock>
  >();
  private readonly intervals = new WeakMap<Member, Interval>();
  private readonly appearanceWindows = new WeakMap<Member, number>();
  private appearanceWindow = 0;

  begin(): void {
    this.active = true;
    this.appearanceWindow += 1;
  }

  settle(): void {
    this.active = false;
    this.appearanceWindow += 1;
    this.tools.clear();
    this.liveTools = new WeakSet();
    this.thinking = new WeakMap();
  }

  toolStart(key: string, at: number, member?: Member): void {
    if (!this.active || this.tools.has(key)) return;
    if (member && (!this.liveTools.has(member) || this.intervals.has(member)))
      return;
    this.tools.set(key, { start: at });
  }

  toolEnd(key: string, at: number, member?: Member): boolean {
    const timing = this.tools.get(key);
    if (
      !this.active ||
      !timing ||
      timing.end !== undefined ||
      at < timing.start
    )
      return false;
    timing.end = at;
    return this.bindToolInterval(key, member);
  }

  bindNewTool(member: Member): boolean {
    if (!this.active) return false;
    this.liveTools.add(member);
    return this.bindToolInterval(member.key, member);
  }

  private bindToolInterval(key: string, member?: Member): boolean {
    const timing = this.tools.get(key);
    if (!member || !this.liveTools.has(member) || timing?.end === undefined)
      return false;
    this.tools.delete(key);
    return this.record(member, { start: timing.start, end: timing.end });
  }

  watchThinking(component: AssistantMessageComponent): void {
    if (this.active) this.thinking.set(component, new Map());
  }

  thinkingStart(
    component: AssistantMessageComponent,
    index: number,
    at: number,
  ): void {
    const blocks = this.thinking.get(component);
    if (blocks && !blocks.has(index)) blocks.set(index, { start: at });
  }

  thinkingEnd(
    component: AssistantMessageComponent,
    index: number,
    at: number,
    text: string,
  ): void {
    const block = this.thinking.get(component)?.get(index);
    if (!block || block.end !== undefined || at < block.start) return;
    block.end = at;
    block.text = text;
  }

  private thinkingInterval(
    component: AssistantMessageComponent,
    blocks: readonly { index: number; text: string }[],
  ): Interval | undefined {
    const observed = this.thinking.get(component);
    if (!observed || blocks.length === 0) return undefined;
    let start = Infinity;
    let end = -Infinity;
    for (const block of blocks) {
      const timing = observed.get(block.index);
      if (timing?.end === undefined || timing.text !== block.text)
        return undefined;
      start = Math.min(start, timing.start);
      end = Math.max(end, timing.end);
    }
    return { start, end };
  }

  finishThinking(
    component: AssistantMessageComponent,
    content: readonly { type: string; thinking?: string }[],
  ): readonly (Interval | undefined)[] {
    if (!this.thinking.has(component)) return [];
    const intervals: (Interval | undefined)[] = [];
    let run: { index: number; text: string }[] = [];
    for (const [index, block] of content.entries()) {
      if (block.type === "thinking") {
        if (block.thinking?.trim()) run.push({ index, text: block.thinking });
      } else if (run.length > 0) {
        intervals.push(this.thinkingInterval(component, run));
        run = [];
      }
    }
    if (run.length > 0) intervals.push(this.thinkingInterval(component, run));
    this.thinking.delete(component);
    return intervals;
  }

  point(
    member: Member | undefined,
    at: number | undefined,
    replaced: boolean,
  ): boolean {
    if (!member) return false;
    // Reusing a row after its original window cannot extend the old group's
    // elapsed time into idle time or another turn. The member can still fold.
    if (
      replaced &&
      this.appearanceWindows.get(member) !== this.appearanceWindow
    ) {
      return this.record(member, undefined);
    }
    this.appearanceWindows.set(member, this.appearanceWindow);
    return this.record(
      member,
      at === undefined ? undefined : { start: at, end: at },
    );
  }

  get = (member: Member): Interval | undefined => this.intervals.get(member);

  record(member: Member | undefined, interval: Interval | undefined): boolean {
    if (!member) return false;
    if (interval === undefined) return this.intervals.delete(member);
    this.intervals.set(member, interval);
    return true;
  }
}
