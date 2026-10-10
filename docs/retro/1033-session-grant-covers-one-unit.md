---
issue: 1033
issue_title: "pi-permission-system: a session grant on one unit of a bash chain approves its sibling asking units"
---

# Retro: #1033 — pi-permission-system: a session grant on one unit of a bash chain approves its sibling asking units

## Stage: Planning (2026-10-06T22:29:11Z)

### Session summary

Reproduced the bypass through the real parser, resolver, and session ruleset in a disposable spike, and found a second shape the issue did not name (`sudo rm y && sudo rm z` with only `y` granted runs `z` unprompted, no rule needed).
Spiked the fix, the dead-filter removal, and the runner hardening against the full suite, then wrote a three-step plan: the floors skip a session grant, the runner's fast path requires a session `allow`, and the architecture doc updates.

### Observations

- The operator chose option A (a session-granted unit is never floored) over option B (a non-session tie-break in `pickMostRestrictive`, which the roadmap step's `Target:` bullet named), and chose to harden `GateRunner` as well.
  The roadmap `Target:` bullet is reworded in the doc step to match.
- The operator asked whether either option violates design principle 3 ("session approvals are just more rules") and where "the roadmap's named target" came from; the answer was that the principle governs matching, and both options read `source` after resolution as the code already does in several places.
  They also asked for a component/responsibility diagram before deciding; an ASCII flow placing each option at its step settled it.
- `floorToAsk`'s spread is the only producer of an `ask`/`session` check (`SessionRules` records only `allow`), so removing it at the floors makes the `source !== "session"` filters in `withChainFloor`/`withAskingUnits` dead; they are removed.
- Hardening the runner makes `isUnconditionalDeny`'s session clause rest on a false premise, so Step 2 drops it and flips its descriptor test; that part was not spiked.
- Observable side effects: a `session_approved` entry for a floored unit now names the grant's pattern instead of the sentinel (113 such entries in the local review log, measured), and a mixed rule-allow/session-allow chain may log a rule allow instead of `session_approved`.
- The Tidy-First assessor recommended no preparatory commits; it corrected the design's "one guard vs two" question: the wrapper guard reads `base` while `floorUnparsedUnit` reads the possibly exempt inner result, so the two guards stay separate.

## Stage: Implementation — TDD (2026-10-06T22:42:29Z)

### Session summary

Completed all three plan steps: the floors skip a session grant (`fix:`), the runner's fast path requires a session `allow` with `isUnconditionalDeny` matching (`refactor:`), and the architecture-doc update with the `✅` step marks and `Landed:` note (`docs:`).
The package suite went from 5664 to 5668 tests (four new chain tests; three existing tests rewritten).

### Observations

- No deviations from the plan; every killing mutation reddened exactly the predicted tests.
  Dropping the wrapper guard also reddened the two existing `#1029`/`#1030` "leaves out … the session already granted" tests, which confirms they now pin the outcome through the unit's state.
- The Step 2 mutations were applied together; each kills a test in a different file that exercises only its own function, so the pairing is unambiguous.
- An `Edit` of a runner comment emitted a literal `\u2014` escape into TypeScript source; caught on read-back and replaced with a colon before commit (the markdown gates do not cover `.ts` comments).
- Pre-completion reviewer: PASS.
  It re-derived that `deriveSource` (session layer) and `SessionRules.approve` (allow only) are the sole producers of a session-sourced check, so no session `ask` can reach the combiner.

## Stage: Sync (worktree) (2026-10-06T22:45:09Z)

### Session summary

Pre-push `pnpm run lint` and `pnpm fallow dead-code` passed from the worktree root.
The plan's marker is `**Release:** ship independently`; the `fix:` commit is the only one that reaches the changelog.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1033--/2026-10-06T21-21-39-169Z_01a11317-f360-76b6-b040-2037a93c752d.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

No follow-ups filed and nothing deferred.

## Stage: Final Retrospective (2026-10-06T22:56:19Z)

### Session summary

The fix landed through the worktree lane: a session grant on a floored bash unit now stays `allow`/`session`, so a sibling unit's real `ask` wins the chain, and `GateRunner`'s fast path requires a session `allow`.
The ship fast-forward-merged cleanly, CI passed, #1033 closed, and `pi-permission-system-v40.0.2` released with no rework at any stage.

### Observations

#### What went well

- Planning spiked all three changes (the floor guards, the dead-filter removal, the runner hardening) against the full suite before writing the plan, so the plan's predicted reds and killing mutations held exactly in TDD: zero deviations, and every mutation reddened the predicted tests.
- The planning gate measured the defect's footprint in the operator's own review log (113 `session_approved` entries carrying a floor sentinel) instead of estimating it, and reproduced through the real parser, resolver, and session ruleset.
- An ASCII component-flow diagram, placing option A at the floor, option B at `pickMostRestrictive`, and the hardening at the runner's fast path, settled the A-vs-B decision in one turn after the first gate left it unanswered.

#### What caused friction (agent side)

- `other` — the first `ask_user` gate described both options in prose and named "the roadmap's named target" without defining it.
  The operator answered only the hardening question, then asked what principle 3 implied and where "the named target" came from, then asked for a diagram of where each option acts.
  Impact: two extra operator round-trips before the decision; no rework.
- `instruction-violation` (self-identified, twice) — a literal `\u2014` escape was emitted into authored text: once into a `runner.ts` comment during TDD (Opus), once into the sync stage note (Sonnet).
  The markdown one was decoded by `pi-autoformat`; the TypeScript one was caught only on read-back, because `scripts/lint/unicode-escapes.mjs` lists only `*.md` files.
  Impact: one extra edit each; no gate would have caught the `.ts` case.
- `other` — in TDD Step 1 a `Read` batched with the implementing `Edit` returned the pre-edit snapshot, costing one extra `git diff`/`grep` call to confirm the edit landed.
  Impact: one tool call; `/tdd-plan` already warns that batched calls run concurrently.

#### What caused friction (user side)

- The operator's questions after the first gate (principle 3, "the named target", then the diagram request) were redirecting questions rather than corrections, and they produced the artifact that decided the design.
  Asking for the diagram in the first reply would have saved one round-trip.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `claude-opus-5-5`; sync ran on `claude-sonnet-5-5`, appropriate for a mechanical stage.
  Both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `claude-sonnet-5-5` per their transcripts; the assessor corrected a design premise (the two floor guards read different values) and the reviewer re-derived the session-source producers independently, so neither was under-powered.
- **Feedback-loop gap analysis** — no gap: TDD ran the affected test file at each Red, Green, and mutation, the package suite plus `check` and root `lint` before each commit, and the full root gates once at the end.

### Changes made

1. `.pi/skills/clarification-gates/SKILL.md` — added a `## Substance first` rule: when the options act at different points of one flow, draw the flow with each option placed at the point it changes.
2. Filed #1038 (`scope:repo`): extend `scripts/lint/unicode-escapes.mjs` to literal escapes in `.ts`/`.js` comments; no package phase applies, so no roadmap disposition.
