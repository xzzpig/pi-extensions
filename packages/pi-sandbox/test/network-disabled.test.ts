// UI surfaces for the network.disabled switch.
import test from "node:test";

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import { type SandboxConfig } from "../src/config.ts";
import {
  formatSandboxConfiguration,
  formatSandboxStatus,
  warnIfAllDomainsAllowed,
} from "../src/ui.ts";

const makeNotifySpyCtx = () => {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
};

test("status and configuration surfaces report unrestricted network when disabled", () => {
  const config = {
    network: { allowedDomains: [], deniedDomains: [], disabled: true },
    filesystem: { denyRead: [], allowWrite: ["/tmp"], denyWrite: [] },
  } as SandboxConfig;

  assert.match(formatSandboxStatus(config), /network unrestricted/);

  const text = formatSandboxConfiguration(
    config,
    { globalPath: "/global/sandbox.json", projectPath: "/project/.pi/sandbox.json" },
    { domains: [], readPaths: [], writePaths: [] },
  );
  assert.match(text, /network\.disabled: all network restrictions are off/);
});

test("all-domains warning stays silent when network.disabled suppresses prompts entirely", () => {
  const { ctx, notifications } = makeNotifySpyCtx();
  const config = {
    network: { allowedDomains: ["*"], deniedDomains: [], disabled: true },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  } as SandboxConfig;

  warnIfAllDomainsAllowed(ctx, config);
  assert.equal(notifications.length, 0);
});

test("all-domains warning still fires without network.disabled", () => {
  const { ctx, notifications } = makeNotifySpyCtx();
  const config = {
    network: { allowedDomains: ["*"], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  } as SandboxConfig;

  warnIfAllDomainsAllowed(ctx, config);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.message, /allows all domains/);
});
