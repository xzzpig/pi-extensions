/**
 * Session-replacement reclamation test (change task 5.3).
 *
 * Runs the GC probe fixture in its own process with --expose-gc (the
 * only honest way to assert reclamation), asserting: old-view components
 * become collectable after session replacement, strong tables reset to
 * the new view's scale, and the new session folds normally.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("session replacement reclamation", () => {
  test("old components are collectable and strong tables reset", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--experimental-strip-types",
        "test/fixtures/gc-probe.ts",
      ],
      { encoding: "utf8", cwd: process.cwd(), timeout: 60_000 },
    );
    expect(output).toContain("gc-probe-ok");
  }, 60_000);
});
