#!/usr/bin/env bash
#
# Fork-divergence audit for upstream-derived packages.
# See the pi-fork-divergence skill (SKILL.md) for the discipline this enforces.
#
# Compares every upstream file recorded in subtrees/<name>.json against the
# fork copy under packages/<name>, then reconciles the result with the
# record's `knownDebt` array:
#
#   NOISE / DELETED   divergence found on an upstream file
#   DECLARED          the finding matches a knownDebt entry of the same kind
#   UNDECLARED        the finding has no knownDebt entry (fails the audit)
#   STALE             a knownDebt entry for noise/deleted that matches nothing
#   SUBMODULE         an upstream gitlink; review by hand
#
# It also validates the record's maintenance-contract arrays (`reapplyOnSync`,
# `doNotReintroduce`): both must be non-empty when present, since an empty
# array records nothing and is better omitted.
#
# Usage (from anywhere inside the repository):
#   scripts/audit-fork-divergence.sh <name> [<name> ...]
#   scripts/audit-fork-divergence.sh --all
#   scripts/audit-fork-divergence.sh --inventory <name> [<name> ...]
#
# `--inventory` additionally derives and prints what the record must not
# store: the fork-only files under packages/<name> (absent from the upstream
# tree) and the upstream files the fork modified. Both come from the recorded
# `upstreamCommit` and the worktree, so they cannot go stale.
#
# Exit status: 0 = no UNDECLARED finding, 1 = UNDECLARED finding(s),
# 2 = usage or precondition error (missing record, unknown commit, missing jq,
# a noise/deleted knownDebt entry without a path, an empty reapplyOnSync /
# doNotReintroduce array, or a record that matches no upstream file at all).

set -uo pipefail

die() {
  printf 'audit-fork-divergence: %s\n' "$*" >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || die 'jq is required'
root=$(git rev-parse --show-toplevel 2>/dev/null) || die 'not inside a git worktree'
cd "$root" || die "cannot change directory to ${root}"

names=()
inventory=0
for arg in "$@"; do
  case "$arg" in
    --inventory) inventory=1 ;;
    *) names+=("$arg") ;;
  esac
