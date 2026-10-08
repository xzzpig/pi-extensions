import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test(
  "real SDK pre-dispatch capture serializes minimized new Goal-X content without cleaning old messages",
  { timeout: 30000 },
  async () => {
    // Clear the parent's test context so the nested worker emits observable TAP.
    const { NODE_TEST_CONTEXT: _dropped, ...childEnv } = process.env;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--experimental-strip-types",
        "--test",
        fileURLToPath(
          new URL("../goal-model-view-sdk-worker.ts", import.meta.url),
        ),
      ],
      { timeout: 25000, env: childEnv },
    );
    assert.match(stdout, /(?:#|ℹ) pass 2/);
    assert.match(stdout, /(?:#|ℹ) fail 0/);
  },
);
