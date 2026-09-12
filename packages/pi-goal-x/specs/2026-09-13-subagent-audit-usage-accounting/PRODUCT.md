# The completion audit's cost is visible and accounted

## Problem

The independent completion audit runs as a pi-subagents child session
(`agent: goal-auditor`) launched through the extension-to-extension delegation
bridge, not through the `subagent` tool. pi-subagents returns the child's usage
in the terminal delegation response (`SubagentDelegationTerminalResponse.usage`),
but pi-goal-x read only `status`, `result`, `model`, and `thinking` from that
response and **discarded the usage**.

Consequences, all of them silent:

- The audit spend never reached the session's cost totals. A real audit is not
  cheap — the recorded run in this repository's own session log spent 48 turns
  and $0.6909 on one approval, and a 23-audit session accumulated $30.36 — and
  none of it appeared in the footer `$`, `/session` Cost, or `getSessionStats`.
- `/subagent-cost` cannot show it either: that command only recognizes
  `subagent`/`bg_wait` tool results and workflow receipts, and a delegated audit
  produces neither.
- The goal's own account did not see it, so the user had no durable record of
  what the audits cost.

## Requirement

1. Capture the delegation response's usage on **every** terminal path —
   approved, disapproved, provider error, terminal timeout, and cancellation —
   and never let a malformed payload (missing/`NaN`/negative counters) enter
   accounting.
2. Make the spend visible in the **session's own cost totals**, so the footer
   `$`, `/session` Cost, and the token counters include what the audit cost.
3. Keep a **separate durable account** in the goal ledger. `goal.usage.tokensUsed`
   must keep its meaning — this session's own turns — so a token budget is not
   silently spent by a child session.
4. Do not change the verdict contract, the completion transaction, the auditor's
   tool whitelist, or any completion message.

## Decisions

- **The session channel is the `update_goal` tool result.** The audit already
  runs inside `update_goal({ status: "complete" })`, so the completion flow has
  a legitimate `AgentToolResult` to attach usage to. That is the only accounting
  channel pi exposes to an extension: `ctx.sessionManager` is a
  *Readonly*SessionManager, and pi counts only assistant messages, tool results,
  and compaction/branch-summary entries. Injecting a synthetic session entry is
  therefore impossible by design and would corrupt provider payloads anyway.
- **The raw delegation usage cannot be attached as-is.** pi-subagents reports
  `cost` as a number; pi's tool-result `Usage` requires an object
  `cost: { …, total }` plus `totalTokens`. The projection is a local helper
  rather than a new export from pi-subagents, because `toAgentToolUsage` is not
  part of that package's public API and pi-subagents is out of scope here.
- **A separate ledger account, not the goal budget.** A new `audit_usage` event
  records the spend; `goal.usage.tokensUsed` is not touched.
- **Out of scope:** teaching `/subagent-cost` about delegated runs, the blocker
  Oracle's nested session (a different path that never surfaces usage at all),
  and any change to pi-subagents.

## Observable outcome

- `update_goal` results carry `usage` in pi's `Usage` shape, on every audit
  branch, whenever the delegation reported usage — and carry no `usage` field
  when it did not.
- The ledger contains one `audit_usage` event per audit with the child's tokens,
  split counters, cost, and turns; reading it back validates through the normal
  ledger parse path.
- `goal.usage.tokensUsed` is byte-for-byte unchanged by an audit.
- The audit card, the goal activity feed, and the compaction summary show the
  audit cost.

## Verification

`pnpm --filter pi-goal-x run typecheck`, `… run test`, and `… run lint`, plus a
real pi session whose `/session` Cost reconciles with the child session's own
cost. See `MILESTONES.md` for the recorded evidence.
