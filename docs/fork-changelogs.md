# Fork release history contract

## Two histories, two version sequences

For each subtree-derived Pi plugin:

- Keep upstream changelogs at their original paths and exact recorded upstream bytes. Do not rename them or append fork releases. If upstream provides no changelog, do not manufacture one.
- Maintain `FORK-CHANGELOG.md` for the independently versioned `@xzzpig/pi-*` distribution. Set `pi.changelogPath` to `./FORK-CHANGELOG.md`; never rely on Pi's default `CHANGELOG.md` discovery for forks.
- Ship both histories when upstream has one. Include navigation from the README and fork log; link the upstream source when no upstream log exists.
- Keep support libraries without `pi.extensions` out of Pi startup-log configuration. Repository-owned non-fork plugins can keep their ordinary CHANGELOG convention.

Pi selects every parsed version newer than its saved package version, even if a heading exceeds the installed package version. Mixed upstream/fork histories therefore repeat forever. Hiding or collapsing notices, inflating fork versions, and editing local last-seen state are not repairs.

## Write a fork release

Use `## [x.y.z] - YYYY-MM-DD` (the date is optional for migrated history). Keep formal releases unique and strictly descending; include the current package version and no future release headings. Only fork versions receive level-two version headings. Use an optional, single `## [Unreleased]` before formal releases for genuinely unpublished work.

Describe the installed distribution's complete user-visible upgrade, not just local code patches. Include sections only when applicable:

```markdown
## [0.2.0] - YYYY-MM-DD

### Upstream sync

- Move the upstream baseline from v2.3.0 to v2.4.0; summarize relevant fixes.
- Link the exact upstream source commit (`https://github.com/OWNER/REPO/tree/<40-character-SHA>`), with the recorded sync metadata as evidence; optionally link release notes/comparisons as well.

### Fork changes

- Describe fork-specific changes and compatibility adaptations.

### Upgrade notes

- Explain changed settings or breaking behavior.
```

Record historical upstream baselines only when supported by Git/release evidence. A link to the **current** subtree baseline must be labelled current, not presented as the baseline of every previous release. Avoid copying entire upstream histories into the fork file.

## Migrate and synchronize

1. Cross-check all subtree records against package manifests; classify plugins versus support libraries.
2. Recover fork entries from the existing files and Git history. Preserve text and known dates; do not invent missing history. Explicitly label undated/unversioned historical notes rather than making them Unreleased.
3. Restore upstream log bytes from `upstreamCommit` plus `upstreamPath`, or preserve them if already exact. This is a targeted fork-divergence cleanup, not an upstream synchronization or baseline change.
4. Configure the manifest, files allowlist and any compiled staging script to publish the fork log and original upstream logs.
5. Update sync replay rules for the manifest/navigation seam; remove obsolete instructions to prepend fork entries to upstream history. Declare accepted upstream-file seams following the fork-divergence skill; fork-only files do not need ritual replay entries.
6. On subsequent subtree updates retain this routing, summarize adopted upstream changes under the next fork release, and preserve independent fork versioning.

Do not change published npm versions in place. A repository-only correction does not repair already installed tarballs. Version preparation, publication and local installation require their own authorization.

## Release gates and evidence

Run `pnpm run audit:fork-changelogs` and `pnpm run test:release`. The existing release CLI runs source checks before registry planning, including already-published versions; its pack function checks the actual tarball after prepack/manifest conversion. Both upload and pack use that same path.

Source checks require the explicit fork route, a safe regular in-package file, valid ordered unique fork headings, a current-version entry, no future headings, unchanged upstream log bytes, immutable source links for explicit upstream-sync/import notes, and no references to a nonexistent Unreleased entry. Archive checks require identical source/packed routing and exact fork/upstream log contents. A missing upstream Git baseline is a failure, not proof that no upstream changelog exists.

Regression evidence must include real Pi changelog parsing: an already-seen current version produces no notices; upgrading from the previous recorded release selects the current fork entry and not upstream versions; saving the current version eliminates the next notice; first discovery records without showing history. Also test malformed, missing, escaped/symlinked paths and tarball omissions. Do not touch user Pi state for these checks.

## Migration inventory

The following snapshot comes from the recorded upstream Git objects and pre-migration repository logs. All plugins route to `FORK-CHANGELOG.md`; counts are preserved formal fork entries, not upstream entries. No package versions were changed.

| Package              | Fork version | Upstream log treatment       | Fork entries |
| -------------------- | ------------ | ---------------------------- | ------------ |
| pi-btw               | 0.11.2       | CHANGELOG.md（恢复上游基线） | 13           |
| pi-context-cap       | 0.1.4        | 上游无日志；原 fork 日志迁出 | 4            |
| pi-goal-x            | 0.12.4       | CHANGELOG.md（恢复上游基线） | 29           |
| pi-permission-system | 1.8.1        | CHANGELOG.md（恢复上游基线） | 18           |
| pi-sandbox           | 0.9.3        | 上游无日志；原 fork 日志迁出 | 16           |
| pi-starline          | 0.11.2       | CHANGELOG.md（恢复上游基线） | 18           |
| pi-subagents         | 0.25.1       | CHANGELOG.md（恢复上游基线） | 24           |
| pi-tidy              | 0.1.4        | CHANGELOG.md（恢复上游基线） | 5            |
| pi-tool-display      | 0.3.2        | CHANGELOG.md（恢复上游基线） | 5            |
| pi-vibeguard         | 0.2.3        | CHANGELOG.md（恢复上游基线） | 5            |
| sandbox-runtime      | 0.1.3        | 支持库，不配置 Pi 日志       | —            |

### Migration provenance

Historical fork entries were taken from repository commit `49ccf05e5135153bb7c3cb4e47e408b84cd38374`, at each package's previous CHANGELOG.md and existing FORK-CHANGELOG.md. Upstream logs were restored from each subtree record's exact upstreamCommit/upstreamPath (not from remote HEAD). Original release text and dates were retained; reordered headings fix existing out-of-order versions. pi-subagents' unversioned “Previous fork changes” remain explicitly undated historical notes. pi-goal-x's fork baseline-capture prose previously misfiled under upstream 0.31.2 is preserved as non-release historical text, not silently discarded or assigned a fabricated fork version.
