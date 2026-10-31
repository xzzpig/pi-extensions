#!/usr/bin/env bash
# Ensure immutable upstream objects needed by the audit exist in a fresh checkout.
# Does not add remotes or merge anything; audit remains the authority afterward.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for record in subtrees/*.json; do
  commit="$(jq -er '.upstreamCommit' "$record")"
  source="$(jq -er '.source' "$record")"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit in $record" >&2; exit 1; }
  [[ "$source" == https://github.com/* ]] || { echo "Unexpected upstream source: $source" >&2; exit 1; }
  if ! git cat-file -e "${commit}^{commit}" 2>/dev/null; then
    git -c protocol.file.allow=never fetch --no-tags --no-write-fetch-head "$source" "$commit"
  fi
  git cat-file -e "${commit}^{commit}"
done
