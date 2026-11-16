import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  repo,
  ".agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh",
);
const upstream = JSON.parse(
  readFileSync(path.join(repo, "subtrees/pi-sandbox.json")),
).upstreamCommit;
const objects = path.resolve(
  repo,
  execFileSync("git", ["rev-parse", "--git-path", "objects"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
);
// No commit, fetch, ref or worktree mutation in the real repository. Fixtures
// read existing upstream objects through a temporary repository's alternates.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
env.GIT_CONFIG_GLOBAL = "/dev/null";
env.GIT_CONFIG_NOSYSTEM = "1";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "fork-audit-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", "--template=", root], { env });
  writeFileSync(
    path.join(root, ".git/objects/info/alternates"),
    `${objects}\n`,
  );
  mkdirSync(path.join(root, "subtrees"));
  const paths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", upstream, "--", "src"],
    { cwd: repo, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  function record(name, extra = {}) {
    const prefix = `packages/${name}`;
    for (const file of paths) {
      const dest = path.join(root, prefix, file.slice(4));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(
        dest,
        execFileSync("git", ["show", `${upstream}:${file}`], { cwd: repo }),
      );
    }
    const value = {
      name,
      prefix,
      upstreamCommit: upstream,
      upstreamPath: "src",
      knownDebt: [],
      ...extra,
    };
    const save = () =>
      writeFileSync(
        path.join(root, "subtrees", `${name}.json`),
        JSON.stringify(value),
      );
    save();
    return { value, save, dir: path.join(root, prefix) };
  }
  function run(...args) {
    const result = spawnSync("bash", [script, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  }
  return { record, run };
}

test("inventory counts match metadata across records, including absent arrays", (t) => {
  const f = fixture(t);
  const records = [
    f.record("alpha", {
      reapplyOnSync: ["one", "two"],
      doNotReintroduce: ["never"],
    }),
    f.record("beta", {
      reapplyOnSync: ["one"],
      doNotReintroduce: ["a", "b", "c"],
    }),
    f.record("gamma"),
  ];
  const result = f.run("--inventory", "--all");
  assert.equal(result.status, 0, result.output);
  for (const { value } of records) {
    assert.ok(
      result.output.includes(
        `CONTRACT ${value.name} reapplyOnSync=${value.reapplyOnSync?.length ?? 0} doNotReintroduce=${value.doNotReintroduce?.length ?? 0}`,
      ),
      result.output,
    );
    assert.match(
      result.output,
      new RegExp(`${value.name}: checked=[1-9][0-9]* .*undeclared=0 stale=0`),
    );
  }
});

for (const field of ["reapplyOnSync", "doNotReintroduce"]) {
  test(`explicit empty ${field} is still rejected`, (t) => {
    const f = fixture(t);
    f.record("alpha", { [field]: [] });
    const result = f.run("--inventory", "alpha");
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, new RegExp(`empty ${field} array`));
  });
}

test("undeclared noise/deletions fail; matching declarations restore acceptance", (t) => {
  const f = fixture(t);
  const record = f.record("alpha");
  const noisy = path.join(record.dir, "config.ts");
  writeFileSync(noisy, ` ${readFileSync(noisy, "utf8")}`);
  rmSync(path.join(record.dir, "extension.ts"));
  const rejected = f.run("--inventory", "alpha");
  assert.equal(rejected.status, 1, rejected.output);
  assert.match(rejected.output, /UNDECLARED packages\/alpha\/config.ts noise/);
  assert.match(
    rejected.output,
    /UNDECLARED packages\/alpha\/extension.ts deleted/,
  );
  record.value.knownDebt = [
    { kind: "noise", path: "packages/alpha/config.ts" },
    { kind: "deleted", path: "packages/alpha/extension.ts" },
  ];
  record.save();
  const accepted = f.run("--inventory", "alpha");
  assert.equal(accepted.status, 0, accepted.output);
  assert.match(accepted.output, /declared=2 undeclared=0 stale=0/);
});

test("an audit with no matched upstream files is still rejected", (t) => {
  const f = fixture(t);
  f.record("alpha", { upstreamPath: "nonexistent-fixture-subdir" });
  const result = f.run("alpha");
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /checked=0/);
});
