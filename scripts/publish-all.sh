#!/usr/bin/env bash
# Local compatibility entry point. Versions are now validated, never rewritten.
# --dry-run is a pure registry plan; --pack builds/validates without uploading.
# Forced support-library publishing and arbitrary publish arguments are deliberately
# unsupported: publish sandbox-runtime separately after explicit review.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export NODE_USE_ENV_PROXY=1
exec node scripts/release.mjs --publish "$@"
