import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createHostHarness, createIsolatedEnvironment, createTuiContext } from "./harness.ts";

/**
 * After the Starline removal, the retired user-message settings must stop
 * applying without failing the session. The upstream once-per-process warning
 * is the user-visible migration path, so assert its text and its deduplication
 * here, on the real extension entry and an isolated config file.
 */
test("pi-starline warns once about retired user-message keys and still loads", async () => {
  const environment = createIsolatedEnvironment();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(" "));
  };
  try {
    writeFileSync(
      join(environment.agentDir, "starline.json"),
      `${JSON.stringify(
        {
          userMessagePaddingY: 0,
          colors: { userMessageBorder: "accent", userMessageText: "accent" },
          colorSources: { userMessages: "terminal" },
          mouse: { transcriptCleanCopy: false },
        },
        null,
        2,
      )}\n`,
    );

    const host = createHostHarness();
    await host.load("pi-starline");

    const moved = warnings.filter((line) => line.includes("User messages are styled by pi-tidy now"));
    assert.equal(moved.length, 1, "the retired keys produce exactly one warning");
    for (const key of [
      "userMessagePaddingY",
      "colors.userMessageBorder",
      "colors.userMessageText",
      "colorSources.userMessages",
    ]) {
      assert.match(moved[0] ?? "", new RegExp(key.replaceAll(".", "\\.")), `the warning names ${key}`);
    }

    // Loading again in the same process must stay silent: the warning is a
    // one-time migration note, not per-session noise.
    await host.load("pi-starline");
    assert.equal(
      warnings.filter((line) => line.includes("User messages are styled by pi-tidy now")).length,
      1,
      "the migration warning is deduplicated per process",
    );

    const ctx = await createTuiContext(environment.home);
    await host.fire("session_start", ctx);
    await host.fire("session_shutdown", ctx, { reason: "reload" });
  } finally {
    console.warn = originalWarn;
    environment.cleanup();
  }
});
