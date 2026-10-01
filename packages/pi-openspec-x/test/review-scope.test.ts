/**
 * Tests for the review-window scope (task 6.5). The pure tests pin rendering
 * and the non-git degradation; the fixture test runs the real goal-x baseline
 * and delta against a throwaway git repository and asserts the required
 * property — a file dirty BEFORE the window never enters the review scope.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureChangeBaseline } from "@xzzpig/pi-goal-x/extensions/goal-change-baseline.ts";
import { computeChangeDelta } from "@xzzpig/pi-goal-x/extensions/goal-change-delta.ts";

import {
  buildReviewScope,
  computeReviewScope,
  type ReviewWindowDelta,
} from "../src/review-scope.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

const DELTA: ReviewWindowDelta = {
  goalId: "goal-1",
  empty: false,
  truncated: false,
  diagnostics: [],
  repos: [
    {
      root: "/repo",
      entries: [
        { path: "src/b.ts", status: "modified", code: "M" },
        { path: "src/a.ts", status: "added", code: "A" },
      ],
    },
  ],
};

describe("buildReviewScope", () => {
  it("lists the window paths, sorted and de-duplicated", () => {
    const scope = buildReviewScope(DELTA);
    expect(scope.fromWindow).toBe(true);
    expect(scope.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keeps every path: the scope is not a rendering cap", () => {
    const entries = Array.from({ length: 205 }, (_, i) => ({
      path: `src/file-${String(i).padStart(4, "0")}.ts`,
      status: "modified",
      code: "M",
    }));
    const scope = buildReviewScope({
      goalId: "goal-1",
      empty: false,
      truncated: false,
      diagnostics: [],
      repos: [{ root: "/repo", entries }],
    });
    expect(scope.paths).toHaveLength(205);
  });

  it("returns no paths for an empty window", () => {
    const scope = buildReviewScope({
      goalId: "goal-1",
      empty: true,
      truncated: false,
      diagnostics: [],
      repos: [{ root: "/repo", entries: [] }],
    });
    expect(scope.fromWindow).toBe(true);
    expect(scope.paths).toEqual([]);
  });

  it("degrades without a window delta", () => {
    const scope = buildReviewScope(undefined);
    expect(scope.fromWindow).toBe(false);
    expect(scope.paths).toEqual([]);
    expect(scope.degraded).toMatch(/not a git repository/);
  });

  it("prefixes paths with the repo root when several repositories are in scope", () => {
    const scope = buildReviewScope({
      goalId: "goal-1",
      empty: false,
      truncated: false,
      diagnostics: [],
      repos: [
        {
          root: "/repo",
          entries: [{ path: "a.ts", status: "modified", code: "M" }],
        },
        {
          root: "/repo/sub",
          entries: [{ path: "b.ts", status: "modified", code: "M" }],
        },
      ],
    });
    expect(scope.paths).toEqual(["/repo/a.ts", "/repo/sub/b.ts"]);
  });
});

describe("computeReviewScope", () => {
  it("degrades when the injected goal-x window facet has no baseline", async () => {
    const scope = await computeReviewScope({ cwd: "/tmp" }, "goal-1", {
      loader: async () => ({
        readChangeBaseline: () => undefined,
        computeChangeDelta: async () => DELTA,
      }),
    });
    expect(scope.fromWindow).toBe(false);
  });

  it("uses the delta when the injected facet provides one", async () => {
    const scope = await computeReviewScope({ cwd: "/tmp" }, "goal-1", {
      loader: async () => ({
        readChangeBaseline: () => ({}),
        computeChangeDelta: async () => DELTA,
      }),
    });
    expect(scope.fromWindow).toBe(true);
    expect(scope.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("degrades when goal-x is missing", async () => {
    const scope = await computeReviewScope({ cwd: "/tmp" }, "goal-1", {
      loader: async () => {
        throw new Error("no goal-x");
      },
    });
    expect(scope.fromWindow).toBe(false);
  });
});

describe("review scope over a real git window (task 6.5 verification)", () => {
  it("excludes a file that was dirty before the window started", async () => {
    const root = makeRoot("pi-openspec-x-review-scope-");
    git(root, ["init"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "v1\n");
    fs.writeFileSync(path.join(root, "predirty.txt"), "v1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "init"]);

    // Pre-window dirt: modified before the baseline, never touched again.
    fs.writeFileSync(path.join(root, "predirty.txt"), "v1-dirty\n");

    const baseline = await captureChangeBaseline({ cwd: root }, "goal-1", {
      depth: 1,
      reason: "test",
    });
    expect(baseline).toBeDefined();

    // Window changes: one tracked modification and one new untracked file.
    fs.writeFileSync(path.join(root, "tracked.txt"), "v2-window\n");
    fs.writeFileSync(path.join(root, "newfile.txt"), "new\n");

    const delta = await computeChangeDelta(baseline!);
    const scope = buildReviewScope(delta);

    expect(scope.fromWindow).toBe(true);
    expect(scope.paths).toContain("tracked.txt");
    expect(scope.paths).toContain("newfile.txt");
    expect(scope.paths).not.toContain("predirty.txt");
  });
});
