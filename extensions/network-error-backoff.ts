/**
 * Bounded, goal-level recovery after Pi has exhausted its provider retries.
 *
 * Pi owns the immediate request retries. These longer delays are deliberately
 * small in number and only apply to terminal `network_error` failures, so an
 * unavailable provider never becomes an unbounded auto-continue loop.
 */

export const NETWORK_ERROR_BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 80_000] as const;

export interface NetworkErrorBackoffPlan {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}

/** Return the recovery plan for a one-based attempt, or undefined after the cap. */
export function networkErrorBackoffPlan(attempt: number): NetworkErrorBackoffPlan | undefined {
	if (!Number.isInteger(attempt) || attempt < 1 || attempt > NETWORK_ERROR_BACKOFF_DELAYS_MS.length) return undefined;
	return {
		attempt,
		maxAttempts: NETWORK_ERROR_BACKOFF_DELAYS_MS.length,
		delayMs: NETWORK_ERROR_BACKOFF_DELAYS_MS[attempt - 1]!,
	};
}