done
if [ "${names[0]:-}" = '--all' ]; then
  names=()
  for record in subtrees/*.json; do
    [ -e "$record" ] || die 'no subtrees/*.json records found'
    names+=("$(basename "$record" .json)")
  done
fi
[ "${#names[@]}" -gt 0 ] ||
  die 'usage: audit-fork-divergence.sh [--inventory] <name> [<name> ...] | --all'

status=0
for name in "${names[@]}"; do
  record="subtrees/${name}.json"
  [ -f "$record" ] || die "missing record: ${record}"
  commit=$(jq -r '.upstreamCommit // empty' "$record") || die "invalid JSON: ${record}"
  prefix=$(jq -r '.prefix // empty' "$record") || die "invalid JSON: ${record}"
  base=$(jq -r '.upstreamPath // ""' "$record")
  [ -n "$commit" ] || die "no upstreamCommit in ${record}"
  [ -n "$prefix" ] || die "no prefix in ${record}"
  git cat-file -e "${commit}^{commit}" 2>/dev/null ||
    die "unknown commit ${commit} for ${name}; fetch the upstream remote first"

  # Declared debt: one "kind<TAB>path" row per entry. A noise/deleted entry
  # without a path would excuse every finding of that kind, so reject it.
  debt_tsv=$(jq -r '(.knownDebt // [])[] | [.kind, (.path // "")] | @tsv' "$record") ||
    die "invalid knownDebt in ${record}"
  debt_kind=()
  debt_path=()
  while IFS=$'\t' read -r kind path; do
    [ -n "$kind" ] || continue
    if [ -z "$path" ] && { [ "$kind" = 'noise' ] || [ "$kind" = 'deleted' ]; }; then
      die "knownDebt entry in ${record} with kind=${kind} requires a path"
    fi
    debt_kind+=("$kind")
    debt_path+=("$path")
  done <<<"$debt_tsv"
  matched=()
  for i in "${!debt_kind[@]}"; do matched[i]=0; done

  # Maintenance contract: an empty array records nothing, so require omission
  # instead of an empty list, and report the counts for review.
  for field in reapplyOnSync doNotReintroduce; do
    count=$(jq -r "(.${field} // []) | length" "$record") ||
      die "invalid ${field} in ${record}"
    if jq -e --arg f "$field" 'has($f) and (.[$f] | length == 0)' "$record" >/dev/null; then
      die "${record} has an empty ${field} array; omit the field instead"
    fi
    if [ "$field" = 'reapplyOnSync' ]; then reapply_count=$count; else do_not_count=$count; fi
  done

  # report_finding <kind> <path>: mark matching debt entries and report.
  # Mark every entry that matches, so overlapping patterns (a glob plus an
  # exact path) cannot make one of them look stale. The unquoted pattern is
  # intentional: knownDebt paths may be shell globs such as packages/x/**.
  report_finding() {
    local kind="$1" path="$2" i match_count=0
    for i in "${!debt_kind[@]}"; do
      [ "${debt_kind[$i]}" = "$kind" ] || continue
      # shellcheck disable=SC2254
      case "$path" in ${debt_path[$i]})
        matched[i]=1
        match_count=$((match_count + 1))
        ;;
      esac
    done
    if [ "$match_count" -gt 0 ]; then
      printf 'DECLARED %s %s\n' "$path" "$kind"
      declared=$((declared + 1))
    else
      printf 'UNDECLARED %s %s\n' "$path" "$kind"
      undeclared=$((undeclared + 1))
    fi
  }

  noise=0 deleted=0 submodule=0 checked=0 declared=0 undeclared=0 stale=0
  reapply_count=0 do_not_count=0
  up_paths=()
  up_shas=()
  local_paths=()
  modified_paths=()
  declare -A upstream_local=()

  # Pass 1: split upstream entries into submodules, deletions, and files that
  # still exist locally. Upstream blob ids come from one ls-tree call.
  while IFS= read -r -d '' entry; do
    sha=${entry%%$'\t'*}
    sha=${sha##* }
    up=${entry#*$'\t'}
    local_path="${prefix}/${up#"$base"/}"
    upstream_local["$local_path"]=1
    if [ -d "$local_path" ]; then
      printf 'SUBMODULE %s\n' "$local_path"
      submodule=$((submodule + 1))
      continue
    fi
    if [ ! -f "$local_path" ]; then
      printf 'DELETED %s\n' "$local_path"
      deleted=$((deleted + 1))
      report_finding deleted "$local_path"
      continue
    fi
    up_paths+=("$up")
    up_shas+=("$sha")
    local_paths+=("$local_path")
  done < <(git ls-tree -r -z "$commit" -- "${base:-.}")

  # Pass 2: hash every surviving local file in one call and skip the
  # byte-identical majority, so the per-file diff comparison (two git
  # processes) runs only for files the fork actually changed.
  local_hashes=()
  if [ "${#local_paths[@]}" -gt 0 ]; then
    mapfile -t local_hashes < <(printf '%s\n' "${local_paths[@]}" | git hash-object --stdin-paths)
  fi

  for i in "${!up_paths[@]}"; do
    up=${up_paths[$i]}
    local_path=${local_paths[$i]}
    checked=$((checked + 1))
    if [ "${local_hashes[$i]:-}" = "${up_shas[$i]}" ]; then continue; fi
    modified_paths+=("$local_path")
    raw=$(git diff --numstat "$commit:$up" -- "$local_path" | cut -f1,2)
    ws=$(git diff --numstat -w "$commit:$up" -- "$local_path" | cut -f1,2)
    if [ "$raw" != "$ws" ]; then
      printf 'NOISE   %s raw=[%s] ws=[%s]\n' "$local_path" "$raw" "$ws"
      noise=$((noise + 1))
      report_finding noise "$local_path"
    fi
  done

  for i in "${!debt_kind[@]}"; do
    case "${debt_kind[$i]}" in
      noise | deleted)
        if [ "${matched[$i]}" -eq 0 ]; then
          printf 'STALE %s %s\n' "${debt_path[$i]}" "${debt_kind[$i]}"
          stale=$((stale + 1))
        fi
        ;;
    esac
  done

  if [ "$inventory" -eq 1 ]; then
    printf 'INVENTORY %s\n' "$name"
    while IFS= read -r local_file; do
      [ -n "$local_file" ] || continue
      [ -n "${upstream_local[$local_file]:-}" ] && continue
      printf '  fork-only  %s\n' "$local_file"
    done < <(git ls-files --cached --others --exclude-standard -- "$prefix")
    for local_path in "${modified_paths[@]:-}"; do
      [ -n "$local_path" ] || continue
      printf '  modified   %s\n' "$local_path"
    done
    printf 'CONTRACT %s reapplyOnSync=%d doNotReintroduce=%d\n' \
      "$name" "$reapply_count" "$do_not_count"
  fi

  printf '%s: checked=%d noise=%d deleted=%d submodule=%d declared=%d undeclared=%d stale=%d\n' \
    "$name" "$checked" "$noise" "$deleted" "$submodule" "$declared" "$undeclared" "$stale"
  [ "$checked" -gt 0 ] || [ "$deleted" -gt 0 ] || [ "$submodule" -gt 0 ] ||
    die "${name}: matched no upstream file; fix the record or the recorded commit"
  [ "$undeclared" -eq 0 ] || status=1
done
exit "$status"
