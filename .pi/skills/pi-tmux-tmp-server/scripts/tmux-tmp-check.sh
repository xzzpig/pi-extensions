#!/usr/bin/env bash
# tmux-tmp-check.sh — verify the persistent tmux server whose socket lives in /tmp.
# Exit 0: server is up and connectable.
# Exit 1: not ready (report prints the user-side start commands).
#
# Run from anywhere; paths are absolute. Reference: the pi-tmux-tmp-server skill.
set -u

TMP_DIR="${TMUX_TMPDIR_CHECK:-/tmp}"
SOCK_DIR="$TMP_DIR/tmux-$(id -u)"

echo "== tmux tmp server check =="
if ! command -v tmux >/dev/null 2>&1; then
  echo "FAIL: tmux not on PATH."
  exit 1
fi
echo "tmux: $(tmux -V 2>/dev/null || echo 'version unknown')"
echo "expected socket dir: $SOCK_DIR"

if TMUX_TMPDIR="$TMP_DIR" tmux ls >/dev/null 2>&1; then
  echo "OK: server connectable at $SOCK_DIR"
  TMUX_TMPDIR="$TMP_DIR" tmux ls 2>/dev/null
  exit 0
fi

echo "NOT-READY: no connectable tmux server at $SOCK_DIR"
if [ -e "$SOCK_DIR" ]; then
  echo "NOTE: a stale socket/dir exists at $SOCK_DIR — it blocks new servers"
  echo "      until removed (must be done outside the sandbox)."
fi
echo
echo "Ask the user to run these OUTSIDE the pi sandbox"
echo "(another terminal, or before enabling the sandbox):"
echo "  TMUX_TMPDIR=$TMP_DIR tmux kill-server 2>/dev/null || true"
echo "  rm -rf $SOCK_DIR"
echo "  TMUX_TMPDIR=$TMP_DIR tmux new-session -d -s host"
echo "Then ask via the ask_user tool whether to continue, and re-run this check."
exit 1
