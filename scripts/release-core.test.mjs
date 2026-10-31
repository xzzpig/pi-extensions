import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkScripts, gatePackages } from "./release.mjs";
import {
  planRelease,
  registryJson,
  compare,
  checkTarEntries,
  checkPackedManifest,
  publishArtifacts,
  checkArchive,
  readJson,
  workspaceDeps,
  order,
} from "./release-core.mjs";
const pkg = (dir, rest = {}) => ({
  dir,
  name: `@xzzpig/${dir}`,
  version: "1.0.0",
  repository: { url: "git+https://github.com/xzzpig/pi-extensions.git" },
  ...rest,
});
const a = pkg("pi-a"),
  b = pkg("pi-b", { dependencies: { [a.name]: "workspace:*" } });
const makePlan = (all, lookup = async () => null, only = []) =>
  planRelease({
    all,
    lookup,
    only,
    versions: Object.fromEntries(all.map((p) => [p.dir, p.version])),
  });
test("peer ranges cannot hide workspace dev dependencies", async () => {
  const consumer = {
    ...b,
    dependencies: {},
    devDependencies: { [a.name]: "workspace:*" },
    peerDependencies: { [a.name]: "*" },
  };
  assert.deepEqual(workspaceDeps(consumer, true), [[a.name, "workspace:*"]]);
  assert.deepEqual(order([consumer, a], [consumer, a], true), [a, consumer]);
  assert.deepEqual((await makePlan([consumer, a])).todo, [a, consumer]);
});
test("clean-workspace checks build public artifacts before self/consumer checks", () => {
  const dependency = {
    ...a,
    publishConfig: { directory: "dist-pkg" },
    scripts: {
      build: "build",
      "build:types": "types",
      prepack: "pack",
      typecheck: "types",
      test: "tests",
      prepublishOnly: "verify",
    },
  };
  assert.deepEqual(checkScripts(dependency), [
    "build",
    "build:types",
    "prepack",
    "typecheck",
    "test",
    "prepublishOnly",
  ]);
  assert.deepEqual(gatePackages([b, dependency], [b]), [dependency, b]);
});
test("stable numeric comparison and prerelease rejection", async () => {
  assert.equal(compare("1.10.0", "1.9.0"), 1);
  await assert.rejects(
    makePlan([pkg("pi-a", { version: "1.0.0-beta.1" })]),
    /stable/,
  );
});
test("discovery selection excludes private and support packages", async () => {
  const result = await makePlan([
    a,
    pkg("pi-components", { private: true }),
    pkg("sandbox-runtime"),
  ]);
  assert.deepEqual(result.todo, [a]);
  await assert.rejects(makePlan([a], undefined, ["typo"]), /Unknown/);
  await assert.rejects(
    makePlan([pkg("pi-components", { private: true })], undefined, [
      "pi-components",
    ]),
    /excluded/,
  );
});
test("empty selection and all already published succeed", async () => {
  assert.equal((await makePlan([])).todo.length, 0);
  assert.equal((await makePlan([a], async () => a)).todo.length, 0);
});
test("dependency order, single-package filtering and availability", async () => {
  assert.deepEqual(
    (await makePlan([b, a])).todo.map((p) => p.dir),
    ["pi-a", "pi-b"],
  );
  await assert.rejects(makePlan([a, b], undefined, ["pi-b"]), /unavailable/);
  const p = await makePlan(
    [a, b],
    async (name, version) => (version && name === a.name ? a : null),
    ["pi-b"],
  );
  assert.deepEqual(p.todo, [b]);
});
test("version rollback/equal registry version rejected", async () => {
  for (const version of ["1.0.0", "2.0.0"])
    await assert.rejects(
      makePlan([a], async (_name, exact) =>
        exact ? null : { versions: { [version]: {} } },
      ),
      /increase/,
    );
});
test("manifest mismatch, wrong repository and private dependency fail", async () => {
  await assert.rejects(
    planRelease({ all: [a], versions: {}, lookup: async () => null }),
    /mismatch/,
  );
  await assert.rejects(
    makePlan([
      { ...a, repository: { url: "https://github.com/upstream/other.git" } },
    ]),
    /repository/,
  );
  await assert.rejects(makePlan([{ ...a, private: true }, b]), /private/);
  const bundled = { ...b, bundledDependencies: [a.name] };
  assert.deepEqual((await makePlan([{ ...a, private: true }, bundled])).todo, [
    bundled,
  ]);
});
test("missing workspace dependency and cycle fail", async () => {
  await assert.rejects(makePlan([b]), /Unknown workspace/);
  await assert.rejects(
    makePlan([{ ...a, dependencies: { [b.name]: "workspace:*" } }, b]),
    /cycle/,
  );
});
test("registry 404 only means absent; auth, network and malformed JSON fail", async () => {
  assert.equal(
    await registryJson("http://registry", "x", async () => ({ status: 404 })),
    null,
  );
  for (const status of [401, 403, 429, 500]) {
    let attempts = 0;
    await assert.rejects(
      registryJson("http://registry", "x", async () => {
        attempts++;
        return { status, ok: false };
      }),
      /lookup failed/,
    );
    assert.equal(attempts, 3);
  }
  await assert.rejects(
    registryJson("http://registry", "x", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(
    registryJson("http://registry", "x", async () => ({
      ok: true,
      status: 200,
      json: () => {
        throw new Error("invalid JSON");
      },
    })),
    /invalid JSON/,
  );
});
test("archive gate, contextual JSON error", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkArchive(root);
  fs.mkdirSync(path.join(root, "openspec/changes/unfinished"), {
    recursive: true,
  });
  assert.throws(() => checkArchive(root), /unfinished/);
  fs.writeFileSync(path.join(root, "bad.json"), "{");
  assert.throws(
    () => readJson(path.join(root, "bad.json")),
    /Cannot read JSON/,
  );
});
test("archive safety, secrets and test exclusion", () => {
  checkTarEntries(["package/package.json", "package/src/index.ts"]);
  for (const bad of [
    "../../escape",
    "package/../escape",
    "package/.env",
    "package/.env.local",
    "package/.npmrc",
    "package/test/a.ts",
    "package/foo.test.ts",
    "package/.git/config",
  ])
    assert.throws(() => checkTarEntries([bad]));
});
test("built-directory artifact entries, declarations, bundle and resolved deps", () => {
  const source = { ...a, scripts: { "build:types": "build" } };
  const packed = {
    ...a,
    pi: { extensions: ["./bundle/index.js"] },
    types: "dist/public.d.ts",
  };
  const entries = [
    "package/package.json",
    "package/bundle/index.js",
    "package/dist/public.d.ts",
  ];
  checkPackedManifest(source, packed, entries);
  assert.throws(
    () => checkPackedManifest(source, packed, entries.slice(0, 1)),
    /Missing/,
  );
  assert.throws(
    () =>
      checkPackedManifest(
        a,
        { ...a, dependencies: { x: "workspace:*" } },
        entries,
      ),
    /Unresolved/,
  );
  assert.throws(
    () => checkPackedManifest(a, { ...a, version: "0.0.1" }, entries),
    /identity/,
  );
  assert.throws(
    () => checkPackedManifest(a, { ...a, bundledDependencies: ["x"] }, entries),
    /bundled/,
  );
});
test("all-artifact publish order, partial failure and idempotent retry", async () => {
  const artifacts = [a, b].map((p) => ({ ...p, integrity: "sha512-example" }));
  const published = new Map(),
    uploads = [];
  const lookup = async (name) => published.get(name) ?? null;
  const upload = async (p) => {
    uploads.push(p.name);
    if (p.name === b.name) throw new Error("upload failed");
    published.set(p.name, { dist: { integrity: p.integrity } });
  };
  await assert.rejects(
    publishArtifacts(artifacts, { lookup, upload, report: () => {} }),
    /upload failed/,
  );
  await publishArtifacts(artifacts, {
    lookup,
    upload: async (p) => {
      uploads.push(p.name);
      published.set(p.name, { dist: { integrity: p.integrity } });
    },
    report: () => {},
  });
  assert.deepEqual(uploads, [a.name, b.name, b.name]);
});
test("verification uncertainty, network failure and integrity mismatch are fatal", async () => {
  const artifact = { ...a, integrity: "sha512-correct" };
  await assert.rejects(
    publishArtifacts([artifact], {
      lookup: async () => null,
      upload: async () => {},
      delay: async () => {},
    }),
    /not verifiable/,
  );
  let uploaded = false;
  await assert.rejects(
    publishArtifacts([artifact], {
      lookup: async () => {
        if (uploaded) throw new Error("network");
        return null;
      },
      upload: async () => {
        uploaded = true;
      },
    }),
    /network/,
  );
  uploaded = false;
  await assert.rejects(
    publishArtifacts([artifact], {
      lookup: async () => (uploaded ? { dist: { integrity: "wrong" } } : null),
      upload: async () => {
        uploaded = true;
      },
    }),
    /integrity/,
  );
});
