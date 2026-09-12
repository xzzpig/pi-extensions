# MILESTONES — Subagent audit usage accounting

Free-form implementation log (per `AGENTS.md`): decisions, setbacks, validation
notes, and evidence. Goal: `mtysoktc-dlzf6m`.

## Requirement

The completion audit's pi-subagents child session spends real money, and
pi-goal-x discarded the usage pi-subagents reports in its terminal response. Fix
it so (1) the session's own cost totals include the audit spend, and (2) the goal
keeps a durable, separate record of it without changing the meaning of
`goal.usage.tokensUsed`. Chosen with the user during goal drafting: session
totals **and** ledger, with the ledger account kept separate from the token
budget.

## Investigation (before implementation)

Established from the installed pi 0.85.1 and pi-subagents 0.13.0 sources, plus
real session logs:

- pi counts `assistant`, `toolResult`-with-`usage`, and
  compaction/branch-summary usage; extension `custom_message` entries are never
  counted (`dist/core/usage-totals.js`, `dist/modes/interactive/components/footer.js`).
- `ctx.sessionManager` is read-only, so an extension cannot append a countable
  entry; the only accounting hook an extension owns is the `tool_result` hook's
  `usage` — which needs a real tool call.
- The delegated audit already runs inside `update_goal`'s `execute`, giving the
  completion flow a legitimate `AgentToolResult` to attach usage to.
- Measured in this repository's own session files: one approved audit cost
  $0.690870 across 48 turns and appeared nowhere in the parent session's totals;
  a 23-child session accumulated $30.3567 with zero `toolResult` usage in the
  parent. A separate control run of `subagent({ async: false })` proved the
  channel works when usage is attached (parent total = own + child, exactly).

## Implementation

1. `extensions/goal-auditor.ts` — `GoalAuditorResult.usage`, a
   `delegationUsage()` validator (finite, non-negative counters; the received
   object is returned untouched), capture on any non-`invalid_request` terminal
   response, and `finish()` merging `result.usage ?? terminalUsage` so timeout
   and abort paths keep what the child already spent.
2. `extensions/goal-completion.ts` — `withAuditorUsage()` projecting to pi's
   `Usage` shape, wrapped around the five audit-stage returns; `audit_usage`
   ledger append right after the auditor settles; `auditorUsageLine()` on the
   approved and rejected cards.
3. `extensions/goal-ledger.ts` — `audit_usage` in the event union and in
   `isValidLedgerEvent`.
4. `extensions/goal-format.ts` — `formatAuditUsage()`.
5. `extensions/goal-activity.ts` — audit-feed mapping plus the `activityTypes`
   membership that keeps the event from being dropped; `extensions/goal-compaction.ts`
   — history line.

## Setbacks

- The first `withAuditorUsage` edit applied to the *pre-audit* focus check as
  well as the post-audit one (identical source text), which typecheck rejected as
  "used before its declaration". Reverted the pre-audit site; the audit-stage
  sites stayed wrapped.
- A ledger validator edit silently failed to apply in a multi-edit call and was
  only caught when a later edit could not find the text. Re-read and re-applied;
  the golden fixture test is what proves the validator is actually present.
- The approved audit card is *enqueued* and flushed on the next `agent_settled`,
  not returned as the tool result, so the test had to drive that handler to
  observe the card line.
- Touching `goal-ledger.ts` surfaced a pre-existing self-scan blocker
  (`checkpointToJson(): unknown`). Fixed by naming the JSON projection
  (`LedgerCheckpointJson`, `CheckpointRuntimeStateJson`) — types only, no
  runtime change.
- **The completion auditor rejected the first completion claim, correctly.**
  One of the six post-audit return paths — the inner focus check *after* the
  Escape dialog — still dropped `auditor.usage`, and neither focused-cancel
  branch had a test. The claim was rejected with that exact finding, so the
  branch was wrapped and both cancels are now covered by
  `usage: both focused-cancel returns keep the auditor usage` (focus is made
  stale from inside the delegation-response handler for the post-audit check,
  and from inside the Escape dialog for the inner check). Six wrapped returns:
  post-audit focus check, Escape-dialog focus check, Escape bypass, continue
  working, rejected, approved.

## Verification evidence

- `node --experimental-strip-types --test --test-concurrency=1 tests/goal-auditor.test.ts`
  → 36/36 pass, including 5 new usage tests (terminal statuses, timeout, abort,
  absent/malformed, `invalid_request`).
