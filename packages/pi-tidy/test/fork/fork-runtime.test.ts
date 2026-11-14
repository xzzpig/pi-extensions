import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.ts";
import { applyForkDefaults, loadForkConfig } from "../../fork/defaults.ts";
import { installForkToolFrames, type ForkToolFrameInstallers } from "../../fork/install.ts";
const fakePi = { on() {} } as unknown as ExtensionAPI;

function withSettings(settings: object, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-fork-settings-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fork omission defaults do not mutate upstream loadConfig defaults", () => {
  withSettings({ tidy: {} }, () => {
    const upstream = loadConfig();
    const before = structuredClone(upstream);
    const fork = loadForkConfig();

    assert.deepEqual(upstream, before);
    assert.equal(fork.frameTools, false);
    assert.equal(fork.frameMessages, true);
    assert.equal(fork.highlightBash, false);
    assert.equal(fork.collapseTurns, "off");
    assert.equal(fork.groupTools, false);
    assert.equal(fork.splitDiff, false);
    assert.equal(fork.backgroundJobs, false);
    assert.equal(fork.cleanCopy, false);
    assert.deepEqual(fork.toolColors, {});
    assert.equal(fork.userMessageStyle, "frame");
    assert.equal(fork.dedupeErrors, true);
    assert.equal(fork.hexSwatches, true);
    assert.equal(fork.finalReplyStyle, "frame");
    assert.equal(fork.codeBlocks, true);

    // The upstream loader still has its own original defaults after fork adaptation.
    assert.equal(loadConfig().frameMessages, true);
    assert.equal(loadConfig().groupTools, true);
    assert.equal(loadConfig().cleanCopy, true);
  });
});

test("explicit tidy settings override fork defaults, including the new frameTools key", () => {
  withSettings(
    {
      tidy: {
        frameTools: true,
        frameMessages: true,
        highlightBash: true,
        collapseTurns: "live",
        groupTools: true,
        splitDiff: true,
        backgroundJobs: true,
        cleanCopy: true,
        toolColors: { bash: "warning" },
        userMessageStyle: "rail",
        dedupeErrors: false,
        hexSwatches: false,
        finalReplyStyle: "rules",
        codeBlocks: false,
      },
    },
    () => {
      const fork = loadForkConfig();
      assert.equal(fork.frameTools, true);
      assert.equal(fork.frameMessages, true);
      assert.equal(fork.highlightBash, true);
      assert.equal(fork.collapseTurns, "live");
      assert.equal(fork.groupTools, true);
      assert.equal(fork.splitDiff, true);
      assert.equal(fork.backgroundJobs, true);
      assert.equal(fork.cleanCopy, true);
      assert.deepEqual(fork.toolColors, { bash: "warning" });
      assert.equal(fork.userMessageStyle, "rail");
      assert.equal(fork.dedupeErrors, false);
      assert.equal(fork.hexSwatches, false);
      assert.equal(fork.finalReplyStyle, "rules");
      assert.equal(fork.codeBlocks, false);
    },
  );
});

test("legacy toolbox settings are still the source of explicit fork options", () => {
  withSettings({ toolbox: { frameTools: true, cleanCopy: true, groupTools: true } }, () => {
    const fork = loadForkConfig();
    assert.equal(fork.frameTools, true);
    assert.equal(fork.cleanCopy, true);
    assert.equal(fork.groupTools, true);
  });
});

test("frameTools=false skips patchToolBoxFrames and installs hover tracking alone", () => {
  withSettings({ tidy: {} }, () => {
    const upstream = loadConfig();
    const config = applyForkDefaults(upstream, { tidy: {} });
    const calls: string[] = [];
    const installers: ForkToolFrameInstallers = {
      patchToolBoxFrames: () => calls.push("patchToolBoxFrames"),
      installHoverTracking: () => calls.push("installHoverTracking"),
    };

    installForkToolFrames(config, fakePi, installers);

    assert.deepEqual(calls, ["installHoverTracking"]);
  });
});

test("frameTools=true delegates frame options to patchToolBoxFrames", () => {
  withSettings({ tidy: { frameTools: true, icons: false, groupTools: true, toolColors: { bash: "warning" } } }, () => {
    const upstream = loadConfig();
    const config = applyForkDefaults(upstream, {
      tidy: { frameTools: true, icons: false, groupTools: true, toolColors: { bash: "warning" } },
    });
    const calls: string[] = [];
    const installers: ForkToolFrameInstallers = {
      patchToolBoxFrames: (options) => {
        calls.push("patchToolBoxFrames");
        assert.equal(options.icons, false);
        assert.equal(options.groupTools, true);
        assert.deepEqual(options.toolColors, { bash: "warning" });
      },
      installHoverTracking: () => calls.push("installHoverTracking"),
    };

    installForkToolFrames(config, fakePi, installers);

    assert.deepEqual(calls, ["patchToolBoxFrames"]);
  });
});
