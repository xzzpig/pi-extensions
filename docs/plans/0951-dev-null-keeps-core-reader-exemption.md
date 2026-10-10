---
issue: 951
issue_title: "pi-permission-system: a `2>/dev/null` redirect withholds the core-reader wrapper exemption"
---

# A `/dev/null` redirect keeps the core-reader wrapper exemption

## Release Recommendation

**Release:** ship independently

The architecture roadmap's open-issue sweep lists [#951] as out of scope for the phase, so it carries no `Release:` batch tag.

## Problem Statement

With `bash: {"*": "allow"}` configured, `rg -l x | xargs ls -1t` is allowed: the `xargs ls -1t` unit carries [#803]'s `core-reader` floor exemption and resolves by `ls`'s own rule.
Appending `2>/dev/null` turns the same pipeline into an `<indirection-bash-wrapper>` prompt.
The operator's review log shows the shape on every indirection-wrapper prompt since 2026-09-16, each a proven core reader (`xargs grep -l …`, `xargs ls -1t`).

`redirectMayWriteFile` (`src/access-intent/bash/redirect-analysis.ts`) refuses the exemption unless every destination is a descriptor or proves a read.
`/dev/null` under a `>` operator parses as a `word` destination, so the operator table proves a write, `redirectedScope` marks the statement `writesViaRedirect`, and `floorExemptionOf` withholds the exemption.
ADR 0013 §11 grants the exemption to a wrapper "with no real output redirect on the unit", and a write to `/dev/null` touches no file any policy protects.

## Goals

- A redirect whose destination is the literal word `/dev/null` (any output operator: `>`, `>>`, `>|`, `&>`, `&>>`, `>&`, with or without a source descriptor) no longer withholds the floor exemption.
- `rg -l x | xargs ls -1t 2>/dev/null` and `xargs grep -l x >/dev/null 2>&1` keep `floorExemption: "core-reader"`.
- The device knowledge stays in one home, `src/path/safe-system-paths.ts`.
- Classification: a bug fix, not breaking.
  It narrows when a synthetic floor `ask` fires to match ADR 0013 §11's stated contract; no default, config field, or output shape changes.
  Commit type `fix(pi-permission-system):`.

## Non-Goals

- **`/dev/stdin`, `/dev/stdout`, `/dev/stderr`.**
  They stay write-proving for the exemption (operator decision).
  On Linux each is a link to `/proc/self/fd/N`, and opening one for writing reopens the descriptor's underlying file with `O_TRUNC`; so `xargs cat < notes.txt > /dev/stdin` truncates `notes.txt`, while its `<` redirect proves a read and would not withhold the exemption.
  This rests on Linux procfs semantics, not a measurement on this macOS host.
  `SAFE_SYSTEM_PATHS` keeps all four members for its existing external-directory role.
- **The token collector** (`redirectEffectForDestination`, `collectRedirectTokens`).
  It keeps emitting `/dev/null` as a `write` token on the `path` surface (operator decision).
  `token-collection.test.ts` line ~1388 and `program.test.ts` line ~2014 pin that today, and [#609]'s planning measured that `path_write` already sees it; dropping it would silently change what a `path_write` rule matches, a separate behavior change.
- **A quoted destination** (`2>"/dev/null"`, `2>'/dev/null'`) or a computed one (`2>$NULL`).
  These stay fail-closed: the check compares the node's raw text, which carries the quotes, and resolving quoting is the `WordReader`'s job, which this module does not hold.
  No review-log entry shows a quoted spelling.
- **`redirectedScope`'s over-attribution** to every unit of a redirected pipeline.
  It stays as documented (fail-closed); fixing the device makes it moot for this shape, as the issue notes.
- **ADR 0013.**
  Predicted unchanged: §11's "no real output redirect" already excludes `/dev/null`, so this change implements the ADR rather than amending it.
- Open PR #971 (lifting the floor for a rule that pins the inner command) edits `command-enumeration.ts` and `wrapper-analysis.ts`, not `redirect-analysis.ts`; it is unrelated and not a close target.

## Background

- `src/access-intent/bash/redirect-analysis.ts` reads a `file_redirect` node for two callers under different burdens of proof.
  `redirectEffectForDestination` answers the token collector with a proof; `redirectMayWriteFile` answers the command enumerator with a refusal.
  The architecture doc's `redirect-analysis.ts` entry pins that the two must not be collapsed; this change edits only the refusal.
- `redirectMayWriteFile` refuses up front on `parseUnresolvedAt`, then loops over the redirect's named children: a descriptor is skipped, and anything whose `redirectEffectForDestination` is not a `read` refuses.
- `src/access-intent/bash/command-enumeration.ts` `redirectedScope` (line ~516) calls `redirectMayWriteFile` for each `file_redirect` child of a statement or command; a `true` sets `writesViaRedirect`, which `floorExemptionOf` reads.
- `src/path/safe-system-paths.ts` holds `SAFE_SYSTEM_PATHS` (`/dev/null`, `/dev/std{in,out,err}`) and `isSafeSystemPath`; `msys-bash-tokens.ts` already imports it from `access-intent/bash/`, and `pnpm --silent fallow guard src/access-intent/bash/redirect-analysis.ts` lists `pi-permission-system/path` among the zones it may import.
- `getParser` hands words the grammar appends after a redirect's target back to the command ([#977]), so in production a redirect's named children are its source descriptor and its target.
  The grammar's own parser (`getGrammarParser`, used by `redirect-analysis.test.ts`) still shows trailing words as further destinations.

### Reproduction

Measured on `main` through the real `BashProgram.parse(command, normalizer).commands()`, mapping each unit's `floorExemption` (a disposable spike in `test/`, deleted afterwards):

```text
rg -l x | xargs ls -1t                   [null,"core-reader"]
rg -l x | xargs ls -1t | head -5         [null,"core-reader",null]
rg -l x | xargs ls -1t 2>/dev/null       [null,null]
rg -l x | xargs ls -1t > /tmp/o          [null,null]
xargs grep -l x 2>/dev/null              [null]
xargs grep -l x >/dev/null 2>&1          [null]
xargs grep -l x &>/dev/null              [null]
xargs grep -l x 2>"/dev/null"            [null]
xargs grep -l x 2>/dev/stdout            [null]
2>/dev/null xargs grep -l x              [null]
xargs grep -l x 2>/dev/null f.txt        [null]
```

The third line is the defect; the fourth is the correct answer it is being treated as.
The hosted-redirect form (`2>/dev/null xargs …`) and the trailing-word form share the defect.

## Design Overview

One predicate and one guard.

```ts
// src/path/safe-system-paths.ts
const DISCARD_DEVICE = "/dev/null";

export const SAFE_SYSTEM_PATHS: ReadonlySet<string> = new Set([
  DISCARD_DEVICE,
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);

/** True for the device a write discards, so writing it touches no file. */
export function isDiscardDevice(path: string): boolean {
  return path === DISCARD_DEVICE;
}
```

```ts
// src/access-intent/bash/redirect-analysis.ts, inside redirectMayWriteFile's loop
if (DESCRIPTOR_NODE_TYPES.has(child.type)) continue;
// A write to the discard device touches no file (ADR 0013 §11's "real" redirect).
if (isDiscardDevice(child.text)) continue;
if (redirectEffectForDestination(redirect, child)?.effect !== "read") return true;
```

Decisions:

- **The guard sits in the refusal, not the proof.**
  `redirectEffectForDestination` is unchanged, so the token collector's `/dev/null` write token, and every `path_write` rule matching it, are unaffected.
- **Raw text equality, no node-type check.**
  Any quoting, escaping, or expansion changes a node's raw text away from `/dev/null`, so equality on `child.text` admits only the bare literal word; a separate `word`-type check would be unkillable dead code.
- **No target-index check.**
  In production a redirect's only non-descriptor named child is its target ([#977] reattaches trailing words), and a trailing word under the grammar's parse is a command argument, not a written file, so clearing it adds no write path.
- **The parse-unresolved refusal stays first**, so `cat <> /dev/null` and other unresolved forms still refuse.
- **Other destinations in the same statement still count.**
  `xargs grep x 2>/dev/null > out.txt` keeps refusing on `out.txt`, because each `file_redirect` is asked independently in `redirectedScope`.
- **Platforms.**
  On a win32 host bash runs through Git Bash, where `/dev/null` is an MSYS device (ADR 0003), so the same literal answer holds.

Behavior by scenario (each row is a TDD Order test):

| Command                                  | Before          | After           | Step |
| ---------------------------------------- | --------------- | --------------- | ---- |
| `rg -l x \| xargs ls -1t 2>/dev/null`    | floor `ask`     | `core-reader`   | 2    |
| `xargs grep -l x >/dev/null 2>&1`        | floor `ask`     | `core-reader`   | 2    |
| `2>/dev/null xargs grep -l x`            | floor `ask`     | `core-reader`   | 2    |
| `xargs grep x 2>/dev/null > out.txt`     | floor `ask`     | floor `ask`     | 2    |
| `xargs grep -l x 2>/dev/stdout`          | floor `ask`     | floor `ask`     | 2    |
| `xargs grep -l x 2>"/dev/null"`          | floor `ask`     | floor `ask`     | 2    |
| `xargs pnpm test 2>/dev/null`            | floor `ask`     | floor `ask`     | 2    |

The last row is the control: the device clears only the redirect half, and a non-core inner command keeps the floor.

## Module-Level Changes

- `src/path/safe-system-paths.ts`: add the private `DISCARD_DEVICE` constant and the exported `isDiscardDevice`; build `SAFE_SYSTEM_PATHS` from the constant.
- `src/access-intent/bash/redirect-analysis.ts`: import `isDiscardDevice` from `#src/path/safe-system-paths`; add the guard in `redirectMayWriteFile`; extend its doc comment ("Past that, only two things clear it" becomes three: a descriptor duplication, a write to the discard device, and an operator that proves a read).
- `test/path/safe-system-paths.test.ts`: a `describe("isDiscardDevice")` block.
- `test/access-intent/bash/redirect-analysis.test.ts`: rows in `describe("redirectMayWriteFile")`.
- `test/access-intent/bash/program.test.ts`: rows in the `floor exemption` describe (line ~1456).
- `docs/architecture/architecture.md`:
  - the `redirect-analysis.ts` module-tree entry (line ~942) gains that `redirectMayWriteFile` clears a `/dev/null` destination via `isDiscardDevice`, while `redirectEffectForDestination` still proves it a write;
  - the `safe-system-paths.ts` entry (line ~960) gains `isDiscardDevice`.

Predicted unchanged, with the claim each rests on:

- `src/access-intent/bash/command-enumeration.ts` (`redirectedScope`): it already asks `redirectMayWriteFile` per redirect.
- `src/access-intent/bash/token-collection.ts` and `src/access-intent/bash/command-effects.ts`: the proof path is untouched, so `token-collection.test.ts` and `program.test.ts`'s `/dev/null` write-token assertions stay green.
- `test/handlers/gates/bash-command.test.ts`: it feeds pre-built units with `floorExemption` set, so it pins the exemption-to-verdict mapping, which does not change.
- `docs/decisions/0013-permission-policy-model.md`: see Non-Goals.
- `.pi/skills/package-pi-permission-system/SKILL.md`: its fail-closed paragraph names `redirect-analysis.ts` only as a pointer to the architecture entry.
- `README.md`: it documents neither the redirect rule nor `/dev/null`.

## Test Impact Analysis

1. New tests: `isDiscardDevice` unit rows; `redirectMayWriteFile` rows for each output operator against `/dev/null`; program-level `floorExemption` rows for the scenario table.
2. Redundant tests: none.
   The existing write-proving rows (`> out.txt`, `2> err.log`) stay as the contrast class.
3. Kept as-is: every `redirectEffectForDestination` test, and the `/dev/null` write-token assertions in `token-collection.test.ts` and `program.test.ts`, which pin the Non-Goal that the collector is unchanged.

## Invariants at risk

- **[#803]'s fail-closed refusal** (architecture entry: a destination the parse cannot resolve counts against the exemption).
  Pinned by `redirect-analysis.test.ts`'s "a destination the parse cannot resolve" table and `program.test.ts`'s `> $OUT` / `> $(mktemp)` rows; step 2 adds `2>"/dev/null"` and `2>/dev/stdout` beside them.
- **[#814]'s unresolved-parse refusal comes first.**
  Pinned by the `cat <>&1` row; the guard sits after the `parseUnresolvedAt` early return.
- **The proof and the refusal stay separate** (the collector still sees `/dev/null` as a write).
  Pinned by `token-collection.test.ts` line ~1388 (`grep pat 2>/dev/null f.txt` attributes `/dev/null` a syntax `write`) and `program.test.ts` line ~2014.
- **The device list keeps its external-directory role.**
  Pinned by `safe-system-paths.test.ts`'s existing `SAFE_SYSTEM_PATHS` / `isSafeSystemPath` rows, which step 1 leaves in place.

## TDD Order

The Tidy-First assessor found no preparatory refactoring warranted; its one optional tidying (the named `DISCARD_DEVICE` constant) is folded into step 1.

1. **`refactor(pi-permission-system): name the discard device in safe-system-paths`**
   - Red: in `test/path/safe-system-paths.test.ts`, add `describe("isDiscardDevice")`: true for `/dev/null`; false for `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/null/x`, `/dev/nullx`, `dev/null`, and `""`.
   - Green: add `DISCARD_DEVICE` and `isDiscardDevice`; build `SAFE_SYSTEM_PATHS` from the constant.
   - Killing mutation: make `isDiscardDevice` return `SAFE_SYSTEM_PATHS.has(path)`; the `/dev/std*` rows go red.
   - `refactor:` because no consumer calls it yet.
2. **`fix(pi-permission-system): a /dev/null redirect keeps the core-reader wrapper exemption`**
   - Red, in `test/access-intent/bash/redirect-analysis.test.ts` under `describe("redirectMayWriteFile")`, a sub-describe "a redirect to the discard device":
     - answers `false` for `pnpm x 2>/dev/null`, `cat a > /dev/null`, `cat a >> /dev/null`, `cat a >| /dev/null`, `cat a &> /dev/null`, `cat a &>> /dev/null`, `cat a >& /dev/null`;
     - answers `true` for `cat a 2>"/dev/null"`, `cat a 2>'/dev/null'`, `cat a 2>/dev/stdout`, `cat a > /dev/stdin`, `cat a > /dev/null.bak`, `cat a > /dev/null/x`, `cat a 2>$NULL`.
   - Red, in `test/access-intent/bash/program.test.ts` under the `floor exemption` describe, a sub-describe "a statement that redirects to the discard device", one row per scenario-table line:
     - `rg -l x | xargs ls -1t 2>/dev/null` → `[undefined, "core-reader"]`;
     - `xargs grep -l x >/dev/null 2>&1` → `["core-reader"]`;
     - `2>/dev/null xargs grep -l x` → `["core-reader"]`;
     - `xargs grep x 2>/dev/null > out.txt` → `[undefined]`;
     - `xargs grep -l x 2>/dev/stdout` → `[undefined]`;
     - `xargs grep -l x 2>"/dev/null"` → `[undefined]`;
     - `xargs pnpm test 2>/dev/null` → `[undefined]`.
   - Green: import `isDiscardDevice` into `redirect-analysis.ts` and add the guard after the descriptor `continue`; update `redirectMayWriteFile`'s doc comment.
   - Killing mutations, by class:
     - Delete the `isDiscardDevice` guard line: every `false` row in `redirect-analysis.test.ts` and the three `core-reader` rows in `program.test.ts` go red.
     - Replace `isDiscardDevice(child.text)` with `isSafeSystemPath(child.text)`: the `/dev/stdout` and `/dev/stdin` rows go red.
     - Replace it with `child.text.includes("/dev/null")`: the quoted, `/dev/null.bak`, and `/dev/null/x` rows go red.
     - Also add `cat <> /dev/null` as a `true` row, a regression row rather than a killer.
       Measured with `getGrammarParser`: it parses as `[<, ERROR, word]` with `hasError` set, so both the `parseUnresolvedAt` early return and the `ERROR` child refuse, and no single-line mutation of the guard turns it green.
       The guard's ordering after the early return is structural (it lives inside the loop), so no mutation is named for it.
   - Verify: `pnpm --filter @gotgenes/pi-permission-system run test`, `check`, `lint`.
3. **`docs(pi-permission-system): record the discard-device clearance in the architecture doc`**
   - Update the `redirect-analysis.ts` and `safe-system-paths.ts` module-tree entries as listed in Module-Level Changes.
   - No killing mutation (docs only).

## Risks and Mitigations

- **A write path through the device.**
  Writing `/dev/null` discards the bytes on every platform bash runs on here (macOS, Linux, Git Bash's MSYS device).
  A user cannot rebind `/dev/null` without root, and a root-capable command is already outside what a core reader can do.
- **The cleared redirect masks a real write elsewhere in the statement.**
  Mitigated by per-redirect evaluation: `xargs grep x 2>/dev/null > out.txt` still refuses (step 2 row).
- **An unresolved redirect naming `/dev/null` gets cleared.**
  Measured: `cat <> /dev/null` parses unresolved (`[<, ERROR, word]`), and the `parseUnresolvedAt` early return refuses it before the loop reaches the guard; step 2 pins it with a `true` row.

## Open Questions

- Whether `path_write`'s view of `/dev/null` (collected as a write token) should also change.
  Deferred until a review-log entry shows a `path_write` prompt on `/dev/null`; no follow-up filed, since the operator kept the collector as-is and nothing concrete is named.

[#609]: https://github.com/gotgenes/pi-packages/issues/609
[#803]: https://github.com/gotgenes/pi-packages/issues/803
[#814]: https://github.com/gotgenes/pi-packages/issues/814
[#951]: https://github.com/gotgenes/pi-packages/issues/951
[#977]: https://github.com/gotgenes/pi-packages/issues/977
