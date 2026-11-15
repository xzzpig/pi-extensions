# Fork notes (sandbox-runtime)

Fork-only notes for `@xzzpig/sandbox-runtime`. This file is not part of the imported
upstream subtree prefix.

## `tsconfig.test.json` is not a gate

Upstream ships `tsconfig.test.json` (a test-wide `tsc --noEmit` config). Nothing in this
repository invokes it — not `package.json` scripts, not the monorepo gate, not CI — and the
package's own source typecheck (`npm run typecheck`, `tsconfig.json`) passes.

Running it manually currently reports **67 type errors confined to `test/**`**, all
pre-existing in the imported upstream tree:

```bash
cd packages/sandbox-runtime && npx tsc -p tsconfig.test.json --noEmit
```

Decision: keep the file byte-identical to upstream and document it as a manual diagnostic.
Do not add it to a gate until the upstream test typings are reconciled; if upstream removes
the file (or fixes the test types), delete the `knownDebt` entry in
`subtrees/sandbox-runtime.json` together with this section.
