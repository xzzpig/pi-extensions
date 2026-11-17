import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  checkForkChangelogs,
  checkForkPackage,
  validateForkLog,
  readInside,
  checkPackedForkLog,
} from "./fork-changelogs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = {
  name: "@xzzpig/pi-fixture",
  version: "0.2.0",
  pi: { changelogPath: "./FORK-CHANGELOG.md" },
};
const valid =
  "# Fork Changelog\n\n## [0.2.0]\n\n- Fix.\n\n## [0.1.0]\n\n- Initial.\n";

test("valid fork log, current version and optional Unreleased", () => {
  assert.deepEqual(validateForkLog(manifest, valid), ["0.2.0", "0.1.0"]);
  assert.equal(
    validateForkLog(manifest, "## [Unreleased]\n\n" + valid).length,
    2,
  );
});
for (const [label, content] of [
  ["future upstream heading", "## [31.0.0]\n" + valid],
  ["duplicate", valid + "\n## [0.1.0]\n"],
  ["unordered", "## [0.1.0]\n\n## [0.2.0]\n"],
  ["missing current", "## [0.1.0]\n"],
  ["invalid heading", "## 0.2.x\n"],
  ["leading zero", "## [00.2.0]\n"],
  ["late Unreleased", valid + "\n## [Unreleased]\n"],
])
  test(`reject ${label}`, () =>
    assert.throws(() => validateForkLog(manifest, content)));

test("reject default, empty and unsafe routing", () => {
  for (const route of [
    undefined,
    "",
    "./CHANGELOG.md",
    "../FORK-CHANGELOG.md",
    "/tmp/log",
  ])
    assert.throws(() =>
      validateForkLog({ ...manifest, pi: { changelogPath: route } }, valid),
    );
});
test("file IO rejects missing, traversal, directory and escaping symlink", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fork-log-path-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const pkg = path.join(temp, "pkg");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(temp, "outside.md"), valid);
  fs.writeFileSync(path.join(pkg, "FORK-CHANGELOG.md"), valid);
  assert.equal(readInside(pkg, "./FORK-CHANGELOG.md"), valid);
  for (const relative of [
    undefined,
    "../outside.md",
    "/tmp/file",
    "missing.md",
    ".",
    "a\\b",
  ])
    assert.throws(() => readInside(pkg, relative));
  fs.symlinkSync(path.join(temp, "outside.md"), path.join(pkg, "escape.md"));
  assert.throws(() => readInside(pkg, "escape.md"));
});
test("actual archive contract rejects missing, changed and misrouted logs", () => {
  const source = {
    dir: "pi-fixture",
    manifest,
    logs: { "FORK-CHANGELOG.md": valid, "CHANGELOG.md": "upstream" },
  };
  const entries = ["package/FORK-CHANGELOG.md", "package/CHANGELOG.md"];
  const read = (e) => source.logs[e.slice(8)];
  checkPackedForkLog(source, manifest, entries, read);
  for (const missing of entries)
    assert.throws(() =>
      checkPackedForkLog(
        source,
        manifest,
        entries.filter((e) => e !== missing),
        read,
      ),
    );
  assert.throws(() =>
    checkPackedForkLog(source, manifest, entries, () => "changed"),
  );
  assert.throws(() =>
    checkPackedForkLog(source, { ...manifest, pi: {} }, entries, read),
  );
});

