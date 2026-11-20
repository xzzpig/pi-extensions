# Agent-initiated goal tweak — live Pi TUI evidence

Change: `allow-agent-initiated-goal-tweak` (packages/pi-goal-x).

## Exact verification commands and results

Run from the repository root with direnv loaded:

```text
pnpm --filter @xzzpig/pi-goal-x run typecheck          # PASS (tsc --noEmit)
pnpm --filter @xzzpig/pi-goal-x test                   # PASS 1869/1869 tests, 151 files, exit 0 (after scope reduction)
cd packages/pi-goal-x && node scripts/fork-test-runner.mjs  # PASS 279/279 fork tests, 18 suites (after scope reduction)
pnpm run audit:fork-divergence                         # PASS exit 0, no undeclared findings
openspec validate allow-agent-initiated-goal-tweak --strict  # PASS
pnpm exec prettier --check <changed files>             # PASS
```

Focused fork regression `tests/fork-agent-initiated-tweak.test.ts`: 72/72 pass,
covering admission binding, control-only reason rejection, continued-draft
admission, no stray draft on validation failure / unavailable host / confirm
conflict, auto-confirm (`1`/`0`/headless), conflict cleanup, and reason display
in rich diff, rich full view, basic `ui.select` host, and saved snapshot.
These tests also assert that an explicit proposal does not clear a pre-existing
user draft and that no draft/runtime state is committed before the decision.
The registered-tool regression seeds the actual parse cache and fixes and asserts
identical file mtime and size across a lock-time status change for both interactive
and explicit automatic confirmation. A separate buffered-usage test changes the
on-disk status under the admission flush lock and verifies no dialog or stale
write occurs. Additional registered-tool tests change the goal ID or objective
at the admission flush lock and assert the focus token remains valid and no
write occurs; interactive and auto-confirm tests change the objective at the
commit lock and verify that the reviewed proposal is rejected. The authoritative
parser reads bytes directly without cache inserts. Additional registered-tool
regressions cover a failed lock-time read with buffered usage (focus and token
remain unchanged), and a same-revision Sisyphus-mode change under the commit
lock for both interactive and automatic confirmation. The same two confirmation
paths also test lock-time active-path redirection and foreign scheduler changes:
the original and unrelated target files remain unchanged after the injected
race, and the budget-exhaustion test establishes that the scheduler projections
would otherwise differ. An auto-confirm regression seeds a stale parse cache with
identical file mtime and size while disk enables the auditor; the applied goal
retains that authoritative choice. Another test verifies that a user's explicit
auditor choice survives continue-chatting and subsequent auto-confirmation.
Registered-tool regressions also reject malformed confirmation responses and
verify abort before admission, during admission, during an interactive dialog
(including a host that never resolves), and under the commit lock. No aborted
proposal changes the goal or leaves a new draft. Additional regressions verify
the host's custom-dialog completion callback is invoked on abort and a late
host failure cannot open a fallback; a continued draft for goal A is rejected
before flushing running goal B; and a 42-row viewport retains its diff source
anchor when a long reason rewraps from width 100 to 48. The viewport test was
also run against the old wrapped-row offset as a negative control and failed.
Additional regressions cover zero-width reasons, equivalent absent/false auditor
fields in buffered flushes (including ledger persistence), explicit tweak call
previews, default headless auto-confirm, and cancellation preserving task
progress, budget, and execution state. A contract-only proposal is rejected
before review because the model must supply a complete objective; clearing the
existing task list is also followed by a successful buffered usage and ledger
flush. Interactive and automatic confirmations also exercise a contract-bearing
objective together with `tasks: []` and `block_completion: true`, checking the
review, persisted target, later buffer flush and ledger against the existing
storage normalizer. With `disableContracts=true`, interactive and automatic
model proposals containing CRLF likewise check review, disk reload, and a
subsequent buffered usage/ledger flush. A full-suite run under parallel load
initially hit a settings-lock timeout; the race test and the full suite passed
on subsequent nonparallel runs.

## Environment / isolation

Both runs launched via
`.agents/skills/pi-plugin-e2e-test/scripts/pi-e2e-env.sh` with `direnv exec .`,
loading only `packages/pi-goal-x/extensions/goal.ts` plus the standard isolation
flags (`--no-extensions --no-skills --no-themes --no-context-files
--session-dir`). Auditor disabled in seed settings
(`{"auditor":{"disabled":true}}`) because the isolated env has no
`goal-auditor` agent. A seeded active goal was focused with `/goal-focus`.

## Recorded scenarios

### Current implementation after scope reduction (`goal-scope-final`)

`/tmp/pi-e2e-goal-scope-final` was started with
`direnv exec . .agents/skills/pi-plugin-e2e-test/scripts/pi-e2e-env.sh start goal-scope-final packages/pi-goal-x/extensions/goal.ts`.
After a seeded-goal restart, `run-c5Kx9g/session.cast` recorded the full flow:

- 23–36s: a user request, without `/goal-tweak`, opened the diff with a reason
  (`pane-1795110415107786663.txt`).
- 52–55s: full view displayed the same reason and revised objective
  (`pane-1795110434090376019.txt`).
