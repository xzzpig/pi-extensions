---
name: pi-fork-divergence
description: Mandatory conflict-minimization discipline (二开分歧纪律) for fork edits inside upstream-derived pi-* packages. This skill must be loaded and followed before writing, adapting, or reviewing any fork code under a subtree prefix, and re-applied after every upstream sync.
compatibility: Requires the repository root with direnv loaded, plus git, bash, and jq; pairs with the pi-upstream-subtree skill, which owns import, pull, metadata, and synchronization commands.
---

# Pi Fork Divergence Discipline

Every fork edit lands in one of two places: a **fork-only new file** (zero
conflict surface on future `git subtree pull --squash` syncs) or an **edit
inside an upstream file** (a recurring cost, re-paid by hand on every sync).
Choose the first whenever mechanically possible, and keep the second as small
as the feature allows.

## When this discipline is required

This skill is mandatory, not advisory. Load it and follow it whenever:

- writing new logic inside a package that came from `git subtree` (any
  `packages/<name>` with a `subtrees/<name>.json` record);
- adapting fork code after an upstream sync, import, or conflict resolution;
- reviewing or committing a diff that touches files under a subtree prefix;
- adding fork tests, fork docs, lockfiles, or `subtrees/<name>.json`
  maintenance entries (`reapplyOnSync`, `doNotReintroduce`, `knownDebt`).

Apply the rules while writing fork code AND re-audit them after every sync —
formatting drift, lockfile churn, and stale shims accumulate quietly.

## Prefer fork-only files with a minimal upstream seam

- New logic (helpers, parsers, UI modals, commands, runners, guard
  functions) goes into a fork-only module. The upstream file keeps only an
  import plus the smallest possible call site (the "seam"). Repo-proven
  shapes: `packages/pi-subagents/src/agents/runtime-discovery.ts` (upstream
  file reduced to one replaced line),
  `packages/pi-sandbox/src/tool-display-decoration.ts` (3-line seam),
  `packages/pi-subagents/src/agents/agent-eject.ts` (upstream file exports 3
  private helpers, `handleEject` delegates).
- Before adding a seam, check whether upstream already exposes an extension
  point — a plugin hook, config option, CLI flag, or exported API. Configure
  through it instead of patching; an unused upstream extension point is free,
  a new seam is a permanent cost.
- Never leave a large fork block inside an upstream file — not even a
  contiguous appended region. On the next sync, upstream edits near the
  region collide with it. Extract it (fork module + seam) instead of
  baking it in.
- When an upstream function needs fork behavior, prefer exactly one of:
  - a parameter/hook with a default value that keeps upstream call sites
    and behavior byte-stable;
  - pre-processing at a single fork-owned call site instead of threading
    new parameters through an upstream call chain — signature and call-site
    edits are the hunks git merges worst;
  - a fork-only pure function the upstream file calls once.
- To cross a package boundary, export the helper from the dependency fork
  (one `export` keyword on a fork-added or stable symbol) instead of copying
  the implementation; copies drift silently.

## Prefer upstreaming over forking

