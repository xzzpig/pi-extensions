---
issue: 910
issue_title: "pi-permission-system: an absolute-path bash rule does not cover the relative spelling of the same path"
pr: 917
---

# Retro: #910 — an absolute-path bash rule does not cover the relative spelling of the same path

## Stage: PR Review (2026-10-06T04:58:30Z)

### Session summary

PR #917 (@ilkerulusoy) makes a `bash` rule written with an absolute path also match the same command written with a `cd`-relative or cwd-relative path, by adding resolved-path rewrites of each command unit as extra lookup values.
The defect reproduces on current `main`, in both directions.
The operator chose to adopt the capability with a simplified design built on `main`'s existing `BashCommand.spellings` mechanism (#981), scoped to the absolute spelling only, shipped as a non-breaking `fix:`.

### Evaluation

**Verify gate (current `main`).**
A scratch test (deleted afterward) drove `BashProgram.parse` → `resolveBashCommandCheck` → real `PermissionResolver` over `createInMemoryManager`:

| Policy (`bash`)                                           | Command                         | `main`            |
| --------------------------------------------------------- | ------------------------------- | ----------------- |
| `*: allow`, `rm *: ask`, `rm /tmp/agent-builds/*: allow`  | `rm /tmp/agent-builds/x`        | allow             |
| same                                                      | `cd /tmp && rm agent-builds/x`  | ask (`rm *`)      |
| same, cwd `/tmp`                                          | `rm agent-builds/x`             | ask (`rm *`)      |
| `*: allow`, `rm /etc/*: deny`                             | `cd /etc && rm passwd`          | allow (`*`)       |

The reported direction is fail-closed (an extra ask).
The mirror direction, not reported, is a `bash`-surface fail-open: an absolute-path `deny` is bypassed by `cd` plus a relative argument.
The `path`/`external_directory` gates still resolve `/etc/passwd`, so the composed decision is not a full bypass.
The input was synthetic (hand-written policy and command), on the far side of no extension — a direct library call.

**Already on `main`.**
The PR is based on `a867122d`; 534 package commits have landed since.
#981 shipped the same multi-spelling mechanism the PR builds: `BashCommandAccessIntent` (`kind: "bash-command"`, `spellings`) in `src/access-intent/access-intent.ts`, evaluated last-match-wins via `evaluateAnyValue` (#928), and populated per unit in `makeCommandUnit` (`src/access-intent/bash/command-enumeration.ts`) — today only with `ShellVariables.spellHomeAtStart`'s leading-home spelling.
The PR's `AliasValuesAccessIntent`, the `aliasMatching` flag on `buildCheckResult`, the `aliasTexts` parameter threaded through `resolveBashCommandCheck`, and the parallel `unitSpans` array in `BashProgram` all duplicate that seam.
`git merge-tree` reports content conflicts in 15 files.

**PR's own checks** (scratch worktree at the PR head): `pnpm run check` clean, `pnpm run lint` clean, package tests 4201/4201 pass — against its stale base only.

**Valuable — keep:**

- The rewrite source: `BashPathResolver.projectRuleCandidates` already holds each rule candidate's cd-aware `AccessPath`; the PR records a rewrite (argument-node span → `path.value()`) only when the absolute form differs from the token as written, so an unknown `cd` base (#393), a glob, and an already-absolute token stay on their typed text by construction.
- Span provenance: tokens derived from something other than a node's own text (`--opt=value`, `find` directives, statement operands) carry no span and are never rewritten.
- Right-to-left span substitution within the unit, one spelling per unit rather than a per-argument cross product.
- The ordering semantics (an absolute `allow` after a broader `ask` decides; before it, it does not) and the documented residuals (session grant records the typed text; mixed-spelling arguments).
- Its test matrix shape for `program.test.ts` and `bash-command.test.ts`.

**Change:**

- Emit the absolute rewrite into `BashCommand.spellings` beside the home spelling, so the gate, intent, and manager need no change — no new intent kind, no manager flag, no per-unit side channel.
- Note the span-location question for the planner: `BashCommand` units are built in `command-enumeration.ts` while rewrites come from the resolver in `bash-path-resolver.ts`; `program.ts` is where both meet, so attaching spellings there (or carrying the unit span on `BashCommand`) is the seam to settle in `/plan-issue`.
- Drop the canonical (symlink) spelling and the `matchedAlias` / `resolved as` evidence from scope (operator decision).
- Cover both directions in tests, including the deny case above.

### Decision and attribution

**Direction:** adopt the capability, simplified design; plan via `/plan-issue #910`, using PR #917 as reference, not merge target.

**Scope:** the absolute (lexical) spelling of resolved path arguments only, added to `BashCommand.spellings`.

**Non-goals:** the canonical/symlink spelling; `matchedAlias` on `PermissionCheckResult`, the `resolved as` prompt evidence, and the review-log field; session grants that cross spellings; whole-command whitespace/quote normalization.

**Release:** `fix:` (non-breaking) — rules now apply as written to the file the command names, as #981 did for the home prefix; the changelog should still name that an absolute `deny` now catches the `cd`-relative spelling.

**Attribution:** every implementation and docs commit carries

```text
Co-authored-by: ilkerulusoy <ilker@ilkerulusoy.com.tr>
```

The ship-stage PR close comment thanks @ilkerulusoy by name and links the implementing SHA(s).
Reference the PR as `Refs #917`, never `Closes #917`.
#910 was closed by the reporter; `/ship` should reopen-or-comment as appropriate when the fix lands.
