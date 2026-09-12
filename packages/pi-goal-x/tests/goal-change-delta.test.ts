/**
 * Workspace change manifest — window delta computation.
 *
 * Covers the five change classes, the pre-existing-dirt exclusion rules, the
 * baseline-untracked stat comparison, `headMoved`, innermost-repository
 * ownership, and the explicit empty record.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { captureChangeBaseline } from "../extensions/goal-change-baseline.ts";
import {
	computeChangeDelta,
	parseNameStatus,
	parseNumstat,
	type ChangeDelta,
	type RepoDelta,
} from "../extensions/goal-change-delta.ts";
import { configureRepo, gitAvailable, initRepo, makeGitFixture } from "./git-fixture.ts";

const skip = gitAvailable ? false : "git is not available";

function sectionFor(delta: ChangeDelta, root: string): RepoDelta {
	const section = delta.repos.find((repo) => repo.root === root);
	assert.ok(section, `delta has a section for ${root}`);
	return section;
}

function statuses(repo: RepoDelta): Record<string, string> {
	return Object.fromEntries(repo.entries.map((entry) => [entry.path, entry.status]));
}

describe("parse helpers", () => {
	it("parses name-status records including renames", () => {
		assert.deepEqual(parseNameStatus("A\u0000added.txt\u0000D\u0000gone.txt\u0000R100\u0000old.txt\u0000new.txt\u0000"), [
			{ status: "A", path: "added.txt" },
			{ status: "D", path: "gone.txt" },
			{ status: "R", path: "new.txt", origPath: "old.txt" },
		]);
	});

	it("parses numstat records including renames and binary markers", () => {
		assert.deepEqual(parseNumstat("3\t1\tmod.txt\u00004\t0\t\u0000old.txt\u0000new.txt\u0000-\t-\timg.png\u0000"), [
			{ path: "mod.txt", additions: 3, deletions: 1, binary: false },
			{ path: "new.txt", origPath: "old.txt", additions: 4, deletions: 0, binary: false },
			{ path: "img.png", additions: undefined, deletions: undefined, binary: true },
		]);
	});
});

describe("computeChangeDelta — change classes", () => {
	it("reports modified, added, deleted, renamed, and untracked changes", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("mod.txt", "a\nb\nc\n");
			fixture.write("gone.txt", "gone\n");
			fixture.write("old.txt", "rename me\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "seed"]);

			const baseline = await captureChangeBaseline({ cwd: fixture.dir }, "g1", { depth: 0, reason: "turn_start" });
			assert.ok(baseline);
			assert.equal((await computeChangeDelta(baseline)).empty, true, "no window change yet");

			// Window work: one of each class.
			fixture.write("mod.txt", "a\nb\nc\nd\n");
			fixture.write("added.txt", "new tracked\n");
			fixture.git(["add", "added.txt"]);
			fs.rmSync(path.join(fixture.dir, "gone.txt"));
			fixture.git(["mv", "old.txt", "renamed.txt"]);
			fixture.write("untracked.txt", "scratch\n");

			const after = await computeChangeDelta(baseline);
			const section = sectionFor(after, fixture.dir);
			const byPath = new Map(section.entries.map((entry) => [entry.path, entry]));
			assert.equal(byPath.get("mod.txt")?.status, "modified");
			assert.equal(byPath.get("mod.txt")?.additions, 1);
			assert.equal(byPath.get("mod.txt")?.deletions, 0);
			assert.equal(byPath.get("added.txt")?.status, "added");
			assert.equal(byPath.get("gone.txt")?.status, "deleted");
			assert.equal(byPath.get("renamed.txt")?.status, "renamed");
			assert.equal(byPath.get("renamed.txt")?.origPath, "old.txt");
			assert.equal(byPath.get("untracked.txt")?.status, "untracked");
			assert.equal(byPath.get("untracked.txt")?.code, "??");
			assert.equal(after.empty, false);
		} finally {
			fixture.remove();
		}
	});

	it("counts changes that were committed inside the window", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("mod.txt", "one\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "seed"]);

			const baseline = await captureChangeBaseline({ cwd: fixture.dir }, "g1c", { depth: 0, reason: "turn_start" });
			assert.ok(baseline);
			fixture.write("mod.txt", "one\ntwo\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "window commit"]);

			const delta = await computeChangeDelta(baseline);
			const section = sectionFor(delta, fixture.dir);
			assert.deepEqual(statuses(section), { "mod.txt": "modified" }, "a clean status still reports the commit");
			assert.equal(section.headMoved?.from, baseline.repos[0]!.head);
			assert.equal(section.headMoved?.to, fixture.git(["rev-parse", "HEAD"]).trim());
		} finally {
			fixture.remove();
		}
	});
});

describe("computeChangeDelta — pre-existing dirt", () => {
	it("excludes baseline dirt that was not touched and reports dirt that was", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("untouched.txt", "one\n");
			fixture.write("touched.txt", "one\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "seed"]);
			// Both files are dirty BEFORE the baseline.
			fixture.write("untouched.txt", "one\nlocal\n");
			fixture.write("touched.txt", "one\nlocal\n");

			const baseline = await captureChangeBaseline({ cwd: fixture.dir }, "g2", { depth: 0, reason: "test" });
			assert.ok(baseline);
			assert.ok(baseline.repos[0]?.stash, "the dirty tree produced a stash baseline");

			// Only one of them changes inside the window.
			fixture.write("touched.txt", "one\nlocal\nwindow\n");

			const delta = await computeChangeDelta(baseline);
			const section = sectionFor(delta, fixture.dir);
			assert.deepEqual(
				statuses(section),
				{ "touched.txt": "modified" },
				"pre-existing dirt that stayed unchanged is excluded",
			);
			assert.equal(section.entries[0]?.additions, 1, "only the in-window line is counted");
		} finally {
			fixture.remove();
		}
	});

	it("excludes untracked files that were already there and reports ones that changed or appeared", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("stable-untracked.txt", "same content\n");
			fixture.write("changed-untracked.txt", "before\n");
			fixture.write("deleted-untracked.txt", "doomed\n");

			const baseline = await captureChangeBaseline({ cwd: fixture.dir }, "g3", { depth: 0, reason: "test" });
			assert.ok(baseline);

			fixture.write("changed-untracked.txt", "before and after\n");
			fixture.write("brand-new-untracked.txt", "new\n");
			fs.rmSync(path.join(fixture.dir, "deleted-untracked.txt"));

			const delta = await computeChangeDelta(baseline);
			const section = sectionFor(delta, fixture.dir);
			assert.deepEqual(statuses(section), {
				"brand-new-untracked.txt": "untracked",
				"changed-untracked.txt": "untracked-modified",
				"deleted-untracked.txt": "deleted",
			});
			assert.equal(section.entries.find((e) => e.path === "changed-untracked.txt")?.code, "??~");
		} finally {
			fixture.remove();
		}
	});

	it("reports a baseline-untracked file that became tracked", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("promoted.txt", "content\n");
			const baseline = await captureChangeBaseline({ cwd: fixture.dir }, "g4", { depth: 0, reason: "test" });
			assert.ok(baseline);
			fixture.git(["add", "promoted.txt"]);

			const delta = await computeChangeDelta(baseline);
			const section = sectionFor(delta, fixture.dir);
			assert.deepEqual(statuses(section), { "promoted.txt": "added" });
		} finally {
			fixture.remove();
		}
	});
});

describe("computeChangeDelta — nested repositories", () => {
	it("keeps submodule changes in the submodule section and out of the enclosing one", { skip }, async () => {
		const submodule = makeGitFixture();
		const superproject = makeGitFixture();
		try {
			superproject.git(["-c", "protocol.file.allow=always", "submodule", "add", submodule.dir, "sub"]);
			superproject.git(["commit", "-q", "-m", "add submodule"]);
			const subDir = path.join(superproject.dir, "sub");
			const subRoot = fs.realpathSync(subDir);

			const baseline = await captureChangeBaseline({ cwd: superproject.dir }, "g5", { depth: 0, reason: "test" });
			assert.ok(baseline);
			assert.equal(baseline.repos.filter((repo) => repo.kind === "submodule").length, 1);

			// Window work inside the submodule: a dirty file plus a new commit.
			fs.writeFileSync(path.join(subDir, "sub-work.txt"), "sub work\n", "utf8");
			fs.writeFileSync(path.join(subDir, "committed.txt"), "committed\n", "utf8");
			configureRepo(superproject, subDir); // the clone has no identity of its own
			superproject.git(["add", "committed.txt"], subDir);
			superproject.git(["commit", "-q", "-m", "submodule commit"], subDir);

			const delta = await computeChangeDelta(baseline);
			const subSection = sectionFor(delta, subRoot);
			assert.equal(subSection.kind, "submodule");
			assert.ok(subSection.headMoved, "the submodule HEAD move is recorded, never hidden");
			assert.deepEqual(
				statuses(subSection),
				{ "committed.txt": "added", "sub-work.txt": "untracked" },
				"the submodule section carries its own files",
			);

			const outer = sectionFor(delta, superproject.dir);
			assert.equal(
				outer.entries.some((entry) => entry.path === "sub" || entry.path.startsWith("sub/")),
				false,
				"innermost repository wins: the outer section does not repeat submodule paths",
			);
		} finally {
			superproject.remove();
			submodule.remove();
		}
	});

	it("segments an unregistered nested repository separately and reports an empty window explicitly", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("outer.txt", "outer\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "seed"]);
			const nestedDir = fixture.mkdir("nested");
			initRepo(fixture, nestedDir);
			const nestedRoot = fs.realpathSync(nestedDir);

			const baseline = await captureChangeBaseline({ cwd: fixture.dir }, "g6", { depth: 1, reason: "test" });
			assert.ok(baseline);
			assert.equal(baseline.repos.length, 2, "both repositories are in the baseline");

			const unchanged = await computeChangeDelta(baseline);
			assert.equal(unchanged.empty, true, "an untouched window is an explicit empty record");
			assert.equal(unchanged.totalEntries, 0);
			assert.equal(unchanged.repos.length, 2, "sections still exist for every repository");

			fixture.write("outer.txt", "outer\nmore\n");
			fs.writeFileSync(path.join(nestedDir, "inner.txt"), "inner\n", "utf8");

			const delta = await computeChangeDelta(baseline);
			assert.equal(delta.empty, false);
			assert.deepEqual(statuses(sectionFor(delta, fixture.dir)), { "outer.txt": "modified" });
			assert.deepEqual(statuses(sectionFor(delta, nestedRoot)), { "inner.txt": "untracked" });
			assert.equal(delta.totalEntries, 2);
		} finally {
			fixture.remove();
		}
	});
});
