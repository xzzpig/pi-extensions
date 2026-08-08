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

## Establish the root and inspect state

```bash
ROOT="${PI_EXTENSIONS_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"
direnv allow
git status --short --branch
```

`add`, `pull`, `record`, `split`, and `push` require a clean worktree. Resolve
or commit unrelated changes before invoking them.

## Metadata contract

Store one JSON record at `subtrees/<plugin-name>.json`. The shape is defined
in [`schemas/subtree-metadata.schema.json`](../../../schemas/subtree-metadata.schema.json)
and documented in [`subtrees/AGENTS.md`](../../../subtrees/AGENTS.md). A valid
record must contain:

- `name`: package name matching `pi-[a-z0-9][a-z0-9-]*`.
- `prefix`: exactly `packages/<name>`.
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

# Commit metadata and subtree together.
git add "subtrees/${name}.json"
git commit -m "chore: add ${name} upstream subtree"
```

After the import, adapt the local `package.json` and Pi manifest in a separate
commit when the upstream layout is not already a valid `pi-*` package.
Confirm the helper accepts the record:

```bash
direnv reload
```

## Pull upstream changes

### Same ref

```bash
name=pi-upstream-plugin
ref=main  # same as record
git fetch "upstream-${name}" "$ref"
commit=$(git rev-parse FETCH_HEAD)
```

If `$commit` equals the current `upstreamCommit` in the record, the subtree
is already synchronized. Otherwise:

```bash
git subtree pull --prefix="packages/${name}" --squash "upstream-${name}" "$commit"
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

### Ref change (explicit override)

Do not edit `ref` in the JSON and reload direnv; the helper rejects it. To
switch to a different ref:

```bash
new_ref=develop
git fetch "upstream-${name}" "$new_ref"
commit=$(git rev-parse FETCH_HEAD)
git subtree pull --prefix="packages/${name}" --squash "upstream-${name}" "$commit"
git config --local "remote.upstream-${name}.pi-ref" "$new_ref"
```

Then update the JSON record: set `ref` to the new value, `upstreamCommit` to
the new commit, and `lastSyncedAt` to the current timestamp. Commit the result.

### Conflict resolution

1. Let the subtree pull stop; do not delete or regenerate the metadata.
2. Resolve conflicts under `packages/<name>` while preserving the local
   `pi-*` package contract.
3. Commit the resolved subtree merge.
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
pnpm --filter "${name}" run typecheck 2>/dev/null || true
pnpm exec prettier --check .
direnv reload
```

Use an isolated local upstream repository to test new workflow behavior. Cover
first add, repeated direnv initialization, upstream updates, conflict
resolution, ref change tracking, and schema enforcement.
