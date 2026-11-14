import assert from "node:assert/strict";
import { test } from "node:test";

import { createHostHarness, createIsolatedEnvironment } from "./harness.ts";

test("isolated harness loads pi-tidy and captures its command and renderers", async () => {
  const environment = createIsolatedEnvironment();
  try {
    const host = createHostHarness();
    await host.load("pi-tidy");

    assert.deepEqual(host.loadedPlugins, ["pi-tidy"]);
    assert.ok(host.commands.has("tidy"), "the real extension registered its /tidy command");
    assert.ok(host.toolRenderers.length > 0, "the Pi 1.5 renderer API received tidy resolvers");
    assert.ok(host.toolRenderers.every(({ owner }) => owner === "pi-tidy"));
    assert.equal(environment.agentDir, process.env.PI_CODING_AGENT_DIR);
  } finally {
    environment.cleanup();
  }
});
