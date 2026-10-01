import { test } from "node:test";

import assert from "node:assert/strict";

import { type SandboxConfig } from "../src/config.ts";
import { applySandboxConfigChange } from "../src/fork-profile-network.ts";
import { sandboxManagerFactory } from "../src/sandbox-runtime.ts";

const ALLOWANCES = { domains: [], readPaths: [], writePaths: [] };

/** A profile-shaped config: network restriction on, so a proxy is required. */
const restrictedConfig = (): SandboxConfig => ({
  network: { allowedDomains: ["example.com"], deniedDomains: [], disabled: false },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
});

/** The user's global shape: network restriction off, so no proxy is started. */
const unrestrictedConfig = (): SandboxConfig => ({
  network: { allowedDomains: [], deniedDomains: [], disabled: true },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
});

/**
 * Substitute a recording stub for the real manager's network methods. The
 * proxy is never started; `waitForNetworkInitialization` reports whether the
 * runtime believes one exists, which is the condition under test.
 */
function makeRecordingManager(proxyReady: boolean) {
  const calls: string[] = [];
  const manager = sandboxManagerFactory.create();
  manager.waitForNetworkInitialization = async () => proxyReady;
  manager.reset = async () => {
    calls.push("reset");
  };
  manager.initialize = async () => {
    calls.push("initialize");
  };
  manager.updateConfig = () => {
    calls.push("updateConfig");
  };
  return { manager, calls };
}

test("turning network restriction on without a proxy re-initializes the manager", async () => {
  const { manager, calls } = makeRecordingManager(false);

  await applySandboxConfigChange(manager, restrictedConfig(), ALLOWANCES);

  assert.deepEqual(calls, ["reset", "initialize"]);
});

test("a restricted config with a live proxy stays an in-place update", async () => {
  const { manager, calls } = makeRecordingManager(true);

  await applySandboxConfigChange(manager, restrictedConfig(), ALLOWANCES);

  assert.deepEqual(calls, ["updateConfig"]);
});

test("an unrestricted config never forces re-initialization", async () => {
  const { manager, calls } = makeRecordingManager(false);

  await applySandboxConfigChange(manager, unrestrictedConfig(), ALLOWANCES);

  assert.deepEqual(calls, ["updateConfig"]);
});