- 68–75s: confirmation applied the `status.md` / Risks goal; the disk file
  contained that objective (`pane-1795110454342303465.txt`).
- 89–120s: a second proposed greeting was cancelled and the disk objective
  remained the prior `status.md` goal (`pane-1795110498842100582.txt`).

Session JSONL contains `tweakReview` outcomes `applied` and `cancel`, each with
reason and diff, plus a `pi-goal-context-event` with reason `tweaked`. Startup
`run-SoKPvf` and resumed `run-c5Kx9g` both have `pi-exit=0` and
`recorder-exit=0`. Both casts were replayed completely in a 130×42 tmux pane
using `asciinema play --idle-time-limit 0.2 --speed 1`; both playback processes
exited 0. Sampled captures are `/tmp/goal-scope-replay-SoKPvf-2.txt` and
`/tmp/goal-scope-replay-c5Kx9g-2.txt`. Replay:

```text
asciinema play /tmp/pi-e2e-goal-scope-final/recordings/run-SoKPvf/session.cast
asciinema play /tmp/pi-e2e-goal-scope-final/recordings/run-c5Kx9g/session.cast
```

### Main lifecycle run (`/tmp/pi-e2e-agent-tweak-live3`, `run-TiQGLv/session.cast`)

1. User asked to add a Risks section and rename `memo.md` → `status.md`. The
   model called `propose_goal_draft` with `tweak={goal_id, reason}` in one call
   and no `/goal-tweak`. The diff dialog showed `调整原因` plus the model's
   reason and semantic diff (pane `pane-1795068167528249798.txt`). Confirmed →
   applied; disk objective became "Draft a short project status memo in
   status.md. The memo must include a Risks section."
2. A second revision request (10-page report with charts) produced another
   reason-bearing dialog and was applied.
3. A third request (one-line greeting): selected `3. Cancel — discard this
tweak` then `[Confirm selection] Cancel`; outcome `cancel` and disk
   objective stayed "Write a 10-page report with charts."

Saved `tweakReview` entries = `[applied, applied, cancel]`; every entry has a
non-empty sanitized reason in `details` and tool text, plus a remove/add diff
and full candidate. `pi-goal-context-event reason=tweaked` confirms the applied
revision refreshed goal context. Exit markers `pi-exit=0`, `recorder-exit=0`.

### Full-view run (`/tmp/pi-e2e-agent-tweak-fullview`, `run-EwdDN3/session.cast`)

The user requested a revision (write `weekly.md`, add "Next Steps"). In the
dialog, option `4. View the full modified goal (read-only)` was selected. Pane
`pane-1795072154034376642.txt` (also in the cast) shows, in the same frame:

- `Modified goal — full effective content`
- `调整原因` and the reason "User asked to change the memo's output file from
  memo.md to weekly.md and to add a Next Steps section."
- the modified objective containing `weekly.md` and `Next Steps`
- `Back to the change diff (read-only)` control

The dialog was then confirmed and the run stopped cleanly (`pi-exit=0`,
`recorder-exit=0`; cast header v2, 168 lines).

## Recordings / replay

- `run-VDNVZL/session.cast` — startup only (settings seeded after launch).
- `/tmp/pi-e2e-agent-tweak-live3/recordings/run-TiQGLv/session.cast` — lifecycle:
  3 tweaks (2 applied, 1 cancel). Replay:
  `asciinema play /tmp/pi-e2e-agent-tweak-live3/recordings/run-TiQGLv/session.cast`
- `/tmp/pi-e2e-agent-tweak-fullview/recordings/run-EwdDN3/session.cast` —
  full-view reason display. Replay:
  `asciinema play /tmp/pi-e2e-agent-tweak-fullview/recordings/run-EwdDN3/session.cast`
- Steps indexes and pane captures are in each run's `steps.tsv` and
  `pane-*.txt` files.

## Limitations

- After scope reduction, both earlier casts were replayed to completion in a
  separate 130×42 tmux pane using `asciinema play --idle-time-limit 0.2 --speed 1`;
  both playback processes exited 0. Captures sampled the replay in
  `/tmp/goal-replay-live3-review-2.txt` and
  `/tmp/goal-replay-fullview-review-2.txt`, including reason/diff and full-view
  controls. Those two earlier recordings use the pre-reduction code; the
  `goal-scope-final` recording above separately exercises the reduced code.
  It predates the contract-only validation and model-candidate normalization;
  the recorded complete-objective scenarios have neither a contract, CRLF nor
  an empty task proposal, so their candidate text and decisions are unchanged.
  Both additional cases are covered by registered-tool tests. Replay capture
  inspection was sampled rather than continuous.
- An independent audit probe later altered the isolated live3 goal fixture; the
  original cast, pane captures and session records remain intact. Cancellation
  evidence uses the pre-probe disk observation and original records.
- The basic-host (`ui.select`) fallback reason display is covered by the
  focused automated test, not by a TUI cast (no select-only host in the TUI).
- Earlier diagnostic recordings (`agent-tweak-live`, `agent-tweak-live2`,
  `run-VDNVZL`) remain under `/tmp` but are not part of the acceptance claim.
