#!/usr/bin/env bash
#
# Publish every installable package in this monorepo to npm.
#
# The package list is discovered from packages/*/package.json — there is no
# hardcoded list to maintain as plugins are added. A package is a publish
# candidate when all of the following hold:
#
#   * it has a package.json and is not marked `"private": true`,
#   * its npm name matches @xzzpig/pi-*, or it is forced with --include,
#   * its directory is not listed in EXCLUDE_PACKAGES below.
#
# Candidates are published in dependency order (a package that others depend on
# through a `workspace:` range goes first), and any package whose exact local
# version is already on the registry is skipped — so re-running is safe.
#
# Registry lookups talk HTTP directly to the version-specific endpoint instead
# of shelling out to `npm view`. The packument endpoint is served through a CDN
# with `cache-control: public, max-age=300`, so `npm view` can answer from a
# stale snapshot taken *before* a publish and report a freshly published version
# as missing. The version endpoint is not cacheable, and every probe carries a
# cache-busting query plus `cache-control: no-cache`, so results reflect the
# registry's real state.
#
# The probes run with NODE_USE_ENV_PROXY=1 so that `fetch` honours HTTP_PROXY and
# HTTPS_PROXY (Node does not read them by default). Set HTTPS_PROXY when the
# registry is only reachable through a proxy, or when this host has no working
# IPv6 route: undici's address-family selection can stall on the AAAA records
# instead of falling back to IPv4, which makes a probe look like a hang.
#
# Usage:
#   bash scripts/publish-all.sh [options] [-- <extra pnpm publish args>]
#
# Options:
#   --registry <url>       Registry to publish to (default: https://registry.npmjs.org).
#   --only <a,b>           Publish only these package directory names.
#   --include <a,b>        Force-include packages ignored by default.
#   --no-sync-versions     Do not rewrite the root versions.json manifest.
#   --dry-run              Print the plan (registry state, pack size) and exit.
#   -h, --help             Show this help.
#
# Examples:
#   bash scripts/publish-all.sh
#   bash scripts/publish-all.sh --dry-run
#   bash scripts/publish-all.sh --only pi-notify,pi-btw
#   bash scripts/publish-all.sh --include sandbox-runtime
#   bash scripts/publish-all.sh -- --otp 123456
#
# Notes:
#   * Publishing needs an interactive terminal: npm asks for a 2FA one-time
#     password unless your token bypasses 2FA (an automation token does).
#   * `pi-components` is a private support library that consumers bundle; it is
#     never published. `sandbox-runtime` is bundled by pi-sandbox and is only
#     published when explicitly requested with --include sandbox-runtime.
#   * A package's own `prepublishOnly`/`prepack` hooks can still abort a publish;
#     those failures surface with the package's own error output.
#   * versions.json is updated for packages that were actually published.
#   * Nothing is committed or pushed by this script.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

# Package directory names that are never published by default. Add entries here
# when a new support library or private package appears; any of them can still
# be forced with `--include <dir>`.
EXCLUDE_PACKAGES=(pi-components sandbox-runtime)

# How long to keep asking the registry whether a publish landed, and how long to
# wait between attempts. The registry can take a few seconds to expose a new
# version, and a just-published version must never be reported as a failure.
VERIFY_ATTEMPTS=12
VERIFY_DELAY_SECONDS=5

REGISTRY="${PI_PUBLISH_REGISTRY:-https://registry.npmjs.org}"
ONLY=""
INCLUDE=""
DRY_RUN=0
SYNC_VERSIONS=1
PASSTHRU=()

usage() {
  cat <<'USAGE'
Publish every installable package in this monorepo to npm.

Usage:
  bash scripts/publish-all.sh [options] [-- <extra pnpm publish args>]

Options:
  --registry <url>       Registry to publish to (default: https://registry.npmjs.org).
  --only <a,b>           Publish only these package directory names.
  --include <a,b>        Force-include packages ignored by default.
  --no-sync-versions     Do not rewrite the root versions.json manifest.
  --dry-run              Print the plan (registry state, pack size) and exit.
  -h, --help             Show this help.

Examples:
  bash scripts/publish-all.sh
  bash scripts/publish-all.sh --dry-run
  bash scripts/publish-all.sh --only pi-notify,pi-btw
  bash scripts/publish-all.sh --include sandbox-runtime
  bash scripts/publish-all.sh -- --otp 123456

Publishing requires an interactive terminal unless your npm token bypasses 2FA.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --registry)
      REGISTRY="${2:?--registry needs a value}"
      shift 2
      ;;
    --only)
      ONLY="${2:?--only needs a value}"
      shift 2
      ;;
    --include)
      INCLUDE="${2:?--include needs a value}"
      shift 2
      ;;
    --no-sync-versions)
      SYNC_VERSIONS=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      PASSTHRU=("$@")
      break
      ;;
    *)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v node >/dev/null || {
  echo "error: node not found on PATH" >&2
  exit 1
}
command -v pnpm >/dev/null || {
  echo "error: pnpm not found on PATH" >&2
  exit 1
}

