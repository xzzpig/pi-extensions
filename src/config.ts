import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HeaderStyle } from "./draw/frame-draw.ts";
import type { UserMessageStyle } from "./messages/user-message.ts";
import type { CollapseTurns, FinalReplyStyle } from "./turns/turn-state.ts";

export interface MessageBorderColors {
  /** The final reply's frame, an open run's rail and its `▾` marker. Also `#rrggbb`. */
  assistant: string;
  user: string;
  compaction: string;
  branch: string;
  skill: string;
  custom: string;
}

export interface TidyConfig {
  enabled: boolean;
  highlightBash: boolean;
  /** Give message boxes the same rounded transparent frame as tool boxes. */
  frameMessages: boolean;
  /**
   * How user messages look: "frame" (the rounded message frame, hugging the
   * text, the user icon in its top border), "rail" (rules above and below, an
   * accent `│` in front of the text), "rules" (only the rules) or "off" (pi's own).
   */
  userMessageStyle: UserMessageStyle;
  /** Alignment of a framed user message and its label; a rail's label only. */
  userMessageAlign: "left" | "right";
  /**
   * The widest a framed user message's text renders before it wraps: `"auto"`
   * (the whole width), a fraction of the width (`0.7`), or a column count
   * (`88`). The frame hugs the narrower text.
   */
  userMessageMaxWidth: number | "auto";
  /** Show a user message's time next to its icon. */
  userMessageTime: boolean;
  /** Fold a whole run live or only after settlement. */
  collapseTurns: CollapseTurns;
  /**
   * The settled final assistant reply, independently of folding: "frame" (a
   * full-width rounded frame), "rail" (rules above and below, a `│` in front of
   * the text), "rules" (only the rules) or "off" (pi's own).
   */
  finalReplyStyle: FinalReplyStyle;
  /** `auto`, or a pattern of `YYYY M MM D DD H HH mm ss` and literal text. */
  messageTimeFormat: string;
  /** What a message's top edge looks like: `inline` or `split`. */
  messageHeaderStyle: HeaderStyle;
  /** Rows between each rule and the text of a "rail" or "rules" user message. */
  userMessagePaddingY: number;
  /** "rail" and "rules" user message colors: theme color names or `#rrggbb`. */
  userMessageColors: { rail: string; rule: string };
  /** Prepend Nerd Font icons (tool kind / file type / message kind). */
  icons: boolean;
  /**
   * Collapsed bash result preview height, in visual lines (default 1). pi's own
   * bash renderer hard-codes 5 and has no setting; `ctrl+o` still shows everything.
   */
  bashResultLines: number;
  /**
   * Collapsed write preview height, in visual lines (default 10, pi's own
   * number). `0` hides the preview until the box is expanded.
   */
  writeLines: number;
  /**
   * Collapse one assistant segment's tool calls into a single summary line.
   * Click the line for one row per call, click a row for the full box.
   */
  groupTools: boolean;
  /**
   * Start each new tool group open (`▾` header, one row per call) instead of
   * folded to its summary line. Only the group's first level: clicking the
   * header or `ctrl+o`'s collapse-all stays folded.
   */
  groupOpen: boolean;
  /** Rows a group's call may take: 2 lets one that does not fit go on to a second. */
  toolRowLines: 1 | 2;
  /**
   * Tools that never fold into a group and keep pi's own box (edit/write by
   * default: the diff is the point). They also end the group before them.
   */
  alwaysShowTools: string[];
  /** Track background jobs (pi-processes) on the row of the call that started them. */
  backgroundJobs: boolean;
  /** Hide a job's notification messages when its row already shows them. */
  hideJobNotifications: boolean;
  /**
   * pi reports a failed request once per retry attempt, as a plain row with the
   * provider's raw body. Fold the repeats into the first row as `×N` and frame
   * it like any other box. Only error rows: warnings and notes stay as pi
   * drew them.
   */
  dedupeErrors: boolean;
  /** Take tidy's frames and rails out of what pi's fullscreen selection copies. */
  cleanCopy: boolean;
  /**
   * Render an edit's diff as two panes (old | new) with line numbers, a
   * coloured bar and a tinted row per changed line. Also decides whether a
   * reply's `diff` code block gets panes. Falls back to pi's unified diff when
   * the box is too narrow (see `splitDiffMinWidth`).
   */
  splitDiff: boolean;
  /** Box width below which the split becomes unreadable; pi's diff is used. */
  splitDiffMinWidth: number;
  /**
   * Diff body rows shown while the box is collapsed (default 20). The window
   * follows the first changed line, not the top of the file; `ctrl+o` shows all.
   * edit has no such budget of its own — pi draws the whole diff.
   */
  diffLines: number;
  /**
   * Put a `copy` chip on a reply's fenced code blocks, and give a language pi's
   * highlighter has no grammar for (fish) the closest one it does. A `diff` block
   * goes side by side instead, per `splitDiff`.
   */
  codeBlocks: boolean;
  /**
   * Paint a dot in front of every hex color a message names (`● #7f849c`).
   * Fenced code blocks and inline code are skipped.
   */
  hexSwatches: boolean;
  /** Per-kind theme fg colors for message-box borders (any ThemeColor name). */
  messageBorderColors: MessageBorderColors;
  /**
   * Theme color for thinking: the `🧠` row, the counting entry in the summary
   * line, and the border of an expanded thinking box. Any theme color name or
   * `#rrggbb`.
   */
  thinkingColor: string;
  /**
   * Per-tool border color for successful executions (theme fg color names;
   * pending stays grey, error stays red). When set in settings, the map
   * REPLACES the defaults entirely — `{}` disables per-tool colors.
   */
  toolColors: Record<string, string>;
}

