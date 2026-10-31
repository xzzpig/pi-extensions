---
name: pi-publish
description: Prepare versions, validate tarballs, and publish pi-* packages through the repository GitHub Actions OIDC workflow. Use when preparing a release, updating versions.json, or publishing packages from this monorepo.
compatibility: Requires the repository root, direnv/Nix environment, Node.js 24, pnpm 11, and GitHub/npm Trusted Publisher configuration for CI publishing.
---

# Pi Package Publish

The default release path is **manual version preparation → push main → GitHub
Actions → npm Trusted Publishing (OIDC)**. Read the repository's
`docs/automatic-publishing.md` for configuration and recovery instructions.
Resolve that path from the repository root, not this skill directory.

## Authorization and boundaries

- Preparing files does not authorize a commit, push, account configuration or
  actual npm publish. Obtain explicit user authorization for those operations.
- Never store credentials, generated npm config or long-lived tokens in Git.
- Never publish an unverified package or use a dry-run as proof of an npm release.
- Never change another workspace's local Pi settings or goals while releasing.
- Upstream-derived files require the
  [fork-divergence discipline](../pi-fork-divergence/SKILL.md).

## Prepare a release

1. Enter the repository's direnv/Nix shell and inspect the worktree.
2. Finish and archive OpenSpec changes before release; verify merged specs and
   run `openspec validate --all`. Never archive incomplete work merely to pass
   a release gate. The automated gate conservatively blocks **any** active
   change until package scope is machine-readable; it never archives for you.
3. Run `pnpm run audit:fork-divergence`. UNDECLARED findings or missing baseline
   objects block release. Fix divergence or declare genuinely accepted debt in
   subtree records; remove stale entries. Do not waive audit failures.
4. Choose independent fork versions manually, update relevant package manifests
   and CHANGELOGs, and edit the corresponding entries in root `versions.json`
   **without replacing other entries**. Keep any package-local lock root versions
   consistent using its owning tool, never hand-edit upstream lockfiles.
5. Check public workspace dependencies: the required version must be on npm or
   included in this release. Bundled support packages remain bundled; private
   pi-components and sandbox-runtime are not automatic publication candidates.
6. Validate with the commands below. Fix failures before requesting a push.

## Local verification (no upload)

```bash
pnpm install --frozen-lockfile
pnpm run test:release
pnpm exec prettier --check .
pnpm run publish:check
pnpm run publish:pack --only pi-notify
# Check/build/pack every public plugin, even already-published versions:
node scripts/release.mjs --pack --check-all
```

`publish:check` only queries registry state and writes a JSON plan; it does not
run build hooks. `publish:pack` additionally performs release gates and builds
and validates tarballs, but never uploads. Both target registry.npmjs.org by
default. Files under `artifacts/release` are local evidence, not source changes.
Builds may require Bun for sandbox-runtime's tests; CI installs it explicitly.

The packer runs each package's own prepack/postpack, checks extension/export/bin
and type entries, bundled dependencies, workspace conversion, forbidden paths,
secrets and tests. Do not assume every plugin publishes src/ or dist/public.d.ts:
pi-subagents publishes compiled dist-pkg, while other packages publish TS source.
All candidate packages are checked and packed before any upload, and the exact
validated archives are published using npm CLI without rerunning lifecycle hooks.

## CI publishing

The workflow is `.github/workflows/publish.yml`. It is default-off: repository
variable `NPM_AUTO_PUBLISH` must be `true`. First review the complete dry-run
plan and configure each npm package's Trusted Publisher with GitHub owner
`xzzpig`, repository `pi-extensions`, workflow filename `publish.yml`.
Do not configure a reusable workflow's name or use npm whoami as an OIDC probe.
No environment is configured by default; if adding one, match it on npm too.
Enable `Allow npm publish` in the Trusted Publisher settings; stage-only access
cannot run this workflow's direct publish command. Each package needs its own
first successful real publish within the configuration's initial two-day window;
dry-runs and skipped existing versions do not validate its publisher.

After explicit push authorization, pushing main starts validation and publishing.
There is no interactive OTP or local npm login requirement for this CI path.
Use workflow_dispatch with dry_run=true for validation, or dry_run=false plus
an optional comma-separated only list for authorized recovery. The repository
variable must still be enabled for a manual real publish.

Only stable, strictly increasing new versions are published. Exact existing
versions are skipped. The scripts validate versions.json, never rewrite it or
commit/push it. CI uses minimal permissions and serializes releases without
cancelling an upload in progress.

## Failures and verification

npm multi-package releases cannot be atomic. Pre-upload registry query errors
and npm publish command failures fail the run. Once npm publish succeeds, the
upload is accepted even if npm is still processing it. A single best-effort
post-upload lookup checks SHA-512 integrity when metadata is visible; a missing
version or query exception only warns, without polling or blocking later uploads.
An observed integrity mismatch remains fatal. Success logs explicitly distinguish
registry-verified uploads from confirmation-pending uploads. Preserve logs and
investigate failures; a rerun skips existing exact versions and retries missing
ones. Do not republish or bump a version solely because confirmation is pending.
Never fix a failed run by overwriting a published version: npm versions are
immutable. Prepare a new version if the published artifact itself is wrong.

`pnpm run publish:all` remains an explicit **real local upload** entry point.
It uses the same gates and verified tarballs and needs local npm authentication;
it is not a dry-run and requires separate authorization. Arbitrary passthrough
publish arguments and --include sandbox-runtime are intentionally unsupported.
Support-library publication is a separate, explicitly reviewed operation.
