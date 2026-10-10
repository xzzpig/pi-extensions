import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  buildRuntimeConfig,
  createSandboxedBashOps,
  sandboxManagerFactory,
} from "../src/sandbox-runtime.ts";

for (const platform of ["linux", "darwin"] as const) {
  test(`${platform} filesystem globs retain syntax and resolve against session cwd`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-session-globs-"));
    const session = join(root, "session");
    mkdirSync(session);
    try {
      const config = buildRuntimeConfig(
        {
          ...DEFAULT_CONFIG,
          filesystem: {
            denyRead: ["secrets/*.txt", "private/file?.json", "docs/[ab].md"],
            allowRead: ["source/**"],
            allowWrite: ["output/**"],
            denyWrite: ["*.secret", "~/private/*.key", "file?.secret", "[ab].secret"],
            protectNonexistentFiles: false,
          },
        },
        undefined,
        platform,
        session,
      );
      assert.deepEqual(config.filesystem.denyRead, [
        join(session, "secrets/*.txt"),
        join(session, "private/file?.json"),
        join(session, "docs/[ab].md"),
      ]);
      assert.ok(config.filesystem.allowRead!.includes(join(session, "source/**")));
      assert.ok(config.filesystem.allowRead!.includes(join(session, "output/**")));
      assert.deepEqual(config.filesystem.allowWrite, [join(session, "output/**")]);
      assert.deepEqual(config.filesystem.denyWrite, [
        join(session, "*.secret"),
        join(homedir(), "private/*.key"),
        join(session, "file?.secret"),
        join(session, "[ab].secret"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("sandboxed bash passes its execution cwd and abort signal into the runtime wrapper", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-wrapper-"));
  const manager = sandboxManagerFactory.create();
  let observed: unknown[] = [];
  manager.wrapWithSandbox = async (...args) => {
    observed = args;
    return "printf safe";
  };
  manager.cleanupAfterCommand = () => {};
  const controller = new AbortController();
  try {
    const operations = createSandboxedBashOps(manager);
    const result = await operations.exec("printf original", root, {
      signal: controller.signal,
      onData() {},
      env: process.env,
      timeout: 5,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(observed[3], controller.signal);
    assert.equal(observed[4], root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "Linux runtime enforces session-relative read globs and trailing-glob write grants",
  { skip: process.platform !== "linux" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-session-glob-exec-"));
    const session = join(root, "session");
    mkdirSync(join(session, "private"), { recursive: true });
    mkdirSync(join(session, "output"));
    writeFileSync(join(session, "private/secret.txt"), "must-not-be-readable");
    const host = process.cwd();
    const manager = sandboxManagerFactory.create();
    try {
      await manager.initialize(
        buildRuntimeConfig(
          {
            ...DEFAULT_CONFIG,
            network: { allowedDomains: [], deniedDomains: [], disabled: true },
            filesystem: {
              denyRead: ["private/*.txt"],
              allowRead: [],
              allowWrite: ["output/**"],
              denyWrite: [],
              protectNonexistentFiles: false,
              denyMandatoryCwdFiles: false,
            },
            enableWeakerNestedSandbox: true,
          },
          undefined,
          "linux",
          session,
        ),
      );
      const operations = createSandboxedBashOps(manager);
      let output = "";
      const denied = await operations.exec("cat private/secret.txt", session, {
        onData: (data) => {
          output += data.toString();
        },
        env: process.env,
        timeout: 5,
      });
      assert.notEqual(denied.exitCode, 0);
      assert.ok(!output.includes("must-not-be-readable"));
      output = "";
      const allowed = await operations.exec(
        "printf permitted > output/result.txt; cat output/result.txt",
        session,
        {
          onData: (data) => {
            output += data.toString();
          },
          env: process.env,
          timeout: 5,
        },
      );
      assert.equal(allowed.exitCode, 0, output);
      assert.equal(output, "permitted");
      assert.equal(process.cwd(), host);
    } finally {
      await manager.reset();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
