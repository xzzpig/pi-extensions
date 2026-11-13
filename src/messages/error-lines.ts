/**
 * pi's own error rows — the ones that are not a tool result: a failed request,
 * an extension that threw, a provider that dropped blocks. It builds each as a
 * plain `ThemedText` (`Error: 429: {…}`) and appends it straight to the chat
 * container, once per retry attempt.
 *
 * Two things are wrong with that: the attempt count never changes the text, so
 * a retry storm leaves three identical rows carrying the provider's raw body;
 * and the row has no frame, unlike every other box in the transcript.
 *
 * So exactly one row survives: a repeat of the same text folds into it with a
 * `×N`, and that row wears the frame the rest of tidy's boxes wear. The rows
 * are transport state, not conversation, but they are also the only record
 * that a turn failed — dropping them all would leave the failure invisible.
 *
 * `ThemedText` is not exported and never reaches a class tidy could patch, so
 * the hook is the container: after `InteractiveMode.init`, the chat container
 * gets its own `addChild`. Rows not painted in the error colour (warnings,
 * notes, dim asides) pass through untouched — a billing notice is information,
 * and repeating one is a real event, not a retry.
 */

import { AssistantMessageComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { type Component, Spacer, Text } from "@earendil-works/pi-tui";
import { drawFrame, labeledTopBorder, stripBackgroundFills, trimBlankEdges, visibleText } from "../draw/frame-draw.ts";
import { liveSlot, tidyEnabled } from "../live.ts";
import { getTheme } from "../theme-access.ts";

export interface ErrorLineOptions {
  /** Fold a repeated error row into the first one as `×N`, and frame it. */
  enabled: boolean;
}

const errorLineOptions = liveSlot<ErrorLineOptions>("error-line-options", { enabled: true });

/** Marks a container already watching, so a second install can't double-wrap. */
const INSTALLED = Symbol.for("pi-tidy:error-lines");
const INIT_PATCH = Symbol.for("pi-tidy:error-lines-init");

export interface ChatContainerLike {
  children: Component[];
  addChild(child: Component): void;
}

/** Wide enough that a probe render says what the row holds, not how it wraps. */
const PROBE_WIDTH = 400;

/** The escape `theme.fg(color, …)` opens with, for prefix matching. */
function opener(color: string): string {
  const probe = getTheme()?.fg(color, "\u0000") ?? "";
  return probe.split("\u0000")[0] ?? "";
}

function rowsOf(component: Component): string[] {
  try {
    return component.render(PROBE_WIDTH).map(stripBackgroundFills);
  } catch {
    return [];
  }
}

/**
 * The colour a row is painted in, when it is one of pi's status rows: pi wraps
 * the whole line in a single `fg`, so the first visible row opens with it.
 */
function rowColor(rows: string[]): string | undefined {
  const row = rows.find((line) => visibleText(line).trim() !== "");
  if (!row) return undefined;
  const painted = row.trimStart();
  for (const color of ["error", "warning"]) {
    const prefix = opener(color);
    if (prefix && painted.startsWith(prefix)) return color;
  }
  return undefined;
}

function blankRows(rows: string[]): boolean {
  return rows.every((line) => visibleText(line).trim() === "");
}

/**
 * Give one row the error frame, labelled `label()` at draw time. Only `render`
 * changes: the row keeps its identity, and nothing is drawn ahead of the frame.
 */
function frameErrorRow(child: Component, label: () => string, live?: () => boolean): void {
  const unpainted = child.render.bind(child);
  child.render = (width: number): string[] => {
    if (live && !live()) return unpainted(width);
    const theme = getTheme();
    const w = Math.max(4, width);
    const rows = trimBlankEdges(unpainted(Math.max(2, w - 2)).map(stripBackgroundFills));
    if (rows.length === 0) return [];
    // No theme yet: pi's shell hasn't painted anything either, so keep the
    // rows exactly as pi drew them rather than inventing colours.
    if (!theme) return rows;
    const framed = drawFrame(rows, w, theme, "error");
    framed[0] = labeledTopBorder(w, theme, "error", theme.fg("error", label()));
    return framed;
  };
}

/**
 * Watch one chat container. `addChild` is the only seam, and the rows keep
 * their identity: pi holds references to some of them (`removeChild` on the
 * previous status line), so a repeat is simply not added and the survivor gets
 * its own `render`.
 */
export function installErrorLines(container: ChatContainerLike): void {
  const target = container as ChatContainerLike & { [INSTALLED]?: boolean };
  if (target[INSTALLED]) return;
  target[INSTALLED] = true;

  const addChild = container.addChild.bind(container);
  let kept: Component | undefined;
  let keptText = "";
  let keptCount = 0;

  const reset = () => {
    kept = undefined;
    keptText = "";
    keptCount = 0;
  };

  const adopt = (child: Component, text: string) => {
    kept = child;
    keptText = text;
    keptCount = 1;
    frameErrorRow(child, () => (keptCount > 1 ? `error ×${keptCount}` : "error"));
  };

  container.addChild = (child: Component) => {
    // Only pi's status rows (a `Text`) and the spacers between them can take
    // part, so nothing else is probed. A probe is a render outside the frame's
    // top-to-bottom pass, and the tool grouping reads that order: a probed tool
    // joined its group before the step that issued it (the step's thinking row
    // then hung above the summary line), and a probed message, not filled in
    // yet, read as a group boundary.
    if (!(child instanceof Text) && !(child instanceof Spacer)) {
      reset();
      const message = child as AssistantLike;
      if (message.contentContainer) chatOf.set(child, container);
      addChild(child);
      // A resumed session builds the message before adding it: it is already
      // filled in, and only now has a place in the chat.
      if (message.contentContainer) noteFailure(message, message.lastMessage);
      return;
    }
    const rows = rowsOf(child);
    // Separators neither repeat nor break a repeat: pi may space two attempts
    // apart, and that should still read as one failure.
    if (rows.length > 0 && blankRows(rows)) {
      addChild(child);
      return;
    }
    const isErrorRow =
      tidyEnabled.get() && errorLineOptions.get().enabled && child instanceof Text && rowColor(rows) === "error";
    if (!isErrorRow) {
      reset();
      addChild(child);
      return;
    }
    const text = rows.map(visibleText).join("\n").trim();
    // pi's "Retry failed after N attempts: <error>" closes a run of failed
    // attempts: it says the same as their box, and says it last.
    const run = failureOf.get(previousMessage(container, container.children.length) as object);
    if (run?.error && text.includes(run.error)) {
      run.closed = true;
      for (const member of run.members) member.contentContainer?.clear?.();
    }
    if (kept && keptText === text && container.children.includes(kept)) {
      keptCount++;
      return;
    }
    adopt(child, text);
    addChild(child);
  };
}

const ASSISTANT_PATCH = Symbol.for("pi-tidy:error-lines-assistant");

interface AssistantLike {
  contentContainer?: { children?: Component[]; clear?: () => void };
  lastMessage?: FailedMessageLike;
}

interface FailedMessageLike {
  stopReason?: unknown;
  content?: unknown;
  errorMessage?: unknown;
}

/**
 * pi retries a failed request as a new assistant message per attempt, each
 * drawing the same `Error: 429 …`. Consecutive identical failures are one run:
 * the first message keeps the box and counts `×N`, the others draw nothing.
 * When pi gives up it adds "Retry failed after N attempts", and the run's box
 * gives way to that row.
 */
interface FailureRun {
  key: string;
  error: string;
  count: number;
  members: AssistantLike[];
  closed: boolean;
}

const failureOf = new WeakMap<object, FailureRun>();
/** The chat each assistant message was added to: its place in the transcript. */
const chatOf = new WeakMap<object, ChatContainerLike>();

/** The message before position `index`, past spacers. Never rendered. */
function previousMessage(container: ChatContainerLike, index: number): Component | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const child = container.children[i];
    if (!(child instanceof Spacer)) return child;
  }
  return undefined;
}