- `… tests/goal-delegation-completion.test.ts tests/goal-activity.test.ts tests/goal-golden.test.ts`
  → 43/43 pass. New assertions: exact tool-result `Usage` shape
  (`totalTokens: 4498`, `cost.total: 0.00774024`, per-bucket cost zeros), all
  six wrapped branches (approved, rejected, no-usage, aborted
  continue-working, Escape bypass, and both focused cancels), the `audit_usage`
  counters, `goal.usage.tokensUsed` still `0`, the card text
  (`Audit cost: $0.0077 · 4.5K (4,498) tokens · 1 turn`), and the fixture ledger
  reading 18 events with `malformed === 1`.
- `pnpm --filter pi-goal-x test` → **1067/1067 pass** across 82 test files
  (17.9 s), no regressions in the existing ledger/checkpoint/auditor suites.
- `pnpm --filter pi-goal-x run typecheck` → 0 errors.
- `pnpm --filter pi-goal-x run lint` → clean (`eslint .`).
- `pnpm exec prettier --check .` → "All matched files use Prettier code style!"
  (pi-goal-x itself stays in `.prettierignore`; only `versions.json` is checked
  outside the subtree).

### Real pi run (the acceptance gate)

Scratch project `/tmp/goal-audit-usage-e2e` with a trivially verifiable
objective ("…verification contract: notes.txt contains the exact line
AUDIT-OK", and that file pre-written), driven by two headless runs:
`pi --mode json --no-extensions -e <goal.ts> -e <pi-subagents/index.ts>
--model new-api/deepseek-ai/DeepSeek-V4-Flash --session-dir …` — the first call
creates and focuses the goal (`create_goal`), the second completes it
(`update_goal { status: "complete" }`) so the **real** auditor child session
runs (7 turns, independent verification of `notes.txt`).

Reconciliation from the written artifacts:

| Number | Value | Source |
| --- | --- | --- |
| `update_goal` tool-result usage | `input 4857, output 1911, cacheRead 23424, cacheWrite 0, totalTokens 30192, cost.total 0.025939` | parent session `…/sessions/*.jsonl` |
| audit child session cost | `0.025939` (in+out+cacheRead = 30192) | child `…/<runId>/run-0/session.jsonl` |
| parent own assistant cost | `0.018924` | parent session assistant messages |
| `/session`-style total | `0.044863` = 0.018924 + 0.025939 | derived, matches the footer arithmetic |
| ledger `audit_usage` | `tokens 30192, input 4857, output 1911, cacheRead 23424, cacheWrite 0, costUsd 0.025939, turns 7` | `.pi/goals/goal_events.jsonl` |
| goal `usage.tokensUsed` | `6013` (parent turns only) | archived goal record |
| audit card | `Audit cost: $0.0259 · 30K (30,192) tokens · 7 turns` | `pi-goal-audit-event` custom message |

Ledger order for that run: `completion_requested → audit_started → audit_usage
→ audit_result(approved) → goal_completed → goal_archived`.

#### The user-facing number, computed by the host's own aggregator

Headless (`-p`/json) runs render no TUI footer, so the totals were recomputed
from the real session file with pi's own accounting code
(`dist/core/usage-totals.js` — `createUsageTotals`/`addUsageToTotals` and
`getUsageCostBreakdown`, the functions behind the footer `$`, `/session` Cost,
and the per-model breakdown). Amounts are printed in micro-USD to avoid the
log's decimal redaction:

| Bucket | micro-USD | tokens |
| --- | --- | --- |
| parent model (`new-api/deepseek-flash`) | 32,394 | 16,474 |
| `Tools/summaries` (the `update_goal` tool result) | 25,939 | 30,192 |
| **session Cost total** | **58,333** | 46,666 |

The `Tools/summaries` bucket equals the audit child session's own cost exactly
(25,939 micro-USD), which is the point of the fix: before it, that bucket did not
exist and the session total excluded the audit entirely. The parent bucket is
larger than the 18,924 micro-USD measured right after the audit because a later
`/session` probe ran one more parent model turn against the same session file.

### Observations (not fixed here)

- The approved card renders `Auditor model: <model>:off:off` — the thinking
  suffix is appended by pre-existing card code on top of a model string that
  already carries it. Untouched: the goal requires existing messages to keep
  their semantics.
- pi-subagents warns that the packaged `agents/goal-auditor.md` declares an
  empty `extensions:` override, which it treats as "disable all ambient
  extensions". The child still resolved its provider-qualified model and
  completed the audit in this run, but the declaration is worth revisiting.


## Follow-ups (explicitly out of scope)

- `/subagent-cost` still cannot list a delegated audit; it would need pi-subagents
  to register the run in a shape that command recognizes.
- The blocker Oracle creates its own in-process session and still accounts
  nowhere.
