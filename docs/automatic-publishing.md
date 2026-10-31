# Automatic npm publishing

## Design contract

Versions and CHANGELOGs remain manually maintained. `versions.json` must match
package manifests before release; CI never writes versions or pushes commits.
Discovery includes public `@xzzpig/pi-*` packages, excluding `pi-components` and
`sandbox-runtime`. Exact versions already on npm are skipped. New releases must
be stable and newer than every stable version in the registry. Network and
permission failures are errors, not evidence that a version is absent.

Release phases are plan → gates → pack all → validate all → publish in dependency
order → verify. The exact validated tarballs are uploaded; npm does not rebuild
packages at publish time. pnpm pack retains package-specific prepack/postpack and
publishConfig.directory handling, including subagents' dist-pkg and sandbox's
bundled runtime. Private support dependencies are built and tested but never
published. Bundled workspace dependencies need not be separately on npm.

PR jobs have no OIDC permission. Only the trusted main release job receives
id-token: write. Runs are serialized and a running release is not cancelled.
GitHub-hosted Ubuntu, pinned Node/pnpm/npm versions and SHA-pinned Actions are
used. The workflow does not create tags, Releases or commits.

The publish workflow defaults to dry-run until repository variable
`NPM_AUTO_PUBLISH` is exactly `true`. Review a complete dry-run plan before
setting it. Manual dispatch can restrict package directory names and defaults
to dry-run. No npm uploads are performed during repository implementation.

Release gates include frozen root-lock installation, version and repository
metadata consistency, workspace dependency availability, relevant package checks,
fork-divergence audit and archive checks. Until changes have machine-readable
package scope, any unarchived OpenSpec change blocks release conservatively;
CI never archives a change itself. Exact upstream commits needed by the fork
audit must be available or fetched from the recorded sources, never silently
skipped. Package-specific runtime tests requiring models/interactive TUI remain
separate from unattended unit checks.

Multi-package npm publishing is not atomic. A failed upload or failed registry
verification stops the release. Re-run after investigation: existing exact
versions are skipped, missing versions are retried. An already-published package
cannot be overwritten or rolled back by this workflow.

## One-time setup and rollout

1. Review and merge the workflow with `NPM_AUTO_PUBLISH` unset. Main pushes
   initially validate/pack only. Review the entire pending list in the Actions
   summary and `artifacts/release/plan.json`; this includes **all** unpublished
   local versions, not only the latest commit's changes. Remove unintended
   release preparation before enabling uploads.
2. For each public npm plugin, open Settings → Trusted Publisher and configure
   owner `xzzpig`, repository `pi-extensions`, workflow **filename** `publish.yml`.
   Do not use the display name or ci.yml. No GitHub Environment is configured;
   leave that field empty. If adding one later, match it exactly on npm.
   Enable direct publishing (`Allow npm publish`); stage-only permission is not
   sufficient for this workflow.
3. Confirm the package's repository URL identifies this repository. Upstream
   provenance is retained in subtree records/homepages, not repository.url.
4. Configure publishers only when ready to test: the current npm service requires
   first successful publish of each newly created publisher within two days.
   A dry-run, an existing-version skip or another package's successful upload
   does not validate that package's configuration. Configure packages when their
   next real release is ready; there is no need to bump every package just to
   validate all publishers at once. If expired,
   delete/recreate the configuration. If a new npm package cannot yet be configured,
   its first publication needs a separately authorized authenticated bootstrap;
   do not invent a permanent token fallback or claim OIDC was tested.
5. After reviewing the dry-run and intended package versions, set the repository
   Actions variable `NPM_AUTO_PUBLISH=true`. This enables future **main pushes**.
   For a controlled first release, dispatch publish.yml on main with dry_run=false
   and only set to a single reviewed plugin. Do not push main between enabling the
   variable and that controlled first dispatch unless ready to release all pending
   versions. Disable the variable again if not ready for broad automation.
6. Inspect successful upload and registry integrity verification. GitHub-hosted
   runners and npm CLI >=11.5.1 are required by the current npm OIDC service.
   Public-repository/public-package OIDC releases generate provenance automatically.
   No NPM_TOKEN, NODE_AUTH_TOKEN or local npm login is needed for CI publication.
   Do not use npm whoami to test OIDC; it does not validate trusted publishing.