/** pi's own collapsed write preview height; `writeLines` defaults to it. */
export const PI_WRITE_PREVIEW_LINES = 10;
export const DEFAULT_BASH_RESULT_LINES = 1;

const DEFAULT_TOOL_COLORS: Record<string, string> = {
  bash: "bashMode",
  read: "toolTitle",
  edit: "syntaxVariable",
  write: "syntaxVariable",
  grep: "syntaxOperator",
  find: "syntaxOperator",
  ls: "syntaxOperator",
  mcp: "customMessageLabel",
};

const DEFAULTS: TidyConfig = {
  enabled: true,
  highlightBash: true,
  frameMessages: true,
  userMessageStyle: "frame",
  userMessageAlign: "left",
  userMessageMaxWidth: "auto",
  userMessageTime: true,
  collapseTurns: "afterRun",
  finalReplyStyle: "frame",
  messageTimeFormat: "auto",
  messageHeaderStyle: "inline",
  userMessagePaddingY: 1,
  userMessageColors: { rail: "accent", rule: "borderMuted" },
  icons: true,
  bashResultLines: DEFAULT_BASH_RESULT_LINES,
  writeLines: PI_WRITE_PREVIEW_LINES,
  groupTools: true,
  groupOpen: false,
  toolRowLines: 1,
  alwaysShowTools: ["edit", "write"],
  backgroundJobs: true,
  hideJobNotifications: true,
  dedupeErrors: true,
  cleanCopy: true,
  splitDiff: true,
  splitDiffMinWidth: 72,
  diffLines: 20,
  codeBlocks: true,
  hexSwatches: true,
  thinkingColor: "warning",
  messageBorderColors: {
    assistant: "accent",
    user: "toolTitle",
    compaction: "customMessageLabel",
    branch: "mdCode",
    skill: "accent",
    custom: "warning",
  },
  toolColors: DEFAULT_TOOL_COLORS,
};

const USER_MESSAGE_STYLES: readonly UserMessageStyle[] = ["rail", "rules", "frame", "off"];

// The pre-0.5 `frameUserMessages` needs no reading: `true` asked for the frame,
// which is the default now, and `false` meant "leave them to pi-starline",
// which no longer draws them.
function userMessageStyle(toolbox: any): UserMessageStyle {
  const style = toolbox?.userMessageStyle;
  return USER_MESSAGE_STYLES.includes(style) ? style : DEFAULTS.userMessageStyle;
}

// A fraction of the width (0 < r ≤ 1) or a column count. Anything else — zero, a
// negative, a non-finite number, a string — is the whole width: a typo in a
// setting should not hide the message it was meant to narrow.
function userMaxWidth(value: unknown): number | "auto" {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULTS.userMessageMaxWidth;
}

const FINAL_REPLY_STYLES: readonly FinalReplyStyle[] = ["frame", "rail", "rules", "off"];

// `frameFinalReply` from before 0.9 keeps working: `true` is "frame", `false` is "off".
function finalReplyStyle(toolbox: any): FinalReplyStyle {
  if (FINAL_REPLY_STYLES.includes(toolbox?.finalReplyStyle)) return toolbox.finalReplyStyle;
  return toolbox?.frameFinalReply === false ? "off" : DEFAULTS.finalReplyStyle;
}

