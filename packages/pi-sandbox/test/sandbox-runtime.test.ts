import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SandboxConfig } from "../src/config.ts";

import { DEFAULT_CONFIG, mergeConfigLayers } from "../src/config.ts";
import { canonicalizePath } from "../src/policy.ts";
import {
  buildRuntimeConfig,
  extractBlockedWritePath,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
  });
  assert.equal(runtime.network?.allowedDomains?.includes("example.com"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("buildRuntimeConfig canonicalizes non-glob filesystem paths", () => {
  const runtime = buildRuntimeConfig({
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      denyRead: ["/tmp"],
      allowRead: [],
      allowWrite: ["/tmp"],
      denyWrite: ["*.key"],
    },
  });

  assert.deepEqual(runtime.filesystem?.denyRead, [canonicalizePath("/tmp")]);
  assert.equal(runtime.filesystem?.allowRead?.includes(canonicalizePath("/tmp")), true);
  assert.deepEqual(runtime.filesystem?.allowWrite, [canonicalizePath("/tmp")]);
  assert.deepEqual(runtime.filesystem?.denyWrite, ["*.key"]);
});

test("default denyWrite drops non-existent literal entries when the opt-out is active", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-sb-denytest-"));
  const originalCwd = process.cwd();
  process.chdir(tmp);
  try {
    // No .env in the project: the built-in default literal entry is dropped so
    // bwrap does not materialize a placeholder mount point for it. Glob
    // patterns pass through untouched.
    const runtime = buildRuntimeConfig(DEFAULT_CONFIG);
    assert.equal(runtime.filesystem?.denyWrite?.includes(canonicalizePath(".env")), false);
    assert.deepEqual(runtime.filesystem?.denyWrite, [".env.*", "*.pem", "*.key"]);

    // An existing .env keeps full write protection.
    writeFileSync(join(tmp, ".env"), "TEST=1");
    const withEnv = buildRuntimeConfig(DEFAULT_CONFIG);
    assert.equal(withEnv.filesystem?.denyWrite?.includes(canonicalizePath(".env")), true);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("user-configured denyWrite literals are filtered when non-existent (false)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-sb-denyuser-"));
  const originalCwd = process.cwd();
  process.chdir(tmp);
  try {
    // Default (false): a user-configured literal path that does not exist is
    // dropped entirely — no placeholder, no protection.
    const runtime = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(runtime.filesystem?.denyWrite, []);

    // An existing user-configured entry keeps full write protection.
    writeFileSync(join(tmp, "custom.key"), "k");
    const withExisting = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(withExisting.filesystem?.denyWrite, [canonicalizePath("custom.key")]);

    // Explicit true: legacy behavior — non-existent user denies stay in place
    // and are protected via placeholder mounts.
    const protectAll = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        protectNonexistentFiles: true,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(protectAll.filesystem?.denyWrite, [
      canonicalizePath("secrets/does-not-exist.env"),
      canonicalizePath("custom.key"),
    ]);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

test("DEFAULT_CONFIG disables placeholder protection for non-existent dangerous files", () => {
  // pi-sandbox wants encoding tools (git status, lint glob scans, …) to see the
  // real directory during a sandboxed run, so the default is the opposite of the
  // runtime default (true).
  assert.equal(DEFAULT_CONFIG.filesystem?.protectNonexistentFiles, false);
});

test("protectNonexistentFiles survives mergeConfigLayers and can be set to true", () => {
  const mergedDefault = mergeConfigLayers(DEFAULT_CONFIG, {}, {});
  assert.equal(mergedDefault.filesystem?.protectNonexistentFiles, false);

  const mergedTrue = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { protectNonexistentFiles: true } },
    {},
  );
  assert.equal(mergedTrue.filesystem?.protectNonexistentFiles, true);

  const mergedProjectOverride = mergeConfigLayers(
    DEFAULT_CONFIG,
    {},
    { filesystem: { protectNonexistentFiles: true } },
  );
  assert.equal(mergedProjectOverride.filesystem?.protectNonexistentFiles, true);

  const runtime = buildRuntimeConfig(mergedTrue, {
    domains: [],
    readPaths: [],
    writePaths: [],
  });
  assert.equal(runtime.filesystem?.protectNonexistentFiles, true);
});

test("buildRuntimeConfig passes network.disabled through to the runtime config", () => {
  const disabled: SandboxConfig = {
    ...DEFAULT_CONFIG,
    network: {
      ...DEFAULT_CONFIG.network,
      allowedDomains: ["example.com"],
      deniedDomains: [],
      disabled: true,
    },
  };

  const runtime = buildRuntimeConfig(disabled);
  assert.equal(runtime.network?.disabled, true);
  assert.deepEqual(runtime.network?.allowedDomains, ["example.com"]);

  // Default config leaves the flag unset, preserving today's behavior.
  const enabled = buildRuntimeConfig(DEFAULT_CONFIG);
  assert.equal(enabled.network?.disabled, undefined);
});
