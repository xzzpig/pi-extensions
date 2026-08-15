---
name: pi-upstream-subtree
description: Add and maintain Pi plugins derived from upstream repositories with git subtree, structured metadata, conflict handling, and auditable synchronization. Use when importing, updating, splitting, or pushing an upstream-derived pi-* package.
compatibility: Requires a clean Git worktree, direnv/Nix environment, Node.js 24, pnpm 11, and git-subtree.
---

# Pi Upstream Subtree

Manage upstream-derived packages under `packages/pi-*` without hiding the
source ref or synchronization commit. The JSON record in `subtrees/` is the
source of truth consumed by the direnv runtime helper; the helper validates
records against the schema, enforces ref consistency, and exports
`PI_UPSTREAM_*` variables. All synchronization is performed by the explicit
git commands below.

## Tracking and commit invariants

Synchronize upstream content only with `git subtree`:

- First import: `git subtree add --prefix="packages/<name>" --squash <remote> <commit>`.
- Existing subtree: `git subtree pull --prefix="packages/<name>" --squash <remote> <commit>`.

Never replace the subtree prefix through `git archive`, ordinary `git merge`,
`cp`, `rsync`, extraction, generated patches, or a manual file replacement.
Those approaches can reproduce the files while losing the squash parent and
`git-subtree-dir` / `git-subtree-split` trailers required for future pulls. If
`git subtree` cannot complete safely, stop and resolve that blocker rather than
falling back to a file-copy update.

An explicit user request to add, import, pull, synchronize, or update an
upstream subtree authorizes the local commits required by this workflow. That
includes the `git subtree` commit and an immediately following fork or metadata
commit when necessary. It does not authorize push, publication, unrelated
commits, or history rewrites.

## Establish the root and inspect state

```bash
ROOT="${PI_EXTENSIONS_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"
direnv allow
git status --short --branch
```

`add`, `pull`, `record`, `split`, and `push` require a clean worktree. Do not
fold unrelated changes into a subtree synchronization; stop or handle them
under separate authorization before running the workflow.

## Metadata contract

Store one JSON record at `subtrees/<plugin-name>.json`. The shape is defined
in [`schemas/subtree-metadata.schema.json`](../../../schemas/subtree-metadata.schema.json)
and documented in [`subtrees/AGENTS.md`](../../../subtrees/AGENTS.md). A valid
record must contain:

- `name`: local record/directory name matching `pi-[a-z0-9][a-z0-9-]*` (unscoped). This is subtree bookkeeping only — NOT the published npm name (see "Forked package npm naming").
- `prefix`: exactly `packages/<name>`.
- `upstreamPath` (optional): relative directory inside a monorepo source. Omit it when the plugin is the source repository root.
- `source`: upstream Git source.
- `remote`: exactly `upstream-<name>`.
- `ref`: branch, tag, or commit-ish.
- `upstreamCommit`: 40-character commit recorded at synchronization.
- `squash`: `true`.
- `lastSyncedAt`: ISO timestamp.

Do not put credentials in `source`. Copy
`subtrees/template.json.example` only as a shape reference; do not commit it as
an active record.

### Helper behavior on load

When direnv loads the project, `env/ensure-upstreams.mjs` validates every
active record against the schema, ensures the `upstream-*` remote exists with
the recorded URL, records the accepted ref in `remote.<name>.pi-ref`, and
refuses an unreviewed ref change. A direct `ref` edit in the JSON without a
corresponding `pull --ref` produces a failure on the next `direnv reload`.
After adding or changing a record, run:

```bash
direnv reload
```

## Forked package npm naming (二开包命名)

Every package imported from upstream is a locally forked (二开) package. It
keeps the unscoped `pi-*` name for the directory, subtree prefix, and metadata
record, but the npm package name in `package.json` MUST be the scoped
`@xzzpig/pi-*` form:

| Where                     | Format          | Example                    |
| ------------------------- | --------------- | -------------------------- |
| Directory / prefix        | `packages/pi-*` | `packages/pi-tool-display` |
| Metadata `name`           | `pi-*`          | `pi-tool-display`          |
| npm `package.json` `name` | `@xzzpig/pi-*`  | `@xzzpig/pi-tool-display`  |

This makes every forked package installable as `pi install npm:@xzzpig/pi-*`,
keeps the local fork clearly distinguishable from the upstream package on npm,
and matches the repo-wide convention in `README.md`. Upstream ships its own
name (e.g. `@gotgenes/pi-permission-system`); the fork MUST NOT keep it.
Rename the npm name in a separate commit immediately after the import, before
any further local changes:

