import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson } from "./release-core.mjs";

export function compareVersions(a, b) {
  const x = a.split(".").map(BigInt),
    y = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export function validateForkLog(manifest, content) {
  if (manifest.pi?.changelogPath !== "./FORK-CHANGELOG.md")
    throw new Error(
      `${manifest.name}: pi.changelogPath must be ./FORK-CHANGELOG.md`,
    );
  const versions = [];
  let unreleased = false;
  for (const line of content.split("\n")) {
    if (!line.startsWith("## ")) continue;
    if (line.trim() === "## [Unreleased]") {
      if (unreleased || versions.length)
        throw new Error("Unreleased must occur once before releases");
      unreleased = true;
      continue;
    }
    const match = line.match(/^## \[?(\d+\.\d+\.\d+)\]?(?:\s|$)/);
    if (!match || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(match[1]))
      throw new Error(`Invalid fork release heading: ${line}`);
    const version = match[1];
    if (compareVersions(version, manifest.version) > 0)
      throw new Error(`Future/upstream version in fork log: ${version}`);
    if (versions.length && compareVersions(versions.at(-1), version) <= 0)
      throw new Error(`Duplicate or unordered fork version: ${version}`);
    versions.push(version);
  }
  if (!versions.includes(manifest.version))
    throw new Error(`Missing current fork release: ${manifest.version}`);
  validateReleaseReferences(content, unreleased);
  return versions;
}
function validateReleaseReferences(content, unreleased) {
  if (
    !unreleased &&
    /\bUnreleased (?:entry|convergence) above\b/i.test(content)
  )
    throw new Error("Dangling reference to an Unreleased entry");
  for (const section of content.split(/(?=^## )/m).slice(1)) {
    const hasSync =
      /synced(?: the fork with)? upstream|sync upstream|— Upstream v\d+\.\d+\.\d+ sync|local fork of|forked from|initial fork of/i.test(
        section,
      );
    if (
      hasSync &&
      !/https:\/\/github\.com\/[^\s)]+\/(?:tree|blob)\/[0-9a-f]{40}(?:[\s)/]|$)/.test(
        section,
      )
    )
      throw new Error(
        `Missing immutable upstream provenance: ${section.split("\n")[0]}`,
      );
  }
}
export function readInside(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    /[\0\r\n]/.test(relative) ||
    relative.split("/").includes("..")
  )
    throw new Error(`Unsafe changelog path: ${relative}`);
  const realRoot = fs.realpathSync(root),
    target = fs.realpathSync(path.resolve(root, relative));
  if (!target.startsWith(realRoot + path.sep) || !fs.statSync(target).isFile())
    throw new Error(`Changelog escapes package: ${relative}`);
  return fs.readFileSync(target, "utf8");
}
export function checkForkPackage(root, dir) {
  const metadata = path.join(root, "subtrees", `${dir}.json`);
  if (!fs.existsSync(metadata)) return null;
  const record = readJson(metadata);
  const packageDir = path.join(root, record.prefix);
  const manifest = readJson(path.join(packageDir, "package.json"));
  if (!manifest.pi?.extensions) return null; // Support libraries have no Pi startup log.
  const content = readInside(packageDir, manifest.pi.changelogPath);
  const versions = validateForkLog(manifest, content);
  const upstreamRoot = record.upstreamPath ? `${record.upstreamPath}/` : "";
  // ls-tree distinguishes an absent upstream log from an unavailable baseline.
  const upstreamFiles = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", record.upstreamCommit],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const upstreamLogs = upstreamFiles
    .filter(
      (f) =>
        f.startsWith(upstreamRoot) &&
        /(^|\/)changelog(?:\.md|\.rst|\.txt)?$/i.test(f),
    )
    .map((f) => f.slice(upstreamRoot.length));
  const logs = { "FORK-CHANGELOG.md": content };
  for (const relative of upstreamLogs) {
    const upstream = execFileSync(
      "git",
      ["show", `${record.upstreamCommit}:${upstreamRoot}${relative}`],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    logs[relative] = readInside(packageDir, relative);
    if (logs[relative] !== upstream)
      throw new Error(`${dir}: upstream log modified: ${relative}`);
  }
  return { dir, manifest, record, logs, versions };
}
export function checkForkChangelogs(root) {
  const results = [];
  for (const file of fs
    .readdirSync(path.join(root, "subtrees"))
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const result = checkForkPackage(root, file.slice(0, -5));
    if (result) results.push(result);
  }
  // Refuse an untracked scoped fork plugin rather than silently missing it.
  for (const dir of fs.readdirSync(path.join(root, "packages"))) {
    const file = path.join(root, "packages", dir, "package.json");
    if (!fs.existsSync(file)) continue;
    const p = readJson(file);
    if (
      p.pi?.extensions &&
      (p.pi.changelogPath === "./FORK-CHANGELOG.md" ||
        fs.existsSync(path.join(root, "packages", dir, "FORK-CHANGELOG.md")))
    ) {
      if (!results.some((r) => r.dir === dir))
        throw new Error(`Fork log without subtree inventory: ${dir}`);
    }
  }
  return results;
}
export function checkPackedForkLog(source, packed, entries, readEntry) {
  if (!source) return;
  if (packed.pi?.changelogPath !== source.manifest.pi.changelogPath)
    throw new Error(`Packed changelog route mismatch: ${source.dir}`);
  for (const [relative, content] of Object.entries(source.logs)) {
    const entry = `package/${relative}`;
    if (!entries.includes(entry))
      throw new Error(`Missing packed changelog: ${source.dir}: ${relative}`);
    const actual = readEntry(entry);
    if (actual !== content)
      throw new Error(`Packed changelog differs: ${source.dir}: ${relative}`);
    if (relative === "FORK-CHANGELOG.md") validateForkLog(packed, actual);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const results = checkForkChangelogs(root);
  for (const r of results)
    console.log(
      `OK ${r.dir}@${r.manifest.version}: ${r.versions.length} fork releases, ${Object.keys(r.logs).length} log files`,
    );
  console.log(`${results.length} fork plugins checked`);
}
