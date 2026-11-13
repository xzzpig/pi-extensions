/**
 * Three-level collapsing for the tool calls of one assistant segment:
 *
 *   0  ▸ 4 calls ·  bash×3  read×1 · 1.2s      (常态;整段工具只剩一行)
 *   1  ▾ 4 calls ·  bash×3  read×1 · 1.2s      (click: back to 0)
 *      │ ✓ bash  cd ~ && python3 - <<'PY' (+26 lines)  0.1s
 *      │ ✓ read  src/app.ts  0.1s
 *   2  │ the full rounded box (what pi renders natively, output preview included)
 *
 * The `│` gutter marks what belongs to the open group. Tools in
 * `alwaysShowTools` (edit/write by default: their diff is the point) never
 * fold — they render as pi's own box and close the group before them, so the
 * calls after one start a new group and the transcript stays in order.
 *
 * One group = the tool calls between two *boundaries*: a user message, or an
 * assistant message with visible text. pi gives every model step its own
 * assistant message, and a step that only calls a tool carries no text — those
 * "carrier" messages do not break the group, so a reply that runs six tools in
 * six steps still folds into one line. The text itself always renders, which is
 * what lets you see a reply drifting.
 *
 * Membership is decided *at render time* from transcript order, which is also
 * what makes it survive a session reload: pi rebuilds the components in order.
 * Every frame renders the whole transcript top to bottom, so a boundary's render
 * only *selects* its group (keyed by the component); it never resets anything.
 * A tool or carrier joins the selected group the first time it renders and stays
 * there.
 *
 * Nothing here touches pi's own expand flag except through `setExpanded`, which
 * is why `ctrl+o` and pi's built-in click-to-expand keep working: both land here
 * first and get translated into "level 1" / "level 2".
 */

import type { JobStatus } from "./background-jobs.ts";
import { agentRunning, groupOpen } from "../live.ts";

export interface GroupMember {
  toolName: string;
  durationMs?: number;
  isPartial: boolean;
  isError?: boolean;
  /** The background job this call started (background-jobs.ts), if any. */
  job?: JobStatus;
  /** A wrapper can own several jobs without becoming several tool calls. */
  jobs?: Array<{ status: JobStatus; fresh: boolean }>;
  /** Running for under RUNNING_ROW_DELAY_MS: not worth announcing yet. */
  fresh?: boolean;
}

export interface BreakdownEntry {
  name: string;
  count: number;
}

export interface GroupSummary {
  count: number;
  /** Per-tool counts, most frequent first, ties alphabetical. */
  breakdown: BreakdownEntry[];
  /** Thinking runs listed inside this group (`thoughts` only when > 0). */
  thoughts: number;
  /** One of those runs is still arriving: the marker animates. */
  thinking: boolean;
  /** Sum of the durations that are known (running tools have none yet). */
  durationMs: number;
  /** Tool name of the member still executing, if any. */
  running?: string;
  /** Members that finished with an error, or whose background job failed. */
  failed: number;
  /** Background jobs still running. */
  jobsRunning: number;
}