7. Protect main and review workflow/script modifications. Fork PR checks use
   pull_request, not pull_request_target, with read-only permissions. Optional
   environment approvals can be added later, but would require matching npm
   Trusted Publisher settings and change the unattended release experience.

GitHub Actions CI itself and actual OIDC exchange cannot be verified by a local
pack. They require pushing the workflow and a separately authorized real upload.
This implementation never configures external accounts automatically.

## Daily release preparation

- Finish relevant specs and archive active changes; do not let CI archive work.
- Update package.json, CHANGELOG and the package's versions.json entry together.
  Update package-local lock root versions with the appropriate package tool if
  applicable. Fork versions remain independent of upstream version tags.
- Check dependency versions too: workspace:\* becomes an exact current version.
  Changing a dependency without bumping/releasing its consumer does not update an
  already-published consumer. Choose consumer version bumps explicitly.
- Run `pnpm run test:release`, `pnpm run publish:check` and
  `pnpm run publish:pack --only pi-notify` (substitute intended packages).
- Commit/push only with operator authorization. An enabled main workflow discovers
  pending versions, runs gates, packs all, uploads in order and verifies integrity.
- No version change means no new version is published. Existing versions are not
  compared byte-for-byte to the working tree and cannot be overwritten.

## Commands and outputs

```bash
pnpm run publish:check                         # plan only; no build or upload
pnpm run publish:pack --only pi-notify          # gates + pack; no upload
node scripts/release.mjs --pack --check-all    # verify every public plugin
pnpm run test:release                          # isolated release regression tests
# Real local upload; separate explicit authorization + local npm auth required:
# pnpm run publish:all --only pi-notify
```

Run commands inside the repository direnv/Nix environment. Bun is additionally
needed for sandbox-runtime tests; on NixOS use `direnv exec . nix-shell -p bun
ripgrep bubblewrap socat python3 --run 'node scripts/release.mjs --pack --check-all'`.
CI installs a pinned Bun and the OS test dependencies explicitly. jq and tar are
required; Ubuntu runners supply them.

`artifacts/release/plan.json` records the registry, pending packages and skipped
versions. `artifacts.json` records the verified archive paths, entry counts and
SHA-512 integrity values; each package is packed into a fresh directory. CI
prints its plan and checksums to the run summary. Local artifact paths are not
persistent downloads from GitHub: to inspect archive contents, reproduce the
pack at the same commit. The workflow currently does not upload build artifacts.
Never commit generated archives or authentication state.

## Recovery and maintenance

- Keep NPM_AUTO_PUBLISH unset/false to disable future uploads. It does not cancel
  a running upload; do not interrupt ongoing publication merely to change policy.
- Re-run a failed main workflow, or dispatch it on main with dry_run=false and
  only set to affected package directory names. Authentication/registry failures
  are hard errors, not evidence a package is absent.
- If package A published and B failed, a rerun skips A and retries B. If registry
  verification was uncertain, inspect npm first. New successful uploads are
  checked against their validated tarball integrity.
- If an existing npm version has bad contents, prepare a **new** version. Do not
  delete/reuse the same version or silently move latest backward.
- All active OpenSpec changes currently block packing/release conservatively.
  Finish and archive them rather than bypassing checks. A future scope index
  could allow unrelated changes without weakening the release rule.
- For a missing fork-audit baseline, release-upstreams.sh fetches its exact commit
  from the source recorded in subtrees/\*.json, without adding remotes or merging.
  A failed fetch fails the gate. Keep maintenance metadata current after syncs.
- Audit Action SHA updates and update pinned Node/pnpm/npm/Bun deliberately.
  Existing local wrapper options --include and arbitrary publish passthrough
  arguments are no longer accepted; default support-library publication remains
  out of scope. --no-sync-versions is accepted as a compatibility no-op because
  the script now validates rather than rewrites versions.json.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
and the repository's `.agents/skills/pi-publish/SKILL.md`.