# Discover publish candidates in dependency order.
# Prints one TAB-separated "dir<TAB>name<TAB>version" record per line.
discover() {
  PUBLISH_ONLY="$ONLY" \
    PUBLISH_INCLUDE="$INCLUDE" \
    PUBLISH_EXCLUDE="$(IFS=,; echo "${EXCLUDE_PACKAGES[*]}")" \
    node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const pkgsDir = path.join(process.cwd(), 'packages');
const split = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const only = new Set(split(process.env.PUBLISH_ONLY));
const forced = new Set(split(process.env.PUBLISH_INCLUDE));
const excluded = new Set(split(process.env.PUBLISH_EXCLUDE));

const all = fs
  .readdirSync(pkgsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => fs.existsSync(path.join(pkgsDir, dir, 'package.json')))
  .map((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgsDir, dir, 'package.json'), 'utf8'));
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    const workspaceDeps = Object.entries(deps)
      .filter(([, range]) => String(range).startsWith('workspace:'))
      .map(([name]) => name);
    return {
      dir,
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
      workspaceDeps,
    };
  });

const candidates = all.filter((pkg) => {
  if (pkg.private) return false;
  if (only.size > 0 && !only.has(pkg.dir)) return false;
  // Support libraries outside the pi-* naming rule need an explicit --include.
  const isPiPackage = /^@xzzpig\/pi-/.test(pkg.name);
  if (!isPiPackage && !forced.has(pkg.dir)) return false;
  if (excluded.has(pkg.dir) && !forced.has(pkg.dir)) return false;
  return true;
});

// Topological order: dependencies before dependents.
const byDir = new Map(candidates.map((pkg) => [pkg.dir, pkg]));
const byName = new Map(all.map((pkg) => [pkg.name, pkg]));
const ordered = [];
const state = new Map(); // dir -> 'visiting' | 'done'

const visit = (pkg) => {
  const seen = state.get(pkg.dir);
  if (seen === 'done' || seen === 'visiting') return;
  state.set(pkg.dir, 'visiting');
  for (const depName of pkg.workspaceDeps) {
    const dep = byName.get(depName);
    if (dep && byDir.has(dep.dir)) visit(dep);
  }
  state.set(pkg.dir, 'done');
  ordered.push(pkg);
};

candidates.forEach(visit);

for (const pkg of ordered) {
  process.stdout.write(`${pkg.dir}\t${pkg.name}\t${pkg.version}\n`);
}
NODE
}

# Ask the registry whether a specific version exists, bypassing both npm's disk
# cache and the CDN's 300s packument cache. Retries because the registry can lag
# briefly behind a successful publish.
# Exit: 0 = published, 1 = not published, 2 = the registry could not be queried.
registry_probe_version() {
  NODE_USE_ENV_PROXY=1 node -e '
    (async () => {
      const [name, version, registry] = process.argv.slice(1);
      const base = registry.replace(/\/+$/, "");
      const url = `${base}/${encodeURIComponent(name)}/${encodeURIComponent(version)}?probe=${Date.now()}`;
      let detail = "no attempt made";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetch(url, {
            headers: { "cache-control": "no-cache", accept: "application/json" },
            signal: AbortSignal.timeout(15000),
          });
          if (response.status === 200) process.exit(0);
          if (response.status === 404) process.exit(1);
          detail = `HTTP ${response.status}`;
        } catch (error) {
          detail = error && error.message ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
      console.error(`registry probe failed for ${name}@${version}: ${detail}`);
      process.exit(2);
    })();
  ' "$1" "$2" "$REGISTRY"
}

# Print the registry's latest version for a package, or nothing when unknown.
registry_latest() {
  NODE_USE_ENV_PROXY=1 node -e '
    (async () => {
      const [name, registry] = process.argv.slice(1);
      const base = registry.replace(/\/+$/, "");
      const url = `${base}/${encodeURIComponent(name)}?probe=${Date.now()}`;
      try {
        const response = await fetch(url, {
          headers: { "cache-control": "no-cache", accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) process.exit(2);
        const body = await response.json();
        const tags = body["dist-tags"] || {};
        const versions = Object.keys(body.versions || {});
        const latest = tags.latest || versions[versions.length - 1] || "";
        if (latest) process.stdout.write(String(latest));
        process.exit(0);
      } catch (error) {
        process.exit(2);
      }
    })();
  ' "$1" "$REGISTRY" 2>/dev/null || true
}

# Confirm a version is on the registry, polling briefly for propagation.
# Exit: 0 = confirmed, 1 = not on the registry, 2 = could not be determined.
verify_published() {
  local name="$1" version="$2" attempt=1 status=0
  while [ "$attempt" -le "$VERIFY_ATTEMPTS" ]; do
    status=0
    registry_probe_version "$name" "$version" || status=$?
    case "$status" in
      0) return 0 ;;
      2) return 2 ;;
    esac
    attempt=$((attempt + 1))
    if [ "$attempt" -le "$VERIFY_ATTEMPTS" ]; then
      sleep "$VERIFY_DELAY_SECONDS"
    fi
  done
  return 1
}

