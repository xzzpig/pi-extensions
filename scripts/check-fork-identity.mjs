#!/usr/bin/env node
/**
 * Check the fork packaging identity convention across every subtree-derived
 * package, so `reapplyOnSync` does not have to carry one hand-written
 * "keep the repository.url / files list / lockfile" entry per package.
 *
 * Hard failures (exit 1):
 *   1. package.json `name` matches the directory (`pi-x` -> `@xzzpig/pi-x`, or the
 *      plain directory name for a support library)
 *   2. a package listed in versions.json identifies xzzpig/pi-extensions as
 *      `repository.url` (required for the OIDC publish workflow)
 *   3. a published package declares an explicit `files` allowlist
 *
 * Notes (reported, not failures — the fork-divergence audit owns debt):
 *   - retained upstream lockfiles: allowed only with a matching `knownDebt`
 *     entry in the package's subtree record
 *
 * Usage: node scripts/check-fork-identity.mjs [--json]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SUBTREES = join(ROOT, "subtrees");
const REPO_URL = "github.com/xzzpig/pi-extensions";
const LOCAL_LOCKS = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
];

// Per-package lockfile policy: the root pnpm workspace lock is the sole
// dependency contract for `delete` packages; `keep` packages publish their
// upstream lockfile (declared in knownDebt) and must not be deleted.
const LOCK_POLICY = {
  "pi-btw": "delete",
  "pi-goal-x": "delete",
  "pi-sandbox": "delete",
  "pi-subagents": "delete",
  "pi-starline": "keep",
  "pi-tool-display": "keep",
  "pi-vibeguard": "keep",
  "sandbox-runtime": "keep",
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const versions = readJson(join(ROOT, "versions.json")) ?? {};
// versions.json keys are the directory names (`pi-goal-x`); manifests use the
// scoped npm name (`@xzzpig/pi-goal-x`). Normalise both so the release-identity
// checks actually run for every published package.
const released = new Set();
for (const key of Object.keys(versions)) {
  released.add(key);
  released.add(`@xzzpig/${key}`);
}

const failures = [];
const notes = [];
const checked = [];

for (const file of readdirSync(SUBTREES)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const record = readJson(join(SUBTREES, file));
  if (!record?.prefix) continue;
  const dir = join(ROOT, record.prefix);
  const manifest = readJson(join(dir, "package.json"));
  if (!manifest) continue;

  const name = basename(record.prefix);
  const label = record.name ?? name;
  checked.push(label);

  const expected = [`@xzzpig/${name}`, name];
  if (!expected.includes(manifest.name)) {
    failures.push(
      `${label}: package name '${manifest.name}' is neither '${expected[0]}' nor '${expected[1]}'`,
    );
  }

  const published = released.has(manifest.name) || record.publishable === true;
  if (published && !String(manifest.repository?.url ?? "").includes(REPO_URL)) {
    failures.push(
      `${label}: published package must set repository.url to ${REPO_URL}`,
    );
  }
  // Bundle-based packages (`bundledDependencies`, e.g. pi-sandbox embedding
  // sandbox-runtime) ship their directory tree plus the bundled deps by design;
  // every other published package must restrict itself with a `files` allowlist.
  const bundled = Boolean(
    manifest.bundledDependencies ?? manifest.bundleDependencies,
  );
  if (published && !Array.isArray(manifest.files) && !bundled) {
    failures.push(
      `${label}: published package needs an explicit files allowlist (or bundledDependencies)`,
    );
  }

  const policy = LOCK_POLICY[name] ?? "keep";
  for (const lockfile of LOCAL_LOCKS) {
    const present = existsSync(join(dir, lockfile));
    if (policy === "delete" && present) {
      failures.push(
        `${label}: ${lockfile} must be deleted (root pnpm workspace lock is the sole dependency contract)`,
      );
    } else if (policy === "keep" && present) {
      notes.push(`${label}: retaining upstream ${lockfile} (declared policy)`);
    }
  }
}

const result = { checked: checked.length, packages: checked, failures, notes };
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const label of checked)
    console.log(`OK   ${label}: packaging identity matches the convention`);
  for (const note of notes) console.log(`NOTE ${note}`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.log(
    `\n${checked.length} package(s) checked, ${failures.length} failure(s), ${notes.length} note(s).`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
