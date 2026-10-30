---
name: pi-plugin-e2e-test
description: Run a pi plugin against a real pi runtime in an isolated throwaway environment, with mandatory asciinema recordings for interactive TUI tests. This skill should be used when a pi-* package needs real-runtime validation before release (extension loading, slash commands, model turns, dialogs, session persistence), when unit tests pass but live TUI behavior is unproven, or when asked to "实际测试" / "真机测试" / "跑一遍" a plugin using pi and tmux.
compatibility: Requires the repository root with direnv loaded, pi CLI on PATH, a working pi model credential for model turns, and — for Level 2 — asciinema CLI 3+, tmux, and a running tmux server in /tmp (see the pi-tmux-tmp-server skill).
---

# Pi Plugin E2E Test

Validate a pi-\* extension against the real pi runtime, not a test harness:
real process load, real TUI, real model turns, real session persistence.
Unit tests and typecheck prove code correctness; this workflow proves the
plugin works when a user actually runs pi. Complements the
pi-plugin-maintainer skill, which covers naming, manifests, and static
validation.

## Ground rules

- Work from the repository root with direnv loaded; prefix repo tooling with
  `direnv exec .`. A bare `npm`/`node` may resolve to the WSL Windows-side
  binaries — always go through direnv for those.
- Never test inside a real project directory. Always launch from a fresh
  directory under `/tmp` so sessions, plugin data files, and settings
  cannot leak into real work.
- Model turns cost tokens and require a configured pi credential. Confirm
  before long flows: `pi auth check --provider <provider>` (find the user's
  default provider and model in `~/.pi/agent/settings.json`).
- Define the evidence checklist BEFORE launching: which commands to run,
  which session-file entries to expect, which disk files must appear, which
  pane output proves each behavior. Report failures honestly; never infer
  live success from green unit tests.
- Record EVERY Level 2 TUI run with asciinema, from process startup through
  graceful exit, including failed attempts and persistence restarts. Keep
  Level 1 print-mode smoke output as text; recording is not required there.
  Never substitute pane captures or session JSONL for a TUI recording.
- Keep recordings local. Do not upload/publish them without explicit user
  authorization. Avoid secrets in prompts, dialogs, and terminal output;
  disabling raw input capture does not hide text echoed by the application.

## The isolation contract

Disable every discovery channel and load ONLY the package under test, plus
companion extensions it needs at runtime (event bridges, delegation hosts):

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-themes \
   --no-context-files --session-dir <tmpdir>/sessions \
   -e <package>/extensions/<entry>.ts \
   [-e ~/.pi/agent/npm/node_modules/<companion>/index.ts ...]
```

- `--no-extensions` keeps explicit `-e` paths working; this is pi's intended
  temporary-load mechanism. The user's installed packages (possibly an older
  published version of the same plugin) stay out of the way — the local tree
  is exercised deliberately, not by discovery.
- `--session-dir` pins the session JSONL files inside the temp dir; sessions
  are the primary evidence source.
- `--no-themes` plus a theme in user settings prints a cosmetic
  "Failed to load theme ... Fell back to dark theme." — expected, not a
  defect.

## Level 1 — print-mode smoke test

Prove the extension loads cleanly and a model round-trip works without any
interactive machinery:

```bash
rm -rf /tmp/pi-e2e-smoke && mkdir -p /tmp/pi-e2e-smoke
cd /tmp/pi-e2e-smoke && timeout 120 pi <isolation flags> -e <entry.ts> \
  -p "Reply with exactly the word: pong"; echo "EXIT=$?"
