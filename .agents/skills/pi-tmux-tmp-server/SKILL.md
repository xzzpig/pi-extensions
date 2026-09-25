---
name: pi-tmux-tmp-server
description: Use a persistent tmux server whose socket lives in /tmp (TMUX_TMPDIR=/tmp) so tmux sessions survive across commands in a pi-sandboxed session. Use when tmux needs to persist across bash commands (e.g. tmux-driven e2e testing of a pi plugin, driving a TUI app over multiple commands), before relying on a tmp tmux server, or when asked to verify or start one. Always verify the server is running and connectable while the user is still present; when it is not, hand the user the start commands and ask via the ask_user tool whether to continue.
---

# Pi Tmux Tmp Server

Keep tmux sessions alive across separate bash tool calls while pi-sandbox is
enabled.

## Why a server in /tmp

Every sandboxed bash command runs in a fresh bwrap PID namespace
(`--unshare-pid`). A tmux server started inside such a command dies as soon as
the command returns, so `tmux new-session -d` from one bash tool call is never
visible to the next one.

A tmux server started on the host — outside any sandbox — with its socket in
`/tmp` survives. Sandboxed commands then act as tmux clients that connect to
it, so sessions (and the processes they host) persist across commands. `/tmp`
is typically already in the sandbox's `allowWrite`, and it is not masked by a
`denyRead` on `/run/user/1000` (the default tmux socket location).

## When to use

- A task needs tmux state to survive between two separate bash tool calls
  (tmux-driven e2e testing, driving a TUI app across commands, etc.).
- The task explicitly asks for a tmux server in `/tmp` or to verify one.
- Before any tmux-based workflow when the session runs under pi-sandbox.

## Pre-flight gate: verify before relying on the server

Run this check while the user is still present (e.g. during requirements
confirmation), BEFORE doing any tmux work:

```bash
TMUX_TMPDIR=/tmp tmux ls   # exit 0 + a session list = ready
```

or use the bundled check script (same result, friendlier report):

```bash
scripts/tmux-tmp-check.sh
```

- If the check passes, proceed and use tmux with `TMUX_TMPDIR=/tmp` as
  described below.
- If the check fails, do NOT start the server from inside the sandbox — it
  dies with the command's PID namespace. Instead:
  1. Present the user the exact start commands (below), which must run OUTSIDE
     the sandbox.
  2. Use the `ask_user` tool to ask whether to continue (options: continue —
     the user has started the server; skip tmux and fall back to headless;
     abort).
  3. Only continue once the user confirms, then re-run the check to confirm
     the server is actually connectable.

## Start commands to hand to the user

Must be run OUTSIDE the pi sandbox: in another terminal, before enabling the
sandbox, or via `!` with `sandboxUserShell: false`.

```bash
TMUX_TMPDIR=/tmp tmux kill-server 2>/dev/null || true
rm -rf /tmp/tmux-$(id -u)                    # clear stale sockets
TMUX_TMPDIR=/tmp tmux new-session -d -s host # keep-alive session
```

A stale socket left by a crashed server blocks new ones with "Address already
in use". Sockets under `/run/user/1000` are read-only inside the sandbox, so
the user must clean those from the host (e.g. `rm -rf /run/user/1000/tmux-$(id -u)`).

## Using the server from sandboxed commands

- Prefix every tmux invocation with `TMUX_TMPDIR=/tmp`, or ensure the pi
  process env exports it. Server and clients must agree on the socket path.
- Supported client operations: `new-session -d`, `send-keys`, `capture-pane`,
  `ls`, `has-session`, `kill-session`, `list-windows`. They connect to the
  host server over its unix socket.
- Do NOT use `attach` inside the bash tool: it needs a tty that does not exist
  there. Drive the pane with `send-keys` and inspect with `capture-pane`.
- Sessions and the processes they host run outside the sandbox (children of
  the host server), so work inside a pane is unsandboxed.

## Pitfalls

- Never start the server from a sandboxed command: it dies with the PID
  namespace, so `tmux ls` may succeed inside the same command and fail in the
  next.
- Stale socket → "Address already in use": remove the socket dir outside the
  sandbox, or run `TMUX_TMPDIR=/tmp tmux kill-server`.
- `TMUX_TMPDIR` mismatch between server and clients = invisible sessions; keep
  the value consistent (prefer `/tmp`).
- A `denyRead` entry for `/run/user/1000` masks the default tmux socket dir —
  that is exactly why the socket must live in `/tmp`.
- `-L <name>` also relocates the socket (under the tmp dir); prefer
  `TMUX_TMPDIR=/tmp` so wrappers and clients agree without extra flags.
