import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const repository = "https://github.com/xzzpig/pi-extensions.git";
export function stable(version) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}
export function compare(a, b) {
  if (!stable(a) || !stable(b))
    throw new Error(`Expected stable versions: ${a}, ${b}`);
  const x = a.split(".").map(BigInt),
    y = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON ${file}: ${error.message}`, {
      cause: error,
    });
  }
}
export function discover(root) {
  return fs
    .readdirSync(path.join(root, "packages"))
    .sort()
    .flatMap((dir) => {
      const file = path.join(root, "packages", dir, "package.json");
      return fs.existsSync(file) ? [{ dir, ...readJson(file) }] : [];
    });
}
export function dependencyEntries(pkg, allKinds = false) {
  const groups = [pkg.dependencies, pkg.optionalDependencies];
  if (allKinds) groups.push(pkg.devDependencies, pkg.peerDependencies);
  return groups.flatMap((group) => Object.entries(group ?? {}));
}
export function workspaceDeps(pkg, allKinds = false) {
  return dependencyEntries(pkg, allKinds).filter(([, value]) =>
    value.startsWith("workspace:"),
  );
}
export function localDeps(pkg, all) {
  const names = new Set(all.map((p) => p.name));
  return dependencyEntries(pkg, true).filter(([name]) => names.has(name));
}
export function order(packages, all, allKinds = false) {
  const byName = new Map(all.map((p) => [p.name, p])),
    states = new Map(),
    result = [];
  const visit = (p) => {
    if (states.get(p.name) === 1)
      throw new Error(`Workspace dependency cycle: ${p.name}`);
    if (states.get(p.name) === 2) return;
    states.set(p.name, 1);
    for (const [name] of allKinds ? localDeps(p, all) : workspaceDeps(p)) {
      const dep = byName.get(name);
      if (!dep) throw new Error(`Unknown workspace dependency: ${name}`);
      if (packages.some((q) => q.name === name)) visit(dep);
    }
    states.set(p.name, 2);
    result.push(p);
  };
  packages.forEach(visit);
  return result;
}
export async function registryJson(registry, suffix, fetcher = fetch) {
  const url = `${registry.replace(/\/+$/, "")}/${suffix}?probe=${Date.now()}`;
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetcher(url, {
        headers: { "cache-control": "no-cache", accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid registry JSON object");
      return body;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`Registry lookup failed: ${suffix}: ${last?.message}`);
}
export function validateMetadata(p, versions) {
  if (versions[p.dir] !== p.version)
    throw new Error(`versions.json mismatch: ${p.dir}`);
  if (!stable(p.version))
    throw new Error(`Only stable releases supported: ${p.name}@${p.version}`);
  const url =
    typeof p.repository === "string" ? p.repository : p.repository?.url;
  if (url?.replace(/^git\+/, "").replace(/\/$/, "") !== repository)
    throw new Error(`repository must identify this fork: ${p.dir}`);
}
export async function planRelease({ all, versions, only = [], lookup }) {
  for (const p of all) {
    if (
      (Object.hasOwn(versions, p.dir) || p.name.startsWith("@xzzpig/pi-")) &&
      versions[p.dir] !== p.version
    )
      throw new Error(`versions.json mismatch: ${p.dir}`);
  }
  const publicPackages = all.filter(
    (p) =>
      !p.private &&
      /^@xzzpig\/pi-/.test(p.name) &&
      !["pi-components", "sandbox-runtime"].includes(p.dir),
  );
  for (const dir of only)
    if (!publicPackages.some((p) => p.dir === dir))
      throw new Error(`Unknown or excluded package: ${dir}`);
  const selected = publicPackages.filter(
    (p) => !only.length || only.includes(p.dir),
  );
  const todo = [],
    skipped = [];
  for (const p of selected) {
    validateMetadata(p, versions);
    const exact = await lookup(p.name, p.version);
    if (exact) {
      if (exact.name !== p.name || exact.version !== p.version)
        throw new Error(`Invalid registry identity: ${p.name}`);
      skipped.push(p);
      continue;
    }
    const packument = await lookup(p.name);
    if (
      packument &&
      (!packument.versions ||
        typeof packument.versions !== "object" ||
        Array.isArray(packument.versions))
    )
      throw new Error(`Invalid registry versions: ${p.name}`);
    for (const v of Object.keys(packument?.versions ?? {}))
      if (stable(v) && compare(p.version, v) <= 0)
        throw new Error(
          `Version must increase: ${p.name}@${p.version} <= ${v}`,
        );
    todo.push(p);
  }
  for (const p of todo) {
    const bundled = p.bundledDependencies ?? p.bundleDependencies ?? [];
    for (const [name] of workspaceDeps(p)) {
      const dep = all.find((q) => q.name === name);
      if (!dep) throw new Error(`Unknown workspace dependency: ${name}`);
      if (bundled === true || bundled.includes(name)) continue;
      if (dep.private) throw new Error(`Unbundled private dependency: ${name}`);
      if (
        !todo.some((q) => q.name === name) &&
        !(await lookup(name, dep.version))
      )
        throw new Error(
          `Dependency unavailable: ${p.name} needs ${name}@${dep.version}`,
        );
    }
  }
  return { todo: order(todo, all, true), skipped };
}
export function checkArchive(root) {
  const dir = path.join(root, "openspec/changes");
  const active = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== "archive")
    : [];
  if (active.length)
    throw new Error(
      `Archive OpenSpec changes before release: ${active.map((d) => d.name).join(", ")}`,
    );
}
export function checkTarEntries(entries) {
  for (const file of entries) {
    if (
      !file.startsWith("package/") ||
      file.split("/").includes("..") ||
      /[\r\0]/.test(file)
    )
      throw new Error(`Unsafe archive path: ${file}`);
    if (
      /(^|\/)(\.env(?:\.[^/]*)?|\.npmrc|\.git|\.ssh|id_rsa|credentials(?:\.json)?)(\/|$)/i.test(
        file,
      )
    )
      throw new Error(`Sensitive archive entry: ${file}`);
    if (
      !file.includes("/node_modules/") &&
      /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
    )
      throw new Error(`Test shipped in archive: ${file}`);
  }
}
export function checkPackedManifest(p, packed, entries) {
  if (packed.name !== p.name || packed.version !== p.version)
    throw new Error(`Packed identity mismatch: ${p.dir}`);
  if (packed.private) throw new Error(`Private packed manifest: ${p.dir}`);
  if (
    dependencyEntries(packed, true).some(([, range]) =>
      /^(workspace:|catalog:|file:|link:)/.test(range),
    )
  )
    throw new Error(`Unresolved packed dependencies: ${p.dir}`);
  const requireEntry = (target) => {
    if (typeof target !== "string" || target.includes("*")) return;
    const relative = target.replace(/^\.\//, "");
    if (relative.split("/").includes("..") || relative.startsWith("/"))
      throw new Error(`Invalid entry: ${target}`);
    const entry = `package/${relative}`;
    if (
      !entries.some(
        (e) => e === entry || e.startsWith(`${entry.replace(/\/$/, "")}/`),
      )
    )
      throw new Error(`Missing packed entry: ${p.dir}: ${target}`);
  };
  const walk = (value) => {
    if (typeof value === "string") requireEntry(value);
    else if (value && typeof value === "object")
      Object.values(value).forEach(walk);
  };
  walk(packed.pi?.extensions);
  walk(packed.pi?.skills);
  walk(packed.bin);
  walk(packed.exports);
  walk(packed.main);
  walk(packed.types);
  if (p.scripts?.["build:types"] && !entries.some((e) => e.endsWith(".d.ts")))
    throw new Error(`Missing type declarations: ${p.dir}`);
  for (const name of Array.isArray(packed.bundledDependencies)
    ? packed.bundledDependencies
    : [])
    if (!entries.includes(`package/node_modules/${name}/package.json`))
      throw new Error(`Missing bundled dependency: ${name}`);
}
export function integrity(file) {
  return `sha512-${createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
}
export async function publishArtifacts(
  artifacts,
  {
    upload,
    lookup,
    delay = () => new Promise((r) => setTimeout(r, 5000)),
    report = console.log,
  },
) {
  for (const a of artifacts) {
    const existing = await lookup(a.name, a.version);
    if (existing) {
      report(`skip ${a.name}@${a.version}`);
      continue;
    }
    await upload(a);
    let verified = false;
    for (let i = 0; i < 12; i++) {
      const remote = await lookup(a.name, a.version);
      if (remote) {
        if (remote.dist?.integrity !== a.integrity)
          throw new Error(`Registry integrity mismatch: ${a.name}`);
        verified = true;
        break;
      }
      if (i < 11) await delay();
    }
    if (!verified)
      throw new Error(
        `Published version not verifiable: ${a.name}@${a.version}`,
      );
    report(`published ${a.name}@${a.version}`);
  }
}
