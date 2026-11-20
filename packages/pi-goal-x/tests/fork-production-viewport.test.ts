import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("real SDK chat viewport and editor Container regression suite", () => {
  // Run a child without the unit runner's SDK stubs: the private production
  // createChatViewport and its TuiAltScreen must use the actual installed SDK.
  const fixture = fileURLToPath(
    new URL("./fixtures/fork-production-viewport-child.ts", import.meta.url),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--test", fixture],
    { encoding: "utf8", timeout: 120_000, env },
  );
  assert.match(output, /(?:#|ℹ)\s+pass 73/);
  assert.match(output, /(?:#|ℹ)\s+fail 0/);
});