```bash
# name=pi-tool-display → npm name @xzzpig/pi-tool-display
jq --arg n "@xzzpig/${name}" '.name = $n' "packages/${name}/package.json" \
  > "packages/${name}/package.json.tmp" && \
  mv "packages/${name}/package.json.tmp" "packages/${name}/package.json"
# Fix README and code references to the upstream name, then:
git add "packages/${name}"
git commit -m "chore: rename ${name} npm package to @xzzpig/${name}"
```

Keep the scope OUT of `subtrees/*.json` records: the schema validates `name`
against the unscoped `pi-*` pattern and rejects `@xzzpig/pi-*` there.

## Add an upstream plugin

The following sequence creates the remote, imports the subtree, and writes the
metadata record. Replace variables with the actual plugin name, source, ref,
and optional version label.

```bash
# Set variables once.
name=pi-upstream-plugin
source=https://github.com/example/pi-upstream-plugin.git
ref=main
version=v1.2.3

# Validate naming.
echo "$name" | grep -qE '^pi-[a-z0-9][a-z0-9-]*$' || exit 1

# Create remote, fetch, and import.
git remote add "upstream-${name}" "$source"
git fetch "upstream-${name}" "$ref"
commit=$(git rev-parse FETCH_HEAD)
git subtree add --prefix="packages/${name}" --squash "upstream-${name}" "$commit"
test "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-dir: packages/${name}"
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-split: ${commit}"

# Record accepted ref.
git config --local "remote.upstream-${name}.pi-ref" "$ref"

# Write metadata record.
cat > "subtrees/${name}.json" <<EOF
{
  "\$schema": "../schemas/subtree-metadata.schema.json",
  "name": "${name}",
  "prefix": "packages/${name}",
  "source": "${source}",
  "remote": "upstream-${name}",
  "ref": "${ref}",
  "version": ${version:+"\"${version}\""}${version:-null},
  "upstreamCommit": "${commit}",
  "squash": true,
  "lastSyncedAt": "$(date -Iseconds)"
}
EOF

# Record metadata in a follow-up local commit after the tracked subtree merge.
git add "subtrees/${name}.json"
git commit -m "chore: add ${name} upstream subtree"
```

After the import, rename the npm package to `@xzzpig/<name>` in a separate
commit (see "Forked package npm naming" above) and adapt the Pi manifest in
the same commit when the upstream layout is not already a valid package.
Confirm the helper accepts the record:

```bash
direnv reload
```

## Pull upstream changes

### Upstream subdirectory

When a plugin lives below the root of a monorepo, set `upstreamPath` in its
metadata. `upstreamCommit` MUST remain the exact commit from `source`; never
replace it with the derived split commit. The split commit belongs only in the
`git-subtree-split` trailer and makes the local prefix synchronizable.

For each update, use this sequence before the regular record update:

1. Fetch the tag or branch through the metadata remote and save its root commit.
2. In a clean local mirror of `source`, create a split branch for
   `upstreamPath` at that root commit. Do not run `git subtree split` against
   the local fork, because it would include local divergence.
3. Fetch that split branch through a separate local transport remote, then use
   `git subtree pull --squash` from the split branch into the local `prefix`.
   The metadata `remote` remains the source remote, never the local split
   transport.
4. Verify the split tree equals `<upstreamCommit>:<upstreamPath>`, verify the
   squash trailer names the split commit, and update metadata with the root
   commit, `upstreamPath`, ref, version, and timestamp.

```bash
name=pi-upstream-plugin
ref=v1.2.3
upstream_path=packages/pi-upstream-plugin
source_mirror=/absolute/path/to/clean/upstream-mirror
split_remote=local-pi-upstream-plugin-split

git fetch "upstream-${name}" "$ref"
upstream_commit=$(git rev-parse FETCH_HEAD)

# The mirror's origin must be the same source as the metadata record.
git -C "$source_mirror" fetch origin "$ref"
test "$(git -C "$source_mirror" rev-parse FETCH_HEAD)" = "$upstream_commit"
split_branch="split-${name}-${upstream_commit:0:12}"
git -C "$source_mirror" subtree split \
  --prefix="$upstream_path" \
  --branch="$split_branch" \
  "$upstream_commit"
split_commit=$(git -C "$source_mirror" rev-parse "$split_branch")
test "$(git -C "$source_mirror" rev-parse "${split_commit}^{tree}")" = \
  "$(git -C "$source_mirror" rev-parse "${upstream_commit}:${upstream_path}")"

# A local transport remote is only a carrier for the derived split branch.
if git remote get-url "$split_remote" >/dev/null 2>&1; then
  test "$(git remote get-url "$split_remote")" = "$source_mirror"
else
  git remote add "$split_remote" "$source_mirror"
fi
git fetch "$split_remote" "$split_branch"
git subtree pull --prefix="packages/${name}" --squash "$split_remote" "$split_branch"
test "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-dir: packages/${name}"
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-split: ${split_commit}"
```

