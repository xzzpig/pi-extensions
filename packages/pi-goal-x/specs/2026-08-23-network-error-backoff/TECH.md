# Technical — network-error recovery backoff

Date: 2026-08-23

`GoalRuntime` owns an in-memory, one-timer network-recovery state keyed to the
focused goal. It derives delay from an exported pure policy helper and, when
the timer fires, uses the existing checkpoint continuation mechanism.

`goal-events.ts` classifies assistant errors using `stopReason`, `rawStopReason`,
and `errorMessage`. On a network error it records a pending recovery during
`agent_end`, but schedules only from `agent_settled`. Any successful
`agent_end` clears that state, thereby allowing Pi's own retry loop to win
without extension interference.

The retry state is deliberately ephemeral. `clearContinuationState()` accepts
an internal opt-out used while the hidden retry checkpoint starts, preserving
the consecutive-error counter across recovery attempts. All user-visible
cancellation paths use the default reset behaviour.

Coverage includes error classification, deterministic delay/cap policy, and
lifecycle-level deferral/cancellation behaviour.
