---
issue: 1030
issue_title: "pi-permission-system: a forwarded bash ask carries only the chain's winning unit, so the serving node approves commands it never judged"
---

# Retro: #1030 — a forwarded bash ask carries only the chain's winning unit, so the serving node approves commands it never judged

## Stage: Planning (2026-10-06T04:04:45Z)

### Session summary

I reproduced the issue's table and its comment's session-grant case through the real parser, `resolveBashCommandCheck`, and the real `ResolverServingPolicy`.
The plan adds a per-unit fact: the child stamps `askingUnits` (`{command, floor?}` for each asking unit that is not session-granted) on its check result, and that list rides `ForwardedAccessFacts`.
The serving node resolves each unit as a `bash-command` intent, honors that unit's floor, and lets the most restrictive answer win.
I filed [#1033] for a local bypass the spike found and recorded it as a new Phase 15 step after this one.

### Observations

- Operator decisions:
  - Only asking units travel (not child-allowed ones).
  - The local session-tie bypass is a separate issue ([#1033]), placed as a new step directly after this issue.
- The spike's sharpest row: a parent's explicit `rm *` deny never saw `rm` in `ls && rm -rf /tmp/x`, so the line auto-approved on `ls*`.
- Review log (measured): 74 forwarded bash auto-approvals, all floored, and 0 plain-rule chains, so the fix adds no prompts on this operator's log.
- [#1033]: a session-granted wrapper unit floors to an `ask` that keeps `source: "session"`, wins `pickMostRestrictive`'s first-wins tie, and `GateRunner`'s session fast path approves the whole chain locally (reproduced).
- Naming: I rejected `unresolvedUnits`, because `parseUnresolved` already means a parse failure; the field is `askingUnits`, and the per-unit object uses `command` so [#1019] can add `spellings`.
- The chain-level `floor` and `matchValues` stay as the summary that older serving nodes read; with units present, the serving node ignores them.
- The empty-array and malformed `askingUnits` cases are rejected in the reader, which escalates.

#### Deferred tidyings

- `src/handlers/gates/bash-command.ts` and `src/policy/serving-policy.ts` each build the same `bash-command` intent literal; sharing it would need a cross-zone edge, so the assessor rejected it.
- `src/authority/forwarding-io.ts`: `asForwardedAccessIntent` could be split into per-field validators; that is unrelated cleanup.

## Stage: Implementation — TDD (2026-10-06T04:24:46Z)

### Session summary

I completed all five plan steps as five commits: three `refactor:`, one `fix:`, and one `docs:`.
Every plan-named killing mutation went red, and one mutation prediction was corrected.
`pi-permission-system` grew from 5562 to 5587 tests (+25).

### Observations

- Plan deviation: the serving yolo row stays green when `resolve` is mutated to always use the single-value path, because there the chain-level floor's yolo branch also approves.
  The row is pinned instead by passing `false` for yolo in `resolveUnit`.
  I dropped the test's `origin: "yolo"` assertion: in `[ls, sudo rm y]`, the first-wins tie reports the unfloored `ls` result, so the winner's origin is `global` even with the fix.
- `const [first, ...rest] = intent.askingUnits ?? []` failed ESLint's `no-unnecessary-condition`, because without `noUncheckedIndexedAccess` the destructured `first` is never `undefined`.
  The fix uses `units.at(0)` with `units.slice(1)`.
- The reader validates with `isWellFormedAskingUnits` and rebuilds each unit with `copyAskingUnits`, so unread keys from the wire cannot ride through.
- The `ServingPolicy` doc comment in `forwarded-request-server.ts` was amended into the `fix:` commit, not the `docs:` one.
- Pre-completion reviewer: PASS.
  Its residual note: a forged request with a non-bash surface that carries `askingUnits` would be judged on the bash surface; no in-tree child produces one.

## Stage: Sync (worktree) (2026-10-06T04:31:01Z)

### Session summary

`pnpm run lint` and `pnpm fallow dead-code` pass on the branch, and the TDD stage's reviewer verdict was a PASS with nothing open.
The plan's marker is `**Release:** ship independently`, so the root dispatches a `pi-permission-system` release after landing.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1030--/2026-10-06T03-50-07-927Z_01a10f55-4134-72ea-b3ef-2eb4c525ab14.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

The branch carries the plan, the five implementation commits, the Phase 15 disposition for [#1033], and the stage notes. [#1033] (the local session-tie bypass) is the filed follow-up, placed as the next Track D step, so the root files nothing new.

## Stage: Final Retrospective (2026-10-06T04:40:06Z)

### Session summary

The issue ran in four sessions: planning, TDD, and sync in one peer worktree session, then ship and retro at the root.
It landed as three `refactor:` commits, one `fix:`, and one `docs:`, and was released as `pi-permission-system-v39.1.2`.
The ship fast-forwarded cleanly, and CI, the release run, and the worktree teardown all passed on the first attempt.

### Observations

#### What went well

- The planning spike drove the real parser, `resolveBashCommandCheck`, and `ResolverServingPolicy` (`test/spike/spike-1030.test.ts`, deleted before commit).
  It reproduced the issue's table and also surfaced [#1033], a separate local bypass, which became a filed issue with a recorded roadmap disposition instead of scope creep.
- A second spike replayed the operator's review log through the real parser (74 forwarded bash auto-approvals, 0 plain-rule chains).
  That turned "adds no prompts" from a guess into a measured claim the close comment could cite.
- Every TDD step ran its plan-named killing mutations through a small `/tmp/mut.mjs` harness that applied the mutation against a saved green copy and then restored it.
  The harness caught the plan's one wrong mutation prediction (the yolo row), and the step's test was re-pinned rather than shipped as a test that kills nothing.

#### What caused friction (agent side)

- `missing-context` — the plan prescribed `const [first, ...rest] = intent.askingUnits ?? []`, which ESLint's `no-unnecessary-condition` rejects in this repo because `noUncheckedIndexedAccess` is off, so the destructured `first` is never `undefined`.
  The `fix:` commit's pre-commit hook failed (TDD turn 87), and the code was rewritten to `units.at(0)` / `units.slice(1)`, with the mutation re-checked against the new line.
  Impact: 2 extra tool calls, no follow-up commit.
- `instruction-violation` (self-identified) — the sync stage's `Edit` wrote a literal `\u2014` escape for an em-dash in the stage note, which `markdown-conventions` already forbids.
  The agent noticed it right away; its `sed -i` repair matched nothing, and a Python replacement fixed it.
  Impact: 2 extra tool calls, no rework past the commit.

#### What caused friction (user side)

- None observed: the operator's two planning-gate answers (only asking units travel; [#1033] as a separate step) were decisive and arrived on the first ask.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `claude-opus-5-5`, and sync and ship on `claude-sonnet-5-5`, which fits each stage's judgment load.
  Both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `claude-sonnet-5-5` according to their own transcripts, and the reviewer's PASS came with a substantive residual note (a forged non-bash request carrying `askingUnits`).
- **Feedback-loop gap analysis** — verification was incremental: each TDD step ran its targeted tests, `pnpm run check`, and its mutations before committing, and the full suite plus lint and `fallow` ran once at the end.

### Changes made

1. Appended this Final Retrospective entry to `packages/pi-permission-system/docs/retro/1030-forwarded-ask-carries-every-unit.md`.
   I proposed one `code-design` line on `noUncheckedIndexedAccess` destructuring, and the operator declined it, because the lint hook already catches the failure in about two calls.

[#1019]: https://github.com/gotgenes/pi-packages/issues/1019
[#1033]: https://github.com/gotgenes/pi-packages/issues/1033
