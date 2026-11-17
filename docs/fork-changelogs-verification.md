# Fork changelog migration verification

## Scope and results

The [contract and per-package inventory](./fork-changelogs.md) cover all 10 subtree-derived Pi plugins. `sandbox-runtime` is a support library and was not given Pi startup-log settings. No package version, `versions.json`, lockfile, user Pi configuration or installed plugin was changed. No repository commit, push or npm publication was performed.

| Fork plugin          | Source log contract    | Actual packed logs       | Real Pi startup-log regression |
| -------------------- | ---------------------- | ------------------------ | ------------------------------ |
| pi-btw               | PASS                   | PASS                     | PASS                           |
| pi-context-cap       | PASS (no upstream log) | PASS                     | PASS                           |
| pi-goal-x            | PASS                   | PASS                     | PASS                           |
| pi-permission-system | PASS                   | PASS                     | PASS                           |
| pi-sandbox           | PASS (no upstream log) | PASS                     | PASS                           |
| pi-starline          | PASS                   | PASS                     | PASS                           |
| pi-subagents         | PASS                   | PASS (compiled dist-pkg) | PASS                           |
| pi-tidy              | PASS                   | PASS                     | PASS                           |
| pi-tool-display      | PASS                   | PASS                     | PASS                           |
| pi-vibeguard         | PASS                   | PASS                     | PASS                           |

Upstream logs in eight plugins match their recorded upstream Git objects. The other two plugins have no upstream changelog at that baseline; their old fork-only CHANGELOG.md files were migrated, not presented as upstream history. Historical entries were sorted without changing version numbers. Undated pi-subagents notes and a misfiled pi-goal-x historical note are explicitly preserved without fabricated release assignments.

## Commands and observed evidence

- `pnpm install --frozen-lockfile`: passed.
- `pnpm run test:release`: **48/48 passed**, including 14 changelog tests and the existing release/startup-harness tests. Default changelog compatibility tests use the repository's Pi 1.5.0 SDK.
- `PI_CHANGELOG_RUNTIME=<host Pi 1.5.2 package root> node --test scripts/fork-changelogs.test.mjs`: **14/14 passed**. Tests directly invoke the real Pi parser and `InteractiveMode.prototype.getExtensionChangelogUpdates`, with in-memory last-seen settings and real migrated files. All ten packages cover initial discovery, previous-release upgrade, next launch with the saved current version, extension deduplication and resumed-session suppression. This is not a live TUI recording or a claim that the locally installed plugins were updated.
- Exported `pack()` from `scripts/release.mjs` was called for each of the ten fork manifests, using separate temporary artifact directories. This runs the package's actual pnpm pack/prepack path and the existing archive/manifest checks plus the new exact changelog-content checks. All ten archives passed. The compiled pi-subagents prepack includes the new static document; final pi-goal-x was repacked after historical-note preservation.
- Final verification reopened all ten archives, compared packed Pi routing and fork/upstream log bytes against current sources, and confirmed every package version equals its pre-change Git version: **10/10 passed**. Artifact identities, paths and SHA-512 integrity values are recorded in `artifacts/fork-changelogs/artifacts.json`; build and final comparison logs are in that directory.
- `pnpm run publish:check`: passed through the existing dry-run CLI and source changelog gate; registry plan reported `Pending (0): none`. This did not upload, prepare a new version or run full package test suites for already-published versions.
- `pnpm run verify`: passed fork-divergence audit, packaging identity audit, new changelog audit and whole-repository Prettier check. All eleven subtree records report `undeclared=0` and `stale=0`, with nonzero checked counts. Existing accepted divergences remain declared.
- `direnv reload` and `direnv exec . true`: passed metadata/ref environment validation.
- `git diff --check`: passed.

Ignored local evidence is under `artifacts/fork-changelogs/`: `pack.log`, `final-pack-check.log`, `artifacts.json`, `host-test.log`, `release-tests.log`, `publish-check.log`, `verify.log` and `direnv.log`. The exported pack function can be reused to reproduce the archive checks without uploading or increasing versions.

## Diagnostics and boundaries

Active LSP/auxiliary probes were run on the changed release/checker JavaScript. They found no new blocking errors; the push-only JavaScript LSP does not confirm a clean verdict for silent files, so executable tests and actual pack checks are the validation evidence. The release CLI retains its pre-existing configurable registry default URL warning. `packages/pi-subagents/scripts/build-package.mjs` retains its pre-existing manifest-export `typeof` lint finding, already declared as `[baseline]` in subtree knownDebt; the only build-script change is adding FORK-CHANGELOG.md to staticFiles. The finding was explicitly deferred for this session, not hidden with an upstream inline suppression.

Full plugin behavioral suites and live interactive TUI startup were not run for this documentation/packaging repair; no runtime plugin behavior was changed. The existing normal release workflow continues to run package gates and tarball startup E2E before real publication. The new source gate runs before registry planning (after ensuring recorded upstream objects exist), and every release CLI archive passes the new packed-log gate before it can be uploaded.

The repository-only goal is satisfied by these source and artifact changes. Existing installed npm packages on this machine still contain their old metadata. A separately authorized version preparation, publication and installation is needed for the user's normal startup to receive this fix.

Additional package-local check: `pnpm --filter @xzzpig/pi-context-cap run verify` passed TypeScript checking, upstream verification and **29 fork cases, 0 failures**. After removing its obsolete deleted-log allowlist entry, pi-context-cap was repacked and its final archive identity replaced in the artifact ledger. Final `test:release` (48/48) and `verify` were rerun successfully.

## Audit follow-up: historical provenance and navigation

The first completion audit correctly found incomplete per-release upstream links and obsolete Starline Unreleased references. Historical sync/import sections now carry immutable upstream source links with the corresponding historical subtree metadata commit as evidence. Where only a release-history entry was verified, the link explicitly says it is release-history evidence, not an independently verified historical checkout. Sandbox runtime provenance uses its own support-library record rather than the sandbox plugin version. Sources were derived from first-parent Git history; no upstream tags, commit IDs or dates were guessed. Starline references now point to the actual 0.11.0 convergence entry (and explicit 0.6.0/0.7.0 anchors). The source/tarball validator and regression tests also reject explicit sync/import entries without immutable sources and dangling references to a nonexistent Unreleased entry. Final tests are 48/48 release tests and 14/14 host-Pi compatibility tests. All ten tarballs were rebuilt and verified again after these documentation changes.
