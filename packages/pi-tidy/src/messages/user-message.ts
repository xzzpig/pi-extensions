/**
 * User messages as a rail: a full-width rule above and below and an accent `│`
 * in front of every content row; the "rules" style is the same without the `│`.
 * With `icons`, the user icon and the message's time sit in the top rule, as they
 * sit in the frame style's top border.
 *
 * pi's UserMessageComponent is one Markdown child that already carries the
 * markdown theme, pi's markdown options and the registered markdown
 * transformers (pi-ide-context's selection references among them). The rail
 * renders that child narrower and replaces only its chrome — the
 * background fill and the blank padding rows — so the text pipeline stays
 * pi's own.
 *
 * `userMessageStyle: "frame"` is drawn by message-frame.ts instead; this patch
 * passes through for "frame" and "off", so the two stack in either order.
 */

import { InteractiveMode, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  formatMessageTime,
  type HeaderStyle,
  italicDim,
  labeledRule,
  messageHeader,
  sameLines,
  stripBackgroundFills,
  trimBlankEdges,
} from "../draw/frame-draw.ts";
import { MESSAGE_ICONS } from "../draw/icons.ts";
import { liveSlot, optionsRevision, tidyEnabled } from "../live.ts";
import { paint } from "../draw/paint.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";

export type UserMessageStyle = "rail" | "rules" | "frame" | "off";

export interface UserMessageOptions {
  style: UserMessageStyle;
  /** Theme color name or `#rrggbb`. */
  railColor: string;
  /** Theme color name or `#rrggbb`. */
  ruleColor: string;
  /** Rail-only rows between each rule and the text. */
  paddingY: number;
  /** The user icon in the top rule (`tidy.icons`). */
  icons: boolean;
  /** The message's time next to the icon (`tidy.userMessageTime`). */
  time: boolean;
  /** The end of the top rule the label sits at. The rail and the text stay left. */
  align: "left" | "right";
  /** `tidy.messageTimeFormat`. */
  timeFormat: string;
  /** `tidy.messageHeaderStyle`. */
  headerStyle: HeaderStyle;
}

/**
 * The rail glyph is fixed: clean-copy.ts recognises user message rows by it and
 * strips it from the clipboard, and older pi-starline versions do the same.
 */
export const USER_RAIL_GLYPH = "│";

// OSC 133 zone markers pi puts on the first/last line — terminals use them for
// prompt navigation, so the rail keeps them in the same positions.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface UserMessageInternals {
  children: Array<{ render(width: number): string[] }>;
  /** Horizontal padding pi gives the Markdown child (1 by default). */
  outputPad?: number;
  render(width: number): string[];
  __tidyRailCache?: {
    width: number;
    /** `optionsRevision()` when it was built: every option a rail reads, in one number. */
    revision: number;
    sample: string;
    labelMinute: number;
    labelTime: number | undefined;
    raw: string[];
    out: string[];
  };
}

/** Where the user message's clock is kept: pi's component only holds the text. */
export const USER_MESSAGE_TIME = Symbol.for("pi-tidy:user-message-time");
const USER_TIME_PATCH = Symbol.for("pi-tidy:user-time-patch");

export function installUserMessageTimes(): void {
  const proto = (InteractiveMode as any)?.prototype;
  const original = proto?.addMessageToChat;
  if (typeof original !== "function" || original[USER_TIME_PATCH]) return;
  const wrapped = function (this: any, message: any, options?: any) {
    const chat = this?.chatContainer;
    const before = Array.isArray(chat?.children) ? chat.children.length : -1;
    const result = original.call(this, message, options);
    if (message?.role === "user" && typeof message.timestamp === "number" && before >= 0) {
      for (let i = before; i < chat.children.length; i++) {
        const child = chat.children[i];
        if (child instanceof UserMessageComponent) (child as any)[USER_MESSAGE_TIME] = message.timestamp;
      }
    }
    return result;
  };
  (wrapped as any)[USER_TIME_PATCH] = true;
  proto.addMessageToChat = wrapped;
}

