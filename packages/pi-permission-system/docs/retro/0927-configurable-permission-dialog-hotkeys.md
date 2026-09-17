---
issue: 927
issue_title: "[Feature Request] pi-permission-system: Configurable hotkeys for the inline permission dialog (unfriendly to IME users)"
---

# Retro: #927 — Configurable hotkeys for the inline permission dialog

## Stage: Planning (2026-09-16T05:23:00Z)

### Session summary

Planned a `permissionDialogKeys` config option that rebinds the inline TUI permission dialog's five decisions to single printable characters, keeping `y`/`s`/`b`/`n`/`r` as defaults.
Two `ask_user` gates settled the direction (config map rather than always-on digit aliases) and three implementation parameters (single-character vocabulary, tolerant fallback instead of fail-closed scope rejection, whole-object cross-scope merge).
The plan is `packages/pi-permission-system/docs/plans/0927-configurable-permission-dialog-hotkeys.md`, with seven TDD steps — two of them Tidy-First preparatory refactors.

### Observations

- The issue is third-party (`undoubted`), so the `ask_user` direction gate was mandatory.
  The operator chose option B (config map, defaults unchanged) over the recommended option C (digit aliases by default plus config override).
- The reported accidental denial traces to a specific code path: `escape` is the natural key for dismissing an IME candidate popup, it reaches the terminal when letter presses do not, and `toEvent` maps it to `cancel` → `createDeniedPermissionDecision()`.
  That is the only non-letter deny path in the dialog.
- Probed `matchesKey` against the pinned `@earendil-works/pi-tui@0.79.1` rather than reading docs.
  Three findings the plan rests on: `matchesKey("+", "+")` is **`false`** (`parseKeyId` splits the id on `+`, leaving an empty key name), `matchesKey("a", "A")` is `true` while `matchesKey("A", "a")` is `false` (so an uppercase config value silently binds the lowercase key and must be rejected), and `Key`'s single-character values enumerate pi-tui's 31 symbol keys at runtime — which turned "named keys are expensive to validate" into a false premise and removed it from the vocabulary trade-off.
- Confirmed Pi has no seam for this: `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` in pi's extension runner governs global editor shortcuts, and a focused `ctx.ui.custom` component consumes every keystroke itself.
- Plan `0573`'s Non-Goal named its own trigger — "revisit only if requested" — so the deferral was a lead that resolved cleanly rather than a boundary to argue around.
  No ADR, README scope row, or architecture non-goal names hotkey configurability.
- The Tidy-First assessor **inverted** the design's own sequencing.
  The design summary led with a `PromptKey` → `PromptAction` rename; the assessor showed the rename is unsafe until the identity/character split lands, because until then the literal `"y"` means "the approve action" on one test line and "the key pressed" on the next.
  Its recommended first commit is a three-site, test-invisible indirection (`config.keys?.[key] ?? key`), after which the rename is a bounded hand edit of ~44 occurrences in one test file.
  It also measured that `permission-prompt-component.test.ts` has **zero** identity-typed occurrences, which shrank the predicted blast radius substantially.
- The assessor's survey of `DEFAULT_EXTENSION_CONFIG` assertion sites found every one spreads `...DEFAULT_EXTENSION_CONFIG`.
  Separately, the package skill's rule that `promptMaxRows`/`promptFieldMaxWidth` keep their defaults at their resolver (`resolveRenderBudget`) redirected the design away from putting a resolved map on `DEFAULT_EXTENSION_CONFIG` at all — which also keeps `config-modal.ts`'s hand-listing `cloneDefaultConfig()` compiling.
  That file is recorded in the plan as a predicted-unchanged site with the claim it rests on (the field is optional).
- The collision rule needed a bounded fixed point rather than a single pass.
  Dropping a colliding override restores its default, and that default can collide with a surviving override: `{ approve: "b", deny: "y" }` needs two rounds.
  That case is the plan's named killing mutation for the loop, and eleven other equivalence classes pass under a single-pass implementation.
- Layering drove the new module into `src/config/dialog-keys.ts` rather than `src/authority/`: `config-loader.ts` needs the resolver for its issue detector, and `config/` is documented as the bottom layer, so the dialog imports *down* into config instead of config importing *up* into authority.
- The tolerant-validation choice is a deliberate carve-out from the package's fail-closed convention (#547).
  The plan states the split explicitly — shape strict in the schema, binding semantics tolerant in the resolver — so a later reader does not read it as an oversight.

#### Deferred tidyings

- `packages/pi-permission-system/src/authority/permission-prompt-decision.ts` — three parallel per-action tables (`OPTION_ORDER`, `NARROW_OPTION_ORDER`, `OPTION_VERBS`) plus `OPTION_LABELS` in the component could collapse into one record carrying order, verb, and label together.
  Rejected as scope creep: none of them gain a dimension from this change, so consolidating now is unrelated cleanup rather than preparation.

## Stage: Implementation — TDD (2026-09-16T21:59:20Z)

### Session summary

