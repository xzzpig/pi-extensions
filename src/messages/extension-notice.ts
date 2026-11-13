/**
 * What an extension's notice says, read from the message rather than from its
 * renderer.
 *
 * A custom message whose renderer paints its own chrome gives Tidy nothing to
 * work with: its rows are the extension's, and the one thing a reader needs
 * from them — who it is about and how it went — is buried in styled text. Every
 * notice an extension sends also carries the text the model read (`content`),
 * and most carry structured `details`, so the label and the body can come from
 * there instead and the frame stays Tidy's.
 *
 * pi-subagents names its notices `subagent…`; `subagent-notify`'s
 * `details.runs` is documented (its `docs/extension-api.md`, "Host session
 * lifetime and completion wakes"), and the other types are read field by field
 * with a fallback — a notice that names nobody is still drawn, just with the
 * glyph alone.
 */

export type NoticeTone = "success" | "error" | "warning";

/** The label a notice wears in its frame. Both halves are optional. */
export interface NoticeLabel {
  /** Who the notice is about: a subagent's name, when the message carries one. */
  name?: string;
  /** What happened, in the plugin's own words. */
  status?: string;
  /** A theme color for the border; Tidy's `custom` color when nothing says. */
  tone?: NoticeTone;
}

interface NoticeMessage {
  customType?: unknown;
  content?: unknown;
  details?: unknown;
}

/** pi-subagents' own `STATUS_TONES`, word for word: what a status means to a reader. */
const STATUS_TONES: Record<string, NoticeTone> = {
  completed: "success",
  failed: "error",
  partial: "error",
  blocked: "error",
  unhandled: "error",
  "save failed": "error",
  "reconciliation failed": "error",
  blocker: "error",
  paused: "warning",
  stopped: "warning",
  recovered: "warning",
  unanswered: "warning",
  concern: "warning",
  interrupted: "warning",
  "timed out": "warning",
  "could not be reconciled": "warning",
  "needs attention": "warning",
  "needs a decision": "warning",
  "needs clarification": "warning",
  decision: "warning",
  "interview request": "warning",
  progress_update: "warning",
};

/** Fields a notice may carry the subject of, in the order worth trying. */
const NAME_FIELDS = ["agent", "childKey", "workflowKey", "runId"];
/** Fields that say how it went, in the order worth trying. */
const STATUS_FIELDS = ["status", "outcome", "state", "severity", "reason"];

const controlNotice = "subagent_control_notice";
const completionNotice = "subagent-notify";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * A notice Tidy draws itself: pi-subagents' whole namespace. Other extensions
 * keep their renderer — their message body is not known to be text.
 */
export function isNoticeType(customType: unknown): customType is string {
  return typeof customType === "string" && customType.startsWith("subagent");
}

/**
 * Every run a completion notice reports, or nothing. All or nothing: a list
 * with one unreadable entry says nothing trustworthy about the notice.
 */
function runs(details: unknown): Array<{ agent: string; status: string }> | undefined {
  const list = record(details)?.runs;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const parsed = list.flatMap((run) => {
    const entry = record(run);
    return typeof entry?.agent === "string" && typeof entry?.status === "string"
      ? [{ agent: entry.agent, status: entry.status }]
      : [];
  });
  return parsed.length === list.length ? parsed : undefined;
}

/** Worst tone of a group: an error outranks a warning, a warning ranks a success. */
function worstTone(list: Array<{ status: string }>): NoticeTone | undefined {
  const tones = list.map((run) => STATUS_TONES[run.status]);
  return tones.includes("error") ? "error" : tones.includes("warning") ? "warning" : tones.includes("success") ? "success" : undefined;
}

/** Words in a notice's type name that say what kind of message it is, not what it is about. */
const KIND_NOISE = new Set(["notice", "warning", "message", "notify", "update"]);

/**
 * What kind of notice this is, from its type name: `subagent_watchdog_warning`
 * is a watchdog. Used when the message names nobody, so the row still says
 * something — the glyph alone cannot say whether it is a run or a watchdog.
 */
function kindOf(customType: string): string | undefined {
  const words = customType
    .replace(/^subagent[-_]?/, "")
    .split(/[-_]/)
    .filter((word) => word && !KIND_NOISE.has(word.toLowerCase()));
  return words.length > 0 ? words.join(" ") : undefined;
}

/** The label for a notice, or undefined when this message is not one. */
export function noticeLabel(message: NoticeMessage | undefined): NoticeLabel | undefined {
  const type = message?.customType;
  if (!isNoticeType(type)) return undefined;
  const details = record(message?.details);

  if (type === controlNotice) {
    const event = record(details?.event);
    const name = event?.agent;
    const status = event?.type;
    if (typeof name !== "string" || typeof status !== "string") return {};
    return { name, status: status.replaceAll("_", " "), tone: "warning" };
  }

  if (type === completionNotice) {
    const list = runs(message?.details);
    if (!list) return {};
    if (list.length === 1) {
      const [run] = list as [{ agent: string; status: string }];
      return { name: run.agent, status: run.status, tone: STATUS_TONES[run.status] };
    }
    return { status: `${list.length} background runs`, tone: worstTone(list) };
  }

  // The rest of pi-subagents' notices each carry part of it: `agent` and
  // `outcome` for a wait, `childKey` and `outcome` for a workflow child,
  // `severity` for a watchdog warning. Whatever is missing is simply not drawn.
  const name = firstString(details, NAME_FIELDS) ?? kindOf(type);
  const status = statusOf(details);
  return {
    ...(name ? { name } : {}),
    ...(status ? { status: status.text, ...(status.tone ? { tone: status.tone } : {}) } : {}),
  };
}

/** The first non-empty string among these fields. */
function firstString(source: Record<string, unknown> | undefined, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = source?.[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** The human words and the tone of whatever status field this notice carries. */
function statusOf(details: Record<string, unknown> | undefined): { text: string; tone?: NoticeTone } | undefined {
  for (const field of STATUS_FIELDS) {
    const value = details?.[field];
    if (typeof value !== "string" || !value.trim()) continue;
    const text = value.replaceAll("_", " ");
    const tone = STATUS_TONES[text] ?? STATUS_TONES[field];
    return tone ? { text, tone } : { text };
  }
  return undefined;
}

/** The text the model read: a custom message's content, flattened to one string. */
export function noticeText(message: NoticeMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const block = record(part);
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n");
}

/**
 * The body of a notice: its text, minus the lines the frame's label already
 * says. A completion notice opens with its own title, then with `<agent>:`, the
 * child's answer underneath; both are the label again. Nothing is removed while
 * the label says nothing — the first line is then the only summary there is —
 * and nothing is removed when it would leave no text at all.
 */
export function noticeBodyText(message: NoticeMessage | undefined, label: NoticeLabel | undefined): string {
  const text = noticeText(message);
  if (!label || (!label.name && !label.status)) return text;
  const [, ...rest] = text.split("\n");
  const body = rest.slice(rest.findIndex((line) => line.trim() !== ""));
  if (label.name && body[0]?.trim() === `${label.name}:`) body.shift();
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  return body.length > 0 ? body.join("\n") : text;
}
