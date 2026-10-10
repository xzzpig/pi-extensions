---
issue: 963
issue_title: "pi-permission-system: execution-modifier wrappers (time/timeout/nice/stdbuf/setsid) inherit the inner command's verdict"
---

# Execution-modifier wrappers inherit the inner command's verdict

## Release Recommendation

**Release:** ship independently

The Phase 15 roadmap step for [#963] carries `Release: independent`, and it is not a member of the "declared-effects" batch ([#880], [#881]).

## Problem Statement

`time`, `timeout`, `nice`, `stdbuf`, and `setsid` change only *how* a visible command runs — its timing, kill deadline, scheduling, buffering, or session — yet they are floored with `sudo`, `env`, and `xargs`, the wrappers that change *what* runs, *as whom*, or *with which operands*.
Under the operator's `bash: {"*": "allow"}`, `time pnpm run lint >/tmp/lintout.txt 2>&1` asks under `<indirection-bash-wrapper>`, while `pnpm run lint >/tmp/lintout.txt 2>&1` resolves by its own rules.
The floor's reason ([#490]: a wrapper hides the command that should be gated) is false for this class: every operand is on the command line, and the wrapper adds no privilege, environment, or argument feed.
ADR 0013 §11 lifts the floor only when the inner command proves a read ([#803]), which `pnpm` never does.

Measured over the local review log (`permission_request.waiting` entries carrying the sentinel, `/var/folders/` fixtures excluded, 2026-07 through 2026-10-04): 84 of 226 floored asks have a winning unit led by one of the five modifiers.

## Goals

- A wrapper unit whose every peeled layer is an execution modifier, admitted by that modifier's option allowlist, and whose peel ends at a literal command name records `floorExemption: "execution-modifier"`, so the gate resolves it by the inner command's own `bash` rule — allow, ask, or deny.
- The existing `core-reader` clause is unchanged, keeps its redirect refusal, and wins when both clauses hold, so no unit exempt today changes its recorded reason.
- The new clause carries no redirect refusal: a redirect destination is gated by the path surfaces exactly as for the unwrapped command.
- Package-audited per wrapper, never user-declared: the modifier set and each option allowlist live in `wrapper-analysis.ts`.
- ADR 0013 §11 gains the wrapper-keyed clause as a dated amendment.
- **Not breaking** (operator decision): `feat:`.
  The observable change is that an exempt `time X` resolves as `X` does — usually relief from an ask, and, as for [#803], an inner `deny` now reaches through (`time git commit -F -` moves from an approvable ask to the repo's deny).
  `FloorExemption` gains a value; it reaches the published `PermissionCheckResult` type as an additive output member.

## Non-Goals

- **`time ( … )` and `time { …; }`.**
  `tree-sitter-bash` 0.25.1 (the latest release; no upstream commits since) has no `time` keyword, so the subshell's commands are never enumerated as units, and this plan's literal-head guard keeps the floor on that shape.
  Filed as [#1027], a new Phase 15 step directly after this one (10 of the 84 measured asks).
- **`nohup` and `flock`** stay floored: `nohup` writes `nohup.out` when stdout is a tty, and `flock` creates its lock-file operand.
- **User-declared transparent wrappers** ([#926]) and **pinning rules** (PR [#971]): this clause is package-audited and does not widen to declarations, which [#880] keeps outside the floor.
  PR [#971] edits `wrapper-analysis.ts` and is sequenced after this step.
- **The `/dev/null` redirect refusal on the core-reader clause** ([#951]) is unchanged; this plan does not touch the core-reader clause's redirect handling.
- **Consulting the inner rule when the wrapper's own text resolves `ask`.**
  As for §11, only a wrapper unit whose own text resolved to `allow` reaches `resolveWrapperUnit`, so an explicit `"time *": "ask"` still asks.
- **`nice -5`** (the legacy numeric option) and every unlisted or abbreviated option refuse the exemption rather than being taught; the cost is an ask, never a write.
- **A shared command-description layer** — the option knowledge this plan adds is one more per-command grammar beside `VALUE_TAKING_FLAGS`, `GREP_FLAGS`, `RETRACTION_GUARDS`, and the `sed`/`awk` allowlists; consolidating them is recorded as a phase candidate in the retro, not done here.

## Background

- `src/access-intent/bash/wrapper-analysis.ts` owns the wrapper vocabulary and three answers over one private `unwrapIndirection` walk: `classifyWrapperWords` (is the unit floored), `executedUnitOf` (what it runs, display-only), and `isTransparentWrapper` (does the floor still have a reason).
  `unwrapIndirection` peels **every** indirection layer: `time sudo rm -rf x` yields `executedUnit: "rm -rf x"` (measured), so a clause keyed on the outermost wrapper alone would exempt the `sudo` behind it.
- `innerCommandIndex` finds where a layer's inner command starts by skipping the wrapper's options (consuming a value for those in `VALUE_TAKING_FLAGS`), `NAME=value` assignments, `--`, and a leading operand for `LEADING_OPERAND_WRAPPERS` (`timeout`'s duration).
  It does not know GNU long-option abbreviations, which the real tools accept (measured: `timeout --sig KILL 1 echo ok`, `gnice --adj 3 echo ok3`, and `gstdbuf --out L echo ok4` all run), so `timeout --sig KILL 5 rm -rf /` yields `executedUnit: "5 rm -rf /"` (measured).
- `src/access-intent/bash/command-enumeration.ts`'s `makeCommandUnit` sets `floorExemption: "core-reader"` when `isTransparentWrapper(words, redirectedScope(node, scope))` holds.
- `src/handlers/gates/bash-command.ts`'s `resolveWrapperUnit` resolves `cmd.executedUnit` on the bash surface whenever `cmd.floorExemption` is set, keeping `command` as the wrapper text; it needs no logic change.
- Redirect destinations reach the path surfaces through `BashPathResolver`, independently of the enumerator and the floor: `timeout 5 pnpm test > /tmp/x` projects `/tmp/x` as `{ effect: "write", source: "syntax" }` (measured through `BashProgram.parse`), as `pnpm test > /tmp/x` does.
- `tree-sitter-bash` parses `time (rm -rf /tmp/x)` as `(command name: (word) (subshell …))` and `time { rm -rf /tmp/x; }` as a `time` command with the words `{`, `rm`, `-rf`, `/tmp/x` (measured), so the inner head word can be shell syntax rather than a command name.
- `scripts/measure-wrapper-transparency.mjs` is the committed instrument behind §11's relief figures (ADR 0013: a durable number ships with the instrument that produced it); it transcribes the wrapper tables rather than importing them.
- `PermissionCheckResult` (with `floorExemption?: FloorExemption`) is re-exported from `src/service.ts`, so the type widening reaches `dist/public.d.ts`.

## Design Overview

### How the design was established

Every shape above was produced through the real `BashProgram.parse` (warmed `tree-sitter-bash` 0.25.1) in disposable spike tests, deleted afterwards.
The relief figure comes from a prototype of exactly this predicate patched into `wrapper-analysis.ts` and `command-enumeration.ts` (reverted), run over the 226 logged floored commands' winning units: 73 of the 84 modifier-led units became exempt, 10 are `time ( … )` (refused by the head guard), and 1 is `timeout 60 $PI …` (computed head).
That prototype admitted only value-taking options; Step 4's flag rows add `-p`/`-l` relief the prototype did not count.

### The answer the enumerator records

`isTransparentWrapper(words, statement): boolean` becomes `floorExemptionOf(words, statement): FloorExemption | undefined`.

```typescript
/** Why a wrapper unit's floor has no reason left to hold (ADR 0013 §11). */
export type FloorExemption = "core-reader" | "execution-modifier";

export function floorExemptionOf(
  words: readonly CommandWord[],
  statement: { readonly writesViaRedirect: boolean },
): FloorExemption | undefined;
```

`makeCommandUnit` passes the result straight into `floorExemption`, so the reason is decided once, in the module that owns the vocabulary.

### The clauses

Both clauses read one `unwrapIndirection` result, whose `peeled` variant now carries each peeled layer's prefix words (the wrapper name and its options) instead of a layer count:

```typescript
type UnwrapResult =
  | { readonly kind: "opaque"; readonly payload: string | null }
  | {
      readonly kind: "peeled";
      readonly text: string;
      readonly words: readonly CommandWord[];
      /** Each peeled layer's words before its inner command; empty when none came off. */
      readonly peeled: readonly (readonly CommandWord[])[];
    };
```

`floorExemptionOf` answers `undefined` unless the unit is an `indirection` wrapper and the unwrap is `peeled` with at least one layer; then:

1. **`core-reader`** (unchanged, checked first): no write-proving redirect, and `proveCommandEffect(innerHead, innerArgs)` proves a read.
2. **`execution-modifier`** (new), all of:
   - **Every** peeled layer's wrapper basename is an execution modifier (`time`, `timeout`, `nice`, `stdbuf`, `setsid`), so `time sudo rm` and `sudo time pnpm` both refuse.
   - Every word of every layer's prefix is **admitted** by that modifier's option allowlist (below), so an abbreviation (`--sig`), an unlisted option, or a file-writing `time` option refuses.
   - The peel ended at a non-wrapper: `classifyWrapperWords(inner) === undefined`, so a peel that stopped at a wrapper it could not see past (`time sudo --unknown-opt`, or five nested modifiers exhausting `MAX_UNWRAP_DEPTH`) refuses.
   - The inner head word is a **literal command name**: its source text matches `/^[A-Za-z0-9_.\/+@%,:-]+$/` and is not a bash reserved word (`!`, `{`, `}`, `[[`, `]]`, `case`, `coproc`, `do`, `done`, `elif`, `else`, `esac`, `fi`, `for`, `function`, `if`, `in`, `select`, `then`, `time`, `until`, `while`).
     This refuses `time (rm …)`, `time { rm …; }`, `time $(echo rm) …`, `time "$CMD"`, and `time if …`; the charset already excludes every computed spelling (`$`, quotes, globs, braces, backslash), so no separate `computed` test is needed.
   - **No** `writesViaRedirect` refusal: the clause inherits the inner verdict rather than classifying the unit as a read, and the redirect destination is gated by the path surfaces as for the unwrapped command.

### The option allowlist

An admitted word in a modifier layer's prefix is one of:

- `--`, a `NAME=value` assignment, or a non-dash word (`timeout`'s duration operand) — the shapes `innerCommandIndex` already skips;
- a **flag** listed for that modifier in `EXECUTION_MODIFIER_FLAGS`;
- a **value-taking option** — a member of that wrapper's `VALUE_TAKING_FLAGS` entry not in `WRITING_OPTIONS` — spelled exactly (its value is the next word), as `--long=value`, or as an attached short value (`-sKILL`, `-oL`, `-n5`) whose two-character prefix is the option.

Value-taking admission is **derived** from `VALUE_TAKING_FLAGS`, the table `innerCommandIndex` skips by, so an admitted value-taker can never be one the skipper treats as a flag — the drift that would misplace the inner command.

```typescript
/** Execution modifiers and the flags each admits; value-taking options derive from VALUE_TAKING_FLAGS. */
const EXECUTION_MODIFIER_FLAGS = new Map<string, ReadonlySet<string>>([
  ["time", new Set([/* Step 4 */])],
  ["timeout", new Set([/* Step 4 */])],
  ["nice", new Set()],
  ["stdbuf", new Set()],
  ["setsid", new Set()],
]);

/** Value-taking options that write a file (`/usr/bin/time -o`), never admitted. */
const WRITING_OPTIONS = new Set(["-o", "--output"]);
```

The flag rows are external facts, so they land in Step 4, each verified against a local binary's `--help` or man page:

| Modifier  | Flags admitted                                                     | Source (local)                                                             |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `timeout` | `-f`, `--foreground`, `-p`, `--preserve-status`, `-v`, `--verbose` | `timeout --help` (GNU coreutils, `/opt/homebrew/bin/timeout`)              |
| `time`    | `-p`, `-l`, `-h`                                                   | `man 1 time` (BSD: `time [-al] [-h \| -p] [-o file]`)                      |
| `nice`    | none (`-n`/`--adjustment` are value-taking)                        | `gnice --help`, `man 1 nice`                                               |
| `stdbuf`  | none (`-i`/`-o`/`-e` are value-taking)                             | `gstdbuf --help`, `/usr/bin/stdbuf` usage                                  |
| `setsid`  | none                                                               | not installed locally; util-linux flags stay out, so `setsid -f …` refuses |

`time -a` (append, BSD and GNU) is not listed, so it refuses; GNU-only `time` flags (`-q`, `-v`, `--portability`) stay out unless verified against a local GNU `time` at implementation time.
`-f`/`--format` reach admission through `VALUE_TAKING_FLAGS` already.

### Edge cases stated as behavior, and the step that tests each

| Case                                                                                          | Behavior                                                                                                     | Step |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| `time grep foo`                                                                               | `core-reader` (precedence)                                                                                   | 3    |
| `time grep foo > out`                                                                         | `execution-modifier` (core-reader refused by the redirect)                                                   | 3    |
| `time pnpm test > out`                                                                        | `execution-modifier`                                                                                         | 3    |
| `time timeout 5 pnpm test`                                                                    | `execution-modifier` (every layer a modifier)                                                                | 3    |
| `time FOO=1 pnpm test`                                                                        | `execution-modifier` — the unwrapped `FOO=1 pnpm test` also resolves as `pnpm test` (#481 strips the prefix) | 3    |
| `time sudo rm -rf x`, `sudo time pnpm test`, `time env A=1 pnpm test`, `time xargs pnpm test` | refused                                                                                                      | 3    |
| `timeout 5 bash -c 'rm x'`                                                                    | refused (opaque)                                                                                             | 3    |
| `timeout --sig KILL 5 rm -rf /`, `nice --adj 5 rm -rf /`                                      | refused (abbreviation)                                                                                       | 3    |
| `/usr/bin/time -o t.txt pnpm test`, `time --output=t.txt pnpm test`                           | refused (`WRITING_OPTIONS`)                                                                                  | 3    |
| `nice -5 pnpm test`                                                                           | refused                                                                                                      | 3    |
| `time (rm -rf /tmp/x)`, `time { rm -rf /tmp/x; }`, `time $(echo rm) -rf x`, `time if true`    | refused (head guard)                                                                                         | 3    |
| `time sudo --unknown-opt`, `time time time time time pnpm test`                               | refused (peel ended at a wrapper)                                                                            | 3    |
| `time`, `timeout 5`                                                                           | refused (no inner command)                                                                                   | 3    |
| `nohup pnpm test`, `flock /tmp/l pnpm test`, `watch pnpm test`                                | refused (not a modifier)                                                                                     | 3    |
| `time -p pnpm test`, `timeout -v 5 pnpm test`, `/usr/bin/time -l yarn make`                   | refused in Step 3, exempt from Step 4                                                                        | 3, 4 |
| `time -a -o t.txt pnpm test`                                                                  | refused before and after Step 4                                                                              | 4    |

### The verdict

No change to `resolveBashCommandCheck`: an exempt unit's inherited result is `resolveOnBashSurface(executedUnit)` with `command` kept as the wrapper text.
Because every layer is a modifier and the peel ends at a literal command name, `executedUnit` is exactly the text the enumerator would emit for the unwrapped command (its redirects and assignment prefixes already excluded), so the metamorphic property strengthens from "never weaker" to "equal" for this class.
A head spelled `~/…` or `$HOME/…` fails the charset, so the absent inner `spellings` cannot make the wrapped verdict differ from the unwrapped one.

### Design-review notes

- `floorExemptionOf` reads only the words and one boolean, as today; no parameter is added.
- The decision "which reason" is made once, in `wrapper-analysis.ts`; `makeCommandUnit` and `resolveWrapperUnit` relay it, and `tool.ts`'s `floorExemptionFact` forwards it to the review log unchanged.
- `wrapper-analysis.ts` gains a type-only import of `FloorExemption` from `#src/types`, the edge `command-enumeration.ts` (same zone) already has; confirm with `pnpm --silent fallow guard packages/pi-permission-system/src/access-intent/bash/wrapper-analysis.ts` in Step 1.

## Module-Level Changes

- `src/access-intent/bash/wrapper-analysis.ts` — rename `isTransparentWrapper` → `floorExemptionOf` returning the reason (Step 1); `UnwrapResult`'s `layers` → `peeled` (Step 2); the `execution-modifier` clause, `EXECUTION_MODIFIER_FLAGS`, `WRITING_OPTIONS`, the reserved-word set, and the admission walk kept adjacent to `innerCommandIndex` with cross-referencing comments (Step 3); flag rows (Step 4).
  Re-read the moved/added code against the `code-design` skill before committing: helpers below their caller, no tombstone comments.
- `src/access-intent/bash/command-enumeration.ts` — import and call `floorExemptionOf`; `makeCommandUnit` passes the reason through (Step 1); the `floorExemption` field's doc comment names both reasons (Step 3).
- `src/types.ts` — `FloorExemption` gains `"execution-modifier"`; its doc comment and `PermissionCheckResult.executedUnit`'s ("only when `floorExemption` says the inner command is a proven pure reader") are reworded (Step 3).
- `src/handlers/gates/bash-command.ts` — doc comments only (`resolveWrapperUnit` names both reasons; the file header's wrapper paragraph) (Step 3).
- `test/access-intent/bash/wrapper-analysis.test.ts` — `describe("isTransparentWrapper")` becomes `describe("floorExemptionOf")`; its `isTransparent` helper compares to `"core-reader"`, and the two direct calls (empty word list, redirect) assert the reason (Step 1); a sibling `describe("an execution modifier")` (Steps 3–4).
- `test/access-intent/bash/program.test.ts` — the `"indirection wrappers"` table's five modifier rows (`time aws s3 ls`, `timeout 10 aws s3 ls`, `nice -n 10 aws s3 ls`, `setsid aws s3 ls`, `stdbuf -oL aws s3 ls`) assert exact unit shapes with `toEqual` and gain `floorExemption: "execution-modifier"`; move them to a sibling `it.each` beside the "running a pure reader" one; add `"floor exemption"` rows for the new reason (Step 3).
- `test/handlers/gates/bash-command-metamorphic.test.ts` — a new `describe("bash command gate — an execution modifier inherits the verdict")`; `makePrefixResolver` (currently local to the redirect describe) lifts to module scope so the bypass pins can use a resolver the wrapper text does not match (Step 3).
- `test/access-intent/bash/program-external-accesses.test.ts` — a redirect-independence pin (Step 3).
- `scripts/measure-wrapper-transparency.mjs` — transcribes the modifier tables and the clause, prints the execution-modifier relief and each guard's cost (Step 5).
- `docs/decisions/0013-permission-policy-model.md` — a dated amendment adding the wrapper-keyed clause, and §11's body gains it (Step 6).
- `docs/configuration.md` — the fail-closed bullet's "The one exception" sentence becomes two exceptions; § Wrapper transparency gains the execution-modifier class, its four conditions, its examples, and `floorExemption: "execution-modifier"`; `time pnpm test` leaves the "still prompt" list (Step 6).
- `docs/architecture/architecture.md` — the `wrapper-analysis.ts` module-tree entry (`floorExemptionOf`, the second clause and its every-layer / allowlist / literal-head constraints); the [#963] roadmap step: `✅` on its heading and Mermaid node `S963`, a `Landed:` note, and its stale `Target:`/`Constraint:` text ("whose outermost wrapper", "`time sudo …` stops the peel at `sudo`") corrected to what landed (Step 6).
- `.pi/skills/package-pi-permission-system/SKILL.md` — the `## Debugging` sentence "a wrapper unit floors to `ask` unless its inner command is a proven pure reader" names the second exemption (Step 6).

Predicted unchanged, and the claim each rests on:

- `src/handlers/gates/tool.ts` — `floorExemptionFact` forwards any `FloorExemption` value without narrowing.
- `src/service/bash-advisory-check.ts` — routes through `resolveBashCommandCheck`, which is unchanged.
- `test/handlers/gates/bash-command.test.ts` and `test/access-intent/bash/sync-commands.test.ts` — their `floorExemption` assertions are `core-reader` units (`xargs grep -l foo`, `xargs find "$HOME"`), which the precedence keeps.
- The existing "a transparent wrapper does not weaken" metamorphic block — `time ${cmd}` over `grep`/`cat`/`wc` stays `core-reader` or now inherits the equal verdict, so "never weaker" still holds.
- `docs/cross-extension-api.md` — documents no `floorExemption` field today.
- `src/access-intent/bash/token-collection.ts` / `bash-path-resolver.ts` — redirect projection is independent of the floor (pinned in Step 3).

## Test Impact Analysis

1. **New tests the change enables:** `floorExemptionOf` is pure and word-based, so every clause (layer class, option admission, head guard, peel end, precedence, redirect independence) is a table row in `wrapper-analysis.test.ts` without a parse; `program.test.ts` pins the real node adapter for a representative subset; the metamorphic block pins the gate-level equality.
2. **Redundant tests:** none; the `isTransparentWrapper` rows become `floorExemptionOf` rows unchanged in substance.
3. **Tests that must stay as-is:** the core-reader rows and the redirect refusal for `xargs grep -l foo > out.txt` (the metamorphic "floors … despite the pure-reader inner command" table), which now also pin that the redirect refusal did **not** leak away from the core-reader clause.

## Invariants at risk

From [#803] (Phase 14 Step 3, ADR 0013 §11) and the shipped gate:

- **An explicit `deny`/`ask` on the wrapper is never weakened** — only an `allow` reaches `resolveWrapperUnit`.
  Pinned by `bash-command.test.ts`'s wrapper-transparency cases; Step 3 adds `"time *": "ask"` → `time pnpm test` asks.
- **An opaque payload is never exempt** — pinned by `wrapper-analysis.test.ts`'s "an opaque payload is never transparent" rows; Step 3 adds `timeout 5 bash -c 'rm x'` for the new clause.
- **The core-reader clause keeps its redirect refusal** — pinned by the metamorphic `xargs grep -l foo > out.txt` / `> $OUT` / `> $(mktemp)` rows, which must stay `ask`.
- **A wrapper never loosens the unwrapped verdict** — the existing metamorphic block; Step 3 strengthens it to equality for modifiers.
- **Redirect destinations are gated whatever the floor decides** — today only argued; Step 3 adds the `program-external-accesses.test.ts` pin.
- **A unit exempt today keeps its recorded reason** (review-log consumers grepping `"core-reader"`) — pinned by the existing `program.test.ts` / `sync-commands.test.ts` `core-reader` assertions plus Step 3's `time grep foo` precedence row.

## TDD Order

1. **Return the exemption reason** — `refactor(pi-permission-system): answer why a wrapper's floor is lifted, not whether`.
   Rename `isTransparentWrapper` → `floorExemptionOf(words, statement): FloorExemption | undefined`, returning `"core-reader"` where it returned `true`; `makeCommandUnit` passes the result through; update the `{@link isTransparentWrapper}` reference in `unwrapIndirection`'s doc comment.
   Tests: `wrapper-analysis.test.ts`'s helper becomes `floorExemptionOf(...) === "core-reader"`, the empty-list and redirect assertions assert `undefined` / `"core-reader"`, and the describe is renamed.
   Run `pnpm --silent fallow guard` on `wrapper-analysis.ts` for the new `#src/types` import.
   Verify: the existing `wrapper-analysis`, `program`, `sync-commands`, `bash-command`, and metamorphic suites stay green unchanged in substance, plus `pnpm run check`.
   No new behavior, so no killing mutation; the existing rows are the measurement (mutating `floorExemptionOf` to return `undefined` for the core-reader branch turns them red).
2. **Carry each peeled layer** — `refactor(pi-permission-system): record each peeled wrapper layer in the unwrap result`.
   `UnwrapResult`'s `layers: number` → `peeled: readonly (readonly CommandWord[])[]`, each entry `current.slice(0, start)` taken before `rebase`; the sole reader becomes `peeled.length === 0`.
   Verify: existing suites green; `pnpm run check`.
3. **The execution-modifier clause** — `feat(pi-permission-system): time, timeout, nice, stdbuf, and setsid resolve by the command they run`.
   `FloorExemption` gains `"execution-modifier"`; `floorExemptionOf` gains the clause, `EXECUTION_MODIFIER_FLAGS` (every set empty), `WRITING_OPTIONS`, the reserved-word set, and the admission walk; doc comments in `types.ts`, `command-enumeration.ts`, and `bash-command.ts` reworded.
   Tests:
   - `wrapper-analysis.test.ts`, `describe("an execution modifier")`: the exempt rows (`time pnpm test`, `timeout 300 pnpm run lint`, `timeout -s KILL 10 pnpm test`, `timeout -sKILL -k5 10 pnpm test`, `timeout --signal=KILL 10 pnpm test`, `nice -n 5 pnpm test`, `nice --adjustment=5 pnpm test`, `stdbuf -oL pnpm test`, `stdbuf -o L pnpm test`, `setsid pnpm test`, `time timeout 5 pnpm test`, `time FOO=1 pnpm test`, `/usr/bin/time pnpm test`, `time ./scripts/x.sh`, `time -f %e pnpm test`, `time -- pnpm test`); `time pnpm test` with `writesViaRedirect: true` still exempt; precedence (`time grep foo` → `core-reader`, and with the redirect → `execution-modifier`); and every refused row of the edge-case table marked Step 3.
   - `program.test.ts`: move the five modifier rows to an `it.each` asserting `floorExemption: "execution-modifier"`; `"floor exemption"` rows for `time pnpm run lint >/tmp/lintout.txt 2>&1` (→ `["execution-modifier"]`) and `time (rm -rf /tmp/x)` / `time { rm -rf /tmp/x; }` / `timeout --sig KILL 5 rm -rf /` (→ no exemption) through the real parse.
   - `bash-command-metamorphic.test.ts`: for wrappers `time`, `timeout 5`, `nice -n 5`, `stdbuf -oL`, `setsid`, `time timeout 5` × cases `pnpm test` at allow/ask/deny and `git push` at deny, assert the wrapped decision **equals** the bare one; the issue's command (`time pnpm run lint >/tmp/lintout.txt 2>&1; echo "lint rc=$?"; tail -3 /tmp/lintout.txt`) is `allow` under `makeKeyedResolver([])`; under `makePrefixResolver("rm", "deny")`, `timeout --sig KILL 5 rm -rf /`, `time sudo rm -rf x`, `time { rm -rf /tmp/x; }`, and `timeout 5 bash -c 'rm x'` stay `ask` (the floor), never `allow`; `"time *"` at `ask` keeps `time pnpm test` at `ask`.
   - `program-external-accesses.test.ts`: `timeout 5 pnpm test > /tmp/x` projects `/tmp/x` as `{ effect: "write", source: "syntax" }`, as `pnpm test > /tmp/x` does (an invariant pin, green at Red).
   Killing mutations, one per class:
   - *Every-layer check:* test only the outermost layer (`peeled[0]`) → `time sudo rm -rf x` and the metamorphic `time sudo` pin go red.
   - *Option admission:* admit every dash word → the `--sig`/`--adj`/`-o`/`--output=`/`nice -5` rows and the metamorphic `--sig` pin go red.
   - *`WRITING_OPTIONS`:* empty it → `/usr/bin/time -o t.txt pnpm test` and `time --output=t.txt pnpm test` go red.
   - *Peel end:* delete the `classifyWrapperWords(inner) === undefined` test → `time sudo --unknown-opt` and the five-deep `time` row go red.
   - *Head guard:* delete the charset test → `time { rm …`, `time (rm …)`, `time $(echo rm) -rf x` go red; delete the reserved-word test → `time if true` goes red.
   - *Redirect independence:* add `if (statement.writesViaRedirect) return undefined` before the modifier clause → the `writesViaRedirect: true` row and the issue-command metamorphic row go red.
   - *Wiring:* make `makeCommandUnit` drop `"execution-modifier"` (pass `undefined` for it) → the `program.test.ts` rows and the metamorphic equality rows at `allow` go red.
   - *Projection pin:* make `collectRedirectTokens` (`token-collection.ts`) collect nothing → the `program-external-accesses` pin goes red (confirms the pin reads the projection; revert).
   Verify: the package suite, `pnpm run check`, and `pnpm --silent fallow dead-code`.
4. **Admit each modifier's verified flags** — `feat(pi-permission-system): time -p and timeout -v keep the execution-modifier exemption`.
   First write the check for one row: run `timeout --help` and confirm `-v, --verbose` is listed as a flag taking no argument; then fill `EXECUTION_MODIFIER_FLAGS` from the table in Design Overview, each row's source in a comment, adding only flags confirmed against a local binary at implementation time.
   Tests: `time -p pnpm test`, `/usr/bin/time -l yarn make`, `timeout -v 5 pnpm test`, `timeout --foreground 5 pnpm test`, `timeout -p 5 pnpm test` flip from refused to `execution-modifier`; `time -a -o t.txt pnpm test` and `setsid -f pnpm test` stay refused.
   Killing mutation: remove `-p` from `time`'s set → `time -p pnpm test` goes red; add `-a` to it → `time -a -o t.txt` still refuses through `-o` (a finding if it does not).
5. **Measure it** — `docs(pi-permission-system): measure the execution-modifier exemption`.
   `scripts/measure-wrapper-transparency.mjs` transcribes the modifier tables and the clause, prints the execution-modifier relief beside the core-reader one, and prices each guard (every-layer, option allowlist, literal head) as a relaxation row; update its header comment's measured table with what it prints.
   Verify: run it; the modifier-led relief should be in the region of the prototype's 73 of 84 winning units plus Step 4's flag rows — record what it prints, not this estimate.
6. **Document the clause and mark the step** — `docs(pi-permission-system): document the execution-modifier exemption and mark Phase 15's #963 step complete`.
   ADR 0013 amendment (dated with `date -u +%F` at implementation time) and §11 body; `docs/configuration.md`; `docs/architecture/architecture.md` (module tree, step `✅` heading and node, `Landed:` note with Step 5's figure, stale `Target:`/`Constraint:` text corrected); the package skill's `## Debugging` sentence.
   Grep before committing: `rg -n 'isTransparentWrapper' packages/pi-permission-system .pi/skills` (only `docs/plans/`, `docs/retro/`, and `history/` may remain) and `rg -n 'pure.reader' .pi/skills/package-pi-permission-system/SKILL.md`.
   Verify: `pnpm exec rumdl check` on each edited doc.

No third-party mechanism is adopted (the issue is the operator's own; PR [#971]'s pinning mechanism is not used), so no `Co-authored-by:` trailer.

## Risks and Mitigations

| Risk                                                                                                                                                           | Mitigation                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| An abbreviation or unknown value-taking option misplaces the inner command, so a deny is bypassed (`timeout --sig KILL 5 rm -rf /` → `"5 rm -rf /"`, measured) | Per-modifier allowlist; value-taking admission derived from the skipper's own table; Step 3 pins the measured bypass at unit and gate level |
| A non-modifier wrapper behind a modifier is exempted (`time sudo …`, measured peel)                                                                            | Every-layer check plus the peel-end check; pinned                                                                                           |
| Shell syntax after `time` is resolved as a command (`time { rm …; }`, `time (rm …)`)                                                                           | Literal-head guard; pinned; the relief it forfeits is [#1027]                                                                               |
| A `time` option writes a file the path surfaces do not see (a bare relative `-o out.txt` is promoted only if it exists)                                        | `WRITING_OPTIONS` and the unlisted `-a` refuse                                                                                              |
| Dropping the redirect refusal lets a write escape                                                                                                              | The redirect destination is projected by `BashPathResolver` independently of the floor (measured); Step 3 pins it                           |
| Data-row error (a flag that actually takes a value)                                                                                                            | Step 4 admits only flags verified against a local binary, separate from the mechanism step; an unverifiable row is left out (fail closed)   |
| A consumer switches exhaustively on `FloorExemption`                                                                                                           | Additive output value; noted in Goals; the type is reported, never accepted, by the service                                                 |

## Open Questions

- Should GNU-only `time` flags (`-q`, `-v`, `--portability`) and util-linux `setsid` flags be admitted once a Linux host verifies them?
  Deferred until a logged ask shows one; none appear in the local review log.

[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#803]: https://github.com/gotgenes/pi-packages/issues/803
[#880]: https://github.com/gotgenes/pi-packages/issues/880
[#881]: https://github.com/gotgenes/pi-packages/issues/881
[#926]: https://github.com/gotgenes/pi-packages/issues/926
[#951]: https://github.com/gotgenes/pi-packages/issues/951
[#971]: https://github.com/gotgenes/pi-packages/pull/971
[#1027]: https://github.com/gotgenes/pi-packages/issues/1027
