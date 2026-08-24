# Milestones — network-error recovery backoff

## 2026-08-23 — Design

- Identified that `agent_end` precedes Pi's built-in retry settlement, so the
  goal extension must defer its fallback to `agent_settled`.
- Chose a bounded 5-step exponential ladder (5–80 seconds), preserving the
  existing protection from runaway provider-error loops.

## 2026-08-23 — Implementation and validation

- Added network-error classification from Pi assistant error metadata and a
  pure bounded-delay policy.
- `agent_end` records a network recovery candidate; `agent_settled` schedules
  it, so a later success in Pi's own retry loop clears the candidate instead.
- Recovery timers are unref'd and cancelled by every ordinary continuation
  reset, including user-driven turns, focus/lifecycle changes, and shutdown.
- Validation passed: `npm run check`, `npm run lint`, `npm test` (837 tests),
  `npm run test:integration` (31 tests), `npm pack --dry-run`, and
  `git diff --check`.
