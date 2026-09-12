# Subagent audit usage accounting — technical design

## Why the delegation path needs explicit plumbing

pi's session accounting is derived from session entries, not from extension
state. `getSessionStats()`, the footer, and the cost breakdown all sum:

- `assistant` messages (this session's own model turns),
- **`toolResult` messages that carry `usage`** (a tool that spent money the
  session did not),
- `compaction` / `branch_summary` entries.

`custom_message` entries — which is what extension notifications are — are never
counted. And `ctx.sessionManager` is a `ReadonlySessionManager`, so an extension
cannot append a countable entry itself.

pi-subagents' foreground execution attaches the child's summed usage to the
`subagent` tool result (`withAggregatedToolUsage` → `toAgentToolUsage`), which is
exactly why a synchronous `subagent` call appears in the session totals. The
goal audit does not go through that tool: `extensions/goal-auditor.ts` emits
`SUBAGENT_DELEGATION_REQUEST_EVENT` and waits for
`SUBAGENT_DELEGATION_RESPONSE_EVENT`, and pi-subagents answers through
`executeDelegated` + `toSubagentDelegationResponse`, returning usage in the
**event payload** instead of a tool result.

The audit nevertheless runs inside the `update_goal` tool call
(`registerCoreTools` → `runGoalCompletionFlow`), so that tool's
`AgentToolResult` is the one legitimate place to publish the spend.

## Channel 1 — session cost totals

```text
goal-auditor.ts   terminal response.usage  →  GoalAuditorResult.usage
goal-completion.ts  auditor.usage → withAuditorUsage(...) on every audit-stage return
```

`withAuditorUsage` projects the validated `SubagentDelegationUsage`
(`{ input, output, cacheRead, cacheWrite, cost: number, turns, toolCalls,
durationMs }`) into pi's `Usage`:

```ts
{
  input, output, cacheRead, cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
}
```

`cost`'s per-bucket fields are zero because the child reports a single total;
`addUsageToTotals` only reads `cost.total` and the four token counters, so the
projection is lossless for pi's arithmetic. Absent usage returns the original
result object untouched, so branches without usage keep their previous shape.

Wrapped returns in `runGoalCompletionFlow`:

| Branch | Site |
| --- | --- |
| focused operation cancelled right after the audit | post-audit focus check |
| focused operation cancelled while the Escape dialog was open | inner check inside the Escape branch |
| Escape bypass (`complete_without_audit`) | `commitGoalCompletion` call |
| audit aborted → continue working | plain result |
| rejected | plain result |
| approved | `commitGoalCompletion` call |

The two returns that happen *before* the auditor runs (completion-gate failure,
pre-audit focus check, disabled/skip branches) are intentionally untouched —
there is no usage to attach.

Because a tool result has no model attribution, the session's per-model cost
breakdown groups this spend under `Tools/summaries`, and the child's tokens are
included in the footer's cumulative `↑ ↓ R W` counters. Context usage is not
affected: `ToolResultMessage.usage` is explicitly "not part of main LLM context
accounting".

## Channel 2 — the goal ledger

New event, validated like every other ledger event
(`isValidLedgerEvent`), so an invalid line is counted malformed rather than
trusted:

```ts
| { type: "audit_usage"; goalId: string; tokens: number; inputTokens: number;
    outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    costUsd: number; turns: number; at: string }
```

Emitted once per audit, immediately after the auditor settles and **before** the
Escape/continue-working/rejected/approved branches, so an aborted or rejected
audit still records what it cost. `goal.usage.tokensUsed` is not written here:
that field is charged from this session's own `turn_end` assistant tokens
(`goal-events.ts` → `accountProgress`), and folding a child session into it would
change token-budget semantics.

Display surfaces:

- audit card (`formatAuditUsage` → `Audit cost: $0.0077 · 4.5K (4,498) tokens · 1 turn`)
  on the approved and rejected cards,
- goal activity feed (`goal-activity.ts`, which is why `audit_usage` was added
  to `activityTypes` — an unlisted type is dropped from the feed),
- compaction summary history line (`goal-compaction.ts`).

## Validation boundary

`delegationUsage(value)` accepts the event payload only when every counter is a
finite non-negative number, and returns the received object unchanged so callers
observe exactly what pi-subagents reported. The delegation response is
untrusted event data: without this, a hostile or broken bridge could inject
`NaN` or a negative cost into both the session totals and the ledger.

## Files

- `extensions/goal-auditor.ts` — capture + validate usage, expose it on
  `GoalAuditorResult`.
- `extensions/goal-completion.ts` — project to the tool result, emit
  `audit_usage`, add the card line.
- `extensions/goal-ledger.ts` — event type, validator (plus a named
  `LedgerCheckpointJson` return type for the checkpoint serializer, which the
  self-scan requires when the file is touched).
- `extensions/goal-format.ts` — `formatAuditUsage`.
- `extensions/goal-activity.ts`, `extensions/goal-compaction.ts` — display.
- `tests/goal-auditor.test.ts`, `tests/goal-delegation-completion.test.ts`,
  `tests/goal-activity.test.ts`, `tests/goal-golden.test.ts` (fixture ledger
  gains an `audit_usage` line, proving the read/validate path).

## Test strategy

- Unit: every terminal status (completed/approved, completed/disapproved,
  failed/error, timeout, abort, invalid_request) with and without usage, plus
  malformed payloads.
- Integration-ish harness: the real `update_goal` tool through a fake event
  bridge, asserting the exact tool-result `Usage` shape, the recorded
  `audit_usage` numbers, the card text, and the `tokensUsed` invariant.
- Golden: the fixture ledger must read one more event type with the malformed
  count unchanged.
