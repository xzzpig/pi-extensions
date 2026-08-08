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
- Do **not** commit or push the version bump unless the user explicitly asks.
  Leave the changes unstaged or staged as the user prefers.
