---
name: pi-plugin-maintainer
description: Create, validate, type-check, format, and package pi-* plugin packages in this monorepo. Use when adding a plugin, changing its Pi manifest or extension code, enforcing naming, or preparing a package for publication.
compatibility: Requires the repository root, direnv/Nix environment, Node.js 24, and pnpm 11.
---

# Pi Plugin Maintainer

Maintain independently installable Pi packages under `packages/pi-*`. Keep
package names, directories, Pi manifests, dependencies, and release artifacts
consistent with the package contract.

## Establish the root

Run from the repository root. Prefer `PI_EXTENSIONS_ROOT` from the direnv
shell; otherwise resolve the Git root before changing files:

```bash
ROOT="${PI_EXTENSIONS_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"
direnv allow
```

Inspect the target package and nearby package conventions before making a
change. Keep unrelated packages and upstream subtrees untouched.

## Create a plugin

Create a new package directory manually. The directory must match
`pi-[a-z0-9][a-z0-9-]*`; the `package.json` `name` uses the repo-wide scoped
form `@xzzpig/pi-*` (directory and npm name intentionally differ).

```bash
mkdir -p packages/pi-my-plugin/extensions
```

Write `packages/pi-my-plugin/package.json`:

```json
{
  "name": "@xzzpig/pi-my-plugin",
  "version": "0.1.0",
  "description": "A pi extension package.",
  "license": "MIT",
  "type": "module",
  "keywords": ["pi-package", "pi-extension"],
  "files": ["extensions", "README.md", "package.json"],
  "pi": { "extensions": ["./extensions"] },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "catalog:",
    "@types/node": "catalog:",
    "typescript": "catalog:"
  }
}
```

Write `packages/pi-my-plugin/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["extensions/**/*.ts"] }
```

Write `packages/pi-my-plugin/extensions/index.ts` and export a default
function receiving `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
  pi.registerCommand("pi-my-plugin", {
    description: "Show that the plugin is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-my-plugin is loaded", "info");
    },
  });
}
```

Write a short `packages/pi-my-plugin/README.md`.

### Naming and manifest rules

- The directory name must start with `pi-` (`packages/pi-*`), and the
  `package.json` `name` must be the scoped `@xzzpig/pi-*` form — this
  monorepo publishes every package under the `@xzzpig` scope, so installs
  use `pi install npm:@xzzpig/<name>`.
- Upstream-derived (forked, 二开) packages follow the same rule: the fork's
  npm name is `@xzzpig/pi-*`, never the upstream's own package name. See the
  pi-upstream-subtree skill for the import/rename workflow.
- `pi.extensions` must list at least one entry pointing inside the package.
- Pi core packages imported by extension code must appear in
  `peerDependencies` (not `dependencies`).
- Runtime libraries belong in `dependencies`; development-only type packages
  belong in `devDependencies`.
- Follow Pi's package and extension contracts:
  [packages](https://github.com/earendil-works/pi-mono/blob/main/docs/packages.md)
  and [extensions](https://github.com/earendil-works/pi-mono/blob/main/docs/extensions.md).

## Validate a change

### Version consistency

For every package, `versions.json` MUST match the package's `package.json`
version. When a package maintains a package-local lockfile, its root package
version fields MUST match as well. Upstream-derived forks keep an independent
`@xzzpig/pi-*` version line; the upstream release version belongs in the
subtree metadata record and MUST NOT replace the fork version automatically.

When preparing a fork release after an upstream sync, follow the versioning
rules in the pi-upstream-subtree skill and add a changelog entry before running
validation.

```bash
pnpm install
pnpm --filter @xzzpig/pi-my-plugin run typecheck
pnpm exec prettier --check .
```

The runtime helper runs on every `direnv reload` and validates every active
subtree metadata record against the JSON schema along with naming and
prefix/remote consistency. Run `direnv reload` after any subtree metadata
change to confirm the helper accepts the state.

Exercise the extension without publishing it when a Pi CLI is available:

```bash
pi -e ./packages/pi-my-plugin/extensions/index.ts
```

For a package-level integration test:

```bash
pi install ./packages/pi-my-plugin
```

## Prepare a release

Inspect the packed contents before publishing:

```bash
mkdir -p artifacts
pnpm --filter @xzzpig/pi-my-plugin pack --pack-destination artifacts
tar -tf artifacts/xzzpig-pi-my-plugin-*.tgz
```

Confirm that the archive includes the declared extension resources and package
metadata, excludes local tests or secrets, and retains Pi core packages as
peers. Use the repository's chosen release tool when several public packages
need coordinated versions.

## Change discipline

This skill is the workflow — do not invoke skill scripts directly. Do not
create a package whose directory does not start with `pi-` or whose
`package.json` `name` is not `@xzzpig/pi-*`. Do not
edit upstream-derived files without following the upstream subtree skill. Do
not add credentials to package manifests, metadata, or packed artifacts.
