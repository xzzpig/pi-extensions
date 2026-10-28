import type { PermissionPromptDecision } from "./permission-dialog";

/**
 * How long a shown permission prompt waits for a human before it denies.
 *
 * Opened when a prompt is presented — never when its ask is admitted, so an
 * ask queued behind another dialog gets its own full window — and closed when
 * a human answers. A human who starts answering engages it, which stops the
 * clock without settling anything: the window bounds an unattended prompt and
 * never cuts off someone mid-answer. If neither happens first, the window aborts its signal,
 * which dismisses the prompt, and the window itself is what decided: it stamps
 * the `unanswered` decider rather than leaving the caller to infer one.
 *
 * The timer is `unref`ed, so a window still open when the session ends never
 * holds the process alive.
 */
export class AnswerWindow {
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly timeoutMs: number | undefined,
    private readonly controller: AbortController | undefined,
  ) {
    if (timeoutMs !== undefined && controller !== undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        controller.abort();
      }, timeoutMs);
      this.timer.unref();
    }
  }

  /** Opens a window, or a null window that never expires when `timeoutMs` is undefined. */
  static open(timeoutMs: number | undefined): AnswerWindow {
    return timeoutMs === undefined
      ? new AnswerWindow(undefined, undefined)
      : new AnswerWindow(timeoutMs, new AbortController());
  }

  /** Aborts when the window expires; `undefined` when no window is configured. */
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  /** The window's length while its clock is running; `undefined` once stopped, expired, or never opened. */
  get pendingTimeoutMs(): number | undefined {
    return this.timer === undefined ? undefined : this.timeoutMs;
  }

  /** A human answered: stop the clock. Idempotent. */
  close(): void {
    this.stopClock();
  }

  /** A human started answering: stop the clock and let them finish. Idempotent. */
  engage(): void {
    this.stopClock();
  }

  /**
   * The decision for a prompt this window dismissed.
   *
   * `confirmationUnavailable` holds because no human ruled. A null window
   * cannot have dismissed anything, so asking it is a caller defect, and the
   * throw fails the ask closed at the gate boundary rather than inventing a
   * decider.
   */
  expiredDecision(): PermissionPromptDecision {
    if (this.timeoutMs === undefined) {
      throw new Error(
        "no answer window was open, so no prompt can have expired",
      );
    }
    return {
      approved: false,
      state: "denied",
      confirmationUnavailable: true,
      decidedBy: { kind: "unanswered", timeoutMs: this.timeoutMs },
    };
  }

  private stopClock(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