Then write `upstreamPath: "$upstream_path"` and `upstreamCommit:
"$upstream_commit"` into the record. For a ref change, set
`remote.upstream-${name}.pi-ref` to the new ref before `direnv reload`.

### Same ref

```bash
name=pi-upstream-plugin
ref=main  # same as record
git fetch "upstream-${name}" "$ref"
commit=$(git rev-parse FETCH_HEAD)
```

If `$commit` equals the current `upstreamCommit` in the record, the subtree
is already synchronized. Otherwise, pull through `git subtree` and verify that
its squash parent preserves tracking trailers before making later commits:

```bash
git subtree pull --prefix="packages/${name}" --squash "upstream-${name}" "$commit"
test "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-dir: packages/${name}"
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-split: ${commit}"
```

Then update the record:

```bash
version=v1.2.4  # optional
jq --arg c "$commit" --arg v "$version" --arg t "$(date -Iseconds)" \
  '.upstreamCommit = $c | .version = $v | .lastSyncedAt = $t' \
  "subtrees/${name}.json" > "subtrees/${name}.json.tmp" &&
  mv "subtrees/${name}.json.tmp" "subtrees/${name}.json"
git add "subtrees/${name}.json"
git commit -m "chore: update ${name} subtree"
```

### Fork package versioning

`subtrees/<name>.json` records the upstream release version, while
`packages/<name>/package.json` and root `versions.json` record the independent
`@xzzpig/<name>` fork release. Never copy the upstream package's `version` into
the fork manifest automatically.

After every upstream sync, compare the old and new upstream release:

- An upstream major or minor release with user-visible changes increments the
  fork's minor version and resets its patch component (`0.x` forks use the
  minor component for breaking upstream changes).
- An upstream patch-only release increments the fork's patch version.
- Update `package.json`, `versions.json`, and any package-local lockfile
  version fields together, then add a local changelog entry.

### Ref change (explicit override)

Do not edit `ref` in the JSON and reload direnv; the helper rejects it. To
switch to a different ref:

```bash
new_ref=develop
git fetch "upstream-${name}" "$new_ref"
commit=$(git rev-parse FETCH_HEAD)
git subtree pull --prefix="packages/${name}" --squash "upstream-${name}" "$commit"
test "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-dir: packages/${name}"
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-split: ${commit}"
git config --local "remote.upstream-${name}.pi-ref" "$new_ref"
```

Then update the JSON record: set `ref` to the new value, `upstreamCommit` to
the new commit, and `lastSyncedAt` to the current timestamp. Commit the result.

### Conflict resolution

1. Let the subtree pull stop; do not delete or regenerate the metadata.
2. Resolve conflicts under `packages/<name>` while preserving the local
   `@xzzpig/pi-*` npm name and the `pi-*` package contract (never adopt the
   upstream's own package name). Do not replace the subtree with copied files.
3. Complete the subtree merge and verify its squash-parent trailers before
   making later fork or metadata commits.
4. Record the exact resolved upstream commit:

```bash
git fetch "upstream-${name}" "$ref"
tip=$(git rev-parse FETCH_HEAD)
git merge-base --is-ancestor <resolved-commit> "$tip"  # must succeed
```

Update the JSON record with the resolved commit and optional version. Verify
with `direnv reload` and type-check the target package.

## Split and push

Produce a subtree commit for review or contribution to upstream:

```bash
git subtree split --prefix="packages/${name}"
```

After reviewing the split output, push to a target branch:

```bash
git subtree push --prefix="packages/${name}" "upstream-${name}" main
```

Treat `push` as an explicit publishing action. The direnv helper never
invokes it.

## Verification

For every upstream change:

```bash
git status --short --branch
# npm name must be the scoped fork name, e.g. @xzzpig/pi-tool-display
jq -e --arg n "@xzzpig/${name}" '.name == $n' "packages/${name}/package.json"
pnpm --filter "@xzzpig/${name}" run typecheck 2>/dev/null || true
pnpm exec prettier --check .
direnv reload
```

For a successful `git subtree pull`, verify its second parent before adding
later commits:

```bash
git show -s --format='%P%n%B' HEAD
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-dir: packages/${name}"
git show -s --format=%B HEAD^2 | grep -Fx "git-subtree-split: ${commit}"
```

Use an isolated local upstream repository to test new workflow behavior. Cover
first add, repeated direnv initialization, upstream updates, conflict
resolution, ref change tracking, trailer preservation, and schema enforcement.
