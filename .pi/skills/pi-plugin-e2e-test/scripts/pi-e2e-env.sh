#!/usr/bin/env bash
# pi-e2e-env.sh — throwaway pi + tmux environment for plugin e2e testing.
#
# start   create a fresh /tmp env dir, launch pi in tmux with discovery
#         disabled and the given extensions loaded via -e
# send    send keys to the tmux session (append Enter for commands)
# capture print pane text including scrollback (default last 40 lines)
# entries print a compact map of the newest session JSONL
# stop    exit pi (C-d) and kill the tmux session
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  pi-e2e-env.sh start <name> <extension-path> [more extension paths...]
  pi-e2e-env.sh send <name> <keys...>
  pi-e2e-env.sh capture <name> [lines]
  pi-e2e-env.sh entries <name>
  pi-e2e-env.sh stop <name>

Environment:
  PI_BIN   pi binary to launch (default: pi from PATH)
  NODE_BIN node binary for `entries` (default: node from PATH; use direnv)
EOF
  exit 1
}

[ $# -ge 1 ] || usage
cmd=$1
shift
case "$cmd" in
  start)
    [ $# -ge 2 ] || usage
    name=$1
    shift
    sess="e2e-$name"
    envdir="/tmp/pi-e2e-$name"
    rm -rf "$envdir"
    mkdir -p "$envdir/sessions"
    ext_flags=()
    for p in "$@"; do
      ext_flags+=(-e "$(readlink -f "$p")")
    done
    tmux kill-session -t "$sess" 2>/dev/null || true
    PI_BIN="${PI_BIN:-pi}"
    launch_pi() {
      # One single-quoted shell string: tmux receives the command as a single
      # argv entry, identical to a hand-typed tmux invocation.
      local inner
      inner="cd '$envdir' && $PI_BIN --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --session-dir '$envdir/sessions' ${ext_flags[*]} 2>&1; sleep 2"
      tmux new-session -d -s "$sess" -x 130 -y 42 "$inner"
    }
    launch_pi
    sleep 2
    # pi occasionally exits silently right after a fresh tmux server start;
    # detect the dead session and retry once before giving up.
    if ! tmux has-session -t "$sess" 2>/dev/null; then
      echo "pi exited immediately (known flake); retrying once..." >&2
      launch_pi
      sleep 2
      if ! tmux has-session -t "$sess" 2>/dev/null; then
        echo "ERROR: pi exited immediately twice. Run manually:" >&2
        echo "  cd $envdir && $PI_BIN --no-extensions -e <entry.ts>" >&2
        exit 1
      fi
    fi
    echo "env=$envdir tmux=$sess"
    echo "inspect: $0 capture $name 40"
    ;;
  send)
    [ $# -ge 2 ] || usage
    name=$1
    shift
    tmux send-keys -t "e2e-$name" "$@"
    ;;
  capture)
    [ $# -ge 1 ] || usage
    name=$1
    lines=${2:-40}
    tmux capture-pane -t "e2e-$name" -p -S "-$lines"
    ;;
  entries)
    [ $# -ge 1 ] || usage
    name=$1
    envdir="/tmp/pi-e2e-$name"
    sfile=$(ls -t "$envdir"/sessions/*.jsonl 2>/dev/null | head -1 || true)
    [ -n "$sfile" ] || { echo "no session file under $envdir/sessions"; exit 1; }
    echo "FILE=$sfile"
    NODE_BIN="${NODE_BIN:-node}"
    "$NODE_BIN" -e 'const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l));lines.forEach((e,i)=>{const n=String(i+1).padStart(4);if(e.type==="custom_message")console.log(n,e.customType.padEnd(26),(e.details?.reason||e.details?.kind||"").padEnd(12),"len="+String((e.content||"").length));else if(e.type==="custom")console.log(n,"(custom)",e.customType,e.data?.reason||"");else if(e.type==="message"&&e.message)console.log(n,"msg role="+e.message.role+(e.message.role==="assistant"?" stop="+e.message.stopReason:""));else console.log(n,e.type);});' "$sfile"
    ;;
  stop)
    [ $# -ge 1 ] || usage
    name=$1
    sess="e2e-$name"
    tmux send-keys -t "$sess" C-d 2>/dev/null || true
    sleep 1
    tmux kill-session -t "$sess" 2>/dev/null || true
    echo "stopped $sess (env kept under /tmp/pi-e2e-$name)"
    ;;
  *)
    usage
    ;;
esac