function stringEntries(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function readSettings(): any {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
}

export function loadConfig(): TidyConfig {
  try {
    // `tidy` since the rename from pi-toolbox; the old key keeps working.
    const settings = readSettings();
    const toolbox = settings?.tidy ?? settings?.toolbox;
    return {
      enabled: toolbox?.enabled ?? DEFAULTS.enabled,
      highlightBash: toolbox?.highlightBash ?? DEFAULTS.highlightBash,
      frameMessages: toolbox?.frameMessages ?? DEFAULTS.frameMessages,
      userMessageStyle: userMessageStyle(toolbox),
      userMessageAlign: toolbox?.userMessageAlign === "right" ? "right" : "left",
      userMessageMaxWidth: userMaxWidth(toolbox?.userMessageMaxWidth),
      userMessageTime: typeof toolbox?.userMessageTime === "boolean" ? toolbox.userMessageTime : DEFAULTS.userMessageTime,
      collapseTurns: ["off", "afterRun", "live"].includes(toolbox?.collapseTurns) ? toolbox.collapseTurns : DEFAULTS.collapseTurns,
      finalReplyStyle: finalReplyStyle(toolbox),
      messageTimeFormat:
        typeof toolbox?.messageTimeFormat === "string" && toolbox.messageTimeFormat.trim()
          ? toolbox.messageTimeFormat
          : DEFAULTS.messageTimeFormat,
      messageHeaderStyle: toolbox?.messageHeaderStyle === "split" ? "split" : DEFAULTS.messageHeaderStyle,
      userMessagePaddingY:
        Number.isInteger(toolbox?.userMessagePaddingY) && toolbox.userMessagePaddingY >= 0
          ? Math.min(3, toolbox.userMessagePaddingY)
          : DEFAULTS.userMessagePaddingY,
      userMessageColors: {
        ...DEFAULTS.userMessageColors,
        ...stringEntries(toolbox?.userMessageColors),
      },
      icons: toolbox?.icons ?? DEFAULTS.icons,
      bashResultLines: typeof toolbox?.bashResultLines === "number" ? toolbox.bashResultLines : DEFAULTS.bashResultLines,
      writeLines: typeof toolbox?.writeLines === "number" ? toolbox.writeLines : DEFAULTS.writeLines,
      groupTools: typeof toolbox?.groupTools === "boolean" ? toolbox.groupTools : DEFAULTS.groupTools,
      groupOpen: typeof toolbox?.groupOpen === "boolean" ? toolbox.groupOpen : DEFAULTS.groupOpen,
      toolRowLines: toolbox?.toolRowLines === 2 ? 2 : DEFAULTS.toolRowLines,
      alwaysShowTools: Array.isArray(toolbox?.alwaysShowTools)
        ? toolbox.alwaysShowTools.filter((name: unknown): name is string => typeof name === "string")
        : DEFAULTS.alwaysShowTools,
      backgroundJobs: typeof toolbox?.backgroundJobs === "boolean" ? toolbox.backgroundJobs : DEFAULTS.backgroundJobs,
      hideJobNotifications:
        typeof toolbox?.hideJobNotifications === "boolean" ? toolbox.hideJobNotifications : DEFAULTS.hideJobNotifications,
      dedupeErrors: typeof toolbox?.dedupeErrors === "boolean" ? toolbox.dedupeErrors : DEFAULTS.dedupeErrors,
      cleanCopy: typeof toolbox?.cleanCopy === "boolean" ? toolbox.cleanCopy : DEFAULTS.cleanCopy,
      splitDiff: typeof toolbox?.splitDiff === "boolean" ? toolbox.splitDiff : DEFAULTS.splitDiff,
      splitDiffMinWidth:
        typeof toolbox?.splitDiffMinWidth === "number" ? toolbox.splitDiffMinWidth : DEFAULTS.splitDiffMinWidth,
      diffLines: typeof toolbox?.diffLines === "number" ? toolbox.diffLines : DEFAULTS.diffLines,
      codeBlocks: typeof toolbox?.codeBlocks === "boolean" ? toolbox.codeBlocks : DEFAULTS.codeBlocks,
      hexSwatches: typeof toolbox?.hexSwatches === "boolean" ? toolbox.hexSwatches : DEFAULTS.hexSwatches,
      thinkingColor: typeof toolbox?.thinkingColor === "string" ? toolbox.thinkingColor : DEFAULTS.thinkingColor,
      messageBorderColors: {
        ...DEFAULTS.messageBorderColors,
        ...toolbox?.messageBorderColors,
      },
      // Replace, not merge: removing a tool's color must be expressible.
      toolColors: toolbox?.toolColors ?? DEFAULTS.toolColors,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

