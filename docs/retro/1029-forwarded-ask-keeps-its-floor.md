---
issue: 1029
issue_title: "pi-permission-system: a forwarded bash ask loses the wrapper floor and auto-approves under a permissive catch-all"
---

# Retro: #1029 — a forwarded bash ask loses the wrapper floor and auto-approves under a permissive catch-all

## Stage: Planning (2026-10-06T00:56:15Z)

### Session summary

I reproduced the bypass through the real parser, `resolveBashCommandCheck`, and the serving node's `buildResolvedIntentFromMatchValues` + `PermissionResolver.resolve`, and measured it in the local review log.
All 74 of 74 forwarded bash auto-approvals were floored asks.
The plan carries a chain-level `floor` fact from the child's `PermissionCheckResult` onto `ForwardedAccessFacts`, and a new `ResolverServingPolicy` (`src/policy/serving-policy.ts`) clamps a serving `allow` to `ask` with it.
I filed two follow-ups, [#1030] (a new Phase 15 step) and [#1031] (out of scope), and recorded both in the roadmap.

### Observations

- Operator decisions:
  - Scope B: the floor travels when any asking unit was floored, not only the winner.
  - A serving node in yolo still approves a floored forwarded ask, which is today's "yolo approves everything".
  - Commit type `fix:`, not `fix!:`, despite the #992/#609 "newly prompts" precedent.
- The spike found a wider bypass: the serving node judges only the chain's winning unit (`ls && rm -rf /tmp/x` under a parent `ls*: allow`).
  I filed it as [#1030] and placed it directly after this step; it and [#1019] likely share one per-unit wire shape.
- A serving session grant must stay exempt from the floor (local parity: the runner's session fast path tests `source` before `state`), or whole-serving-session grants stop sticking for floored commands.
- Zone constraint: `authority/` may not import `policy/`, so the serving policy class lives in `policy/` with a type-only import of `ServingPolicy`.
  `ForwardedRequestServer`'s deps bag does not grow; yolo enters through the policy.
- `test/authority/forwarded-request-server.test.ts`'s `ServingPolicy resolves…` block hand-rebuilds the `index.ts` lambda.
  Step 3 moves it onto the extracted class, which closes that drift.
- The Tidy-First assessor claimed the composition-root `approveForwardedRequest` drives the parent's server end to end.
  It does not: it writes the response by hand.
  So the serving wiring is pinned through the class tests, not the composition root.
- Unverified lead, not filed: locally, a session-sourced floored unit that wins a tie fast-paths the whole chain through `GateRunner`'s session branch, approving sibling asking units.

#### Deferred tidyings

- None.
  The assessor rejected widening `accessFactsFromValue` with a `floor` parameter (its skill callers never floor) and moving the `ServingPolicy` interface; neither is debt.

## Stage: Implementation — TDD (2026-10-06T01:18:14Z)

### Session summary

I completed all five plan steps as five commits (two preparatory `refactor:`, one wire `refactor:`, the `fix:`, and `docs:`), and every plan-named killing mutation went red.
`pi-permission-system` grew from 5541 to 5562 tests (+21).
The one changelog line is `fix(pi-permission-system): a subagent's floored bash ask prompts on the parent instead of riding its allow rule`.

### Observations

- The deny-winner probe first used `sudo ls && rm x`, and its mutation survived: `ls` is a core reader, so `sudo ls` is exempt and raises no floor for the chain to leak.
  The probe became `sudo touch y && rm x`.
- Plan deviation: Test Impact item 3 claimed a bare `floor: check.floor` would turn the unfloored `toEqual` tests red.
  It does not, because `toEqual` ignores `undefined`-valued keys.
  The conditional spread stays; the reviewer confirmed it keeps the key set stable for `toStrictEqual` consumers, and JSON drops `undefined` on the wire either way.
- The roadmap step's `Outcome:` named `time rm x`, which [#963] already resolves by `rm`'s own rule, so it never floors; the Outcome now names `sudo rm x`.
- The test block that hand-rebuilt the `index.ts` serving lambda moved to `test/policy/serving-policy.test.ts`, where it now constructs `ResolverServingPolicy`.
  Mutating the class's surface argument reddens four of its five tests.
- `index.ts` passes `isYoloEnabled` into `ResolverServingPolicy`, and nothing pins that wiring; this is the one-line risk the plan named.
- Pre-completion reviewer: WARN.
  Reviewer warning: a chain floor does not hold against a serving session grant that covers the winning unit's value (`git push *` granted on the parent approves `git push … && sudo rm y`).
  It is not a regression, and it belongs to [#1030]'s class, so I recorded it there as a comment rather than widening this change.

## Stage: Sync (worktree) (2026-10-06T01:29:18Z)

### Session summary

`pnpm run lint` and `pnpm fallow dead-code` pass on the branch; the plan's marker is `**Release:** ship independently`, so the root dispatches a `pi-permission-system` release after landing.
The TDD stage's reviewer WARN is already settled: the chain-floor-versus-serving-session-grant case is recorded on [#1030], which is the follow-up the root need not file again.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1029--/2026-10-05T17-37-23-126Z_01a10d24-44b4-73ea-ab24-f4e9a0dddba1.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

The branch carries the plan, the five implementation commits, and the Phase 15 dispositions for [#1030] and [#1031]; no stage note cites a branch SHA.

## Stage: Final Retrospective (2026-10-06T03:03:25Z)

### Session summary

The issue went from planning through TDD and sync in one peer worktree session, then landed at the root as a clean fast-forward and released as `pi-permission-system-v39.1.1`.
Across all four stages, no step was reworked after its commit, no plan step was re-planned, and no operator correction came after the planning gate.
The friction that did occur cost one retry each and stayed inside its own step.

### Observations

#### What went well

- The planning spike ran the real parser, `resolveBashCommandCheck`, and the serving resolution in a throwaway `test/spike/` file, then deleted it.
  It turned a suspected bypass into a four-row table, and it found [#1030]'s wider bypass before the plan was written, not after the fix shipped.
- Measuring the operator's own review log (74 of 74 forwarded bash auto-approvals were floored) priced the fix's prompt cost from data instead of an estimate.
- Scripted mutation probes (`/tmp/mut.mjs`, which refuses a match count other than one, with a green-copy restore after each run) ran on every TDD step.
  The deny-row probe survived once (`sudo ls` is exempt, so it never floors), and that sharpened the test to `sudo touch y`.
  An under-specified test was caught by its own mutation rather than by review.
- The pre-completion reviewer's WARN (a serving session grant on the winning unit bypasses a chain floor) went to [#1030] as a comment, and the branch did not grow to cover it.

#### What caused friction (agent side)

- `missing-context` — the plan's Test Impact item 3 claimed that a bare `floor: check.floor` would turn the unfloored `toEqual` tests red.
  `toEqual` ignores keys whose value is `undefined`, so they stay green.
  Impact: none on the code (the conditional spread stays, for `toStrictEqual` consumers); one extra probe in TDD to disprove the claim.
- `other` — in TDD, a `node -e '…'` that built the relocated test file broke on an apostrophe inside the single-quoted script, and the peer switched to a `/tmp/*.mjs` file.
  Impact: one retry.
- `other` — the `fix:` commit's first attempt was rejected because the `biome` pre-commit hook reformatted a test that had been appended by heredoc and never formatted.
  Impact: one re-stage and re-commit.
- `other` — the planning retro note failed `rumdl` MD013 (two sentences on one line) and was fixed with `rumdl fmt`.
  Impact: one retry.
- `instruction-violation` (self-identified) — the ship's final report said the phase-close check had not been run, when the step only needed a read of the Phase 15 step list.
  Impact: none (it is not the last step; [#1030] follows it), but the report left an open item where a single `grep` would have settled it.
- `other` — in ship, a pasted `head -0` and a stray `[ $? ]` in two shell calls; both were harmless noise.

#### What caused friction (user side)

- None observed.
  The single operator intervention, the parent-yolo question in planning, came back as a question in place of a selection.
  The peer answered it in a visible message and re-asked, which is the clarification-gates pattern working as written.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `claude-opus-5-5` (judgment-heavy: spike design, three operator decisions, mutation design); sync ran on `claude-sonnet-5-5` (mechanical: gates, a note, a rebase); both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `claude-sonnet-5-5`, per their transcripts.
  The assessor made one false claim (that the composition-root `approveForwardedRequest` drives the server end to end), which the planner caught; the reviewer's WARN was correct and actionable.
  No mismatch to act on.
- **Feedback-loop gap analysis** — TDD ran the targeted tests and the package `check` after every step, and lint, fallow, and the full suite at the end.
  The gates also ran three times across sync and ship: before the rebase, after it (which the peer chose to add because `main` had moved), and again at ship on the same tree.
  The sync's post-rebase run and the ship's run covered an identical tree (`27db48c5`), costing roughly 26 seconds.

### Changes made

1. `.pi/skills/testing/SKILL.md`: added that `toEqual` ignores `undefined`-valued keys and cannot pin a key's absence, so `toStrictEqual` is the matcher when the key set is the claim.

[#963]: https://github.com/gotgenes/pi-packages/issues/963
[#1019]: https://github.com/gotgenes/pi-packages/issues/1019
[#1030]: https://github.com/gotgenes/pi-packages/issues/1030
[#1031]: https://github.com/gotgenes/pi-packages/issues/1031
