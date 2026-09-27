# AGENTS.md

This file is loaded automatically by AI coding agents that follow the AGENTS.md
convention (Claude Code, the Pi coding agent, and others) as project context. It
is a short orientation for assistants working in this repository; operational
detail lives in the sources of truth below.

## Sources of truth

| Document                                                                                         | Covers                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [`README.md`](./README.md)                                                                       | User-facing project overview, package list, install instructions   |
| [`.agents/skills/pi-plugin-maintainer/SKILL.md`](./.agents/skills/pi-plugin-maintainer/SKILL.md) | Creating, validating, naming, and packaging a `pi-*` plugin        |
| [`.agents/skills/pi-upstream-subtree/SKILL.md`](./.agents/skills/pi-upstream-subtree/SKILL.md)   | Importing and updating upstream-derived plugins, conflict handling |
| [`.agents/skills/pi-fork-divergence/SKILL.md`](./.agents/skills/pi-fork-divergence/SKILL.md)     | Mandatory conflict-minimization discipline for fork (二开) code    |
| [`subtrees/AGENTS.md`](./subtrees/AGENTS.md)                                                     | The upstream metadata contract and the direnv runtime helper       |

Read the relevant skill before making non-trivial changes.

## Architecture in one paragraph

A pnpm monorepo of independently installable Pi packages under `packages/pi-*`.
Each package owns its extension code, manifest, dependencies, and release
version; Pi core packages stay as peer dependencies so a package runs against
the host Pi installation. Plugins derived from external repositories are
imported with `git subtree` as squashed commits, and a repository-owned JSON
record in `subtrees/` preserves the upstream source, ref, exact commit, and
timestamp. On direnv load, one minimal helper (`env/ensure-upstreams.mjs`)
validates every record against the schema, ensures the `upstream-*` remotes
exist, and exports `PI_UPSTREAM_*` variables; it never fetches, merges,
commits, or pushes.

## Conventions you must follow

- Package directories and `package.json` names must be identical. Pi plugin
  packages match `pi-[a-z0-9][a-z0-9-]*` (npm name `@xzzpig/pi-*`); an
  upstream-derived support library that is not a Pi plugin may use the plain
  upstream name instead (e.g. `sandbox-runtime`, npm `@xzzpig/sandbox-runtime`).
- Pi core imports belong in `peerDependencies`, runtime libraries in
  `dependencies`, development-only types in `devDependencies`.
- One metadata record per imported subtree, validated against
  `schemas/subtree-metadata.schema.json`. Ref changes are an explicit skill
  workflow; never edit a record's `ref` and reload direnv to bypass it.
- Secondary development (二开) of an upstream-derived package MUST follow the
  `pi-fork-divergence` skill: fork logic in fork-only files with minimal
  upstream seams, byte-stable upstream files, fork-only tests and docs,
  current `subtrees/<name>.json` `reapplyOnSync` and `doNotReintroduce`
  entries, every accepted divergence declared in that record's `knownDebt`
  array, and a passing whitespace audit before any commit that touches an
  upstream file.
- Keep repository-specific metadata outside imported subtree prefixes.
- Do not commit credentials, generated environment state, or fake upstream
  records. Never silently overwrite an existing `upstream-*` remote.
- Never run `git push` unless the user explicitly asks for it. `git commit`
  also requires explicit authorization, except that an explicit request to add,
  pull, synchronize, or update an upstream subtree authorizes the local commits
  required by the `pi-upstream-subtree` workflow. That exception never
  authorizes a push, publication, unrelated commits, or a history rewrite.

## Verification

Run all commands from the repository root inside the direnv/Nix environment:

```bash
direnv allow
pnpm install --frozen-lockfile
pnpm --filter pi-permission-system run typecheck
pnpm --filter pi-permission-system test
pnpm exec prettier --check .

# Fork-divergence gate: every NOISE/DELETED finding in an upstream-derived
# package must be fixed or declared in subtrees/<name>.json `knownDebt`.
pnpm run audit:fork-divergence   # or: pnpm run verify (audit + prettier)
```

The subtree (`packages/pi-permission-system`) is excluded from the prettier
check via `.prettierignore` because its upstream code is formatted with biome,
not prettier.

`pnpm run audit:fork-divergence` is the fork-divergence gate: it must exit 0
before publishing (see the `pi-publish` skill's pre-publish gate) and before
committing a change that touches an upstream file.

`direnv reload` re-runs the metadata schema and ref validation and exports the
`PI_UPSTREAM_*` environment; address any failure it reports before committing.
