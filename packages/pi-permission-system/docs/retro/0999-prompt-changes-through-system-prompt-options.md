---
issue: 999
issue_title: "mcp_servers prompt section missing when pi-permission-system is enabled"
---

# Retro: #999 — mcp_servers prompt section missing when pi-permission-system is enabled

## Stage: Planning (2026-10-01T21:43:08Z)

### Session summary

Confirmed the cause the operator traced in the issue's comments: `AgentPrepHandler.handle` returns `{ systemPrompt }`, Pi stores it as `forceSystemPrompt`, and builtin:mcp's later `sections` edit never lands.
That cause collides with ADR 0014's relocation, and that ADR's #962 amendment had already rejected the `systemPromptOptions` route.
The operator chose in-place narrowing through the options, which retires the inherited-prefix invariant, and sequenced two prerequisites first: #970 (peer floor raised to `>=1.0.0`, not 0.86) and the newly filed #1009 (pi-subagents cuts `<tools>`/`<rules>` from the inherited identity).

### Observations

- The issue was filed by a third party (`graelo`), but the operator had already commented with a proposed fix; the gate confirmed the direction rather than skipping it.
- In Pi 1.0, mutable options, `sections`, `toolGuidelines`, and the reconciliation that sets an unedited `selectedTools` to `getActiveToolNames()` all arrived in one commit (`9e05370b2`, tagged into `v0.86.0`).
  So on 1.0 a Pi-authored root needs no tool-surface work at all beyond `setActiveTools`.
- Alternatives the operator considered and rejected: "pointer" (override Pi's head `<tools>`/`<rules>` in place with constant text and put the real surface in new tail sections; keeps the prefix but adds mechanism) and "keep forced" (decline).
  A `customPrompt` trick that suppresses Pi's built-ins was rejected without being offered, because other extensions read `customPrompt` (pi-subagents' `portablePrompt`, this package's #980 branch).
- The first `ask_user` bounced on the tool-surface question for lack of context; before/after prompt diagrams for root and child under each option settled it.
  Lead with diagrams when an option's effect is a prompt layout.
- A new residual: a denied skill in a catalogue Pi did not render (an operator's `SYSTEM.md`) is no longer filtered.
  This was decided inline on the #919/#932 precedent and recorded in the plan's Non-Goals; worth confirming at review.
- Breaking classification: `fix:`, not breaking, because ADR 0014 itself says the block's position is not a contract.
  The floor raise is #970's breaking change.
- Release ordering: #1009 (pi-subagents) must be released before this package, or children double-list their tools.
- `pi-subagents` has no open improvement phase, so roadmap-fit exited for #1009.
- Commented on #970 to record the operator's `>=1.0.0` floor decision.

## Stage: Implementation — TDD (2026-10-02T04:49:29Z)

### Session summary

All six plan steps landed, plus one review-driven fix folded into step 5: three preparatory commits (`renderToolSurfaceSections`, the skill classification split, the `makePromptOptions` fixture), two `fix:` commits that move the tool surface and the skill filter onto `systemPromptOptions`, and the ADR 0015 docs commit.
The handler never returns `systemPrompt` now; the ADR 0014 relocation and both prompt layouts are deleted.
The pi-permission-system suite went from 5174 to 5139 tests (about 1600 lines of relocation tests deleted, bullet-content tests retargeted, new option-mutation tests added).

### Observations

- The branch predated #970 and #1009, which had both landed by the time this session started.
  I rebased the two unpushed planning commits onto `origin/main` before step 1, since the plan required #970's 1.0 types.
  The retro for #970 changed two plan facts: the header layout was still present (#970 moved its deletion into #999), and #999 is the tail of the ad-hoc batch "pi-1.0 prompt options".
  A `docs:` commit ("mark #999 as the pi-1.0 prompt options batch tail") updated the Release marker before step 1.
- Deviation: a subagent child with no snippet for any allowed tool gets `sections.tools = ""` rather than no key, so a peer's stale list is cleared (Pi omits empty sections).
  It has its own test and killing mutation.
- Deviation: the composition-root root-under-custom-prompt test gained a `sections` assertion, because step 4's "drop `isSubagent`" mutation killed only the handler test at first.
- Pre-completion round 1 (WARN) found a regression this change introduced.
  `event.systemPrompt` is rendered from a pre-chain copy whose `selectedTools` is the previous turn's set, so on the turn `read`/`bash` return from a full denial it carries no `<skills>`, and denied skills went unfiltered while Pi then rendered the catalogue.
  The operator chose the minimal fix: judge denials on `systemPromptOptions.skills` through `withoutDeniedSkills`.
  `classifySkillPromptEntries` became `visibleSkillPromptEntries` (entries only).
  The fix was folded into the step-5 commit ("keep later prompt sections when a skill is denied") so the changelog does not announce a regression that never shipped.
- Pre-completion round 2: WARN.
  The remaining finding predates this change and was accepted when the operator chose option 1 over option 2: on that same relaxation turn the skill path-match entries are empty, so reading an `ask` skill's files is not skill-gated for one turn.
  Fix if wanted: build Pi's catalogue entries from `options.skills` (`name`, `filePath`) and merge them with the parsed ones.
- Mutation hygiene: a `cp` to `/tmp/green.ts` run in the same batch as the mutating `Edit` captured the mutated file (step 2); I restored it by hand and re-ran.
  Another mutation read green once, likely because the formatter raced the edit; re-applying it and checking the file showed the expected reds.
- Not run: the plan's end-to-end check (a fresh Pi session with one `codemode` MCP server, counting `<mcp_servers>` in the first request).
  This session runs the published handler, so the check needs a fresh Pi session; do it before or at `/ship`.
- Not changed: `packages/pi-subagents/docs/decisions/0008-inherited-region-is-shared-parts.md` item 2 still says pi-permission-system implements tail-placed tool prose in ADR 0014.
  pi-subagents ADR 0011 already records the transition, so it is a cross-package boy-scout edit, not this issue's.

## Stage: Sync (worktree) (2026-10-02T04:51:45Z)

### Session summary

Pre-push checks passed (`pnpm run lint`, `pnpm fallow dead-code`).
The plan's marker is `**Release:** ship now — batch "pi-1.0 prompt options" tail`, so `/ship` should name pi-permission-system in the dispatch: #970's unreleased `feat!:` floor raise rides the same major, and #1009 already shipped as pi-subagents 21.9.1.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-999--/2026-10-01T21-08-38-613Z_01a0f94c-3e55-7379-a632-628d5e4fcf4a.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

- The plan's end-to-end check (fresh Pi session, one `codemode` MCP server, count `<mcp_servers>` in the first request) has not run; do it before or at `/ship`.
- The accepted pre-completion WARN is the relaxation-turn gap in skill path-match entries, recorded in the TDD stage note.
