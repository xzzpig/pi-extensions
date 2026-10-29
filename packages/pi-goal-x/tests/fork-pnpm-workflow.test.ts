import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the fork uses the root pnpm lockfile for installation and packing", () => {
 assert.equal(existsSync(new URL("../package-lock.json", import.meta.url)), false);
 const setup = read(".github/actions/fork-setup/action.yml");
 assert.match(setup, /pnpm\/action-setup@v4/);
 assert.match(setup, /pnpm install --filter '@xzzpig\/pi-goal-x\.\.\.'/);
 assert.match(setup, /--frozen-lockfile --ignore-scripts/);
 for (const file of ["ci.yml", "publish.yml"]) {
  const workflow = read(`.github/workflows/${file}`);
  assert.match(workflow, /working-directory: packages\/pi-goal-x/);
  assert.match(workflow, /uses: \.\/packages\/pi-goal-x\/\.github\/actions\/fork-setup/);
  assert.doesNotMatch(workflow, /npm ci|cache: npm|package-lock\.json/);
 }
 const release = read(".github/workflows/publish.yml");
 assert.match(release, /pnpm pack --json/);
 assert.match(release, /github\.repository == 'tmonk\/pi-goal-x'/);
 assert.match(read("docs/publishing.md"), /repository-root `pnpm-lock\.yaml`/);
 assert.match(read("scripts/package-stabilization-check.mjs"), /node_modules\/@xzzpig\/pi-goal-x/);
});