function isEmpty(message: FailedMessageLike): boolean {
  return Array.isArray(message.content) && message.content.length === 0;
}

function noteFailure(component: AssistantLike, message: FailedMessageLike | undefined): void {
  if (!message || failureOf.has(component) || !failedWithNothingElse(message)) return;
  if (!tidyEnabled.get() || !errorLineOptions.get().enabled) return;
  const container = chatOf.get(component);
  if (!container) return;
  const error = typeof message.errorMessage === "string" ? message.errorMessage : "";
  const key = `${String(message.stopReason)}\u0000${error}`;
  const index = container.children.indexOf(component as Component);
  const run = index > 0 ? failureOf.get(previousMessage(container, index) as object) : undefined;
  if (run && !run.closed && run.key === key && isEmpty(message)) {
    run.count++;
    run.members.push(component);
    failureOf.set(component, run);
  } else {
    failureOf.set(component, { key, error, count: 1, members: [component], closed: false });
  }
  hideIfAbsorbed(component);
}

/** A repeat, or a run pi has closed, draws nothing. */
function hideIfAbsorbed(component: AssistantLike): void {
  const run = failureOf.get(component);
  if (run && (run.closed || run.members[0] !== component)) component.contentContainer?.clear?.();
}

/**
 * A request that fails for good never reaches the chat as a row of its own:
 * pi ends the assistant message with `stopReason: "error"` and draws
 * `Error: …` as the last line *inside* that message. A length stop does the
 * same with "Response was truncated". Neither passes `addChild` on the chat, so
 * they stayed bare while a retried failure wore the frame.
 *
 * Only a failure with nothing else to show is framed. After streamed text the
 * line belongs to that text, and the settled reply may wear its own frame: a
 * box inside it would be a frame in a frame. An abort is the user's own Esc,
 * not a failure, and stays as pi drew it.
 *
 * The hook is `updateContent`, which rebuilds the message's rows: the line is
 * found by what pi put there, never by rendering it.
 */
