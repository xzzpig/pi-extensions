import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { warnIfLinuxUnenforcedGlobsSafely } from "../src/fork-ui-warnings.ts";
import { loadConfig, mergeProfileLayers } from "../src/profile-config.ts";
import { buildRuntimeConfig } from "../src/sandbox-runtime.ts";

for (const withProfiles of [false, true]) {
  test(`untrusted no-profile config ignores project overrides (registry=${withProfiles})`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-fork-sync-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const previousProfile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    try {
      process.env.PI_CODING_AGENT_DIR = join(root, "agent");
      delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
      mkdirSync(process.env.PI_CODING_AGENT_DIR);
      mkdirSync(join(root, ".pi"));
      writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR, "sandbox.json"),
        JSON.stringify({
          enabled: true,
          ...(withProfiles ? { profiles: { reviewer: {} } } : {}),
        }),
      );
      writeFileSync(join(root, ".pi/sandbox.json"), '{ /* untrusted */ "enabled": false }');
      assert.equal(loadConfig(root, { projectTrusted: false }).enabled, true);
      assert.equal(loadConfig(root, { projectTrusted: true }).enabled, false);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (previousProfile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
      else process.env.PI_SUBAGENT_SANDBOX_PROFILE = previousProfile;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("profiles parse JSONC through the upstream parser", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-profile-jsonc-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    writeFileSync(
      join(root, "sandbox.json"),
      `{
      // A global profile can contain ordinary JSONC comments.
      "profiles": { "reviewer": { "network": { "allowedDomains": ["example.com"] } } }
    }`,
    );
    const config = loadConfig(root, { profileName: "reviewer", projectTrusted: false });
    assert.deepEqual(config.network?.allowedDomains, ["example.com"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("mandatory CWD opt-out preserves profile explicit hard denies at the session cwd", () => {
  const cwd = join(tmpdir(), "pi-sandbox-session-cwd");
  const config = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      filesystem: { denyMandatoryCwdFiles: false, protectNonexistentFiles: false },
      profiles: { reviewer: { filesystem: { denyWrite: ["missing.secret"] } } },
    },
    {},
    "reviewer",
  );
  const runtime = buildRuntimeConfig(config, undefined, "linux", cwd);
  assert.equal(runtime.filesystem.denyMandatoryCwdFiles, false);
  assert.equal(runtime.filesystem.protectNonexistentFiles, true);
  assert.ok(runtime.filesystem.denyWrite.includes(join(cwd, "missing.secret")));
});

test("ordinary pi-sandbox opt-out still filters nonexistent literal denyWrite entries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-no-placeholders-"));
  try {
    const runtime = buildRuntimeConfig(
      {
        ...DEFAULT_CONFIG,
        filesystem: {
          ...DEFAULT_CONFIG.filesystem!,
          protectNonexistentFiles: false,
          denyMandatoryCwdFiles: false,
          denyWrite: ["missing.secret", "*.secret"],
        },
      },
      undefined,
      "linux",
      cwd,
    );
    assert.equal(runtime.filesystem.denyMandatoryCwdFiles, false);
    assert.deepEqual(runtime.filesystem.denyWrite, [join(cwd, "*.secret")]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Linux write-glob warnings cannot fail headless initialization", () => {
  assert.doesNotThrow(() =>
    warnIfLinuxUnenforcedGlobsSafely(
      {
        ui: {
          notify: () => {
            throw new Error("renderer unavailable");
          },
        },
      } as never,
      {
        ...DEFAULT_CONFIG,
        filesystem: { ...DEFAULT_CONFIG.filesystem!, allowWrite: ["*.custom"] },
      },
    ),
  );
});
