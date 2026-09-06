---
name: pi-plugin-e2e-test
description: Run a pi plugin against a real pi runtime in an isolated throwaway environment. This skill should be used when a pi-* package needs real-runtime validation before release (extension loading, slash commands, model turns, dialogs, session persistence), when unit tests pass but live TUI behavior is unproven, or when asked to "实际测试" / "真机测试" / "跑一遍" a plugin using pi and tmux.
compatibility: Requires the repository root with direnv loaded, pi CLI on PATH, tmux, and a working pi model credential for model turns.
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
Use the bundled wrapper so launch, inspection, and teardown are
deterministic (paths relative to this skill directory):

```bash
scripts/pi-e2e-env.sh start <name> <entry.ts> [companion.ts ...]
scripts/pi-e2e-env.sh capture <name> [lines]   # pane text, scrollback included
scripts/pi-e2e-env.sh send <name> "/some-command args" Enter
scripts/pi-e2e-env.sh entries <name>           # compact session JSONL map
scripts/pi-e2e-env.sh stop <name>              # C-d, then kill-session
```

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
- Restart persistence: `stop`, then relaunch the same command with
  `--continue` and the same `--session-dir`; verify restored state in the
  pane and the replayed transcript before continuing.
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

Collect with each test step: pane captures, files the plugin wrote under the
temp cwd, and the exact launch command. Keep the temp dir for the final
report; only the tmux session is disposable.

## Worked example

`references/worked-example.md` walks a complete real run — load check, slash
commands, a full goal lifecycle with subagent audit, pause/restart/resume,
dialog interaction, and the session-file assertions that proved each
behavior for the pi-goal-x plugin.
