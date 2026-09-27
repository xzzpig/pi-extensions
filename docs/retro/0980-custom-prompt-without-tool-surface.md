---
issue: 980
issue_title: "pi-permission-system: do not synthesize <tools> and <rules> when Pi uses a custom system prompt"
---

# Retro: #980 — pi-permission-system: do not synthesize <tools> and <rules> when Pi uses a custom system prompt

## Stage: Planning (2026-09-26T03:18:54Z)

### Session summary

Planned a root-only stand-aside: when Pi builds the prompt from `customPrompt` and the node is not a detected subagent child, `AgentPrepHandler` skips `renderToolSurface` and hands `event.systemPrompt` to the skill filter unchanged.
Children and Pi-default sessions keep today's behavior; the change is breaking (`feat(pi-permission-system)!:`) because `docs/configuration.md` documents the appended block.
Plan committed at `packages/pi-permission-system/docs/plans/0980-custom-prompt-without-tool-surface.md` (two steps: one `feat!` cycle, one docs commit).

### Observations

- **Third-party issue; the proposed one-liner is the same one #919 rejected.**
  Every `@gotgenes/pi-subagents` child is a `customPrompt` session (re-verified: `create-subagent-session.ts:251` → pinned `resource-loader.js:329` → `agent-session.js:645`; Pi `main` `agent-session.ts:1389`), so branching on `customPrompt` alone strips every child's tool prose. #919's Non-Goals had named "reported again as a problem in its own right" as the reopen condition; this issue met it.
- **The discriminator already existed.**
  `SubagentDetector.isSubagent(ctx)` (registry → env hints → session dir) is the package's single node-role owner; both of its error directions land on an existing behavior (a misread root keeps today's block; an undetected child gets Pi-native no-list), so the predicate carries a low burden.
- **Gate decisions.**
  Direction: stand aside at the root, keep the block in children (recommended option taken).
  No opt-in setting to restore the block.
  The operator asked whether a user could suppress the block in children too; the answer was that a child cannot see its root's `customPrompt`, so it needs a cross-node signal or a config switch.
  The operator chose to wait for user feedback and **not** file an issue.
- **Tidy-First's one Recommended step was folded, not sequenced.**
  The `makeSetup` detector seam cannot precede the constructor parameter it feeds, and an injected-but-unread dependency risks Biome's unused-private-member rule, so it lands inside the `feat!` step.
  The assessor declined reshaping the constructor into a deps object, since siblings (`SessionLifecycleHandler`, seven params) are positional.
- **Credit.**
  The plan's step 1 carries `Co-authored-by:` for both tonybro233 (#980) and yofriadi (#919), whose `customPrompt` branch is the mechanism adopted with a child guard.
- **Open PR #908** (OMP prompt arrays) touches the same two files; not a close target, will need a rebase.

#### Deferred tidyings

- `src/handlers/before-agent-start.ts` — reshaping `AgentPrepHandler`'s positional constructor into a deps object; declined as inconsistent with its positional siblings.

## Stage: Implementation — TDD (2026-09-26T17:40:26Z)

### Session summary

Executed both planned steps: the `feat(pi-permission-system)!:` cycle (`AgentPrepHandler` gains a `SubagentDetector`, and a root under `customPrompt` skips `renderToolSurface`) and the docs commit (ADR 0014 amendment, architecture entries, `docs/configuration.md`).
`pi-permission-system` went from 4743 to 4749 tests (+6: four new handler cases, two composition-root cases; two existing handler cases moved into the new `describe` and retargeted to the child role).
`check`, root `lint`, `test`, and `fallow dead-code` are green.

### Observations

- **All five planned killing mutations killed exactly the predicted tests.**
  Always-render → three handler root cases plus the composition-root root case; drop the detector → both handler child cases plus the composition-root child case; `customPrompt !== undefined` → only the empty-string case; `{ isSubagent: () => false }` in `index.ts` → only the composition-root child case; early `return {}` → only the skills case.
  The two tests that stayed green during Red (the child case and the empty-string case) were pins, confirmed by those mutations.
- **Small deviation: a `hasCustomPrompt(event)` module helper.**
  Pi's truthiness test is now read in two places (the render decision and `piAuthoredPreamble`), so it moved into one function carrying the "empty string reads as none" comment instead of repeating `!event.systemPromptOptions?.customPrompt`.
- **Doc wording beyond the plan's list:** `docs/configuration.md`'s "moves to the end of the prompt for every session" became "every session on pi's default prompt", because the paragraph's own next sentence now excludes a root under a custom prompt.
- **Pre-completion reviewer: PASS.**
  It re-derived the four invariants (child states its tools, Pi-default relocation unchanged, filtering still runs, the inherited identity stays byte-identical) against the code rather than the plan, and found no stale statement in `README.md`, `docs/subagent-integration.md`, or the package skill.

## Stage: Sync (worktree) (2026-09-26T20:28:43Z)

### Session summary

Pre-push checks (`pnpm run lint`, `pnpm fallow dead-code`) passed clean, no fixes needed.
The plan's `**Release:** ship independently` marker stands — issue #980 is not a roadmap step, so `/ship` releases `pi-permission-system` on its own major bump for the breaking commit (`feat(pi-permission-system)!: stop appending a tool list and rules to an operator's custom system prompt`).
No deferred work: the Non-Goals' child-override question stays an open question with no issue filed, by operator decision.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-980--/2026-09-26T02-37-18-996Z_01a0db92-ff13-714c-840c-8e819a4a36d0.jsonl` — read with `read_session_file({ path: "..." })` for message-level verification at land/retro time.

### Observations

Nothing beyond the TDD stage's own notes; this sync found the branch already green.
