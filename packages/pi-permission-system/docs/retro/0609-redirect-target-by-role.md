---
issue: 609
issue_title: "Allow Bash commands without automatically allowing output redirects"
---

# Retro: #609 — Allow Bash commands without automatically allowing output redirects

## Stage: Planning (2026-09-24T22:07:43Z)

### Session summary

Planned the Phase 15 step for #609: `PathToken` gains a required `TokenRole`, and a redirect's literal first destination with a syntax-proven effect skips the shape gate and the existence probe at projection.
I prototyped the design and measured it against 8746 real review-log commands, filed #977 and #978, dispositioned both into Phase 15, corrected the #609 roadmap step, and committed the plan (`docs/plans/0609-redirect-target-by-role.md`).

### Observations

- The issue is third-party (`hcrosse`), but the owner's comment settled the direction against ADR 0013 before this session, so the gate covered design, not whether to build it.
- **Pre-existing grammar quirk (filed as #977).**
  `tree-sitter-bash` 0.25.1's `file_redirect` has `destination: repeat1(...)`, so words after a redirect parse as extra destinations.
  I measured it through the real `resolveBashCommandCheck`: `git 2>/dev/null push --force` and `find ~/x 2>/dev/null -delete` both resolve `allow` under explicit denies.
  Upstream tree-sitter/tree-sitter-bash#233 is closed, but the default branch still has `repeat1`.
  The operator chose to keep #609 on the first destination only and make #977 the step right after it.
- **Roadmap errors corrected in the disposition commits.**
  1. The suggested migration note `path_write: {"*": "allow"}` lifts a `path` write deny: explicit directional entries go after the sugar, and last match wins (measured on `.env`).
  2. "An unconfigured install prompts on `echo hi > out.txt`" is false: the unmatched-promotion guard keeps `path` silent, and the measured count of new prompts with no config was 1 in 8746.
  3. `> /dev/null` is already a `path_write` candidate today, so the #951 interaction note was wrong.
- The prototype showed that both admission rules are load-bearing.
  Without the first-destination rule it admitted `-type`, `d`, and `--include=*.ts`; without the literal-target rule it admitted `$3`, `$tmp`, and `$f`.
- The operator chose to admit input-redirect targets too (one uniform rule).
  On this corpus it gained 0 tokens beyond the output-only variant.
- The `path_write: {"*": "ask"}` recipe from the issue comment already asks on `path` for 6842 of 8746 commands before this change, because unproven tokens consult both directions.
  The plan's docs step avoids presenting it as a redirect-only switch.
- Tidy-First assessor: it recommended one `test:` prep (route 19 effect `toEqual`s through a projection helper) and rejected both roadmap-assigned preps.
  Its claim that `bash-path-extractor.ts` has no production caller checked out on a grep; the operator moved the prefix tidy to #977 and the facade question to #978.
- Co-author trailers for steps 4–5 credit `hcrosse` (#609's provenance mechanism) and `pikujs` (#785's unconditional emission).

#### Deferred tidyings

- `src/access-intent/bash/token-collection.ts` / `bash-path-resolver.ts`: three literal re-spellings of `COMMAND_PREFIX_TYPES`, now #977's prep.
- `src/handlers/gates/bash-path-extractor.ts` and its 1300-line test: no production caller, now #978.

## Stage: Implementation — TDD (2026-09-24T22:46:05Z)

### Session summary

All six plan steps landed as six commits: the `test:` projection prep, `redirectTargetIndex`, `hasComputedPart`, the required `PathToken.role`, the `fix!:` projection by role, and the docs.
The `pi-permission-system` suite went from 4614 to 4648 tests (+34), and every step's named killing mutation turned its tests red.
The re-run corpus spike matched the plan exactly: over 8753 commands, `path` +90 tokens in 60 commands, `external_directory` +97 in 62, 0 lost, and no gained token flag-shaped or computed.

### Observations

- Step 1 deviated in form: instead of wrapping 19 call sites, it changed the two helpers (`tokensOf`, `attributedTokens`) to return the `{ token, effect }` projection, which has the same effect with two edits.
  The assessor's count missed one more exact `PathToken` assertion (the `node -e "$(cat /etc/shadow)"` case in the interpreter describe), which failed at step 4 and was routed through the same `tokenEffectsOf` projection in that commit.
- Step 4's `syntax`-source mutation **survived** the plan's `cat <> rw.txt` case, because that parse leaves an `ERROR` child after the operator, so the word is not the target index and the first-destination rule covers it anyway.
  I added `cat <> ~/rw.txt` (the split where the parse leaves a well-formed-looking redirect), which the mutation kills.
- The mutation for step 1 was applied in the same tool batch as its green-copy `cp`, and the tools ran concurrently, so the saved copy held the mutation; `git checkout` restored the file because it had no uncommitted green edit.
  Sequence the save and the mutation in separate turns.
- I emitted `\u2014` escapes three times in `Edit` bodies (source comment, ADR 0013 staging line, architecture edit); each time I caught it with a grep and replaced it by a parenthetical or a scripted substitution.
- A test block inserted with a Python script skipped `pi-autoformat`, so the pre-commit Biome hook reformatted `program.test.ts` and rejected the first `fix!:` commit; it landed on re-stage.
- Pre-completion reviewer: **WARN**.
  It independently re-derived the redirect spellings (fd-prefixed, `>&-`, `<>`, herestrings, heredocs, quoted/expanded, substitution targets, redirects on compound statements) and found no gap.
  Reviewer warnings: the TDD retro entry was missing (this entry); two decision-surface consumers outside the diff, `logging/command-redaction.ts` (for `node-text.ts`, which only gained an export) and `command-enumeration.ts` (for `redirectMayWriteFile`, which is unchanged), are not re-covered by in-range tests.
