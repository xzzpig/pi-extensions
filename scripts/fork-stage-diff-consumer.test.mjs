import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stageDiffConsumer } from "./fork-stage-diff-consumer.mjs";

function fixture(dir = "pi-goal-x") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-diff-"));
  const root = path.join(temp, dir);
  const components = path.join(temp, "pi-components");
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(components, "dist/src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "extensions/index.ts"),
    "export default () => {};\n",
  );
  fs.writeFileSync(
    path.join(components, "dist/src/diff.js"),
    "export const test = 1;\n",
  );
  fs.writeFileSync(
    path.join(components, "dist/src/diff.d.ts"),
    "export declare const test: number;\n",
  );
  fs.writeFileSync(
    path.join(components, "package.json"),
    JSON.stringify({
      name: "@xzzpig/pi-components",
      version: "0.5.0",
      private: true,
      exports: {
        "./diff": { types: "./dist/src/diff.d.ts", default: "./src/diff.ts" },
      },
      peerDependencies: { "@earendil-works/pi-tui": ">=1 <2" },
    }),
  );
  const manifest = {
    name: `@xzzpig/${dir}`,
    version: "1.0.0",
    files: ["extensions"],
    publishConfig: {
      access: "public",
      directory: "dist-pkg",
      linkDirectory: false,
    },
    dependencies: { "@xzzpig/pi-components": "workspace:*" },
    bundledDependencies: ["@xzzpig/pi-components"],
    scripts: { prepack: "build", postinstall: "existing" },
    devDependencies: { typescript: "1" },
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  return {
    temp,
    root,
    components,
    manifest,
    close: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

test("each staged consumer has its own compiled private diff and resolved manifest", () => {
  for (const name of ["pi-goal-x", "pi-tool-display"]) {
    const f = fixture(name);
    try {
      const output = stageDiffConsumer(f.root);
      const result = JSON.parse(
        fs.readFileSync(path.join(output, "package.json"), "utf8"),
      );
      const componentRoot = path.join(
        output,
        "node_modules/@xzzpig/pi-components",
      );
      const component = JSON.parse(
        fs.readFileSync(path.join(componentRoot, "package.json"), "utf8"),
      );
      assert.equal(result.dependencies["@xzzpig/pi-components"], "0.5.0");
      assert.deepEqual(result.bundledDependencies, ["@xzzpig/pi-components"]);
      assert.equal(result.scripts.postinstall, "existing");
      assert.equal(result.scripts.prepack, undefined);
      assert.equal(result.publishConfig.directory, undefined);
      assert.equal(result.publishConfig.linkDirectory, undefined);
      assert.equal(result.devDependencies, undefined);
      assert.deepEqual(Object.keys(component.exports), ["./diff"]);
      assert.equal(component.exports["./diff"].default, "./dist/src/diff.js");
      assert.equal(component.exports["./diff"].types, "./dist/src/diff.d.ts");
      assert.equal(
        fs.readFileSync(
          path.join(componentRoot, component.exports["./diff"].default),
          "utf8",
        ),
        "export const test = 1;\n",
      );
      assert.ok(
        fs.existsSync(
          path.join(componentRoot, component.exports["./diff"].types),
        ),
      );
      assert.equal(fs.existsSync(path.join(componentRoot, "src")), false);
      assert.equal(fs.lstatSync(componentRoot).isSymbolicLink(), false);
    } finally {
      f.close();
    }
  }
});

test("staging refuses missing compiled input, unsafe paths and external links", () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.components, "dist/src/diff.js"));
    assert.throws(() => stageDiffConsumer(f.root), /Build pi-components first/);
    fs.writeFileSync(
      path.join(f.components, "dist/src/diff.js"),
      "export {};\n",
    );
    fs.symlinkSync(
      path.join(f.temp, "outside"),
      path.join(f.root, "extensions/escape"),
    );
    assert.throws(() => stageDiffConsumer(f.root), /symlink/);
    fs.rmSync(path.join(f.root, "extensions/escape"));
    fs.writeFileSync(
      path.join(f.root, "package.json"),
      JSON.stringify({ ...f.manifest, files: ["../private"] }),
    );
    assert.throws(() => stageDiffConsumer(f.root), /Unsupported package file/);
  } finally {
    f.close();
  }
});
