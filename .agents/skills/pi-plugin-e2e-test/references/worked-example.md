# Worked example: pi-goal-x end-to-end validation

> Historical scenario reference: the original run did not retain asciinema
> recordings. Do not treat its results as satisfying the current recording
> gate. For a new run, use the current wrapper as shown below and retain a
> cast for every start/resume, plus step marks and a replay review.

A real run that exercised every level of this workflow. The plugin under
test was `packages/pi-goal-x` (a goal-lifecycle extension) plus its runtime
companion `@xzzpig/pi-subagents` (provides the delegation bridge the
completion auditor needs).

## Setup

```bash
S=/home/xzzpig/workspaces/nodejs/pi-extensions/.agents/skills/pi-plugin-e2e-test/scripts/pi-e2e-env.sh
$S start goalx \
  packages/pi-goal-x/extensions/goal.ts \
  ~/.pi/agent/npm/node_modules/@xzzpig/pi-subagents/index.ts
$S capture goalx 40
$S mark goalx "01: startup extensions visible; PASS"
```

Use `direnv exec .` for wrapper commands; provide asciinema CLI 3+ in that
environment (on NixOS, a temporary `nix-shell -p asciinema` suffices). Use a
fresh name if `/tmp/pi-e2e-goalx` already exists. Before each scenario below,
add a descriptive `mark`; after checking the result, mark PASS/FAIL with the
actual observation.

The startup pane must contain `[Extensions]  @xzzpig/pi-subagents@0.9.0,
goal.ts`. The "Failed to load theme ... Fell back to dark theme." line was
the expected cosmetic artifact of `--no-themes`.

## Level 1 smoke test (before the TUI run)

```bash
mkdir -p /tmp/pi-e2e-smoke && cd /tmp/pi-e2e-smoke
pi --no-extensions --no-skills --no-prompt-templates --no-themes \
   --no-context-files -e packages/pi-goal-x/extensions/goal.ts \
   -p "Reply with exactly the word: pong"; echo "EXIT=$?"
```

Printed `pong`, exit 0 — extension loads cleanly and model turns work.

## Command surface + full lifecycle

1. `/goal-list` → "No open goals..." proves the command palette registered.
2. `/goal-direct Create hello.txt containing exactly pong. Read it back,
then mark complete` → model wrote the file, called `update_goal
complete`, the goal-auditor subagent ran (progress UI in the pane,
   byte-level verification via `od`/`cmp`), approved, goal archived.
3. `entries goalx` showed the expected evidence chain:

```text
4  (custom) pi-goal-focus     created        <- focus entry, session-local
5  pi-goal-context-event      created        len=1697   <- full context msg
6  pi-goal-state-event        state          len=846    <- per-turn snapshot
7  pi-goal-event              checkpoint     len=73     <- 73-byte marker
8  msg role=assistant ...     (write / read / update_goal turns)
14 (custom) pi-goal-focus     completed
15 pi-goal-audit-event                       <- auditor report entries
```

Snapshot immediately followed by the tiny checkpoint marker, before the
model turns — exactly the contract the plugin documents.

## Pause / restart / resume

1. Start a second goal, then `/goal-pause` a few seconds in: the widget
   switched to `goal: paused`.
2. `$S stop goalx`, then `$S resume goalx`: the wrapper relaunches with
   `--continue` and starts a new cast without replacing the first one. The
   replayed transcript and the `goal: paused` widget prove state survived
   restart.
3. `/goal-resume` → fresh snapshot + checkpoint pair in `entries`, model
   re-verified the artifact, completed, audit approved, goal archived.

## Dialog interaction and idle-turn behavior

- `/goal <concrete objective>` → the model proposed via its drafting tool
  and the real confirm dialog rendered in the pane (proposal text, auditor
  toggle line, ★ recommended option). Sending `Enter` confirmed; goal
  creation and the continuation turn started atomically.
- A plain user prompt sent while a turn was streaming produced no snapshot
  entry — it was delivered as steering (a documented limitation, confirmed
  live). Re-testing with the agent idle (no spinner in the capture) showed
  the expected snapshot entry adjacent to the user message with no
  checkpoint marker after it: the idle user-turn path.

## Health check

`/goal-status health` reported 10 checkpoints, 0 legacy, all v2 minimal
markers — the quantitative claim the plugin's CHANGELOG makes, verified in
a live session.

## Teardown

`$S stop goalx` — wait for clean `pi-exit` and `recorder-exit` markers before
removing the tmux session. Keep `/tmp/pi-e2e-goalx/` (sessions, artifacts,
recordings, step indexes, and captures) for the report.

Replay **both** the initial run and the resume run in a terminal:

```bash
asciinema play /tmp/pi-e2e-goalx/recordings/run-<first-id>/session.cast
asciinema play /tmp/pi-e2e-goalx/recordings/run-<resume-id>/session.cast
```

Report the actual cast paths, key step offsets, observed results, and which
portions were visually reviewed. If no visual replay was performed, state
"recorded, visual replay pending" rather than asserting UI success. Copy
evidence to a user-approved retained location if it must survive `/tmp`
cleanup; never upload recordings or commit them by default.
