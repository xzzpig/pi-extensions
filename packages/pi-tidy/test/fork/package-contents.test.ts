/**
 * Packaging contract.
 *
 * The npm tarball is what users install, so its `files` allowlist must ship
 * every runtime module the entry point imports. A missing `fork/` entry once
 * made an installable package throw at import time; this test pins the
 * allowlist to the real directory layout instead of relying on a manual
 * `npm pack` check.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readManifest(): {
  name: string;
  version: string;
  files: string[];
  pi: { extensions: string[] };
} {
  return JSON.parse(
    readFile(join(packageRoot, "package.json")),
  ) as ReturnType<typeof readManifest>;
}

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

test("the npm allowlist ships the runtime entry and fork modules", () => {
  const manifest = readManifest();
  assert.equal(manifest.name, "@xzzpig/pi-tidy");
  assert.ok(manifest.version.length > 0);
  for (const entry of ["src", "fork", "README.md", "FORK-CHANGELOG.md"]) {
    assert.ok(
      manifest.files.includes(entry),
      `package.json files must include ${entry}`,
    );
  }
  for (const extension of manifest.pi.extensions) {
    const extensionPath = join(packageRoot, extension);
    assert.ok(statSync(extensionPath).isFile(), `${extension} must exist`);
  }
});

test("every fork runtime module is inside the allowlisted directory", () => {
  const forkDir = join(packageRoot, "fork");
  const modules = readdirSync(forkDir).filter((name) => name.endsWith(".ts"));
  assert.ok(modules.length > 0, "fork/ must contain runtime modules");
  // `files: ["fork"]` packages the whole directory, so every module is
  // covered; this also fails if a module moves outside the allowlist.
  assert.ok(readManifest().files.includes("fork"));
});