mapfile -t CANDIDATES < <(discover)

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "error: no publish candidates found (check --only/--include and EXCLUDE_PACKAGES)" >&2
  exit 1
fi

echo "registry:    $REGISTRY"
echo "candidates:  ${#CANDIDATES[@]}"
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  echo "note:        working tree has uncommitted changes — they are included in the tarballs"
fi
if [ ! -t 0 ] && [ "${#PASSTHRU[@]}" -eq 0 ]; then
  echo "note:        stdin is not a TTY; npm 2FA prompts cannot be answered here."
  echo "             run this script from your own terminal, or use an automation token."
fi
echo

PUBLISHED=()
SKIPPED=()
UNVERIFIED=()
FAILED=()

for record in "${CANDIDATES[@]}"; do
  IFS=$'\t' read -r dir name version <<<"$record"
  tag="$name@$version"

  probe=0
  registry_probe_version "$name" "$version" || probe=$?
  if [ "$probe" -eq 0 ]; then
    latest="$(registry_latest "$name")"
    echo "skip    $tag (already on registry; latest=${latest:-unknown})"
    SKIPPED+=("$tag")
    continue
  fi

  latest="$(registry_latest "$name")"
  if [ "$DRY_RUN" -eq 1 ]; then
    size="$(
      cd "$ROOT/packages/$dir" &&
        npm pack --dry-run 2>&1 | grep -E 'package size|unpacked size' | tr '\n' ' ' || true
    )"
    echo "todo    $tag (registry latest=${latest:-none}) ${size}"
    PUBLISHED+=("$tag")
    continue
  fi

  echo "publish $tag (registry latest=${latest:-none})"
  if pnpm --filter "$name" publish --registry "$REGISTRY" --no-git-checks --access public \
    "${PASSTHRU[@]}"; then
    status=0
    verify_published "$name" "$version" || status=$?
    case "$status" in
      0)
        echo "ok      $tag"
        PUBLISHED+=("$tag")
        ;;
      2)
        echo "??      $tag: publish reported success, but the registry could not be queried"
        echo "        re-run this script later to confirm before releasing again"
        UNVERIFIED+=("$tag")
        ;;
      *)
        echo "!!      $tag: the registry does not show this version after publishing"
        echo "        (the publish command reported success — check the package's own hooks and the npm log)"
        FAILED+=("$tag")
        ;;
    esac
  else
    echo "!!      $tag: publish failed"
    FAILED+=("$tag")
  fi
  echo
done

if [ "$DRY_RUN" -eq 0 ] && [ "$SYNC_VERSIONS" -eq 1 ] && [ "${#PUBLISHED[@]}" -gt 0 ]; then
  for record in "${CANDIDATES[@]}"; do
    IFS=$'\t' read -r dir name version <<<"$record"
    entry="$name@$version"
    found=0
    for published in "${PUBLISHED[@]}"; do
      [ "$published" = "$entry" ] && found=1
    done
    [ "$found" -eq 1 ] || continue
    node -e "
      const fs = require('node:fs');
      const [file, dir, version] = process.argv.slice(1);
      const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      // Preserve the file's existing key order; new packages append at the end.
      manifest[dir] = version;
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\\n');
    " "$ROOT/versions.json" "$dir" "$version"
  done
  echo "versions.json updated for published packages (not committed)."
  echo
fi

print_list() {
  if [ "$#" -gt 0 ]; then
    printf '  %s\n' "$@"
  else
    echo "  (none)"
  fi
}

echo "================= summary ================="
echo "published:  ${#PUBLISHED[@]}"
print_list "${PUBLISHED[@]}"
echo "skipped:    ${#SKIPPED[@]} (already on the registry)"
print_list "${SKIPPED[@]}"
if [ "${#UNVERIFIED[@]}" -gt 0 ]; then
  echo "unverified: ${#UNVERIFIED[@]} (published, but the registry could not be reached)"
  print_list "${UNVERIFIED[@]}"
fi
echo "failed:     ${#FAILED[@]}"
print_list "${FAILED[@]}"

[ "${#FAILED[@]}" -eq 0 ]
