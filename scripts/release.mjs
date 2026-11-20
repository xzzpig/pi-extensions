#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  discover,
  readJson,
  planRelease,
  registryJson,
  checkArchive,
  order,
  localDeps,
  checkTarEntries,
  checkPackedManifest,
  checkPackedSharedDiff,
  integrity,
  publishArtifacts,
} from "./release-core.mjs";
import { runPackageStartupE2E } from "./package-startup-e2e.mjs";
import {
  publicationSource,
  reportPublications,
} from "./release-publications.mjs";
import {
  checkForkChangelogs,
  checkForkPackage,
  checkPackedForkLog,
} from "./fork-changelogs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function run(command, args, cwd = root, options = {}) {
  return execFileSync(command, args, { cwd, stdio: "inherit", ...options });
}
export function gatePackages(all, candidates) {
  const needed = new Set(candidates.map((p) => p.name));
  // Each consumer requires the private compiled components before its own
  // checks and package staging, including a tool-display-only release.
  if (
    candidates.some((p) =>
      ["pi-btw", "pi-subagents", "pi-goal-x", "pi-tool-display"].includes(
        p.dir,
      ),
    )
  )
    needed.add("@xzzpig/pi-components");
  let changed;
  do {
    changed = false;
    for (const p of all.filter((p) => needed.has(p.name))) {
      for (const [name] of localDeps(p, all))
        if (!needed.has(name)) {
          needed.add(name);
          changed = true;
        }
    }
  } while (changed);
  return order(
    all.filter((p) => needed.has(p.name)),
    all,
    true,
  );
}
export function checkScripts(p, platform = process.platform) {
  const scripts = p.scripts ?? {},
    checks = [];
  // Native helpers are ignored by Git and must exist before clean-checkout tests.
  if (
    p.name === "@xzzpig/sandbox-runtime" &&
    platform === "linux" &&
    scripts["build:seccomp"]
  )
    checks.push("build:seccomp");
  if (scripts.build) checks.push("build");
  if (scripts["build:types"]) checks.push("build:types");
  // A clean workspace may link this package's own public imports to dist-pkg.
  if (p.publishConfig?.directory && scripts.prepack) checks.push("prepack");
  if (scripts.typecheck) checks.push("typecheck");
  else if (scripts.check) checks.push("check");
  if (scripts.test) checks.push("test");
  if (scripts.prepublishOnly) checks.push("prepublishOnly");
  return checks;
}
export function gates(all, candidates) {
  checkArchive(root);
  run("bash", ["scripts/release-upstreams.sh"]);
  run("pnpm", ["run", "audit:fork-divergence"]);
  for (const p of gatePackages(all, candidates)) {
    console.log(`Checking ${p.dir}`);
    const cwd = path.join(root, "packages", p.dir);
    for (const check of checkScripts(p)) run("pnpm", ["run", check], cwd);
  }
}
export function pack(p, destination) {
  const forkLog = checkForkPackage(root, p.dir);
  fs.mkdirSync(destination, { recursive: true });
  run(
    "pnpm",
    ["pack", "--pack-destination", destination],
    path.join(root, "packages", p.dir),
  );
  const files = fs
    .readdirSync(destination)
    .filter((name) => name.endsWith(".tgz"));
  if (files.length !== 1)
    throw new Error(`Expected one archive for ${p.dir}, got ${files.length}`);
  const file = path.join(destination, files[0]);
  const entries = run("tar", ["-tzf", file], root, {
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString()
    .trim()
    .split("\n");
  checkTarEntries(entries);
  const manifestText = run(
    "tar",
    ["-xOzf", file, "package/package.json"],
    root,
    { stdio: "pipe" },
  ).toString();
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Invalid packed manifest: ${p.dir}`, { cause: error });
  }
  checkPackedManifest(p, manifest, entries);
  checkPackedSharedDiff(p, manifest, entries, (entry) =>
    run("tar", ["-xOzf", file, entry], root, {
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
    }).toString(),
  );
  checkPackedForkLog(forkLog, manifest, entries, (entry) =>
    run("tar", ["-xOzf", file, entry], root, {
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
    }).toString(),
  );
  return {
    dir: p.dir,
    name: p.name,
    version: p.version,
    file,
    integrity: integrity(file),
    entries: entries.length,
  };
}
async function publishValidatedArtifacts(artifacts, { lookup, registry }) {
  const source =
    process.env.GITHUB_ACTIONS === "true" ? publicationSource() : null;
  if (source && registry.replace(/\/+$/, "") !== "https://registry.npmjs.org")
    throw new Error("GitHub Actions releases require the public npm registry");
  if (
    source &&
    run("git", ["rev-parse", "HEAD"], root, { stdio: "pipe" })
      .toString()
      .trim() !== source.commit
  )
    throw new Error("Release checkout does not match the GitHub event SHA");
  const publications = [];
  try {
    await publishArtifacts(artifacts, {
      lookup,
      onPublication: (publication) => publications.push(publication),
      upload: async (a) => {
        if (integrity(a.file) !== a.integrity)
          throw new Error(`Artifact changed after verification: ${a.file}`);
        run("npm", [
          "publish",
          a.file,
          "--registry",
          registry,
          "--access",
          "public",
          "--tag",
          "latest",
          "--ignore-scripts",
        ]);
      },
    });
  } finally {
    if (source) reportPublications(source, publications);
  }
}
async function main() {
  const args = process.argv.slice(2);
  let mode = "plan",
    only,
    registry = process.env.PI_PUBLISH_REGISTRY ?? "https://registry.npmjs.org";
  let output = path.join(root, "artifacts/release"),
    checkAll = false;
  const value = (flag) => {
    if (!args.length || args[0].startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    return args.shift();
  };
  while (args.length) {
    const arg = args.shift();
    if (["--dry-run", "--plan"].includes(arg)) mode = "plan";
    else if (arg === "--pack") mode = "pack";
    else if (arg === "--publish") mode = "publish";
    else if (arg === "--check-all") checkAll = true;
    else if (arg === "--only")
      only = value(arg)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--registry") registry = value(arg);
    else if (arg === "--output") output = path.resolve(value(arg));
    else if (arg === "--no-sync-versions") {
      /* Legacy compatibility: validation replaces mutation. */
    } else if (["--help", "-h"].includes(arg)) {
      console.log(
        "release.mjs [--plan|--dry-run|--pack|--publish] [--only dir,dir | --check-all] [--registry URL] [--output dir]",
      );
      return;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (checkAll && only !== undefined)
    throw new Error(
      "--check-all cannot be combined with --only. Use --pack --check-all for all public plugins, or --pack --only <dir> for pending versions of selected plugins.",
    );
  if (!registry || !/^https?:\/\//.test(registry))
    throw new Error("Expected HTTP(S) registry");
  if (
    mode === "publish" &&
    process.env.GITHUB_ACTIONS === "true" &&
    (process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_EVENT_NAME === "pull_request")
  )
    throw new Error("CI publishing only allowed from main");
  // Fresh CI checkouts may not contain the immutable subtree Git objects yet.
  run("bash", ["scripts/release-upstreams.sh"]);
  checkForkChangelogs(root);
  const all = discover(root),
    versions = readJson(path.join(root, "versions.json"));
  const lookup = (name, version) =>
    registryJson(
      registry,
      `${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ""}`,
    );
  const plan = await planRelease({ all, versions, only, lookup });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(
    path.join(output, "plan.json"),
    JSON.stringify(
      {
        registry,
        todo: plan.todo.map(({ dir, name, version }) => ({
          dir,
          name,
          version,
        })),
        skipped: plan.skipped.map((p) => `${p.name}@${p.version}`),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Pending (${plan.todo.length}): ${plan.todo.map((p) => `${p.name}@${p.version}`).join(", ") || "none"}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## npm release plan\n\nMode: ${mode}\n\n${plan.todo.map((p) => `- ${p.name}@${p.version}`).join("\n") || "No pending versions."}\n`,
    );
  const candidates = checkAll
    ? all.filter((p) => !p.private && p.name.startsWith("@xzzpig/pi-"))
    : plan.todo;
  if (mode === "plan" || !candidates.length) return;
  gates(all, candidates);
  const artifacts = candidates.map((p) => {
    const destination = fs.mkdtempSync(path.join(output, `${p.dir}-`));
    return pack(p, destination);
  });
  runPackageStartupE2E(artifacts);
  fs.writeFileSync(
    path.join(output, "artifacts.json"),
    JSON.stringify(artifacts, null, 2) + "\n",
  );
  if (mode !== "publish") return;
  if (checkAll) throw new Error("--check-all is not allowed for publishing");
  await publishValidatedArtifacts(artifacts, { lookup, registry });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