A fork edit is a recurring cost; an upstream edit is paid once. Before
committing a seam, ask whether the change is generic enough for upstream to
accept it (a bug fix, a missing hook, a config option that upstream would
want anyway). If it is, contribute it with `git subtree push` (see "Split and
push" in the `pi-upstream-subtree` skill) and delete the local seam once a
release carries it. Never upstream a change that leaks fork-specific
identity (the `@xzzpig/pi-*` name, private paths, internal policy).

## Keep upstream files byte-stable

- Never reformat an upstream file. Tab style, quote style, import order,
  line wrapping, and trailing newlines all stay exactly as upstream wrote
  them, even when they look wrong. Fork-only files may use any style; add
  the subtree prefix to root `.prettierignore` when upstream formatting is
  not prettier-clean, and never point a formatter at upstream files.
- After each sync, audit the diff for gratuitous noise before adapting, using
  the whitespace audit below. Files whose only change is whitespace are
  restored byte-identical with `git show <upstreamCommit>:<path>`; mixed
  files are rebuilt from upstream bytes plus the substantive lines. A growing
  raw diff with a stable `-w` diff is pure conflict surface.
- Do not hand-edit `package-lock.json`. It is unconsumed in this pnpm
  monorepo: restore upstream bytes after each sync, regenerate it
  mechanically (`npm install --package-lock-only`) when it must track
  package.json, or delete it and expect it to resurrect on the next pull —
  record the choice as a `knownDebt` entry.
- Comment-only insertions (`SAFETY:`, lint-ignore notes) are upstream edits
  too. Keep them on fork-written lines or in fork-only files; never
  annotate upstream-original lines.
- Before adding a "new" fork file, check it is not a copy of something
  upstream later moved, renamed, or deleted — a zero-reference fork file
  (often a revived upstream module) is pure dead weight; delete it.
- Deleting an upstream file (e.g. a package-local lockfile or workspace
  file) is a modify/delete conflict on every future pull. Do it only when
  required (e.g. pnpm pack), record the recurring `git rm` step in the
  `notes`, and declare the file as a `knownDebt` entry with `kind: deleted`.

## Prefer fork-only test and doc files

- Fork behavior tests live in fork-only test files (runners discover tests
  by glob; a new file is free). Upstream test files keep only assertion
  changes to genuinely upstream cases — and those must be re-reviewed on
  every sync.
- Docs follow the same split: fork chapters live in fork-only docs; the
  upstream doc keeps only irreducible inline edits (package renames, field
  lists).
- One fork-only helper beats N scattered copies: the same validation
  try/catch or trust-check duplicated across upstream files is N conflict
  points for one edit.

## Record and re-audit

Four fields carry the record, each holding what only it can hold:

- `notes` — a short summary: what the fork is, and where its behavior
  contract lives (`openspec/`). Capability intent belongs in a spec or a
  change, not here.
- `reapplyOnSync` — one entry per adaptation a sync must re-apply by hand.
- `doNotReintroduce` — one entry per decision never to re-introduce: a
  dropped divergence, or a deliberate non-change worth keeping.
- `knownDebt` — the machine-readable list of divergences that are
  **deliberately accepted** rather than fixed, one entry per item:
  `{kind, reason, path?, recordedAt?}` with `kind` in
  `noise | deleted | lint | test | other`. `noise` and `deleted` entries
  require `path` (exact or shell glob) because the audit reconciles them.

Keep those three maintenance fields current on every fork change, not just on
syncs; sync-time agents read them, and a missing or stale entry turns the next
sync into archaeology. Do not store what another source already holds: the
dated sync narrative (the record's own git history has it), "file X is
byte-identical to upstream" claims and the seam / fork-only module inventory
(the audit derives both — see the `--inventory` flag below), implementation
detail the code shows, and known failing-test baselines (they belong in
`knownDebt`).

Rules for `knownDebt`:

- Declare debt only after deciding the divergence must stay; never add an
  entry to silence the audit. The `reason` must say why it is accepted and
  what would have to change to remove it.
- Prefer one glob entry over N near-identical entries, but never a `path`-less
  `noise`/`deleted` entry — the audit rejects those, since a blanket entry
  would excuse every finding of that kind.
- Keep the list current: delete an entry when its divergence disappears. The
  audit reports a `noise`/`deleted` entry that matches nothing as `STALE`.
- After every sync and before the follow-up commit, re-run the whitespace
  audit below and fix noise while the diff is fresh.

## Whitespace audit (run before every fork commit)

Compare the fork's copy of every upstream file against the exact upstream
bytes recorded in `subtrees/<name>.json`. A raw diff larger than its
whitespace-ignoring (`-w`) counterpart is pure conflict surface: restore
those lines to upstream bytes before committing, not after the next sync
collides on them.

Run the bundled script. It resolves `prefix` and `upstreamPath` from the
record, so it is correct for both a whole-repository upstream and a monorepo
subdirectory:

```bash
.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh <name>
.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --all
# Derive the seam / fork-only module inventory instead of storing it:
.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory <name>
```

Output and exit status:

- `NOISE   <path> raw=[…] ws=[…]` — the audit counts a line as changed that
  `git diff -w` does not: whitespace-only drift on an upstream file, or a
  diff-alignment artifact where a fork-added line is a whitespace twin of an
  upstream line. Restore the upstream bytes (`git show "$commit:$up" > <path>`,
  then re-apply only the substantive lines) or move the fork logic into a
  fork-only file; declare a genuine artifact in `knownDebt`.
- `DELETED <path>` — the fork removed an upstream file. Acceptable only when
  required and declared in `knownDebt`.
- `DECLARED <path> <kind>` — the finding matches a `knownDebt` entry of the
  same kind, so it is accepted divergence, not a regression.
- `UNDECLARED <path> <kind>` — the finding has no matching entry. Fix the
  divergence or declare it in `knownDebt` with a real reason. Exit status 1.
- `STALE <path> <kind>` — a `noise`/`deleted` entry that matches no current
  finding; the divergence is gone, so delete the entry. Reported but not
  fatal.
- `SUBMODULE <path>` — an upstream gitlink; review it by hand.
- With `--inventory`, `INVENTORY <name>` followed by `fork-only <path>` lines
  (files under `packages/<name>` that the upstream tree does not have) and
  `modified <path>` lines (upstream files the fork changed), then
  `CONTRACT <name> reapplyOnSync=… doNotReintroduce=…`. Both lists are derived
  from the recorded `upstreamCommit` and the worktree, which is why the record
  does not store them.
- `<name>: checked=… noise=… deleted=… submodule=… declared=… undeclared=… stale=…`
  — the per-package summary. `checked=0` with no deletions means the audit
  matched no upstream file at all, and the script fails with exit status 2:
  fix the record or the recorded commit before trusting any result.
- Exit status 0 means every `NOISE`/`DELETED` finding is declared; 2 reports a
  usage or precondition failure (missing record, unknown `upstreamCommit`,
  missing `jq`, a `noise`/`deleted` entry without `path`, or an empty
  `reapplyOnSync`/`doNotReintroduce` array — omit the field instead of writing
  an empty list). Never read a silent run as a pass.

Report the summary line with the diff. Import, pull, conflict resolution, and
synchronization commands live in the `pi-upstream-subtree` skill.

## Commit gate

Before committing any diff that touches an upstream file, confirm all of:

- [ ] new logic lives in fork-only files; every seam is the smallest possible
      call site, and no upstream extension point was ignored;
- [ ] no upstream file was reformatted — the bundled audit exits 0 with a
      non-zero `checked=` count and `undeclared=0`;
- [ ] every remaining `NOISE`/`DELETED` finding has a `knownDebt` entry with a
      real `reason`, and no `STALE` entry is left behind;
- [ ] fork tests and fork docs are fork-only files;
- [ ] the `subtrees/<name>.json` `notes`, `reapplyOnSync`,
      `doNotReintroduce` and `knownDebt` fields describe every divergence
      added, changed, or removed by this change;
- [ ] the audit command and its result are reported with the diff.

Run this audit before publishing (see the pre-publish gate in the `pi-publish`
skill) and before any commit that touches an upstream file. A red audit means
fix the divergence or declare it in `knownDebt` — never leave an `UNDECLARED`
finding unreviewed.