Shipped `permissionDialogKeys` in seven planned TDD cycles plus one reviewer-driven follow-up, across eight commits (four `refactor:`, two `feat:`, one `docs:`, one `test:`).
The `pi-permission-system` suite went from 4342 to 4391 tests (+49).
Pre-completion reviewer: **PASS** on the delta round, after a **WARN** on the first round whose two findings were both fixed.

### Observations

- The Tidy-First sequencing paid off exactly as the assessor predicted.
  Step 1's three-site `config.keys?.[key] ?? key` indirection changed no existing assertion — verified by stashing the source and watching precisely the four new tests go red — and that made Step 2's `PromptKey` → `PromptAction` rename a mechanical single-file test edit.
  The assessor's measurement that `permission-prompt-component.test.ts` holds **zero** identity-typed occurrences held: all its single-letter literals are simulated keystrokes or rendered characters, which stay correct under the default bindings.
- The rename was scripted with line-mode `perl -pi` per-symbol substitutions (safe: single-line, no backslashes), but the four roster/`seen` array assertions and one `.toBe("y")` had to be hand-edited — a scripted pass cannot tell a roster element from a rendered character.
- Every planned killing mutation behaved as predicted, and the counts matched.
  The one that earned its place is Step 4's `(b)`: replacing the collision loop's bound with a single pass reddened exactly the cascading case (`{ approve: "b", deny: "y" }`) and left the other eleven equivalence classes green — which is the whole argument for a fixed point rather than a check.
- Three deviations from the plan, all noted in commit bodies:
  1. Step 1 also threaded `PromptPreferences.dialogKeys`, because the plan's two component sites are unreachable from a test without a way in.
  2. `test/composition-root.test.ts` was listed as predicted-unchanged and did change — it gained a `makeTuiCtx` harness (`mode: "tui"` plus a `ui.custom` that captures the component) and two end-to-end tests.
     That harness is the only place the feature is observable as a user sees it, and the composition root previously drove only the `select`/`input` fallback, which has no hotkeys.
  3. The plan named `loadUnifiedPermissionConfig` as the detector's caller; the real function is `loadAndMergeConfigs`.
- The plan's step-6 design assumed the config issue would reach `ui.notify`.
  It does not: `index.ts` primes the store with `configStore.refresh(undefined, false)`, which records `lastConfigWarning` while `ctx?.ui.notify(…)` is a no-op, so the identical warning at `session_start` is deduped away.
  This swallows `detectPermissiveBashFallback` and `detectDeprecatedPreviewCaps` the same way and predates this change — filed as [#933], dispositioned out of scope against Phase 15, and the composition-root test asserts against the debug log's `config.loaded` entry as a result.
  The reviewer independently confirmed the mechanism and traced the dedupe back to [#335].
- Verifying pi-tui's matcher by execution rather than by reading was the right call and changed the design twice: `matchesKey("+", "+")` is `false` (the identifier is split on `+`), and `matchesKey("a", "A")` is `true` while `matchesKey("A", "a")` is `false` — so an uppercase binding would silently answer to the lowercase key and is rejected rather than normalized.
  Both are pinned by test, the `+` exclusion against a live `matchesKey` call so it cannot rot into an unexplained special case.
- Two ESLint rules shaped the implementation rather than merely annotating it: `@typescript-eslint/no-misused-spread` rejects `[...someString]` and `.split("")`, so the bindable set is built with `Array.from`; and the counted `for (let round = ACTION_ORDER.length; round > 0; round--)` form keeps `round` used, which a `for (const _ of …)` would not.
- Reviewer round 1 returned WARN on two precision findings, both fixed in `test(pi-permission-system): pin permissionDialogKeys' strict-shape rejection`: the `detectUnusableDialogKeys` docstring claimed the user is told (false given [#933]), and the schema half of the strict-shape/tolerant-semantics split had no test of its own, unlike the sibling `shellTools field` block.
  Round 2 (delta-scoped) returned PASS, having named a distinct reddening mutation for each of the five new schema cases.
- `test/composition-root.test.ts` flaked three times during the session on three *different* tests, each time green on re-run.
  Already tracked as [#925]; no new issue filed.

## Stage: Sync (worktree) (2026-09-16T22:41:26Z)

### Session summary

Pre-push checks (`pnpm run lint`, `pnpm fallow dead-code`) both pass with no changes needed.
The plan's `**Release:**` marker is `ship independently`, so the root may release `pi-permission-system` without waiting on any batch.
No deferred work or follow-ups beyond [#933], already filed and dispositioned against Phase 15 as out of scope.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-927--/2026-09-16T04-49-39-500Z_01a0a88c-90ab-72d8-9833-1352768b615f.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

Straightforward sync; nothing to flag beyond what the TDD stage note already records.

[#335]: https://github.com/gotgenes/pi-packages/issues/335
[#925]: https://github.com/gotgenes/pi-packages/issues/925
[#933]: https://github.com/gotgenes/pi-packages/issues/933
