#!/usr/bin/env bash
# Opt-in setup for disposable GitHub-hosted Linux runners ONLY.
# Never sourced or invoked by local release commands.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux ]]; then
  echo 'CI sandbox setup requires a GitHub-hosted Linux runner; refusing kernel changes.' >&2
  exit 1
fi

# Match sandbox-runtime's upstream Linux integration-test prerequisites.
# An absent kernel knob is allowed, but a failed change is not silently ignored.
for setting in \
  kernel.apparmor_restrict_unprivileged_userns=0 \
  kernel.unprivileged_userns_clone=1; do
  key="${setting%=*}"
  expected="${setting#*=}"
  if sysctl -n "$key" >/dev/null 2>&1; then
    sudo -n sysctl -w "$setting"
    [[ "$(sysctl -n "$key")" == "$expected" ]] || {
      echo "Kernel setting did not take effect: $setting" >&2
      exit 1
    }
  else
    echo "Kernel setting not exposed: $key; relying on namespace preflight."
  fi
done

# Exercise actual network/loopback setup and nested namespaces, not just unshare.
echo 'Checking bubblewrap user, PID and network namespaces (including nesting)...'
if ! bwrap --die-with-parent --ro-bind / / --unshare-user --unshare-pid \
  --unshare-net --proc /proc \
  bwrap --die-with-parent --ro-bind / / --unshare-user --unshare-pid \
  --unshare-net --proc /proc true; then
  echo 'Bubblewrap namespace preflight failed; OS sandbox tests cannot run on this runner.' >&2
  exit 1
fi
echo 'Bubblewrap namespace preflight passed.'