/** Pure: what the summary line says, independent of theme or icons. */
export function buildGroupSummary(members: GroupMember[], thoughts = 0, thinking = false): GroupSummary {
  const counts = new Map<string, number>();
  let durationMs = 0;
  let running: string | undefined;
  let failed = 0;
  let jobsRunning = 0;
  for (const member of members) {
    const jobs = member.jobs ?? (member.job ? [{ status: member.job, fresh: !!member.fresh }] : []);
    const failedJobs = jobs.filter((job) => job.status === "failed").length;
    failed += Math.max(!member.isPartial && member.isError ? 1 : 0, failedJobs);
    jobsRunning += jobs.filter((job) => job.status === "running" && !job.fresh).length;
    counts.set(member.toolName, (counts.get(member.toolName) ?? 0) + 1);
    if (typeof member.durationMs === "number" && Number.isFinite(member.durationMs)) {
      durationMs += member.durationMs;
    }
    if (member.isPartial && !member.fresh && running === undefined) running = member.toolName;
  }
  const breakdown = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { count: members.length, breakdown, thoughts, thinking, durationMs, running, failed, jobsRunning };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assistant message roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * - `boundary`: has visible text → starts a group, renders as usual
 * - `carrier`:  only thinking + tool calls → belongs to the current group and
 *               shows as a `🧠` row (or not at all while folded)
 * - `plain`:    anything else (still streaming its thinking, an error, a
 *               truncation notice) → renders as usual, leaves grouping alone
 */
export type AssistantRole = "boundary" | "carrier" | "plain";

interface AssistantMessageLike {
  content?: unknown;
  stopReason?: unknown;
}

export function classifyAssistant(message: AssistantMessageLike | undefined): AssistantRole {
  // `message_start` adds the component to the chat before pi hands it the
  // message: `updateContent` comes right after. A frame that lands in between
  // sees no message at all, and reading that as a boundary cut one reply's group
  // in two — every call before that step stayed in the old group, every call
  // after it opened a new one, so one reply read as `5 calls` above a second
  // `1 call`. There is nothing to fold yet, so leave the grouping alone.
  if (!message) return "plain";
  // Unknown shape (pi changed the field): keep the old behaviour, never hide.
  if (!Array.isArray(message.content)) return "boundary";
  let hasToolCall = false;
  for (const block of message.content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return "boundary";
    if (block?.type === "toolCall") hasToolCall = true;
  }
  // A length stop renders "Response was truncated" — never fold that away.
  if (hasToolCall && message.stopReason !== "length") return "carrier";
  return "plain";
}

/**
 * The message's thinking, one entry per *run*: pi renders consecutive thinking
 * blocks as one block, so a run is what a single label (or our single row)
 * stands for. Whitespace-only blocks are dropped, exactly like pi drops them.
 *
 * Asked for by every assistant message on every frame, so the runs are kept
 * per message and handed back as the same array while the text is unchanged
 * (callers cache their previews against it). Thinking only ever grows by
 * appending, so the block count plus the thinking length says when it has.
 */
export function thinkingRuns(message: AssistantMessageLike | undefined): readonly string[] {
  if (!message || !Array.isArray(message.content)) return [];
  const content = message.content as Array<{ type?: unknown; thinking?: unknown }>;
  let size = 0;
  for (const block of content) {
    if (block?.type === "thinking" && typeof block.thinking === "string") size += block.thinking.length;
  }
  const cached = runsOf.get(message);
  if (cached && cached.blocks === content.length && cached.size === size) return cached.runs;
  const runs = collectRuns(content);
  runsOf.set(message, { blocks: content.length, size, runs });
  return runs;
}

const runsOf = new WeakMap<object, { blocks: number; size: number; runs: readonly string[] }>();

function collectRuns(content: Array<{ type?: unknown; thinking?: unknown }>): string[] {
  const runs: string[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i]?.type !== "thinking") continue;
    const blocks: string[] = [];
    for (; i < content.length && content[i]?.type === "thinking"; i++) {
      const text = content[i].thinking;
      if (typeof text === "string" && text.trim()) blocks.push(text.trim());
    }
    i--;
    if (blocks.length > 0) runs.push(blocks.join("\n\n"));
  }
  return runs;
}