function patchAssistantErrors(): void {
  const proto = (AssistantMessageComponent as unknown as { prototype?: Record<string | symbol, unknown> }).prototype;
  if (!proto || proto[ASSISTANT_PATCH]) return;
  const original = proto.updateContent;
  if (typeof original !== "function") return;
  proto[ASSISTANT_PATCH] = true;
  proto.updateContent = function (this: AssistantLike, message: FailedMessageLike, ...rest: unknown[]) {
    const result = (original as (...args: unknown[]) => unknown).call(this, message, ...rest);
    if (failedWithNothingElse(message)) {
      const last = this.contentContainer?.children?.at(-1);
      if (last instanceof Text) {
        frameErrorRow(
          last,
          () => {
            const run = failureOf.get(this);
            return run && run.count > 1 ? `error ×${run.count}` : "error";
          },
          () => tidyEnabled.get() && errorLineOptions.get().enabled,
        );
      }
      noteFailure(this, message);
      // pi rebuilds the rows on every update (a theme change, a thinking
      // toggle): a message the run absorbed stays absorbed.
      hideIfAbsorbed(this);
    }
    return result;
  };
}

function failedWithNothingElse(message: FailedMessageLike | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  if (message.stopReason !== "error" && message.stopReason !== "length") return false;
  // pi leaves a failed tool call's error to the tool row, and draws nothing here.
  if (message.stopReason === "error" && message.content.some((block) => block?.type === "toolCall")) return false;
  return !message.content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
}

/**
 * pi's interactive mode owns the chat container and hands it to nobody, so the
 * instance is reached through `init`. A pi that renames that method leaves the
 * hook uninstalled: rows then render as pi draws them, which is the behaviour
 * before this patch and not a crash.
 */
export function patchErrorLines(options: ErrorLineOptions): void {
  errorLineOptions.set(options);
  patchAssistantErrors();
  const proto = (InteractiveMode as unknown as { prototype?: Record<string | symbol, unknown> }).prototype;
  if (!proto || proto[INIT_PATCH]) return;
  const original = proto.init;
  if (typeof original !== "function") return;
  const init = original as (...args: unknown[]) => unknown;
  proto[INIT_PATCH] = true;
  proto.init = function (this: { chatContainer?: ChatContainerLike }, ...args: unknown[]) {
    const install = () => {
      const chat = this?.chatContainer;
      if (chat && typeof chat.addChild === "function") installErrorLines(chat);
    };
    const result = init.apply(this, args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).then((value) => {
        install();
        return value;
      });
    }
    install();
    return result;
  };
}
