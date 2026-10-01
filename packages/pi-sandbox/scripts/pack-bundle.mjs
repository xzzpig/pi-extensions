// Fork-only prepack/postpack helper for bundling @xzzpig/sandbox-runtime.
//
// The root workspace pins nodeLinker: hoisted, so sandbox-runtime's runtime
// deps without a version conflict anywhere in the workspace (commander,
// node-forge, @pondwader/socks5-server) are hoisted to the root node_modules,
// outside both bundled packages. When pnpm packs pi-sandbox, it inlines the
// bundled dep at its resolved on-disk location, so those hoisted deps land in
// the tarball as `package/../../node_modules/...` entries and the npm registry
// rejects the upload with E415 "invalid path". zod is unaffected because its
// version conflict with pi-permission-system keeps it nested inside
// packages/sandbox-runtime/node_modules, and pnpm pack nests whatever is
// physically present there.
//
// prepack copies the missing deps into packages/sandbox-runtime/node_modules so
// the packer finds them inside the bundle; postpack (--clean) removes exactly
// what this script copied. The next `pnpm install` also rebuilds that tree, so
// a leftover copy is harmless.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.resolve(pkgDir, "..", "sandbox-runtime");
const runtimeNodeModules = path.join(runtimeDir, "node_modules");
const recordDir = path.join(pkgDir, "node_modules", ".cache");
const recordPath = path.join(recordDir, "pack-bundle-record.json");

// Resolve like Node's walk-up would, but on directories: some packages
// (e.g. commander) do not export ./package.json, so require.resolve cannot be
// used to locate them.
function resolveDepDir(dep) {
  let dir = runtimeDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...dep.split("/"));
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function clean() {
  if (!existsSync(recordPath)) return;
  for (const dep of JSON.parse(readFileSync(recordPath, "utf8"))) {
    const parts = dep.split("/");
    rmSync(path.join(runtimeNodeModules, ...parts), { recursive: true, force: true });
    if (parts.length > 1) {
      try {
        rmdirSync(path.join(runtimeNodeModules, parts[0]));
      } catch {
        // scope dir still holds another package — leave it alone
      }
    }
  }
  rmSync(recordPath, { force: true });
}

if (process.argv.includes("--clean")) {
  clean();
} else {
  clean();
  const manifest = JSON.parse(readFileSync(path.join(runtimeDir, "package.json"), "utf8"));
  const deps = Object.keys(manifest.dependencies ?? {});
  const copied = [];
  for (const dep of deps) {
    const nested = path.join(runtimeNodeModules, ...dep.split("/"));
    if (existsSync(nested)) continue;
    const source = resolveDepDir(dep);
    if (!source) throw new Error(`Cannot resolve ${dep} from ${runtimeDir}`);
    cpSync(source, nested, { recursive: true, dereference: true });
    copied.push(dep);
  }
  if (copied.length > 0) {
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(recordPath, JSON.stringify(copied));
  }
}
