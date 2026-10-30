#!/usr/bin/env bash
# Throwaway pi + tmux environment with mandatory local asciinema recording.
set -euo pipefail

# Connect to the host server; never start a server inside a sandbox.
export TMUX_TMPDIR=/tmp

usage() {
  cat <<'EOF'
Usage:
  pi-e2e-env.sh start <name> <extension-path> [more extension paths...]
  pi-e2e-env.sh resume <name>
  pi-e2e-env.sh send <name> <keys...>
  pi-e2e-env.sh mark <name> <step description...>
  pi-e2e-env.sh capture <name> [lines]
  pi-e2e-env.sh entries <name>
  pi-e2e-env.sh stop <name>

Environment:
  PI_BIN        pi executable (default: pi from PATH)
  ASCIINEMA_BIN asciinema 3+ executable (default: asciinema from PATH)
  NODE_BIN      node executable for `entries` (use direnv)

Recordings and evidence remain under /tmp/pi-e2e-<name>/recordings/.
Use a new name for a fresh test; resume preserves sessions and earlier casts.
EOF
  exit 1
}

fail() { echo "ERROR: $*" >&2; exit 1; }
[ $# -ge 2 ] || usage
cmd=$1
name=$2
shift 2
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || fail "invalid test name"
sess="e2e-$name"
envdir="/tmp/pi-e2e-$name"

current_run() {
  [ -f "$envdir/current-run" ] || fail "no recording for $name"
  run=$(cat "$envdir/current-run")
  [ -d "$run" ] || fail "missing recording directory: $run"
}

mark() {
  local now start elapsed label
  now=$(date +%s%3N)
  start=$(cat "$run/start-ms")
  elapsed=$(awk -v n="$now" -v s="$start" 'BEGIN {printf "%.3f", (n-s)/1000}')
  label="$*"
  label=${label//$'\t'/ }
  label=${label//$'\n'/ }
  printf '%s\t%s\t%s\n' "$elapsed" "$(date -u +%FT%TZ)" "$label" >> "$run/steps.tsv"
}

case "$cmd" in
  start|resume)
    if [ "$cmd" = start ]; then [ $# -ge 1 ] || usage; else [ $# -eq 0 ] || usage; fi
    tmux ls >/dev/null 2>&1 || fail "host tmux server unavailable; follow pi-tmux-tmp-server first"
    if tmux has-session -t "=$sess" 2>/dev/null; then fail "session $sess already exists; stop it first"; fi
    pi_bin=$(command -v "${PI_BIN:-pi}") || fail "pi executable not found"
    recorder=$(command -v "${ASCIINEMA_BIN:-asciinema}") || fail "asciinema 3+ required; no unrecorded fallback"
    [[ "$pi_bin" = /* && "$recorder" = /* ]] || fail "executables must resolve to absolute paths"
    rec_help=$("$recorder" rec --help)
    [[ "$rec_help" == *asciicast-v2* && "$rec_help" == *--return* ]] || fail "asciinema 3+ required"
    if [ "$cmd" = start ]; then
      [ ! -e "$envdir" ] || fail "$envdir exists; use a new name or resume (never overwrite evidence)"
      ext_flags=()
      for p in "$@"; do
        [ -f "$p" ] || fail "extension not found: $p"
        ext_flags+=(-e "$(readlink -f "$p")")
      done
      mkdir -m 700 "$envdir"
      mkdir -p "$envdir/sessions" "$envdir/recordings"
      printf '%s\0' "${ext_flags[@]}" > "$envdir/extensions.args"
    else
      [ -f "$envdir/extensions.args" ] || fail "no environment to resume"
      current_run
      [ -f "$run/recorder-exit" ] || fail "previous recording unfinished; inspect it before resuming"
      mapfile -d '' -t ext_flags < "$envdir/extensions.args"
    fi
    run=$(mktemp -d "$envdir/recordings/run-XXXXXX")
    printf '%s\n' "$run" > "$envdir/current-run"
    mkdir "$run/asciinema-config"
    # Ignore personal recorder settings: never capture raw input or compress time.
    printf '[session]\ncapture_input = false\ncapture_env = "SHELL"\n' > "$run/asciinema-config/config.toml"
    pi_args=("$pi_bin" --no-extensions --no-skills --no-prompt-templates --no-themes
      --no-context-files --session-dir "$envdir/sessions" "${ext_flags[@]}")
    if [ "$cmd" = resume ]; then pi_args+=(--continue); fi
    # Export the caller's direnv PATH explicitly: the host server can have a
    # different PATH. Quote each argument, including extension paths with spaces.
    {
      printf '#!/usr/bin/env bash\ncd %q || exit 1\nexport PATH=%q\n' "$envdir" "$PATH"
      printf '%q ' "${pi_args[@]}"
      # Expand status in the generated script, not while writing it.
      # shellcheck disable=SC2016
      printf '\nrc=$?\nprintf "%%s\\n" "$rc" > %q\nexit "$rc"\n' "$run/pi-exit"
    } > "$run/launch.sh"
    {
      printf '#!/usr/bin/env bash\nexport PATH=%q\n' "$PATH"
      printf 'export ASCIINEMA_CONFIG_HOME=%q ASCIINEMA_STATE_HOME=%q\n' "$run/asciinema-config" "$run/asciinema-state"
      printf 'date +%%s%%3N > %q\n' "$run/start-ms"
      printf '%q ' "$recorder" rec --output-format asciicast-v2 --return --quiet --capture-env SHELL
      printf '%q ' --command "bash $(printf '%q' "$run/launch.sh")" "$run/session.cast"
      # shellcheck disable=SC2016
      printf '\nrc=$?\nprintf "%%s\\n" "$rc" > %q\n' "$run/recorder-exit"
      # Keep the pane alive so startup failures and recorder diagnostics can be inspected.
      printf 'exec sleep 86400\n'
    } > "$run/record.sh"
    "$recorder" --version > "$run/asciinema-version.txt"
    printf 'elapsed_seconds\tutc\tstep (approximate offset from recorder launch)\n' > "$run/steps.tsv"
    printf -v inner 'bash %q' "$run/record.sh"
    tmux new-session -d -s "$sess" -x 130 -y 42 "$inner"
    for ((i=0; i<50; i++)); do
      [ ! -f "$run/recorder-exit" ] || fail "recorded process exited during startup; inspect $run and capture $name"
      if [ -s "$run/session.cast" ] && [ -f "$run/start-ms" ]; then break; fi
      sleep 0.1
    done
    [ -s "$run/session.cast" ] || fail "recording did not start; inspect pane and stop $name"
    mark "recording started ($cmd)"
    echo "env=$envdir tmux=$sess"
    echo "recording=$run/session.cast steps=$run/steps.tsv"
    printf 'replay: %q play %q\n' "$recorder" "$run/session.cast"
    echo "inspect: $0 capture $name 40"
    ;;
  send)
    [ $# -ge 1 ] || usage
    current_run
    [ ! -f "$run/recorder-exit" ] || fail "recorded process has exited"
    # Do not duplicate potentially sensitive key contents into the step index.
    mark "send-keys (add a descriptive mark separately)"
    tmux send-keys -t "=$sess:" "$@"
    ;;
  mark)
    [ $# -ge 1 ] || usage
    current_run
    mark "$*"
    ;;
  capture)
    lines=${1:-40}
    [[ "$lines" =~ ^[0-9]+$ ]] || fail "lines must be numeric"
    current_run
    capture="$run/pane-$(date +%s%N).txt"
    tmux capture-pane -t "=$sess:" -p -S "-$lines" > "$capture"
    mark "capture $(basename "$capture")"
    cat "$capture"
    ;;
  entries)
    sfile=""
    for candidate in "$envdir"/sessions/*.jsonl; do
      [ -f "$candidate" ] || continue
      if [ -z "$sfile" ] || [ "$candidate" -nt "$sfile" ]; then sfile=$candidate; fi
    done
    [ -n "$sfile" ] || fail "no session file under $envdir/sessions"
    echo "FILE=$sfile"
    NODE_BIN="${NODE_BIN:-node}"
    "$NODE_BIN" -e 'const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l));lines.forEach((e,i)=>{const n=String(i+1).padStart(4);if(e.type==="custom_message")console.log(n,e.customType.padEnd(26),(e.details?.reason||e.details?.kind||"").padEnd(12),"len="+String((e.content||"").length));else if(e.type==="custom")console.log(n,"(custom)",e.customType,e.data?.reason||"");else if(e.type==="message"&&e.message)console.log(n,"msg role="+e.message.role+(e.message.role==="assistant"?" stop="+e.message.stopReason:""));else console.log(n,e.type);});' "$sfile"
    ;;
  stop)
    current_run
    if [ ! -f "$run/recorder-exit" ]; then
      mark "stop requested (C-d)"
      tmux send-keys -t "=$sess:" C-d 2>/dev/null || true
      for ((i=0; i<100; i++)); do
        [ ! -f "$run/recorder-exit" ] || break
        sleep 0.1
      done
    fi
    if [ ! -f "$run/recorder-exit" ]; then
      mark "FORCED teardown; recording may be incomplete"
      tmux kill-session -t "=$sess" 2>/dev/null || true
      fail "graceful exit timed out; evidence kept at $run; do not report a complete recording"
    fi
    tmux kill-session -t "=$sess" 2>/dev/null || true
    [ -s "$run/session.cast" ] || fail "missing/empty recording at $run"
    [ -f "$run/pi-exit" ] || fail "pi did not run; inspect recorder diagnostics"
    mark "recording finalized; pi exit=$(cat "$run/pi-exit"), recorder exit=$(cat "$run/recorder-exit")"
    echo "stopped $sess; evidence kept at $envdir"
    echo "recording=$run/session.cast steps=$run/steps.tsv"
    [ "$(cat "$run/pi-exit")" = 0 ] && [ "$(cat "$run/recorder-exit")" = 0 ] || fail "non-zero exit; inspect $run"
    ;;
  *) usage ;;
esac
