/**
 * Workspace change manifest — baseline capture, sidecar storage, and the
 * one-shot capture trigger.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	changeBaselinePath,
	captureChangeBaseline,
	captureRepoBaseline,
	createBaselineCaptureState,
	deleteChangeBaseline,
	listBaselineGoalIds,
	maybeCaptureBaseline,
	parseStatusEntries,
	readChangeBaseline,
	writeChangeBaselineIfAbsent,
	type BaselineCaptureRequest,
} from "../extensions/goal-change-baseline.ts";
import { runGit } from "../extensions/goal-change-manifest.ts";
import { gitAvailable, initRepo, makeGitFixture } from "./git-fixture.ts";

const skip = gitAvailable ? false : "git is not available";

const PRIMARY = { root: "", kind: "primary" as const };

describe("captureRepoBaseline", () => {
	it("writes no git objects for a clean tree and records no stash", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const before = fixture.git(["count-objects", "-v"]);
			const baseline = await captureRepoBaseline({ ...PRIMARY, root: fixture.dir });
			const after = fixture.git(["count-objects", "-v"]);
			assert.equal(baseline.head, fixture.git(["rev-parse", "HEAD"]).trim());
			assert.equal(baseline.unborn, false);
			assert.equal(baseline.stash, null, "a clean tree has nothing to stash");
			assert.deepEqual(baseline.status, []);
			assert.equal(before, after, "capture must not write git objects on a clean tree");
		} finally {
			fixture.remove();
		}
	});

	it("captures a stash commit holding the pre-window content of a dirty tracked file", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("tracked.txt", "one\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "track"]);
			fixture.write("tracked.txt", "one\ntwo\n");

			const baseline = await captureRepoBaseline({ ...PRIMARY, root: fixture.dir });
			assert.ok(baseline.stash, "a dirty tree yields a stash commit");
			assert.equal(
				fixture.git(["show", `${baseline.stash}:tracked.txt`]),
				"one\ntwo\n",
				"the stash tree holds the baseline working-tree content",
			);
			assert.equal(
				fixture.git(["stash", "list"]).trim(),
				"",
				"capture never writes to the user's stash list",
			);

			// A later edit is measurable against the baseline commit.
			fixture.write("tracked.txt", "one\ntwo\nthree\n");
			assert.match(fixture.git(["diff", "--numstat", baseline.stash!]), /^1\t0\ttracked\.txt/m);
		} finally {
			fixture.remove();
		}
	});

	it("records untracked entries with a stat so a later content change stays detectable", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("scratch.txt", "before\n");
			const baseline = await captureRepoBaseline({ ...PRIMARY, root: fixture.dir });
			assert.equal(baseline.stash, null, "untracked-only dirt is not part of the stash commit");
			const entry = baseline.status.find((item) => item.path === "scratch.txt");
			assert.ok(entry, "the untracked file is in the baseline status");
			assert.equal(entry.code, "??");
			assert.equal(entry.stat?.size, "before\n".length);
			assert.equal(typeof entry.stat?.mtimeMs, "number");
			assert.equal(baseline.statusComplete, true);
		} finally {
			fixture.remove();
		}
	});

	it("degrades to status-only on an unborn HEAD", { skip }, async () => {
		const fixture = makeGitFixture({ init: false });
		try {
			initRepo(fixture, fixture.dir, { commit: false });
			const baseline = await captureRepoBaseline({ ...PRIMARY, root: fixture.dir });
			assert.equal(baseline.unborn, true);
			assert.equal(baseline.head, null);
			assert.equal(baseline.stash, null, "no commit means nothing to diff against");
			assert.ok(Array.isArray(baseline.status), "the status snapshot is still recorded");
		} finally {
			fixture.remove();
		}
	});
});

describe("parseStatusEntries", () => {
	it("parses codes, paths, and rename originals from NUL-delimited output", () => {
		const parsed = parseStatusEntries(" M a.txt\u0000?? b/c.txt\u0000R  new.txt\u0000old.txt\u0000");
		assert.deepEqual(parsed, [
			{ path: "a.txt", code: " M" },
			{ path: "b/c.txt", code: "??" },
			{ path: "new.txt", code: "R ", origPath: "old.txt" },
		]);
	});

	it("ignores empty and truncated fields", () => {
		assert.deepEqual(parseStatusEntries("\u0000\u0000 ??\u0000"), []);
	});
});

describe("baseline sidecar", () => {
	it("creates the sidecar once, at .pi/goals/<goalId>.baseline.json", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const ctx = { cwd: fixture.dir };
			const baseline = await captureChangeBaseline(ctx, "g1", {
				depth: 0,
				reason: "tool_call:write",
				now: () => Date.parse("2026-01-02T03:04:05Z"),
			});
			assert.ok(baseline);
			assert.equal(
				changeBaselinePath(ctx, "g1"),
				path.join(fixture.dir, ".pi", "goals", "g1.baseline.json"),
			);
			assert.equal(writeChangeBaselineIfAbsent(ctx, baseline), true, "the first write creates the file");
			const first = fs.readFileSync(changeBaselinePath(ctx, "g1"), "utf8");
			assert.equal(writeChangeBaselineIfAbsent(ctx, baseline), false, "a second write is refused");
			assert.equal(fs.readFileSync(changeBaselinePath(ctx, "g1"), "utf8"), first, "content is untouched");

			const read = readChangeBaseline(ctx, "g1");
			assert.equal(read?.goalId, "g1");
			assert.equal(read?.reason, "tool_call:write");
			assert.equal(read?.capturedAt, "2026-01-02T03:04:05.000Z");
			assert.equal(read?.repos[0]?.kind, "primary");
		} finally {
			fixture.remove();
		}
	});

	it("reads nothing for an absent or invalid sidecar", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const ctx = { cwd: fixture.dir };
			assert.equal(readChangeBaseline(ctx, "missing"), undefined);
			fs.mkdirSync(path.dirname(changeBaselinePath(ctx, "bad")), { recursive: true });
			fs.writeFileSync(changeBaselinePath(ctx, "bad"), "{not json", "utf8");
			assert.equal(readChangeBaseline(ctx, "bad"), undefined);
			fs.writeFileSync(changeBaselinePath(ctx, "bad"), JSON.stringify({ version: 99, repos: [] }), "utf8");
			assert.equal(readChangeBaseline(ctx, "bad"), undefined, "an unknown version is ignored");
		} finally {
			fixture.remove();
		}
	});

	it("lists and deletes baseline sidecars", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const ctx = { cwd: fixture.dir };
			for (const goalId of ["g1", "g2"]) {
				const baseline = await captureChangeBaseline(ctx, goalId, { depth: 0, reason: "test" });
				assert.ok(baseline);
				writeChangeBaselineIfAbsent(ctx, baseline);
			}
			assert.deepEqual(listBaselineGoalIds(ctx).sort(), ["g1", "g2"]);
			assert.equal(deleteChangeBaseline(ctx, "g1"), true);
			assert.equal(deleteChangeBaseline(ctx, "g1"), false, "deleting twice is a no-op");
			assert.deepEqual(listBaselineGoalIds(ctx), ["g2"]);
		} finally {
			fixture.remove();
		}
	});
});

describe("baseline trigger wiring", () => {
	const extensions = new URL("../extensions/", import.meta.url);
	const read = (name: string): string => fs.readFileSync(new URL(name, extensions), "utf8");

	it("is tied to the execution turn, never to tool names or tool callbacks", () => {
		const events = read("goal-events.ts");
		const toolNames = read("goal-tool-names.ts");
		assert.match(events, /reason: "turn_start"/, "the trigger lives in the turn_start handler");
		for (const forbidden of ["isWorkspaceMutationTool", "isTaskStartToolCall", "tool_call:"]) {
			assert.equal(events.includes(forbidden), false, `goal-events.ts must not reintroduce ${forbidden}`);
			assert.equal(toolNames.includes(forbidden), false, `goal-tool-names.ts must not reintroduce ${forbidden}`);
		}
		assert.equal(
			toolNames.includes("WORKSPACE_MUTATION_TOOL_NAMES"),
			false,
			"no workspace-mutation tool classification exists",
		);
		// Capture is attempted exactly once per goal, so the hot path cannot capture
		// twice: the requested reason replaces the old per-tool reason string.
		assert.equal(events.split("maybeCaptureBaseline(").length - 1, 1, "a single capture call site");
	});

	it("records the turn_start reason in the sidecar", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const ctx = { cwd: fixture.dir };
			const outcome = await maybeCaptureBaseline(createBaselineCaptureState(), {
				ctx,
				goalId: "g-turn",
				mode: "auto",
				depth: 0,
				reason: "turn_start",
			});
			assert.equal(outcome, "captured");
			assert.equal(readChangeBaseline(ctx, "g-turn")?.reason, "turn_start");
		} finally {
			fixture.remove();
		}
	});
});

describe("maybeCaptureBaseline", () => {
	function request(ctx: { cwd: string }, overrides: Partial<BaselineCaptureRequest> = {}): BaselineCaptureRequest {
		return { ctx, goalId: "g1", mode: "auto", depth: 0, reason: "tool_call:write", ...overrides };
	}

	it("captures at most once per goal and never overwrites an existing baseline", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const ctx = { cwd: fixture.dir };
			const state = createBaselineCaptureState();
			assert.equal(await maybeCaptureBaseline(state, request(ctx)), "captured");
			assert.equal(fs.existsSync(changeBaselinePath(ctx, "g1")), true);
			const first = fs.readFileSync(changeBaselinePath(ctx, "g1"), "utf8");
			assert.equal(await maybeCaptureBaseline(state, request(ctx)), "skipped", "one attempt per goal");
			assert.equal(
				await maybeCaptureBaseline(createBaselineCaptureState(), request(ctx)),
				"skipped",
				"a fresh state still respects the on-disk baseline",
			);
			assert.equal(fs.readFileSync(changeBaselinePath(ctx, "g1"), "utf8"), first);
		} finally {
			fixture.remove();
		}
	});

	it("skips without a focused goal and when collection is off", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const ctx = { cwd: fixture.dir };
			assert.equal(await maybeCaptureBaseline(createBaselineCaptureState(), request(ctx, { goalId: null })), "skipped");
			assert.equal(
				await maybeCaptureBaseline(createBaselineCaptureState(), request(ctx, { mode: "off" })),
				"disabled",
			);
			assert.equal(fs.existsSync(changeBaselinePath(ctx, "g1")), false, "nothing is written");
		} finally {
			fixture.remove();
		}
	});

	it("stays silent when git is unavailable", { skip }, async () => {
		const fixture = makeGitFixture();
		const originalPath = process.env.PATH;
		try {
			const ctx = { cwd: fixture.dir };
			process.env.PATH = path.join(os.tmpdir(), "goal-manifest-no-git-here");
			assert.equal(
				await maybeCaptureBaseline(createBaselineCaptureState(), request(ctx, { goalId: "g-nogit" })),
				"disabled",
			);
			assert.equal(fs.existsSync(changeBaselinePath(ctx, "g-nogit")), false);
		} finally {
			process.env.PATH = originalPath;
			fixture.remove();
		}
	});

	it("kills a hung git command at the timeout and reports it instead of throwing", { skip }, async () => {
		const fixture = makeGitFixture();
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-manifest-shim-"));
		const originalPath = process.env.PATH;
		try {
			const shim = path.join(shimDir, "git");
			// `exec` so the kill signal reaches the sleeping process itself.
			fs.writeFileSync(shim, "#!/bin/sh\nexec sleep 5\n", "utf8");
			fs.chmodSync(shim, 0o755);
			process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
			const started = Date.now();
			const result = await runGit(["rev-parse", "HEAD"], fixture.dir, { timeoutMs: 150 });
			assert.equal(result.ok, false);
			assert.equal(result.timedOut, true, "a hung command is killed and flagged");
			assert.ok(Date.now() - started < 4_000, "the timeout is enforced, not the full sleep");
		} finally {
			process.env.PATH = originalPath;
			fs.rmSync(shimDir, { recursive: true, force: true });
			fixture.remove();
		}
	});
});