```

Success means the model reply appears and exit is 0. Extension crashes,
registration errors, and load failures surface here in seconds and cheaply.

## Level 2 — tmux interactive TUI test

Slash commands, dialogs, widgets, and lifecycle flows need the real TUI.

Prerequisite — tmux server in /tmp: this level drives the real TUI through
a persistent tmux server whose socket lives in `/tmp` (a server started
inside a sandboxed command dies with its PID namespace, so it must live on
the host). Follow the `pi-tmux-tmp-server` skill first: verify the server is
running and connectable (`TMUX_TMPDIR=/tmp tmux ls`, or its bundled
`tmux-tmp-check.sh`). If it is not, do NOT start it from inside the sandbox —
hand the user the start commands from that skill and ask via the `ask_user`
tool whether to continue. Only proceed once the check passes.

Check `asciinema --version` and `asciinema rec --help`; require CLI 3+ with
`--output-format asciicast-v2` and `--return`. If missing on NixOS, use
`nix-shell -p asciinema --run 'direnv exec . <wrapper command>'`, or enter
that temporary shell for the workflow. Do not silently fall back to an
unrecorded TUI test. Set `ASCIINEMA_BIN` to an absolute executable if needed.

The bundled wrapper forces `TMUX_TMPDIR=/tmp`, resolves executable paths,
and starts asciinema INSIDE the tmux pane wrapping pi (not a recording of
`tmux capture-pane`). It preserves the caller's direnv PATH on the host
server. Use the wrapper for launch, inspection, and graceful teardown
(paths relative to this skill directory; invoke from the repo root with
`direnv exec .`):

```bash
scripts/pi-e2e-env.sh start <name> <entry.ts> [companion.ts ...]
scripts/pi-e2e-env.sh capture <name> [lines]   # print AND save pane text
scripts/pi-e2e-env.sh mark <name> "01: open command dialog; expect choices"
scripts/pi-e2e-env.sh send <name> "/some-command args" Enter
scripts/pi-e2e-env.sh mark <name> "01: observed choices; PASS"
scripts/pi-e2e-env.sh entries <name>           # compact session JSONL map
scripts/pi-e2e-env.sh stop <name>              # C-d, wait for recorder, then kill
scripts/pi-e2e-env.sh resume <name>            # same sessions, --continue, NEW cast
```

- Use a unique `<name>` per fresh test. `start` refuses existing directories
  or sessions rather than deleting evidence. Use `resume` only after a
  finalized recording; never overwrite an earlier cast or retry invisibly.
- After `start`, capture immediately: the `[Extensions]` startup line must
  list the loaded entry files.
- Drive one behavior per step: send a command or prompt, sleep a few
  seconds, capture, assert on the pane. Poll long flows (model turns,
  subagents, audits) with repeated `sleep N && capture` instead of one long
  wait.
- Confirm the agent is idle before testing idle-state behaviors. A spinner
  or `Working` line means the next prompt will be steered into the running
  turn — steered messages do not fire extension turn hooks such as
  `before_agent_start` and may be dropped when a turn aborts. If a captured
  answer seems to come "for free", re-check whether the prompt was actually
  delivered as steering.
- Fast models outrun the keyboard: to exercise pause/abort or mid-run
  states, pick an objective that cannot finish quickly or send the command
  within seconds of starting the turn.
- Restart persistence: `stop`, then `resume <name>` to use `--continue` and
  the same `--session-dir` with a separate recording. Verify restored state
  in the pane and the replayed transcript before continuing.
- Interactive dialogs (confirm/question UIs) render inside the pane; answer
  them by sending keys (`Enter` picks the highlighted option). Env-var
  auto-confirm helpers some plugins provide (e.g. `PI_GOAL_AUTO_CONFIRM`)
  bypass dialogs and are useful for headless flows but skip exactly the UI
  being tested.

## Evidence collection

The session JSONL under the temp `sessions/` dir is the authoritative record
of what reached the runtime. `scripts/pi-e2e-env.sh entries <name>` prints a
one-line map per entry (type, customType, length, reason/kind). Entry shapes
to know: `custom` entries are session-local metadata never sent to the LLM;
`custom_message` entries persist across restarts and their `display:false`
variants ride LLM requests; `message` entries are the conversation itself.
Which custom types prove which behavior is plugin-specific — derive the
expected sequence from the plugin's docs/source, then confirm actual timing
and ordering in the JSONL (e.g. snapshot-before-marker pairs, create → turn
→ completion chains).

Collect with each test step: a descriptive `mark` before the action and after
its assertion (PASS/FAIL plus actual observation), pane captures, files the
plugin wrote under the temp cwd, and the exact launch command. The wrapper
records generic send/capture events automatically; add descriptive marks to
explain the expected behavior without duplicating sensitive key contents.

Find each run under `/tmp/pi-e2e-<name>/recordings/run-*/`:

- `session.cast`: timed terminal output in asciicast v2 format, at 130×42.
- `steps.tsv`: UTC times and approximate seconds since recorder launch;
  use this index to locate actions in the replay (not precise timing assertions).
- `pane-*.txt`: saved captures, cross-referenced by the step index.
- `launch.sh`, `record.sh`, `asciinema-version.txt`: exact commands and tool version.
- `pi-exit`, `recorder-exit`: completion status; require both to be `0` for
  a clean run. Missing markers or forced teardown mean incomplete evidence,
  not a passing test. Keep the cast and diagnostics even on failure.

The wrapper isolates asciinema config/state and disables raw input capture;
record only output and SHELL metadata. Retain original event timing (no
record-time idle compression). Use `stop` while pi is idle, with dialogs
closed and an empty editor so `C-d` can exit. Wait for recorder finalization
BEFORE killing tmux; a timeout is a failure, not permission to claim success.

### Replay and acceptance gate

After `stop`, check that the cast is nonempty, parses as JSONL, has a v2
header and terminal output events, and has clean exit markers. In a real
terminal, replay the full recording, including startup and shutdown:

```bash
asciinema play /tmp/pi-e2e-<name>/recordings/run-<id>/session.cast
# Optional faster review; keep the original cast unchanged:
asciinema play --idle-time-limit 2 /tmp/pi-e2e-<name>/recordings/run-<id>/session.cast
```

When no interactive terminal is available to the agent, run playback in a
separate tmux review pane and inspect key states with captures. If only file
integrity/text checks are possible, label the run **recorded, visual replay
pending**; never claim actual visual verification. A cast existing or
successfully parsing does not prove dialog layout, animation, or interaction
correctness. Validate behavior against the recording AND session/artifact
assertions; session JSONL alone cannot establish rendered UI behavior.

Include in the final report:

1. Tested package/entry paths, scenarios, expected vs actual, PASS/FAIL.
2. Environment directory, every cast path (including restarts/failures), and
   exact `asciinema play ...` commands.
3. Key step offsets from `steps.tsv`, corresponding captures/session entries,
   and the observed UI result.
4. Exit statuses, recording completeness, and replay scope: visually
   reviewed portions vs unreviewed portions and any remaining limitations.

Keep the temp dir for later observation and review; only the tmux session
is disposable. `/tmp` is not durable storage: if review will outlive host
cleanup/reboot, copy the full evidence directory to a user-approved retained
location. Do not commit casts, sessions, or credentials to the repository.

## Worked example

`references/worked-example.md` walks a complete real run — load check, slash
commands, a full goal lifecycle with subagent audit, pause/restart/resume,
dialog interaction, and the session-file assertions that proved each
behavior for the pi-goal-x plugin. Treat that historical run as a scenario
reference, not proof of compliance with today's mandatory recording gate.
