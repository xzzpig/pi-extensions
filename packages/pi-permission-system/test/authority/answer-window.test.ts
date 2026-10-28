import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerWindow } from "#src/authority/answer-window";

describe("AnswerWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("an open window", () => {
    it("aborts its signal once the window has elapsed, and not before", () => {
      const window = AnswerWindow.open(60_000);

      vi.advanceTimersByTime(59_999);
      expect(window.signal?.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(window.signal?.aborted).toBe(true);
    });

    it("never aborts once closed before it elapses", () => {
      const window = AnswerWindow.open(60_000);

      vi.advanceTimersByTime(30_000);
      window.close();
      vi.advanceTimersByTime(60_000);

      expect(window.signal?.aborted).toBe(false);
    });

    it("never aborts once a human engages before it elapses", () => {
      const window = AnswerWindow.open(60_000);

      vi.advanceTimersByTime(30_000);
      window.engage();
      vi.advanceTimersByTime(60_000);

      expect(window.signal?.aborted).toBe(false);
    });

    it("reports its length only while the clock is running", () => {
      const expired = AnswerWindow.open(60_000);
      const engaged = AnswerWindow.open(60_000);
      const closed = AnswerWindow.open(60_000);

      engaged.engage();
      closed.close();
      vi.advanceTimersByTime(60_000);
      const running = AnswerWindow.open(60_000);

      expect(running.pendingTimeoutMs).toBe(60_000);
      expect(expired.pendingTimeoutMs).toBeUndefined();
      expect(engaged.pendingTimeoutMs).toBeUndefined();
      expect(closed.pendingTimeoutMs).toBeUndefined();
    });

    it("tolerates a second close", () => {
      const window = AnswerWindow.open(60_000);
      window.close();
      window.close();
      vi.advanceTimersByTime(60_000);

      expect(window.signal?.aborted).toBe(false);
    });

    it("denies as unanswered, naming the window that expired", () => {
      const window = AnswerWindow.open(60_000);
      vi.advanceTimersByTime(60_000);

      expect(window.expiredDecision()).toStrictEqual({
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
        decidedBy: { kind: "unanswered", timeoutMs: 60_000 },
      });
    });
  });

  describe("no configured window", () => {
    it("has no signal, so nothing can dismiss the prompt", () => {
      expect(AnswerWindow.open(undefined).signal).toBeUndefined();
    });

    it("reports no running clock", () => {
      expect(AnswerWindow.open(undefined).pendingTimeoutMs).toBeUndefined();
    });

    it("refuses to name an expiry that cannot have happened", () => {
      expect(() => AnswerWindow.open(undefined).expiredDecision()).toThrow(
        /no answer window/,
      );
    });
  });
});
