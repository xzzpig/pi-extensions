import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { stageDiffConsumer } from "../../../scripts/fork-stage-diff-consumer.mjs";

const root = process.cwd();
const output = stageDiffConsumer(root);
const manifestPath = path.join(output, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const entry = "./dist/extension.ts";

// Keep the .ts entry so Pi's loader resolves peer imports against the host
// instead of using Node's native import path to load a second Pi instance.
// dist/ is one level below the package root, just like src/: the debug
// logger resolves its config and log directory relative to import.meta.url.
await build({
  entryPoints: [path.join(root, manifest.pi.extensions[0])],
  outfile: path.join(output, entry),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: [
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.dependencies ?? {}),
  ],
});

manifest.pi.extensions = [entry];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
