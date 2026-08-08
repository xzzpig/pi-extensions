# Subtree Metadata

Each active JSON file in this directory describes one upstream-derived Pi
package. The metadata is repository-owned and stays outside the imported
subtree prefix so upstream files do not need local-only records.

The schema is [`schemas/subtree-metadata.schema.json`](../schemas/subtree-metadata.schema.json).
The non-example fields are:

| Field            | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `name`           | Local `pi-*` package and record name.                        |
| `prefix`         | Local subtree path, exactly `packages/<name>`.               |
| `source`         | Upstream Git source used by the local remote.                |
| `remote`         | Local remote, exactly `upstream-<name>`.                     |
| `ref`            | Branch, tag, or commit-ish used for synchronization.         |
| `version`        | Optional human-readable release/tag label.                   |
| `upstreamCommit` | Exact 40-character commit recorded at synchronization.       |
| `squash`         | Whether subtree history is synchronized with squash commits. |
| `lastSyncedAt`   | ISO timestamp for the local record.                          |

[`template.json.example`](template.json.example) shows the shape without
pretending that an upstream repository has been imported.

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
