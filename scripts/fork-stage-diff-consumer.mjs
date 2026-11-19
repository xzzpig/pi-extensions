import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const componentName = "@xzzpig/pi-components";
const consumers = new Set(["@xzzpig/pi-goal-x", "@xzzpig/pi-tool-display"]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Stage each consumer independently; never package workspace symlinks or TS
 * entries for the private dependency inside node_modules. */
export function stageDiffConsumer(root) {
  const consumer = readJson(path.join(root, "package.json"));
  if (!consumers.has(consumer.name))
    throw new Error(`Unexpected consumer: ${consumer.name}`);
  if (!consumer.bundledDependencies?.includes(componentName))
    throw new Error(`Missing bundled ${componentName}`);
  if (consumer.publishConfig?.directory !== "dist-pkg")
    throw new Error("Expected isolated dist-pkg staging");

  const packagesRoot = path.resolve(root, "..");
  const componentsRoot = path.join(packagesRoot, "pi-components");
  const component = readJson(path.join(componentsRoot, "package.json"));
  if (component.name !== componentName || !component.private)
    throw new Error("Unexpected private component identity");
  if (
    component.exports?.["./diff"]?.types !== "./dist/src/diff.d.ts" ||
    component.exports?.["./diff"]?.default !== "./src/diff.ts"
  ) {
    throw new Error("Unexpected source diff exports");
  }
  for (const file of ["dist/src/diff.js", "dist/src/diff.d.ts"]) {
    if (!fs.existsSync(path.join(componentsRoot, file)))
      throw new Error(`Build pi-components first: missing ${file}`);
  }

  const output = path.join(root, "dist-pkg");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const relative of consumer.files ?? []) {
    if (
      typeof relative !== "string" ||
      relative.startsWith("/") ||
      relative.split("/").includes("..") ||
      /[*?{}]/.test(relative)
    ) {
      throw new Error(`Unsupported package file entry: ${relative}`);
    }
    const input = path.join(root, relative);
    if (!fs.existsSync(input)) continue; // Match npm's optional files-list behavior.
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(input, destination, {
      recursive: true,
      filter: (entry) => {
        if (fs.lstatSync(entry).isSymbolicLink())
          throw new Error(`Refusing package symlink: ${entry}`);
        return true;
      },
    });
  }

  const bundle = path.join(output, "node_modules", "@xzzpig", "pi-components");
  fs.mkdirSync(path.join(bundle, "dist", "src"), { recursive: true });
  for (const file of ["diff.js", "diff.d.ts"]) {
    fs.copyFileSync(
      path.join(componentsRoot, "dist", "src", file),
      path.join(bundle, "dist", "src", file),
    );
  }
  // Only the diff subpath is needed here. Do not bundle the removed Goal-X
  // transcript runtime, and never expose a .ts entry under node_modules.
  const bundledManifest = {
    name: component.name,
    version: component.version,
    private: true,
    type: "module",
    exports: {
      "./diff": {
        types: "./dist/src/diff.d.ts",
        default: "./dist/src/diff.js",
      },
    },
    peerDependencies: {
      "@earendil-works/pi-tui":
        component.peerDependencies["@earendil-works/pi-tui"],
    },
  };
  fs.writeFileSync(
    path.join(bundle, "package.json"),
    `${JSON.stringify(bundledManifest, null, 2)}\n`,
  );

  const published = structuredClone(consumer);
  delete published.devDependencies;
  if (published.scripts) delete published.scripts.prepack;
  delete published.publishConfig.directory;
  delete published.publishConfig.linkDirectory;
  for (const [name, range] of Object.entries(published.dependencies ?? {})) {
    if (!range.startsWith("workspace:")) continue;
    const local = fs
      .readdirSync(packagesRoot)
      .map((dir) => path.join(packagesRoot, dir, "package.json"))
      .filter((file) => fs.existsSync(file))
      .map(readJson)
      .find((manifest) => manifest.name === name);
    if (!local || range !== "workspace:*")
      throw new Error(`Cannot resolve workspace dependency ${name}: ${range}`);
    published.dependencies[name] = local.version;
  }
  fs.writeFileSync(
    path.join(output, "package.json"),
    `${JSON.stringify(published, null, 2)}\n`,
  );
  return output;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  stageDiffConsumer(process.cwd());
}
