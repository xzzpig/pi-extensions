import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { createProfileStartupHelpers } from "../src/fork-profile-startup.ts";

for (const selected of [undefined, "required"]) {
  for (const devices of [undefined, [], ["/dev/kvm"]]) {
    for (const failure of [new Error("proxy failed"), "proxy failed"]) {
      test(`initialization failure: profile=${selected}, devices=${JSON.stringify(devices)}, error=${typeof failure}`, () => {
        let startupError: string | undefined;
        let unavailable = false;
        const notices: string[] = [];
        const helper = createProfileStartupHelpers({
          selectedProfile: () => selected,
          deviceAccessRequested: () => false,
          startupError: () => startupError,
          setStartupError: (value) => {
            startupError = value;
          },
          sandboxInitialized: () => true,
          setSandboxUnavailable: () => {
            unavailable = true;
          },
          profileTrusted: () => false,
          lastStatusContext: () => undefined,
          notifySafely: (_ctx, message) => {
            notices.push(message);
          },
        });
        // The helper only forwards this context to the supplied notifier.
        const ctx = {} as ExtensionContext;
        helper.recordSandboxInitializationFailure(
          failure,
          {
            ...DEFAULT_CONFIG,
            filesystem: { ...DEFAULT_CONFIG.filesystem!, allowDevices: devices },
          },
          ctx,
        );
        const required = Boolean(selected) || devices !== undefined;
        assert.equal(unavailable, required);
        assert.equal(startupError !== undefined, required);
        assert.equal(notices.length, 1);
        assert.match(notices[0]!, /proxy failed/);
        if (devices !== undefined) assert.match(notices[0]!, /filesystem\.allowDevices:/);
        if (!required) assert.equal(notices[0], "Sandbox initialization failed: proxy failed");
        assert.equal(helper.profileBlockReason() !== undefined, required);
      });
    }
  }
}
