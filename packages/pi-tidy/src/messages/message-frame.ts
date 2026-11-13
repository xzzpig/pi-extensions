/**
 * Rounded transparent frames for the message boxes pi draws outside tool
 * calls: compaction / branch / skill summaries, extension custom messages and
 * user messages in the "frame" style.
 *
 * Options live in global slots (see live.ts): every call updates them, and only
 * the first one installs the prototype patches, so a `/reload` with different
 * settings — including `frameMessages: false` — takes effect without a restart.
 */

import {
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  SkillInvocationMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import {
  clipToWidth,
  drawFrame,
  formatMessageTime,
  type HeaderStyle,
  italicDim,
  labeledTopBorder,
  messageHeader,
  sameLines,
  stripBackgroundFills,
  trimBlankEdges,
  trimTrailingSpaces,
  visibleText,
} from "../draw/frame-draw.ts";
import { MESSAGE_ICONS, TOOL_ICONS } from "../draw/icons.ts";
import { liveSlot, optionsRevision, tidyEnabled } from "../live.ts";
import { noticeBodyText, noticeLabel, noticeText, type NoticeLabel } from "./extension-notice.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";
import { installUserMessageTimes, USER_MESSAGE_TIME } from "./user-message.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Message boxes (compaction / branch summary)
// ═══════════════════════════════════════════════════════════════════════════

interface MessageBoxInternals {
  children: Array<{ render(width: number): string[] }>;
  expanded: boolean;
  render(width: number): string[];
  __msgFrameCache?: { width: number; sample: string; revision: number; lines: string[]; out: string[] };
}

interface MessageBoxOptions {
  enabled: boolean;
  borderColors: { compaction: string; branch: string; skill: string };
  icons: boolean;
}

const messageOptions = liveSlot<MessageBoxOptions | undefined>("message-box-options", undefined);

/**
 * Compaction, branch-summary, and skill-invocation boxes are plain `Box`es
 * with a filled `customMessageBg` background — ToolExecutionComponent never
 * sees them, so the tool frame patch leaves them in pi's default style. They
 * get the same rounded, transparent frame here, each drawn in its own color
 * from `borderColors` to keep them distinct from the tool state colors and
 * from each other. Children are rendered directly, skipping the Box's
 * background fill and padding, so the frame is the only chrome; on any
 * mismatch the original Box render runs.
 *
 * `enabled: false` turns installed patches into pass-throughs and installs
 * nothing new.
 */
export function patchMessageBoxes(
  borderColors: { compaction: string; branch: string; skill: string },
  icons = false,
  enabled = true,
): void {
  messageOptions.set({ enabled, borderColors, icons });
  if (!enabled) return;
  for (const [cls, kind] of [
    [CompactionSummaryMessageComponent, "compaction"],
    [BranchSummaryMessageComponent, "branch"],
    [SkillInvocationMessageComponent, "skill"],
  ] as const) {
    const proto = cls.prototype as unknown as MessageBoxInternals & { __toolboxFramed?: boolean };
    if (proto.__toolboxFramed) continue;
    proto.__toolboxFramed = true;

    const originalRender = proto.render;
    const icon = MESSAGE_ICONS[kind];

    proto.render = function (this: MessageBoxInternals, width: number): string[] {
      const options = messageOptions.get();
      const theme = getTheme();
      if (!theme || !options?.enabled || !tidyEnabled.get()) return originalRender.call(this, width);
      try {
        const { icons } = options;
        const borderColor = options.borderColors[kind];
        const w = Math.max(4, width);
        // Frame + one cell of horizontal padding on each side (+2 for the icon).
        const contentWidth = Math.max(1, icons ? w - 6 : w - 4);
        const content: string[] = [];
        for (const child of this.children) {
          for (const line of child.render(contentWidth)) {
            content.push(stripBackgroundFills(line));
          }
        }
        if (content.length === 0) return [];
        // The border color escape acts as a theme sample — a theme switch
        // with identical content must not hit the cache.
        const sample = theme.fg(borderColor, "·");
        const cache = this.__msgFrameCache;
        const revision = optionsRevision();
        if (
          cache &&
          cache.width === w &&
          cache.sample === sample &&
          cache.revision === revision &&
          sameLines(cache.lines, content)
        )
          return cache.out;
        // pi draws the kind label on a row of its own above the body
        // (`[branch]`, `[compaction]`, `[skill]`). That row is a title, not
        // content, so it goes into the top border and the `Spacer(1)` under it
        // goes with it — the border is the separation now. A collapsed skill
        // box keeps its label inline: it shares the row with the skill's name.
        const lifted = content[0] !== undefined && visibleText(content[0]).trim() === `[${kind}]`
          ? trimTrailingSpaces(content[0]).trim()
          : "";
        const body = lifted ? trimBlankEdges(content.slice(1)) : content;
        const label = lifted && icons ? `${theme.fg(borderColor, icon)} ${lifted}` : lifted;
        const padded = body.map((line, i) => (icons && i === 0 && !label ? ` ${icon} ${line}` : ` ${line}`));
        // No blank row above the frame: pi puts a `Spacer(1)` in front of a
        // compaction, branch and skill box already (interactive-mode), and the
        // border is a separation in itself. A second row read as a stray gap
        // (issue #29).
        const out = drawFrame(padded, w, theme, borderColor);
        if (label) out[0] = labeledTopBorder(w, theme, borderColor, clipToWidth(label, Math.max(1, w - 6)));
        this.__msgFrameCache = { width: w, sample, revision, lines: content, out };
        return out;
      } catch {
        return originalRender.call(this, width);
      }
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Container boxes (user messages / extension custom messages)
// ═══════════════════════════════════════════════════════════════════════════

// OSC 133 zone markers UserMessageComponent puts on its first/last line —
// terminals use them for prompt navigation, so the framed output keeps them
// in the same positions.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface ContainerBoxInternals {
  children: Array<{ render(width: number): string[] }>;
  /** CustomMessageComponent's default box; absent on UserMessageComponent. */
  box?: { render(width: number): string[] };
  /** Set when an extension renderer supplies its own styled component. */
  customComponent?: CustomRender;
  render(width: number): string[];
  /** Where the extension component's rows ended up inside the frame we drew. */
  __customFrame?: { target: CustomRender; top: number; trimTop: number; inset: number; width: number; height: number; rows: number };
  /** A notice Tidy drew itself: the rows a click on it may land on. */
  __noticeFrame?: { rows: number };
  __msgFrameCache?: { width: number; sample: string; revision: number; labelMinute: number; labelTime: number | undefined; lines: string[]; out: string[] };
}

interface CustomRender {
  render(width: number): string[];
  handleMouse?(event: unknown): unknown;
}

/**
 * User and extension custom messages are `Container`s whose visible box is an
 * inner `Box` with a filled background. The frame replaces that chrome: the
 * inner box renders one frame-width narrower, its background fills and
 * vertical padding rows are stripped, and the rounded border takes over —
 * the box's own horizontal padding is kept as the insets.
 */
export interface ContainerBoxOptions {
  icons?: boolean;
  /**
   * Frame user messages too (`userMessageStyle: "frame"`). The default
   * "rail" style is drawn by user-message.ts. While false, this patch leaves
   * UserMessageComponent alone (and is not installed if it never was).
   */
  includeUser?: boolean;
  /** Align the framed user message and its label; other message kinds stay left. */
  userAlign?: "left" | "right";
  /** The widest a framed user message's text gets: `"auto"`, a fraction of the width, or columns. */
  userMaxWidth?: number | "auto";
  /** The framed user message's time next to its icon. */
  userTime?: boolean;
  /** `tidy.messageTimeFormat`. */
  timeFormat?: string;
  /** `tidy.messageHeaderStyle`. */
  headerStyle?: HeaderStyle;
  /** False turns installed patches into pass-throughs and installs nothing new. */
  enabled?: boolean;
}

interface ResolvedContainerOptions {
  enabled: boolean;
  borderColors: { user: string; custom: string };
  icons: boolean;
  includeUser: boolean;
  userAlign: "left" | "right";
  userMaxWidth: number | "auto";
  userTime: boolean;
  timeFormat: string;
  headerStyle: HeaderStyle;
}

const containerOptions = liveSlot<ResolvedContainerOptions | undefined>("container-box-options", undefined);

/**
 * A user message's frame hugs its text: a one-word prompt gets a small box
 * instead of a full-width one, and a long one still stops at the full width, or
 * at `userMessageMaxWidth` when that is narrower. The text keeps the one-cell
 * inset it has on the left on its right as well.
 * The box stays wider than its label: `╭─ ` and ` ─╮` alone leave the top border
 * a stub on each side, which reads as a cramped label and not as a border (#49).
 */
function hugContent(content: string[], width: number, labelWidth: number): { lines: string[]; width: number } {
  const lines = content.map(trimTrailingSpaces);
  const widest = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const floor = labelWidth > 0 ? labelWidth + 10 : 0;
  return { lines, width: Math.min(width, Math.max(widest + 3, floor)) };
}

/**
 * How wide a framed user message's text renders, in cells: everything inside the
 * border by default, otherwise the `userMessageMaxWidth` cap. A cap below 1 is a
 * fraction of the width pi gave the message. The frame then hugs the wrapped
 * text, and `hugContent` still keeps room for the label.
 */
function userTextWidth(maxWidth: number | "auto", width: number): number {
  const inside = width - 2;
  if (maxWidth === "auto") return inside;
  const columns = maxWidth <= 1 ? maxWidth * width : maxWidth;
  return Math.max(1, Math.min(inside, Math.floor(columns)));
}

/** Rows of a notice's own text shown before it is opened. */
const NOTICE_LINES = 1;
/** Open state per message object: pi keeps the message across rebuilds. */
const noticeOpen = new WeakMap<object, boolean>();
/** Markdown costs more than the frame around it, so its rows are kept per message. */
const noticeBodies = new WeakMap<object, { key: string; lines: string[] }>();

/** The notice's own text as rows: one row while closed, everything once open. */
function noticeBody(message: object & { content?: unknown }, width: number, open: boolean, theme: ThemeLike, label: NoticeLabel): string[] {
  const text = noticeBodyText(message, label).trim();
  if (!text) return [];
  const key = `${width}:${open}:${label.name ?? ""}:${label.status ?? ""}`;
  const cached = noticeBodies.get(message);
  if (cached?.key === key) return cached.lines;
  const rows = new Markdown(text, 0, 0, getMarkdownTheme(), { color: (line: string) => theme.fg("customMessageText", line) }).render(width);
  const lines = open ? rows : rows.slice(0, NOTICE_LINES);
  noticeBodies.set(message, { key, lines });
  return lines;
}

/**
 * A notice Tidy draws itself: `╭─ <icon> worker needs attention ─╮`, the text
 * the model read as the body, and a click that opens the rest of it. The
 * extension's own component is not drawn — its first row is the label that just
 * went into the border, and its `(ctrl+o to expand)` was chrome Tidy does not
 * put on a row that is already a header.
 */
function frameNotice(
  component: ContainerBoxInternals & { message?: { customType?: unknown; content?: unknown } },
  notice: NoticeLabel,
  width: number,
  live: ResolvedContainerOptions,
  theme: ThemeLike,
): string[] {
  const { icons } = live;
  const tone = notice.tone ?? live.borderColors.custom;
  const w = Math.max(4, width);
  const contentWidth = Math.max(1, icons ? w - 4 : w - 2);
  const message = component.message ?? {};
  const open = noticeOpen.get(message) ?? (component as unknown as { _expanded?: boolean })._expanded === true;
  const body = noticeBody(message, contentWidth, open, theme, notice);
  const label = [
    icons ? theme.fg(tone, TOOL_ICONS.subagent!) : "",
    notice.name ?? "",
    notice.status ? theme.fg(tone, notice.status) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const clipped = clipToWidth(label, Math.max(1, w - 6));
  const out = drawFrame(body.map((line) => ` ${line}`), w, theme, tone);
  // The glyph fills the cell the width table gives it, so the label is one cell
  // wider than measured whenever it leads with one.
  out[0] = labeledTopBorder(w, theme, tone, clipped, "left", 1, visibleWidth(clipped) + (icons ? 1 : 0));
  component.__noticeFrame = { rows: out.length };
  return out;
}

function customKindIcon(component: ContainerBoxInternals, icons: boolean): string {
  if (!icons) return "";
  const type = (component as unknown as { message?: { customType?: unknown } }).message?.customType;
  // pi-subagents names its fourteen notice types `subagent-…`/`subagent_…`; the
  // rest are extensions with no glyph of their own, and get the custom one.
  return typeof type === "string" && type.startsWith("subagent") ? TOOL_ICONS.subagent! : MESSAGE_ICONS.custom;
}

/**
 * Frame a message whose body an extension renderer drew.
 *
 * The rows are the extension's, so they keep their own ordering and are only
 * trimmed of the blank edges its box wanted around itself — the frame is the
 * separation now. The component renders one frame narrower than the row it
 * lands on, and everything inside it moved down one row and right two cells,
 * which is what `customMouse` maps back.
 */
function frameCustom(
  component: ContainerBoxInternals,
  custom: CustomRender,
  width: number,
  live: ResolvedContainerOptions,
  theme: ThemeLike,
): string[] {
  const { icons } = live;
  const borderColor = live.borderColors.custom;
  const w = Math.max(4, width);
  // Border, then the one-cell inset every body row gets (and two more when the
  // icon is drawn into the border, which no row of the body has to make room for).
  const contentWidth = Math.max(1, icons ? w - 4 : w - 2);
  const raw = custom.render(contentWidth);
  let start = 0;
  let end = raw.length;
  while (start < end && visibleText(raw[start]!).trim() === "") start++;
  while (end > start && visibleText(raw[end - 1]!).trim() === "") end--;
  const content = raw.slice(start, end);
  component.__customFrame = content.length
    ? { target: custom, top: 1, trimTop: start, inset: 2, width: contentWidth, height: raw.length, rows: content.length }
    : undefined;
  if (content.length === 0) return [];
  const out = drawFrame(content.map((line) => ` ${line}`), w, theme, borderColor);
  const glyph = customKindIcon(component, icons);
  if (glyph) out[0] = labeledTopBorder(w, theme, borderColor, theme.fg(borderColor, glyph));
  return out;
}

export function patchContainerBoxes(
  borderColors: { user: string; custom: string },
  options: ContainerBoxOptions = {},
): void {
  const { icons = false, includeUser = false, enabled = true, userAlign = "left", userMaxWidth = "auto", userTime = true, timeFormat = "auto", headerStyle = "inline" } = options;
  containerOptions.set({ enabled, borderColors, icons, includeUser, userAlign, userMaxWidth, userTime, timeFormat, headerStyle });
  if (!enabled) return;
  if (includeUser) installUserMessageTimes();

  const patch = (cls: { prototype: unknown }, kind: "user" | "custom") => {
    const proto = cls.prototype as ContainerBoxInternals & { __toolboxFramed?: boolean };
    if (proto.__toolboxFramed) return;
    proto.__toolboxFramed = true;

    const originalRender = proto.render;
    const icon = MESSAGE_ICONS[kind];
    const isUserMessage = kind === "user";

    proto.render = function (this: ContainerBoxInternals, width: number): string[] {
      const live = containerOptions.get();
      const theme = getTheme();
      if (!theme || !live?.enabled || !tidyEnabled.get() || (isUserMessage && !live.includeUser)) {
        return originalRender.call(this, width);
      }
      try {
        // pi-subagents' notices are drawn from the message itself: the label in
        // the border, the text the model read as the body. Its own component is
        // not drawn — the first row of it is that label, and its
        // `(ctrl+o to expand)` was chrome on a row that is already a header.
        const message = (this as unknown as { message?: Parameters<typeof noticeLabel>[0] & { content?: unknown } }).message;
        const notice = noticeLabel(message);
        // A notice with nothing to say keeps its renderer: an empty frame would
        // hide whatever its rows were.
        if (notice && (notice.name || notice.status || noticeText(message).trim())) {
          this.__customFrame = undefined;
          return frameNotice(this, notice, width, live, theme);
        }
        // Everything else: the extension owns the rows, Tidy owns the frame around
        // them. Its fills go and its blank edges are trimmed, and its kind goes in
        // the top border instead of the `[type]` row pi's own box would draw.
        const custom = this.customComponent;
        if (custom && typeof custom.render === "function") return frameCustom(this, custom, width, live, theme);
        const box = this.box ?? this.children[0];
        if (!box) return originalRender.call(this, width);

        const { icons } = live;
        const align = isUserMessage ? live.userAlign : "left";
        const borderColor = live.borderColors[kind];
        const userTime = isUserMessage && live.userTime ? (this as any)[USER_MESSAGE_TIME] : undefined;
        // The clock is painted into the border every frame, but its text only
        // changes when the day it belongs to rolls over. Key the cache on the
        // minute the label was built for and format the two dates on a miss,
        // not on every rendered row.
        const labelMinute = isUserMessage && icons && typeof userTime === "number" ? Math.floor(Date.now() / 60_000) : 0;
        const w = Math.max(4, width);
        // A custom message's icon takes two cells of its first row; rendering
        // the box narrower keeps every line lossless. A user message carries
        // its icon in the label instead, and its text stops at its own cap.
        const iconInRow = icons && !isUserMessage;
        const boxWidth = isUserMessage ? userTextWidth(live.userMaxWidth, w) : w - 2;
        const raw = box.render(iconInRow ? w - 4 : boxWidth).map(stripBackgroundFills);
        let content = trimBlankEdges(raw);
        if (content.length === 0) return [];
        // A custom message's `[type]` row is a title too, and goes into the top
        // border with the spacer under it. Only the custom kind: a user
        // message's first row is its own text, which may well be a bare
        // `[word]`, and a label there would be the user's, not ours.
        const customType = (this as any).message?.customType;
        const labelText = !isUserMessage && typeof customType === "string" ? `[${customType}]` : "";
        const lifted = labelText && visibleText(content[0]).trim() === labelText ? trimTrailingSpaces(content[0]).trim() : "";
        if (lifted) content = trimBlankEdges(content.slice(1));
        if (iconInRow && !lifted) content[0] = ` ${icon} ${content[0].replace(/^ +/, "")}`;
        const label = lifted && icons ? `${theme.fg(borderColor, icon)} ${lifted}` : lifted;

        const sample = theme.fg(borderColor, "·");
        const cache = this.__msgFrameCache;
        const revision = optionsRevision();
        if (
          cache &&
          cache.width === w &&
          cache.sample === sample &&
          cache.revision === revision &&
          cache.labelMinute === labelMinute &&
          cache.labelTime === userTime &&
          sameLines(cache.lines, content)
        )
          return cache.out;

        const header = isUserMessage && icons
          ? messageHeader(
              theme,
              borderColor,
              theme.fg(borderColor, icon),
              typeof userTime === "number" ? italicDim(theme, formatMessageTime(userTime, live.timeFormat)) : "",
              live.headerStyle,
              w,
            )
          : undefined;

        // A leading blank row separates the box from the transcript above it.
        // Custom messages need it: pi adds no spacer of its own there. A user
        // message gets a `Spacer(1)` from pi already, and its top border is a
        // separation in itself, so a second row reads as a stray gap.
        let out: string[];
        if (isUserMessage) {
          // `╭─  ─╮`: the icon is the frame's, so the text starts on its own
          // row and copies without it. No icons, no label: a plain top border.
          const framed = hugContent(content, w, visibleWidth(header?.label ?? ""));
          const frame = drawFrame(framed.lines, framed.width, theme, borderColor);
          if (header) frame[0] = labeledTopBorder(framed.width, theme, borderColor, header.label, align, header.lead);
          const indent = align === "right" ? " ".repeat(w - framed.width) : "";
          out = indent ? frame.map((line) => indent + line) : frame;
        } else {
          const framed = drawFrame(content, w, theme, borderColor);
          if (label) framed[0] = labeledTopBorder(w, theme, borderColor, clipToWidth(label, Math.max(1, w - 6)));
          out = ["", ...framed];
        }
        if (isUserMessage) {
          out[0] = OSC133_ZONE_START + out[0];
          out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
        }
        this.__msgFrameCache = { width: w, sample, revision, labelMinute, labelTime: userTime, lines: content, out };
        return out;
      } catch {
        this.__customFrame = undefined;
        return originalRender.call(this, width);
      }
    };

    // The rows inside the frame are the extension's, and the border moved them
    // down one row and right two cells. pi's own handler would measure the
    // child, not the frame, so without this a click lands a row above what it
    // points at, and its column is off by the border.
    const inheritedMouse = (proto as unknown as { handleMouse?: (event: any) => unknown }).handleMouse;
    (proto as unknown as Record<string, unknown>).handleMouse = function (this: ContainerBoxInternals, event: any) {
      const live = containerOptions.get();
      if (!live?.enabled || !tidyEnabled.get()) return inheritedMouse?.call(this, event);
      // A notice Tidy drew has no component under the pointer: the whole frame
      // is the switch, and the rows are its own.
      const notice = this.__noticeFrame;
      if (notice) {
        if (event?.y < 0 || event.y >= notice.rows) return undefined;
        if (event.type !== "click" || (event.button !== "left" && event.button !== 0)) return undefined;
        const message = (this as unknown as { message?: object }).message;
        if (message) noticeOpen.set(message, !(noticeOpen.get(message) ?? (this as unknown as { _expanded?: boolean })._expanded === true));
        return { handled: true, render: true };
      }
      const geometry = this.__customFrame;
      const inside = geometry && event?.y >= geometry.top && event.y < geometry.top + geometry.rows;
      if (!geometry || !inside || typeof geometry.target.handleMouse !== "function") {
        return inheritedMouse?.call(this, event);
      }
      return geometry.target.handleMouse({
        ...event,
        x: event.x - geometry.inset,
        y: event.y - geometry.top + geometry.trimTop,
        width: geometry.width,
        height: geometry.height,
      });
    };
  };

  if (includeUser) patch(UserMessageComponent, "user");
  patch(CustomMessageComponent, "custom");
}
