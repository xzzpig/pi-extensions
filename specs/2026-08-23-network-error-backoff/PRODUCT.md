# Product — network-error recovery backoff

Date: 2026-08-23

## Problem

Pi retries a failed provider request three times. A provider response such as
`Provider finish_reason: network_error` can still exhaust that retry budget,
leaving an active auto-continue goal stranded even though the outage may be
short-lived.

## Behaviour

- After Pi has fully settled with a terminal network error, an active,
  auto-continue goal retries its checkpoint using a bounded exponential
  backoff: 5, 10, 20, 40, then 80 seconds.
- The extension waits for `agent_settled`; a transient Pi retry that succeeds
  must clear the pending goal-level recovery instead of creating a duplicate
  turn.
- A recovery retry is cancelled by user-driven input, pausing/stopping or
  changing the focused goal, and session shutdown.
- After the fifth goal-level recovery is exhausted, the goal remains active
  but no longer retries automatically. The user receives an actionable
  warning and can resume when the provider is healthy.
- Non-network provider errors retain the existing non-retry behaviour.

## Non-goals

- Do not create an unbounded retry loop.
- Do not persist transient retry counters or change a goal's lifecycle status.
- Do not replace Pi's built-in provider retry policy.
