# Subtree Metadata

Each active JSON file in this directory describes one upstream-derived Pi
package. The metadata is repository-owned and stays outside the imported
subtree prefix so upstream files do not need local-only records.

The schema is [`schemas/subtree-metadata.schema.json`](../schemas/subtree-metadata.schema.json).
The non-example fields are:

| Field              | Meaning                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`             | Local record/directory name, unscoped `^[a-z0-9][a-z0-9-]*$`; `pi-*` for plugins, plain upstream-derived name for support libraries (see below). |
| `prefix`           | Local subtree path, exactly `packages/<name>`.                                                                                                   |
| `upstreamPath`     | Optional relative directory inside a monorepo source.                                                                                            |
| `source`           | Upstream Git source used by the local remote.                                                                                                    |
| `remote`           | Local remote, exactly `upstream-<name>`.                                                                                                         |
| `ref`              | Branch, tag, or commit-ish used for synchronization.                                                                                             |
| `version`          | Optional human-readable release/tag label.                                                                                                       |
| `upstreamCommit`   | Exact 40-character commit recorded at synchronization.                                                                                           |
| `squash`           | Whether subtree history is synchronized with squash commits.                                                                                     |
| `lastSyncedAt`     | ISO timestamp for the local record.                                                                                                              |
| `notes`            | Optional short summary of the fork; the maintenance lists live in the two arrays below (see below).                                              |
| `reapplyOnSync`    | Optional array of adaptations a sync must re-apply by hand (see below).                                                                          |
| `doNotReintroduce` | Optional array of decisions never to re-introduce (see below).                                                                                   |
| `knownDebt`        | Optional array of accepted, declared divergences (see below).                                                                                    |

[`template.json.example`](template.json.example) shows the shape without
pretending that an upstream repository has been imported.

### Maintenance contract (`notes`, `reapplyOnSync`, `doNotReintroduce`)

The maintenance contract is split across three fields, and each part belongs
where it can be checked or re-derived:

| Field              | Holds                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `notes`            | A short summary: what the fork is, and where its behavior contract lives (`openspec/`).       |
| `reapplyOnSync`    | One entry per adaptation a sync must re-apply by hand.                                        |
| `doNotReintroduce` | One entry per decision never to re-introduce (a dropped divergence, a deliberate non-change). |

Keep all three current on **every** fork change — not only on syncs — so the
next synchronization (or agent) can distinguish a necessary adaptation from a
droppable difference without archaeology.

Do not record what another source already holds:

- the dated sync narrative — the record's own git history has it
  (`git log -p subtrees/<name>.json`);
- "file X is byte-identical to upstream" claims, and the seam / fork-only
  module inventory — `bash .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory <name>`
  derives both from the recorded `upstreamCommit` and the worktree, so a stored
  copy could only go stale;
- capability intent — what the fork's behavior must be is specified in
  `openspec/` (a spec under `openspec/specs/` or a change under
  `openspec/changes/`), and `notes` may point at it;
- known failing-test baselines — those belong in `knownDebt`.

The conflict-minimization rules the contract should reflect are defined in the
[Pi Fork Divergence skill](../.agents/skills/pi-fork-divergence/SKILL.md)
(mandatory for all 二开 work), whose commands are driven by the
[Pi Upstream Subtree skill](../.agents/skills/pi-upstream-subtree/SKILL.md).

### Known debt (`knownDebt`)

`knownDebt` is the machine-readable half of the record: one array entry per
divergence that is deliberately accepted rather than fixed. `notes` describes
what the fork does; `knownDebt` declares what the fork tolerates, so tooling
can tell an accepted divergence from a regression. Each entry is an object:

| Key          | Required | Meaning                                                                     |
| ------------ | -------- | --------------------------------------------------------------------------- |
| `kind`       | yes      | One of `noise`, `deleted`, `lint`, `test`, `other`.                         |
| `reason`     | yes      | Why the divergence is accepted, and what would have to change to remove it. |
| `path`       | per kind | Repo-relative path or shell glob (`packages/x/**`) the debt applies to.     |
| `recordedAt` | no       | ISO date-time the debt was recorded or last re-confirmed.                   |

`kind` meanings:

- `noise` — a line the audit counts as changed that `git diff -w` does not:
  either whitespace-only divergence on an upstream file, or a diff-alignment
  artifact where a fork-added line is a whitespace twin of an upstream line
  (repeated `}`, `});` closers). Requires `path`.
- `deleted` — an upstream file the fork removed. Requires `path`.
- `lint` / `test` / `other` — upstream-original lint findings, known failing
  tests with their baseline, or any other accepted non-change. `path` is
  optional; omit it for debt that spans the whole package.

The schema validates `kind` and `reason` and rejects unknown keys; the
[`audit-fork-divergence.sh`](../.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh)
script additionally requires `path` on `noise` and `deleted` entries, and
reports an undeclared `NOISE`/`DELETED` finding as `UNDECLARED` and exits
non-zero. Never declare debt to silence the audit: record it only after
deciding that the divergence must stay, and delete the entry when the
divergence disappears (a stale `noise`/`deleted` entry is reported as
`STALE`).

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

Use the [Pi Upstream Subtree skill](../.agents/skills/pi-upstream-subtree/SKILL.md) for
all add, pull, record, split, push, and conflict-resolution workflows.
