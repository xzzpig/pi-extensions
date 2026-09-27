---
name: pi-publish
description: Publish a pi-* package to npm with version bump, build (dist/*.d.ts), pack verification, and registry sync. Use when preparing a release, updating the version manifest, or publishing a package from this monorepo.
compatibility: Requires the repository root, direnv/Nix environment, Node.js 24, pnpm 11, and npm login credentials for the target registry.
---

# Pi Package Publish

Publish a `pi-*` package from this monorepo to npm. The workflow handles
version bump, **versions.json** manifest sync, type declaration build, pack
verification, and publish.

## Prerequisites

- Repository root with `direnv allow` loaded.
- Clean working tree (or at least the package to be published has no staged
  changes that should not be included).
- **npm login** — the target registry must be authenticated. This repo's
  default registry is the npmmirror mirror; the publish step explicitly
  targets `https://registry.npmjs.org`:

  ```bash
  # Check login status
  npm whoami --registry https://registry.npmjs.org

  # Login if needed (interactive; you may need to configure an access token)
  npm login --registry https://registry.npmjs.org
  ```

  Credentials and tokens are handled by `~/.npmrc`; never commit them.

- **No active OpenSpec change covering the packages being released** — the
  delta of an unarchived change is applied to no main spec, so archiving it is
  part of the release preparation (see the gate below).

## Pre-publish gate: fork divergence

Every package published from this repository is a 二开 fork, so an undeclared
divergence would ship as unreviewed conflict surface. Run the audit before
bumping any version and stop if it fails:

```bash
pnpm run audit:fork-divergence   # whole repository
# or scope it to the packages being released:
bash .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh <name> [<name> ...]
```

The gate is the audit's exit status: `0` = every finding is declared, `1` =
an `UNDECLARED` finding, `2` = a precondition failure (missing record, unknown
`upstreamCommit`, missing `jq`, or a `noise`/`deleted` entry without `path`).

- `UNDECLARED` — fix the divergence (restore upstream bytes, or move the fork
  logic into a fork-only file) or declare it in the package's
  `subtrees/<name>.json` `knownDebt` array with a real reason. Do not publish
  while one remains.
- `STALE` — the divergence is gone; delete the entry before publishing.
- `DECLARED` — accepted divergence, recorded in the record. It does not block.

The audit's rules and the discipline it enforces live in the
[pi-fork-divergence skill](../pi-fork-divergence/SKILL.md).

## Pre-publish gate: OpenSpec change archived

A release ships behavior, and this repository records that behavior in
OpenSpec. A change still sitting in `openspec/changes/` has its delta applied
to no main spec, so publishing it ships behavior the spec tree does not
describe. Before bumping any version, list the active changes and archive
every one that covers a package being released:

```bash
openspec list                    # active changes with task progress
openspec show <change>           # scope: which packages the change touches
openspec archive <change> --yes  # apply the delta to the main spec, then move the change to archive/
openspec validate --all          # must pass after every archive
```

The gate is `openspec list` reporting no active change that covers the
released package(s). Leaving one active is acceptable only when the release is
unrelated to it; say so in the release notes.

- **Tasks complete** — `openspec archive` warns about unchecked tasks and
  `--yes` proceeds anyway. Do not use that to skip work: finish the tasks, or
  state why they no longer apply.
- **The delta carries the whole requirement** — a `MODIFIED` requirement
  replaces that block in the main spec, so the delta must repeat every scenario
  that should survive. The CLI refuses to drop them and `openspec validate`
  names the missing ones (see the 组织约定 in `openspec/config.yaml`).
- **Verify the merge** — after archiving, the capability must read as synced:
  added requirements present, modified ones carrying their scenarios, removed
  ones gone.
- **Independent of the fork gate** — archiving a change does not touch
  `subtrees/<name>.json`, and the fork-divergence audit does not read specs.
  Run both before publishing.

## Workflow

### 1. Update the package version

Set the new version in `packages/<name>/package.json`:

```bash
# Example: bump to 0.2.0
pnpm --filter @xzzpig/<name> version 0.2.0
```

Edit the file manually when the version line is independent of a tag.

### 2. Sync the version manifest

Update `versions.json` in the repository root:

```bash
# Read current version and write to versions.json
echo "{\"<name>\": \"$(pnpm --filter @xzzpig/<name> exec node -p 'require("./package.json").version')\"}" > versions.json
```

Or edit the file directly. The manifest maps package directory names to
their current npm versions.

### 3. Build type declarations

The package must have a `build:types` script (usually `rollup -c rollup.dts.config.mjs`)
that produces `dist/public.d.ts`:

```bash
pnpm --filter @xzzpig/<name> run build:types
```

Verify the output exists:

```bash
ls -la packages/<name>/dist/public.d.ts
```

### 4. Verify the pack contents

```bash
pnpm --filter @xzzpig/<name> pack --pack-destination /tmp/ 2>&1
tar -tf /tmp/$(node -p "require('./packages/<name>/package.json').name.replace('@','').replace('/','-')")-*.tgz | head -30
```

Confirm the tarball contains:

- `package/dist/public.d.ts` — type declarations
- `package/src/` — source (runtime entry)
- `package/schemas/`, `package/docs/`, `package/README.md`
- No `test/` files, no `.env` or credentials, no `.git/`

### 5. Publish to npm

```bash
npm publish --registry https://registry.npmjs.org /tmp/$(node -p "require('./packages/<name>/package.json').name.replace('@','').replace('/','-')")-*.tgz
```

Or publish directly from the package (pnpm publish runs `prepack` first):

```bash
pnpm --filter @xzzpig/<name> publish --registry https://registry.npmjs.org
```

To release every package that has a newer local version than the registry (the
usual case for a multi-package release), use the repo script instead — it
auto-discovers packages under `packages/`, skips versions already on npm,
publishes in `workspace:` dependency order, and syncs `versions.json`:

```bash
pnpm run publish:check   # dry run: show the plan
pnpm run publish:all     # publish (needs an interactive TTY for 2FA)
```

The underlying script also accepts flags, e.g.
`pnpm run publish:all --only pi-notify,pi-btw` or
`pnpm run publish:all --include sandbox-runtime` (use `--` before `--otp`).

### 6. Verify the published version

```bash
npm view @xzzpig/<name> version --registry https://registry.npmjs.org
```

## Notes

- This repo uses `pnpm`; `npm publish` is not used directly except for the
  `--registry` override. Use `pnpm publish` from the package filter.
- The `publishConfig.access` in `package.json` is set to `"public"` for
  scoped packages (`@xzzpig/*`).
- After publishing, consider updating the nixos-config `settings.packages`
  entry to pin the new version (`npm:@xzzpig/<name>@<version>`).
- Always verify the tarball contents before publishing — a missing `dist/`
  or `src/` entry will break consumers.
- Run the fork-divergence audit (`pnpm run audit:fork-divergence`) before
  publishing; an `UNDECLARED` finding blocks the release until it is fixed or
  declared in `knownDebt`.
- Archive the OpenSpec change that covers the released package before
  publishing (`openspec archive <change> --yes`), so the release and
  `openspec/specs/` describe the same behavior; `openspec list` must show no
  active change for it.
- Do **not** commit or push the version bump unless the user explicitly asks.
  Leave the changes unstaged or staged as the user prefers.
