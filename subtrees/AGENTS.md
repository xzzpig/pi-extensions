# Subtree Metadata

Each active JSON file in this directory describes one upstream-derived Pi
package. The metadata is repository-owned and stays outside the imported
subtree prefix so upstream files do not need local-only records.

The schema is [`schemas/subtree-metadata.schema.json`](../schemas/subtree-metadata.schema.json).
The non-example fields are:

| Field            | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `name`           | Local record/directory name, unscoped `pi-*` (see below).    |
| `prefix`         | Local subtree path, exactly `packages/<name>`.               |
| `upstreamPath`   | Optional relative directory inside a monorepo source.        |
| `source`         | Upstream Git source used by the local remote.                |
| `remote`         | Local remote, exactly `upstream-<name>`.                     |
| `ref`            | Branch, tag, or commit-ish used for synchronization.         |
| `version`        | Optional human-readable release/tag label.                   |
| `upstreamCommit` | Exact 40-character commit recorded at synchronization.       |
| `squash`         | Whether subtree history is synchronized with squash commits. |
| `lastSyncedAt`   | ISO timestamp for the local record.                          |

[`template.json.example`](template.json.example) shows the shape without
pretending that an upstream repository has been imported.

The metadata's `upstreamCommit` always identifies a commit in `source`. When
`upstreamPath` is set, its subtree trailer records a derived split commit; use
both values to reproduce the imported source directory at that exact upstream
revision.

### Tracking invariant

The JSON record alone does not preserve a synchronizable subtree history. Import
an upstream package only with `git subtree add --squash`; update one only with
`git subtree pull --squash`. Do not substitute an archive extraction, file copy,
`rsync`, patch application, or ordinary `git merge`: those approaches may match
the files but omit the squash parent and `git-subtree-dir` /
`git-subtree-split` trailers required for later pulls.

### Forked package naming

Every upstream-derived package is a local fork (二开) and publishes its npm
name as `@xzzpig/pi-*` while the directory, subtree prefix, and record `name`
stay unscoped `pi-*` (e.g. directory `packages/pi-tool-display`, npm name
`@xzzpig/pi-tool-display`). These two names intentionally differ; do not
write the `@xzzpig` scope into `subtrees/*.json`.

When direnv loads the project, `env/ensure-upstreams.mjs` executes the shared
schema loader and validates all active records before adding any missing
remotes. It refuses to overwrite an existing remote whose URL differs from
`source`, stores the accepted ref in the local-only
`remote.<name>.pi-ref` Git config key, and rejects a direct metadata ref change.
Use the explicit ref override in the upstream skill to review and accept a ref
change. The helper exports metadata-derived `PI_UPSTREAM_*` variables and does
not fetch, merge, commit, or push.

Use the [Pi Upstream Subtree skill](../.pi/skills/pi-upstream-subtree/SKILL.md) for
all add, pull, record, split, push, and conflict-resolution workflows.