/** The ids of the tool calls a message carries (matched against `toolCallId`). */
export function toolCallIds(message: AssistantMessageLike | undefined): string[] {
  if (!message || !Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content as Array<{ type?: unknown; id?: unknown }>) {
    if (block?.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine
// ─────────────────────────────────────────────────────────────────────────────

/** What a component should draw this frame, top to bottom. */
export interface ViewPlan {
  /** The group's summary line, carried by its first member: `▸` folded, `▾` open. */
  header: "closed" | "open" | null;
  /** The one-row view of this call. */
  line: boolean;
  /** The full box. */
  full: boolean;
  /** Indent `line`/`full` under a `│` gutter: they belong to the header above. */
  gutter: boolean;
  /** Ms until this hidden running row is due to appear — schedule a repaint. */
  revealIn?: number;
}

/**
 * How long a call (or the background job it started) must have been running
 * before a folded group shows its row and says "running". Most calls finish
 * well within it, and a row that pops out under the summary and folds back a
 * frame later reads as a flicker. Long commands still surface after a second.
 */
export const RUNNING_ROW_DELAY_MS = 1000;

/** The running thing's age, for the delay above. */
export interface JobTiming {
  status: JobStatus;
  /** Epoch ms. */
  startTime?: number;
}

/** An always-shown tool: pi's own box, nothing else. */
const PINNED: ViewPlan = { header: null, line: false, full: true, gutter: false };

/**
 * What a carrier message draws this frame. A carrier renders *before* the call
 * of its own step, so when it is also the group's first entrant it takes the
 * summary line over from that call — otherwise the line would land under the
 * carrier's own row.
 */
export interface CarrierPlan {
  /** The group summary line, drawn above the rows (`▾` once open). */
  header: "closed" | "open" | null;
  /** This step's thinking is arriving right now: a sliding row, and the
   * summary spins. False the moment the tokens stop, whatever pi's flag says. */
  live: boolean;
  /** Ms until `live` times out on its own — the caller schedules a repaint. */
  settlesIn?: number;
  /** This render changed what the summary line says (runs counted): it was
   * already drawn this frame, so ask for another. */
  counted: boolean;
  /** One `🧠` row per thinking run. */
  rows: boolean;
  /** Hand pi's own render through untouched (`alwaysShowTools` interop). */
  plain: boolean;
}

/** What the renderer knows about a carrier that the plan needs. */
export interface CarrierInput {
  /** The tool calls this step issued (for the `alwaysShowTools` interop). */
  ids?: readonly string[];
  /**
   * Its thinking runs as pi has them *this* render. Growth against the previous
   * render is what makes a run live; leave it out (mouse routing) to only read.
   */
  runs?: readonly string[];
  now?: number;
}

export interface ToolLike {
  toolName: string;
  toolCallId?: string;
  isPartial: boolean;
  expanded: boolean;
  result?: { durationMs?: number; isError?: boolean };
}

interface Group {
  level: 0 | 1;
  /** The tool components themselves, so the summary always reads live state. */
  members: ToolLike[];
  /** Thinking runs of the carrier messages that joined this group. */
  thoughts: number;
  /** The carrier that draws the summary line instead of the first member. */
  headerCarrier: object | null;
  /** Per carrier: how many of its runs the total already includes. */
  counted: Map<object, number>;
}

/**
 * `groupOpen`: whether a new group starts open (header `▾` plus one row per
 * call) instead of the folded summary line. Only the level a group is *born*
 * with — `openGroup`/`closeGroup`/`noteSetExpanded` still own it afterwards, so
 * an explicitly folded group stays folded. The frame patch calls this on every
 * load, `/reload` included.
 */
export function setGroupOpenDefault(open: boolean): void {
  // The slot, not a module variable: `/reload` loads this module a second time
  // and pushes the value from there, while the patch the previous load installed
  // is the one that keeps calling `newGroup()`.
  groupOpen.set(open);
  // `current` is built at import time, before any setting is read: a transcript
  // that renders a tool before its first boundary would otherwise keep the old
  // level. Only an untouched, empty group is re-levelled.
  if (current.members.length === 0 && current.headerCarrier === null) current.level = open ? 1 : 0;
}

const newGroup = (): Group => ({
  level: groupOpen.get() ? 1 : 0,
  members: [],
  thoughts: 0,
  headerCarrier: null,
  counted: new Map(),
});

/**
 * How long a thinking run still counts as live after its last token. pi repaints
 * on every delta, so this only has to bridge the gap between two tokens; past it
 * the run has stalled and the row (and the spinner) must stop by itself.
 */
export const THOUGHT_LIVE_MS = 1500;

/** The group of the boundary rendered most recently in this frame. */
let current: Group = newGroup();
const groupOfBoundary = new WeakMap<object, Group>();
const groupOf = new WeakMap<object, Group>();
const groupOfCarrier = new WeakMap<object, Group>();
/** Carriers by logical message, so a new component for the same message can
 * still give its runs back when the text arrives. */
const carrierByKey = new Map<string, { component: object; group: Group }>();
/** The key is built per rendered message; keep it while the message is the same. */
const MESSAGE_KEY = Symbol.for("pi-tidy:message-key");
function messageKeyOf(component: any): string | undefined {
  const message = component?.lastMessage;
  if (!message) return undefined;
  const cached = component[MESSAGE_KEY];
  if (cached?.message === message) return cached.key;
  const key = typeof message.timestamp === "number"
    ? `${message.role ?? "assistant"}:${message.timestamp}:${message.provider ?? ""}:${message.model ?? ""}`
    : undefined;
  component[MESSAGE_KEY] = { message, key };
  return key;
}
/** When each tool first rendered (≈ when its call appeared). */
const firstSeen = new WeakMap<object, number>();
/** Always-shown tools by call id, so the step that carried one can follow it. */
const pinnedById = new Map<string, WeakRef<ToolLike>>();
/** A tool joined a group whose summary line already rendered this frame. */
let lateJoin = false;

/** Take the runs of `component` back out of a group. */
function giveBack(group: Group, component: object): void {
  const counted = group.counted.get(component) ?? 0;
  if (counted <= 0) return;
  group.thoughts = Math.max(0, group.thoughts - counted);
  group.counted.set(component, 0);
  lateJoin = true;
}

/**
 * A step that was counted as a carrier but will not be a row of its group:
 * its text arrived (boundary), it ended without text/tool calls (plain), or
 * the tool it carries is pinned. Give its runs back, by component and by
 * message, since pi may hand the final message a fresh component.
 */
export function releaseCarrier(component: object): void {
  const own = groupOfCarrier.get(component);
  // The common case on a settled transcript: this message never carried a run
  // and no keyed carrier is waiting for it. Skip building the key at all.
  if (!own && carrierByKey.size === 0) return;
  const key = messageKeyOf(component as any);
  if (key) {
    const prior = carrierByKey.get(key);
    carrierByKey.delete(key);
    if (prior && prior.component !== component) giveBack(prior.group, prior.component);
  }
  if (own) {
    groupOfCarrier.delete(component);
    giveBack(own, component);
  }
}

/**
 * A boundary component rendered: what follows it (until the next boundary)
 * belongs to its group. Idempotent — called on every frame.
 *
 * The boundary's own thinking does **not** join the group's count. It renders
 * where it sits (above the text, pi's own label in our format) and never as a
 * row in the list, so counting it would make the summary promise rows that
 * opening the group cannot show.
 */
export function noteBoundary(component: object): void {
  // The same message may have been counted as a streaming carrier before its
  // text arrived. Its runs are not rows of that group now, so give them back
  // instead of promising rows that opening the group cannot show.
  releaseCarrier(component);
  let group = groupOfBoundary.get(component);
  if (!group) {
    group = newGroup();
    groupOfBoundary.set(component, group);
  }
  current = group;
}

/**
 * Per-message thinking growth. A run is live when its text grew inside the last
 * `THOUGHT_LIVE_MS`; that is the one signal which cannot lie, because pi's
 * private `isStreaming` flag is not guaranteed to be settled when a step ends.
 *
 * Keyed by the message, not by a group: the same run is drawn in two places —
 * a carrier's `🧠` row inside a group, and a message's own label outside one —
 * and both have to go live and settle together.
 */
const thoughtGrowth = new WeakMap<object, { chars: number; at: number | null }>();

/** Record the thinking text this render shows; only a live run grows. */
export function noteThinking(component: object, runs: readonly string[], now = Date.now()): void {
  const chars = runs.reduce((sum, run) => sum + run.length, 0);
  const growth = thoughtGrowth.get(component) ?? { chars: 0, at: null };
  // A restored session hands us a message with its whole text at once: that is
  // not growth, so it never starts a spinner when a new turn begins.
  if (chars > growth.chars && agentRunning.get()) growth.at = now;
  growth.chars = chars;
  thoughtGrowth.set(component, growth);
}

/**
 * Whether this message's thinking is still arriving: the run is open, the
 * message is still streaming, and its text grew inside the window.
 */
export function thinkingState(component: object, now = Date.now()): { live: boolean; settlesIn?: number } {
  const at = thoughtGrowth.get(component)?.at;
  if (at == null || !agentRunning.get()) return { live: false };
  if ((component as { isStreaming?: boolean }).isStreaming !== true) return { live: false };
  if (now - at >= THOUGHT_LIVE_MS) return { live: false };
  return { live: true, settlesIn: Math.max(0, THOUGHT_LIVE_MS - (now - at)) };
}

export function thinkingLive(component: object, now = Date.now()): boolean {
  return thinkingState(component, now).live;
}

export function carrierPlan(component: object, input: CarrierInput = {}): CarrierPlan {
  const { ids = [], runs, now = Date.now() } = input;
  let grew = false;
  let group = groupOfCarrier.get(component);
  if (!group) {
    group = current;
    groupOfCarrier.set(component, group);
    // A streaming step has no runs on its first frame and gains them later, so
    // the total tracks the delta rather than being set once.
    if ((runs?.length ?? 0) > 0 && group.members.length === 0 && group.headerCarrier === null) {
      group.headerCarrier = component;
    }
  }
  {
    const counted = group.counted.get(component) ?? 0;
    if (runs && runs.length > counted) {
      group.thoughts += runs.length - counted;
      group.counted.set(component, runs.length);
      // The summary rendered on the first member, before this carrier: its
      // count is one carrier short until the next frame.
      lateJoin = true;
      grew = true;
    }
  }
  if (runs) noteThinking(component, runs, now);
  if (runs && runs.length > 0) {
    const key = messageKeyOf(component as any);
    // Per frame this runs once per carriage message: re-storing the same
    // component would allocate a fresh entry for nothing.
    const prior = key === undefined ? undefined : carrierByKey.get(key);
    if (key !== undefined && (prior?.component !== component || prior.group !== group)) {
      carrierByKey.set(key, { component, group });
    }
  }
  // With calls already listed the runs stay rows of that list, whether the box
  // under them is open or not: opening it must not throw its thinking out of the group.
  if (group.members.length === 0) for (const id of ids) {
    if (!pinnedById.get(id)?.deref()?.expanded) continue;
    // No list to sit in: pi draws the step's thinking with the call's own box, so
    // those runs must not be counted in a group that will never show them.
    const included = group.counted.get(component) ?? 0;
    if (included > 0) {
      group.thoughts -= included;
      group.counted.set(component, 0);
      lateJoin = true;
    }
    return { header: null, live: false, rows: false, counted: false, plain: true };
  }
  const thought = thinkingState(component, now);
  const live = thought.live;
  // The line only lands once a call has actually joined: a carrier whose call
  // turns out to be always-shown (an edit) leaves the group empty, and a
  // summary line for a group that never happened would hang there forever.
  // Level 1 only: while folded the first member still carries the line, which
  // keeps the frame the group first appears on from being blank.
  const owns = group.headerCarrier === component && group.members.length > 0 && group.level === 1;
  return {
    header: owns ? "open" : null,
    live,
    settlesIn: thought.settlesIn,
    // Folded, a step that is still thinking keeps one row: the sliding window
    // under the summary shows what it is working on without opening anything.
    // Once the tokens stop the row goes: a `thinking` line next to nothing is
    // worse than the count that replaced it.
    // An opened group with no members at all (`groupOpen` and a step whose only
    // call is always-shown, an edit say) lists nothing: its rows would hang
    // under a header that never materialised.
    rows: (runs?.length ?? 0) > 0 && ((group.level === 1 && group.members.length > 0) || live),
    // The gap belongs to the opened list only; it is what makes steps read as
    // blocks there. Folded there is nothing but that one live row.
    // Rhythm only where it earns its keep: a two-row group reads fine tight, and
    // a gap there looks like a stray blank line under the summary.
    counted: grew,
    plain: false,
  };
}

function join(tool: ToolLike): Group {
  const known = groupOf.get(tool);
  if (known) return known;
  const group = current;
  // The summary sits on the first member, which rendered before this one:
  // its count is one short until the next frame. An expanded newcomer also
  // un-hides its carrier, which rendered before it too.
  if (group.members.length > 0 || tool.expanded || group.headerCarrier) lateJoin = true;
  group.members.push(tool);
  firstSeen.set(tool, Date.now());
  // pi hands a new box `setExpanded(toolOutputExpanded)` before it ever
  // renders: arriving already expanded means ctrl+o's expand-all is on.
  if (tool.expanded) group.level = 1;
  groupOf.set(tool, group);
  return group;
}

/**
 * Whether a tool joined an existing group since the last call. The render
 * patch then asks pi for one more frame, so the summary line catches up.
 */
export function takeLateJoin(): boolean {
  const late = lateJoin;
  lateJoin = false;
  return late;
}

/**
 * `pinned`: the tool is in `alwaysShowTools`. It draws pi's own box and acts as
 * a boundary — whatever follows it starts a new group.
 */
/** Ms the call (or its job) has been running, or undefined when nothing runs. */
function runningFor(tool: ToolLike, job: JobTiming | undefined, now: number): number | undefined {
  if (job?.status === "running") return now - (job.startTime ?? now);
  if (tool.isPartial) return now - (firstSeen.get(tool) ?? now);
  return undefined;
}

/** Whether the current group already holds calls (we're mid-segment). */
export function currentGroupHasMembers(): boolean {
  return current.members.length > 0;
}

export function planFor(tool: ToolLike, pinned = false, job?: JobTiming, now = Date.now()): ViewPlan {
  if (pinned) {
    if (tool.toolCallId && !pinnedById.has(tool.toolCallId)) {
      pinnedById.set(tool.toolCallId, new WeakRef(tool));
      // Its carrier rendered just before it, before it could be found.
      if (tool.expanded) lateJoin = true;
    }
    if (!groupAbovePinned.has(tool)) groupAbovePinned.set(tool, current);
    noteBoundary(tool);
    return PINNED;
  }
  const group = join(tool);
  // A leading carrier takes the line over once the group is open (it renders
  // above the first member there); folded, the member keeps it.
  const header =
    group.members[0] === tool && (!group.headerCarrier || group.level === 0)
      ? group.level === 0
        ? "closed"
        : "open"
      : null;
  if (group.level === 0) {
    // 运行中的那个露一行 B,否则长命令跑三十秒时 C 行一动不动(跑满一秒才露,
    // 免得几十毫秒的调用闪一下)。失败的不再挂行:一个五十来个调用的折叠组,
    // 每条失败都在下面吊一行红色,折叠就白折了——摘要行带着 `✗ N failed`,
    // 要看是哪一条就点开。后台任务同理,只有还在跑的才露。
    const age = runningFor(tool, job, now);
    if (age === undefined) return { header, line: false, full: false, gutter: true };
    if (age >= RUNNING_ROW_DELAY_MS) return { header, line: true, full: false, gutter: true };
    return { header, line: false, full: false, gutter: true, revealIn: RUNNING_ROW_DELAY_MS - age };
  }
  return { header, line: !tool.expanded, full: tool.expanded, gutter: true };
}

/** The group that was open when a pinned tool ended it. */
const groupAbovePinned = new WeakMap<object, Group>();

/**
 * Whether a group's rail meets this pinned box. Only an open group has a rail. Above:
 * the group it ended is open, so its rail comes down to the box's corner. Below: the
 * group behind it is open, so its rail leaves from the other corner. Any text in
 * between is a boundary of its own and leaves the group behind this box empty.
 */
export function pinnedJoints(tool: object): { above: boolean; below: boolean } {
  const before = groupAbovePinned.get(tool);
  const after = groupOfBoundary.get(tool);
  const hasRail = (group: Group | undefined) => !!group && group.level === 1 && group.members.length > 0;
  return { above: hasRail(before), below: hasRail(after) };
}

/** The calls this component's group holds, in render order. */
export function groupMembers(component: object): readonly ToolLike[] {
  return groupFor(component)?.members ?? [];
}

/**
 * Whether earlier steps already sit in this group: true when the first call this
 * carrier issued is not the group's first member. Derived from membership rather
 * than a "first carrier" flag, because a step can have no carrier at all (a
 * tool-only step) and the next step still needs its gap.
 */
function cameBefore(ids: readonly string[], group: Group): boolean {
  if (ids.length > 0) {
    const first = group.members.findIndex((member) => member.toolCallId !== undefined && ids.includes(member.toolCallId));
    if (first >= 0) return first > 0;
  }
  return group.members.length > 0;
}

/** The group a component belongs to — a tool or a carrier message. */
function groupFor(component: object): Group | undefined {
  return groupOf.get(component as ToolLike) ?? groupOfCarrier.get(component);
}

/** Whether any run this group lists is still arriving (the summary spins). */
function livesNow(group: Group, now: number): boolean {
  if (!agentRunning.get()) return false;
  for (const [component, counted] of group.counted) {
    // A carrier whose call renders as pi's own box is not in this list: its
    // thinking belongs to pi's rendering, not to this line.
    if (counted > 0 && thinkingLive(component, now)) return true;
  }
  return false;
}

export function summaryFor(
  tool: object,
  jobOf?: (member: ToolLike) => JobTiming | JobTiming[] | undefined,
  now = Date.now(),
): GroupSummary | undefined {
  const group = groupFor(tool);
  if (!group) return undefined;
  return buildGroupSummary(
    group.members.map((member) => {
      const found = jobOf?.(member);
      const jobs = Array.isArray(found) ? found : found ? [found] : [];
      const job = jobs.find((job) => job.status === "running");
      const age = runningFor(member, job, now);
      return {
        toolName: member.toolName,
        isPartial: member.isPartial,
        isError: member.result?.isError === true,
        durationMs: member.isPartial ? undefined : member.result?.durationMs,
        jobs: jobs.map((job) => ({
          status: job.status,
          fresh: job.status === "running" && now - (job.startTime ?? now) < RUNNING_ROW_DELAY_MS,
        })),
        fresh: age !== undefined && age < RUNNING_ROW_DELAY_MS,
      };
    }),
    group.thoughts,
    livesNow(group, now),
  );
}

export function groupIsOpen(component: object): boolean {
  return groupFor(component)?.level === 1;
}

/** Level 0 → 1: the summary line unfolds into one row per call. */
export function openGroup(component: object): void {
  const group = groupFor(component);
  if (group) group.level = 1;
}

/**
 * Level 1 → 0 from the `▾` header. Returns the members still showing a full
 * box; the caller folds them through pi's `setExpanded`, so reopening the
 * group starts from plain rows again.
 */
export function closeGroup(component: object): ToolLike[] {
  const group = groupFor(component);
  if (!group) return [];
  group.level = 0;
  return group.members.filter((member) => member.expanded);
}

/**
 * pi calls `setExpanded` for `ctrl+o` (every box, `fromPointer` false) and for
 * a click on a full box (that one box, `fromPointer` true).
 *
 * Expanding anything opens the group, so the rows become reachable. Collapsing
 * from a click folds that box back into its row; collapsing from ctrl+o's
 * collapse-all returns the whole group to its summary line.
 */
export function noteSetExpanded(tool: object, expanded: boolean, fromPointer: boolean): void {
  const group = groupFor(tool);
  if (!group) return;
  if (expanded) group.level = 1;
  else if (!fromPointer) group.level = 0;
}

/** Test seam: forget the current group (WeakMaps drop with their components). */
export function resetGroups(): void {
  current = newGroup();
  lateJoin = false;
  carrierByKey.clear();
}
