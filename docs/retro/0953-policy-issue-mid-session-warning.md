---
issue: 953
issue_title: "pi-permission-system: a policy-file issue that appears mid-session is never shown"
---

# Retro: #953 — pi-permission-system: a policy-file issue that appears mid-session is never shown

## Stage: Planning (2026-10-05T04:36:30Z)

### Session summary

Reproduced the defect through the real composition root before designing, and the spike found a second defect the issue did not name: a schema error present at `session_start` is notified twice, once by `ConfigStore`'s reporter and once by the policy loop.
That regression arrived with [#933].
The operator chose to dedupe at the source (the policy side reports only its derived notices), to have `AgentPrepHandler` supply the agent name, and to rename both resolver and manager to `getPolicyIssues`.
Plan committed as `packages/pi-permission-system/docs/plans/0953-policy-issue-mid-session-warning.md`, four TDD steps; follow-up [#1028] filed and dispositioned out of scope for Phase 15.

### Observations

- **The spike reframed the issue.**
  Measured: mid-session break → fail-closed notice 0 times; broken at start → `Unrecognized config key` 2 times.
  The issue's "natural fold is a second source over the resolver" would have latched the duplicate in place.
  The cause is that `FilePolicyLoader` and `ConfigStore` both run `loadUnifiedConfig` over the same two `config.json` files, so the loader's accumulated issues are a strict duplicate.
  Only the fail-closed and MCP port notices are unique to the policy side.
- **The first spike timed out (5 s).**
  A `tool_call` against the floored `allow` → `ask` opened a dialog; `before_agent_start` alone re-resolves policy through `isToolFullyDenied`, which was enough.
- **The first gate bounced on a term:** "What is ConfigStore?
  Is that something in Pi?"
  The substance named `ConfigStore` without saying it is this package's settings holder or that the package reads each `config.json` twice.
  Define package-internal class names in a gate's substance, not only SDK terms.
- **The operator's reaction to the duplication ("I'm not thrilled") is now [#1028]:** the duplicated *parsing* is out of scope here; only the duplicated *reporting* is removed.
- **Agent-name timing:** a pi-subagents child is named only by the `<active_agent>` prompt tag, which `AgentPrepHandler` reads after turn prep, so a turn-prep-driven report would lag a turn.
  The report goes in `AgentPrepHandler`; `SessionLifecycleHandler` swaps its now-single-use `resolver` dep for the reporter.
- **Accumulation removal also fixes a latent latch bug:** the loader never forgot an issue, so a fixed-then-rebroken file could not be re-announced; the derived notices are recomputed per resolve.

#### Deferred tidyings

The Tidy-First assessor recommended one preparatory commit, the `getPolicyIssues` rename (step 1), and declined:

- `src/config/config-issue-reporter.ts` + new `policy-issue-reporter.ts`: a shared replace-set latch (e.g. `ReportedIssueSet.unreported(current)`); two callers, and the policy source is agent-keyed.
  Revisit at a third.
- `src/handlers/before-agent-start.ts`: converting `AgentPrepHandler`'s positional deps (now seven) to a deps object; the `src/handlers/` convention is positional.
- Folding both reporters into one class over a `Map` of sources: wrong abstraction given the agent-name parameter.

## Stage: Implementation (TDD) (2026-10-05T05:02:56Z)

### Session summary

Executed all four plan steps as four commits: the `getPolicyIssues` rename, the dedupe fix (the policy side answers only its derived notices; the loader accumulation is deleted), the `PolicyIssueReporter`, and the wiring fix through `SessionLifecycleHandler` and `AgentPrepHandler`.
Package test count 5418 to 5429 (+11: +3 and −4 in step 2, +8 in step 3, +4 in step 4).
Baseline and final gates were all green; the pre-completion reviewer returned WARN, with no FAILs.

### Observations

- **Every killing mutation killed exactly what the plan predicted.**
  Step 3's mutation (c) (dropping the agent argument) also reddened the agent-switch row, which is expected because that row is keyed by agent.
  Step 4's mutation (c) reddened the `session_start`-only pin as the plan required, so the [#933] lesson (a pin that fires both moments lets turn prep mask a missing start-time drive) held.
- **Step 2's killing mutation equalled the Red state.**
  Restoring the loader spread is the pre-Green code byte for byte, so the Red run (2 notifications; the extra string in both manager tests) was the mutation's evidence.
- **Deviation:** `pnpm fallow dead-code` flagged `PermissionResolver.getPolicyIssues` as unused, because the resolver satisfied `PolicyIssueSource` only structurally.
  Fixed by declaring `implements PolicyIssueSource` (a type-only `policy/` → `config/` edge, which `fallow guard` allows), amended into step 4's commit.
  The plan's Module-Level Changes did not predict a resolver edit in step 4.
- **Deviation:** `lifecycle.test.ts`'s `makeSetup` also lost its now-unread `permissionManager` return field, beyond the planned swap of `resolver` for the reporter.
- **Em-dash dropout recurred twice in `Edit` bodies** (the `before-agent-start.ts` doc bullet arrived as a newline plus `dash`; one `oldText` failed to match the same way).
  Both were caught by re-reading the region, and the written one was repaired with a scripted substitution, per `markdown-conventions`.
- **Reviewer re-derivation:** it enumerated every `loadUnifiedConfig` call `FilePolicyLoader` made at the base ref and found no string the removed channel delivered that `ConfigStore` does not, covering untrusted projects, reloads, legacy files, and agent files.
  It noted one timing nuance: the fail-closed notice can now arrive a turn *before* the schema string, since the policy side re-reads by mtime and `ConfigStore` per turn.

### Reviewer verdict

Pre-completion reviewer: **WARN**, ready for `/ship`.
Reviewer warnings: evidence provenance only.
The planning baseline (2 duplicates, 0 mid-session) came from one spike run per scenario; the new composition-root pins re-assert both outcomes.

## Stage: Sync (worktree) (2026-10-05T05:04:48Z)

### Session summary

Pre-push checks (`pnpm run lint` with zero Biome findings, `pnpm fallow dead-code`) both passed clean with no changes needed.
The plan's `**Release:** ship independently` marker holds: no batch, and the work is confined to `packages/pi-permission-system/` plus its package skill.
The one follow-up, [#1028], is filed and dispositioned out of scope for Phase 15; nothing else was deferred.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-953--/2026-10-05T04-09-05-762Z_01a10a40-41e1-76e8-a007-196620e69613.jsonl` — read with `read_session_file({ path: "..." })` for message-level verification at land/retro time.

### Observations

The latest stage entry's reviewer WARN is an evidence-provenance note only, with no open operator decision.
The `/ship` root should know the fix changes what the operator sees in two ways: a fail-closed notice now arrives mid-session, and a schema error at session start is shown once rather than twice.

## Stage: Final Retrospective (2026-10-05T13:53:04Z)

### Session summary

The peer session planned, implemented, and synced #953 in one transcript (Opus for planning and TDD, Sonnet for sync), and the root session shipped it as a worktree-lane fast-forward.
CI and the release run both passed, and `pi-permission-system` released as 39.0.4.
The implementation was clean: every killing mutation reddened what the plan predicted, and the only deviation (the `implements PolicyIssueSource` fix) came from a gate rather than from rework.

### Observations

#### What went well

- **The planning spike changed the design.**
  Reproducing through the real composition root before the first gate found the start-time duplicate that the issue's suggested fold would have locked in.
  The plan then deleted code (the loader's issue accumulation) instead of adding a second reporter over a duplicated list.
- **The worktree convergence had no friction.**
  `/sync-worktree`'s rebase was a no-op, step 4's `merge-base --is-ancestor` prediction held, and the root's lint and dead-code gates passed on the merged tree.

#### What caused friction (agent side)

- `instruction-violation` (user-caught) — the planning gate's turn had no visible text before the `ask_user` call, so all of its substance sat in option descriptions.
  The planning stage note recorded the bounce as an undefined term (`ConfigStore`), but the transcript shows a bigger miss: the `clarification-gates` skill's `## Substance first` rule was broken outright, 17 turns after the skill was loaded.
  The follow-up explanation then laid out the three options without arguing for one, so the operator had to ask "Which way forward would you recommend?"
  Impact: two extra operator round-trips before the design settled; no rework.
- `instruction-violation` (self-identified, in this retro) — the architecture-doc entries for `policy-issue-reporter.ts`, `permission-manager.ts`, and `before-agent-start.ts` each end with a `(#953)` provenance citation.
  The `markdown-conventions` skill's `## Architecture docs` section says to cite an issue in a module-tree entry only for an active constraint.
  The pre-completion reviewer did not flag it.
  Impact: three citations that `/finish-phase`'s doc-hygiene pass would otherwise have to remove.
- `other` — Unicode handling in `Edit` bodies again: an em-dash came out as a newline plus `dash` in a `newText`, an `oldText` failed on a mistyped em-dash, and the TDD stage note arrived with literal `\u2212`/`\u2192` escapes.
  All three were self-caught by re-reading, and the escape gates exist.
  Impact: about four extra tool calls; no rework that landed.
- `instruction-violation` (self-identified, in this retro) — in `/ship` the agent called `issue_close` without first re-resolving the close comment's hex tokens with `git rev-parse` and `merge-base --is-ancestor`, as the `## 9. Close the issue` section requires.
  The SHAs were pasted from `git log` output in the same session, so all of them were correct.
  The final report also said the roadmap last-step check had not been done instead of doing it; #953 is not a Phase 15 step.
  Impact: none this time, but the verification is there to catch a bad SHA before it is published.

#### What caused friction (user side)

- None of note.
  The operator's challenge ("I'm not thrilled about the duplication") turned into a scoped follow-up, [#1028], instead of scope creep.

### Diagnostic details

- **Model-performance correlation** — Opus ran planning and TDD, which were the judgment-heavy stages; Sonnet ran the mechanical sync stage.
  The `tidy-first-assessor` and `pre-completion-reviewer` dispatches both returned sound verdicts.
  Neither the assessor nor the reviewer caught the `(#953)` architecture-doc citations.
- **Feedback-loop gap analysis** — `pnpm fallow dead-code` ran only at the baseline and in the final gates.
  It flagged `PermissionResolver.getPolicyIssues` after step 4, which forced an amend.
  The plan did not predict the edit, because a method that satisfies an interface only structurally shows as unused once its old caller is removed.

### Changes made

1. `packages/pi-permission-system/docs/architecture/architecture.md`: dropped the `(#953)` provenance citations from the `policy-issue-reporter.ts`, `permission-manager.ts`, and `before-agent-start.ts` module-tree entries.
2. No change to `clarification-gates` or `/plan-issue` for the gate that had no message before it; the rule already exists word for word, and one breach does not justify a tool-side mechanism.

[#933]: https://github.com/gotgenes/pi-packages/issues/933
[#1028]: https://github.com/gotgenes/pi-packages/issues/1028
