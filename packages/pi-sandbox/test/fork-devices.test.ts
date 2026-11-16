import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG, type SandboxConfigFile } from "../src/config.ts";
import { createProfileStartupHelpers } from "../src/fork-profile-startup.ts";
import {
  loadConfig,
  mergeConfigLayers,
  mergeProfileLayers,
  validateProfileConfig,
} from "../src/profile-config.ts";
import { buildRuntimeConfig } from "../src/sandbox-runtime.ts";

const A = "/dev/kvm";
const B = "/dev/net/tun";

test("top-level device lists union and runtime conversion preserves explicit paths", () => {
  const config = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { allowDevices: [A] } },
    { filesystem: { allowDevices: [A, B] } },
  );
  assert.deepEqual(config.filesystem?.allowDevices, [A, B]);
  assert.deepEqual(buildRuntimeConfig(config, undefined, "linux").filesystem.allowDevices, [A, B]);
});

for (const devices of [undefined, [], [B]]) {
  test(`profile device override ${JSON.stringify(devices)}`, () => {
    const global: SandboxConfigFile = {
      filesystem: { allowDevices: [A] },
      profiles: { dev: { filesystem: devices === undefined ? {} : { allowDevices: devices } } },
    };
    const result = mergeProfileLayers(DEFAULT_CONFIG, global, {}, "dev", true);
    assert.deepEqual(result.filesystem?.allowDevices, devices ?? [A]);
  });
}

test("same-name project profile replaces devices; inheritance false drops global devices", () => {
  const global: SandboxConfigFile = {
    filesystem: { allowDevices: [A] },
    profiles: { dev: { filesystem: { allowDevices: [A] } }, clean: { inheritGlobalConfig: false } },
  };
  const project: SandboxConfigFile = { profiles: { dev: { filesystem: { allowDevices: [B] } } } };
  assert.deepEqual(
    mergeProfileLayers(DEFAULT_CONFIG, global, project, "dev", true).filesystem?.allowDevices,
    [B],
  );
  assert.deepEqual(
    mergeProfileLayers(DEFAULT_CONFIG, global, project, "dev", false).filesystem?.allowDevices,
    [A],
  );
  assert.equal(
    mergeProfileLayers(DEFAULT_CONFIG, global, {}, "clean", true).filesystem?.allowDevices,
    undefined,
  );
  assert.deepEqual(
    mergeProfileLayers(DEFAULT_CONFIG, global, {}, "dev", true).filesystem?.allowDevices,
    [A],
  );
});

for (const trusted of [true, false, undefined]) {
  for (const withProfiles of [true, false]) {
    test(`project devices require affirmative trust=${trusted}, registry=${withProfiles}`, () => {
      const root = mkdtempSync(join(tmpdir(), "pi-device-config-"));
      const saved = process.env.PI_CODING_AGENT_DIR;
      const profile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
      try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
        mkdirSync(process.env.PI_CODING_AGENT_DIR);
        mkdirSync(join(root, ".pi"));
        writeFileSync(
          join(process.env.PI_CODING_AGENT_DIR, "sandbox.json"),
          JSON.stringify({
            filesystem: { allowDevices: [A] },
            ...(withProfiles ? { profiles: { dev: {} } } : {}),
          }),
        );
        writeFileSync(
          join(root, ".pi/sandbox.json"),
          JSON.stringify({ filesystem: { allowDevices: [B] } }),
        );
        const warnings: string[] = [];
        const config = loadConfig(root, {
          projectTrusted: trusted,
          onWarning: (w) => warnings.push(w),
        });
        assert.deepEqual(config.filesystem?.allowDevices, trusted === true ? [A, B] : [A]);
        assert.equal(
          warnings.some((w) => w.includes("allowDevices")),
          trusted !== true,
        );
        if (withProfiles) {
          const selected = loadConfig(root, { profileName: "dev", projectTrusted: trusted });
          assert.deepEqual(selected.filesystem?.allowDevices, trusted === true ? [A, B] : [A]);
        }
      } finally {
        if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = saved;
        if (profile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
        else process.env.PI_SUBAGENT_SANDBOX_PROFILE = profile;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("invalid device list is rejected rather than discarded by config merge/profile", () => {
  assert.throws(
    () =>
      mergeConfigLayers(
        DEFAULT_CONFIG,
        { filesystem: { allowDevices: "/dev/kvm" } } as unknown as SandboxConfigFile,
        {},
      ),
    /allowDevices/,
  );
  assert.throws(
    () => validateProfileConfig({ filesystem: { allowDevices: ["/dev/*"] } }, "dev"),
    /invalid sandbox runtime/,
  );
});

test("device startup failure blocks no-profile session", () => {
  let error: string | undefined;
  let unavailable = false;
  let requested = false;
  const helper = createProfileStartupHelpers({
    selectedProfile: () => undefined,
    deviceAccessRequested: () => requested,
    startupError: () => error,
    setStartupError: (e) => {
      error = e;
    },
    sandboxInitialized: () => false,
    setSandboxUnavailable: () => {
      unavailable = true;
    },
    profileTrusted: () => false,
    lastStatusContext: () => undefined,
    notifySafely: () => {},
  });
  helper.recordProfileStartupFailure(new Error("filesystem.allowDevices: missing device"));
  assert.equal(unavailable, true);
  assert.match(helper.profileBlockReason()!, /allowDevices.*missing device/);
  error = undefined;
  requested = true;
  helper.recordProfileStartupFailure(new Error("proxy reinitialization failed"));
  assert.match(helper.profileBlockReason()!, /proxy reinitialization failed/);
});