/** The child's left padding, behind the styles pi resets in front of it (`\x1b[49m \x1b[39mtext`). */
const LEADING_PAD_RE = /^((?:\x1b\[[0-9;:]*m)*) /;

const userMessageOptions = liveSlot<UserMessageOptions | undefined>("user-message-options", undefined);

function renderRail(
  component: UserMessageInternals,
  width: number,
  theme: ThemeLike,
  options: UserMessageOptions,
): string[] | undefined {
  // Row layout: rail, a space, text. The child pads its text by `outputPad` on both
  // sides; one cell of that on the left is taken off again, so it renders that much
  // wider than the text it holds.
  // Without the rail the child keeps its full width and its padding is the text's inset.
  const flat = options.style === "rules";
  const childPad = (component.outputPad ?? 1) > 0;
  const childWidth = flat ? width : width - 2 + (childPad ? 1 : 0);
  const raw: string[] = [];
  for (const child of component.children) raw.push(...child.render(childWidth));

  const rail = paint(theme, options.railColor, USER_RAIL_GLYPH);
  const rule = paint(theme, options.ruleColor, "─".repeat(width));
  const time = options.icons && options.time ? (component as any)[USER_MESSAGE_TIME] : undefined;
  // A message's clock text changes only when its day rolls over, so the label is
  // built on a cache miss and the minute is what expires it.
  const labelMinute = typeof time === "number" ? Math.floor(Date.now() / 60_000) : 0;
  // The painted cells double as a theme sample: a theme switch with identical
  // content must not hit the cache.
  const sample = rail + rule;
  const revision = optionsRevision();
  const cache = component.__tidyRailCache;
  if (
    cache &&
    cache.width === width &&
    cache.revision === revision &&
    cache.sample === sample &&
    cache.labelMinute === labelMinute &&
    cache.labelTime === time &&
    sameLines(cache.raw, raw)
  )
    return cache.out;

  const content = trimBlankEdges(raw.map(stripBackgroundFills));
  if (content.length === 0) return undefined;

  const header = options.icons
    ? messageHeader(
        theme,
        options.ruleColor,
        paint(theme, options.railColor, MESSAGE_ICONS.user),
        typeof time === "number" ? italicDim(theme, formatMessageTime(time, options.timeFormat)) : "",
        options.headerStyle,
        width,
      )
    : { label: "", lead: 1 };
  const padRows = Array.from({ length: options.paddingY }, () => (flat ? "" : rail));
  const rows = flat ? content : content.map((line) => `${rail} ${childPad ? line.replace(LEADING_PAD_RE, "$1") : line}`);
  const out = [labeledRule(width, theme, options.ruleColor, header.label, options.align, header.lead), ...padRows, ...rows, ...padRows, rule];
  out[0] = OSC133_ZONE_START + out[0];
  out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
  component.__tidyRailCache = {
    width,
    revision,
    sample,
    labelMinute,
    labelTime: time,
    raw,
    out,
  };
  return out;
}

/**
 * Install the rail patch once; later calls (a `/reload`) only update the
 * options it reads. "frame" or "off", `tidy.enabled: false`, a missing
 * theme or a render error falls through to the render underneath.
 */
export function patchUserMessages(options: UserMessageOptions): void {
  userMessageOptions.set(options);
  if (options.style === "rail" || options.style === "rules") installUserMessageTimes();
  const proto = UserMessageComponent.prototype as unknown as UserMessageInternals & { __tidyUserRail?: boolean };
  if (proto.__tidyUserRail) return;
  proto.__tidyUserRail = true;

  const originalRender = proto.render;
  proto.render = function (this: UserMessageInternals, width: number): string[] {
    const live = userMessageOptions.get();
    const theme = getTheme();
    if (!theme || (live?.style !== "rail" && live?.style !== "rules") || !tidyEnabled.get() || width < 6) {
      return originalRender.call(this, width);
    }
    try {
      return renderRail(this, width, theme, live) ?? originalRender.call(this, width);
    } catch {
      return originalRender.call(this, width);
    }
  };
}