test("all fork histories against real Pi parsing and startup last-seen logic", async () => {
  // Default to the repo's Pi 1.5 SDK; allow a host runtime for explicit compatibility evidence.
  const runtime =
    process.env.PI_CHANGELOG_RUNTIME ??
    path.join(
      root,
      "packages/pi-tidy/node_modules/@earendil-works/pi-coding-agent",
    );
  const { parseChangelog, getNewEntries } = await import(
    pathToFileURL(path.join(runtime, "dist/utils/changelog.js"))
  );
  const { InteractiveMode } = await import(
    pathToFileURL(
      path.join(runtime, "dist/modes/interactive/interactive-mode.js"),
    )
  );
  // Runtime regression needs no fetched Git objects; source-baseline enforcement
  // is tested separately in an isolated Git fixture and in the release gate.
  const packages = fs
    .readdirSync(path.join(root, "subtrees"))
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const record = JSON.parse(
        fs.readFileSync(path.join(root, "subtrees", file), "utf8"),
      );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, record.prefix, "package.json"), "utf8"),
      );
      if (!manifest.pi?.extensions) return [];
      const content = readInside(
        path.join(root, record.prefix),
        manifest.pi.changelogPath,
      );
      return [
        {
          dir: file.slice(0, -5),
          manifest,
          versions: validateForkLog(manifest, content),
        },
      ];
    });
  assert.ok(packages.length > 0);
  for (const p of packages) {
    const log = path.join(root, "packages", p.dir, "FORK-CHANGELOG.md");
    const entries = parseChangelog(log);
    assert.deepEqual(getNewEntries(entries, p.manifest.version), [], p.dir);
    const sourceInfo = {
      origin: "package",
      scope: "user",
      source: `npm:${p.manifest.name}`,
      baseDir: path.dirname(log),
      changelogPath: log,
    };
    const seen = new Map();
    const subject = {
      session: {
        state: { messages: [] },
        resourceLoader: {
          getExtensions: () => ({
            extensions: [{ sourceInfo }, { sourceInfo }],
          }),
        },
      },
      settingsManager: {
        getExtensionChangelogVersion: (key) => seen.get(key),
        setExtensionChangelogVersion: (key, value) => seen.set(key, value),
      },
      readPackageJson: () => p.manifest,
    };
    const check = () =>
      InteractiveMode.prototype.getExtensionChangelogUpdates.call(subject);
    assert.deepEqual(check(), [], `${p.dir}: first discovery`);
    assert.equal([...seen.values()][0], p.manifest.version);
    assert.deepEqual(check(), [], `${p.dir}: restart after discovery`);
    if (p.versions.length > 1) {
      seen.set([...seen.keys()][0], p.versions[1]);
      const updates = check();
      assert.equal(updates.length, 1, p.dir);
      assert.equal(updates[0].version, p.manifest.version);
      assert.ok(updates[0].markdown.includes(p.manifest.name));
      assert.equal(getNewEntries(entries, p.versions[1]).length, 1, p.dir);
      assert.deepEqual(check(), [], `${p.dir}: second launch after update`);
    }
    subject.session.state.messages.push({ role: "user" });
    assert.deepEqual(check(), [], `${p.dir}: resumed session`);
  }
});

test("source gate checks recorded Git baseline, unchanged upstream bytes and missing inputs", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fork-log-source-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: temp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  fs.writeFileSync(
    path.join(temp, "CHANGELOG.md"),
    "# Upstream\n\n## [31.0.0]\n",
  );
  git("add", "CHANGELOG.md");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "baseline",
  );
  const commit = git("rev-parse", "HEAD").trim();
  const dir = path.join(temp, "packages/pi-fixture");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(temp, "subtrees"));
  const meta = path.join(temp, "subtrees/pi-fixture.json");
  const record = { prefix: "packages/pi-fixture", upstreamCommit: commit };
  fs.writeFileSync(meta, JSON.stringify(record));
  const p = { ...manifest, pi: { ...manifest.pi, extensions: ["./index.ts"] } };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(p));
  fs.writeFileSync(path.join(dir, "FORK-CHANGELOG.md"), valid);
  assert.throws(() => checkForkPackage(temp, "pi-fixture"));
  fs.copyFileSync(
    path.join(temp, "CHANGELOG.md"),
    path.join(dir, "CHANGELOG.md"),
  );
  assert.equal(checkForkPackage(temp, "pi-fixture").versions.length, 2);
  assert.equal(checkForkChangelogs(temp).length, 1);
  fs.appendFileSync(path.join(dir, "CHANGELOG.md"), "fork contamination");
  assert.throws(
    () => checkForkPackage(temp, "pi-fixture"),
    /upstream log modified/,
  );
  fs.writeFileSync(
    meta,
    JSON.stringify({ ...record, upstreamCommit: "0".repeat(40) }),
  );
  assert.throws(() => checkForkPackage(temp, "pi-fixture"));
});

test("sync releases require immutable upstream sources and cannot reference absent Unreleased", () => {
  const sync = valid.replace("- Fix.", "- Synced upstream v1.0.0 → v2.0.0.");
  assert.throws(
    () => validateForkLog(manifest, sync),
    /Missing immutable upstream provenance/,
  );
  const linked = sync.replace(
    "- Synced upstream",
    `- [Upstream source](https://github.com/example/upstream/tree/${"a".repeat(40)}).\n- Synced upstream`,
  );
  assert.equal(validateForkLog(manifest, linked).length, 2);
  assert.throws(
    () =>
      validateForkLog(manifest, valid + "\nSee the Unreleased entry above.\n"),
    /Dangling reference/,
  );
  const starline = fs.readFileSync(
    path.join(root, "packages/pi-starline/FORK-CHANGELOG.md"),
    "utf8",
  );
  assert.ok(starline.includes("## 0.11.0 — pi-tidy ownership convergence"));
  assert.ok(starline.includes("(#0110--pi-tidy-ownership-convergence)"));
  assert.doesNotMatch(starline, /Unreleased (?:entry|convergence) above/i);
});
