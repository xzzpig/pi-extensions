/**
 * Workspace change manifest — repository scope resolution.
 *
 * Covers `extensions/goal-change-manifest.ts`: primary/ancestor/submodule/nested
 * discovery, the bounded downward walk (skip list + gitignore), the resolution
 * budget, and innermost-repository ownership.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	nestedReposOf,
	repoOwner,
	resolveRepoScope,
	runGit,
	GIT_COMMAND_TIMEOUT_MS,
	type RepoScope,
} from "../extensions/goal-change-manifest.ts";
import { gitAvailable, initRepo, makeGitFixture } from "./git-fixture.ts";

const skip = gitAvailable ? false : "git is not available";

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-manifest-nogit-")));
	return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe("runGit", () => {
	it("resolves instead of throwing when the command fails", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const result = await runGit(["rev-parse", "--verify", "no-such-ref-at-all"], fixture.dir);
			assert.equal(result.ok, false, "a failing command is reported, not thrown");
			assert.equal(result.timedOut, false);
			assert.notEqual(result.code, 0);
			assert.ok(result.stderr.length > 0, "git's stderr is preserved for diagnostics");
		} finally {
			fixture.remove();
		}
	});

	it("reports ok with stdout for a successful command", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const result = await runGit(["rev-parse", "--show-toplevel"], fixture.dir);
			assert.equal(result.ok, true);
			assert.equal(fs.realpathSync(result.stdout.trim()), fixture.dir);
			assert.ok(GIT_COMMAND_TIMEOUT_MS > 0);
		} finally {
			fixture.remove();
		}
	});
});

describe("resolveRepoScope — primary repository", () => {
	it("reports the feature as disabled outside a git repository", { skip }, async () => {
		await withTempDir(async (dir) => {
			const resolution = await resolveRepoScope(dir, { depth: 1 });
			assert.equal(resolution.enabled, false, "a non-repository cwd disables the manifest");
			assert.deepEqual(resolution.repos, []);
			assert.equal(resolution.truncated, false);
		});
	});

	it("resolves the repository root from a nested working directory", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const nested = fixture.mkdir("packages/inner");
			const resolution = await resolveRepoScope(nested, { depth: 0 });
			assert.equal(resolution.enabled, true);
			assert.equal(resolution.repos.length, 1, "only the primary repository is in scope");
			assert.equal(resolution.repos[0]!.kind, "primary");
			assert.equal(resolution.repos[0]!.root, fixture.dir, "root is the top level, not the cwd");
		} finally {
			fixture.remove();
		}
	});

	it("flags a truncated scan when the resolution budget is exhausted", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const resolution = await resolveRepoScope(fixture.dir, { depth: 2, budgetMs: 0 });
			assert.equal(resolution.enabled, true);
			assert.equal(resolution.truncated, true, "a spent budget is reported, not silently ignored");
			assert.ok(resolution.diagnostics.length > 0);
			assert.deepEqual(
				resolution.repos.map((repo) => repo.kind),
				["primary"],
				"the primary repository is still resolved",
			);
		} finally {
			fixture.remove();
		}
	});
});

describe("resolveRepoScope — ancestor repositories", () => {
	it("finds an enclosing repository by walking upward", { skip }, async () => {
		const outer = makeGitFixture();
		try {
			const innerDir = outer.mkdir("inner");
			initRepo(outer, innerDir);
			const innerRoot = fs.realpathSync(innerDir);

			const resolution = await resolveRepoScope(innerDir, { depth: 0 });
			const byKind = new Map(resolution.repos.map((repo) => [repo.kind, repo]));
			assert.equal(resolution.enabled, true);
			assert.equal(byKind.get("primary")?.root, innerRoot, "the innermost repository is primary");
			assert.equal(byKind.get("ancestor")?.root, outer.dir, "the enclosing repository is discovered");
			assert.equal(resolution.repos.length, 2);
		} finally {
			outer.remove();
		}
	});

	it("does not invent ancestors above a non-repository working directory", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			const resolution = await resolveRepoScope(fixture.dir, { depth: 0 });
			assert.equal(
				resolution.repos.some((repo) => repo.kind === "ancestor"),
				false,
				"temp directories are not enclosed by a repository",
			);
		} finally {
			fixture.remove();
		}
	});
});

describe("resolveRepoScope — submodules", () => {
	it("enumerates initialized submodules with their path and HEAD", { skip }, async () => {
		const submodule = makeGitFixture();
		const superproject = makeGitFixture();
		try {
			// `-c` must be on the submodule command itself: the child `git clone`
			// does not inherit protocol.file.allow from the superproject config.
			superproject.git(["-c", "protocol.file.allow=always", "submodule", "add", submodule.dir, "sub"]);
			superproject.git(["commit", "-q", "-m", "add submodule"]);
			const submoduleHead = submodule.git(["rev-parse", "HEAD"]).trim();

			const resolution = await resolveRepoScope(superproject.dir, { depth: 0 });
			const found = resolution.repos.filter((repo) => repo.kind === "submodule");
			assert.equal(found.length, 1, "the initialized submodule is in scope");
			assert.equal(found[0]!.relativePath, "sub");
			assert.equal(found[0]!.parentRoot, superproject.dir);
			assert.equal(found[0]!.root, fs.realpathSync(path.join(superproject.dir, "sub")));
			assert.equal(found[0]!.head, submoduleHead, "the submodule HEAD is recorded");
		} finally {
			superproject.remove();
			submodule.remove();
		}
	});

	it("skips uninitialized submodules", { skip }, async () => {
		const submodule = makeGitFixture();
		const superproject = makeGitFixture();
		try {
			// `-c` must be on the submodule command itself: the child `git clone`
			// does not inherit protocol.file.allow from the superproject config.
			superproject.git(["-c", "protocol.file.allow=always", "submodule", "add", submodule.dir, "sub"]);
			superproject.git(["commit", "-q", "-m", "add submodule"]);
			fs.rmSync(path.join(superproject.dir, "sub"), { recursive: true, force: true });

			const resolution = await resolveRepoScope(superproject.dir, { depth: 0 });
			assert.deepEqual(
				resolution.repos.filter((repo) => repo.kind === "submodule"),
				[],
				"a submodule without a working tree contributes nothing",
			);
		} finally {
			superproject.remove();
			submodule.remove();
		}
	});
});

describe("resolveRepoScope — bounded downward walk", () => {
	it("honors the configured directory depth and never enters skip-listed or ignored directories", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			// Direct child repository (depth 1).
			initRepo(fixture, fixture.mkdir("directRepo"));
			// Three levels down (depth 3).
			initRepo(fixture, fixture.mkdir("deep1/deep2/repoX"));
			// Dependency directory: skipped by name, never entered.
			initRepo(fixture, fixture.mkdir("node_modules/repoY"));
			// Gitignored directory: skipped because git ignores it.
			fixture.write(".gitignore", "ignored/\n");
			initRepo(fixture, fixture.mkdir("ignored/repoZ"));
			fixture.git(["add", ".gitignore"]);
			fixture.git(["commit", "-q", "-m", "ignore dir"]);

			const shallow = await resolveRepoScope(fixture.dir, { depth: 1 });
			const shallowNested = new Map(
				shallow.repos.filter((repo) => repo.kind === "nested").map((repo) => [repo.relativePath, repo.depth]),
			);
			assert.deepEqual([...shallowNested.keys()], ["directRepo"], "depth 1 only reaches direct children");
			assert.equal(shallowNested.get("directRepo"), 1);

			const deep = await resolveRepoScope(fixture.dir, { depth: 3 });
			const deepNested = new Map(
				deep.repos.filter((repo) => repo.kind === "nested").map((repo) => [repo.relativePath, repo.depth]),
			);
			assert.deepEqual(
				[...deepNested.keys()].sort(),
				["deep1/deep2/repoX", "directRepo"],
				"depth 3 reaches three directory levels and still honors the skip rules",
			);
			assert.equal(deepNested.get("deep1/deep2/repoX"), 3);

			const noScan = await resolveRepoScope(fixture.dir, { depth: 0 });
			assert.deepEqual(
				noScan.repos.filter((repo) => repo.kind === "nested"),
				[],
				"depth 0 disables the downward walk entirely",
			);
		} finally {
			fixture.remove();
		}
	});
});

describe("resolveRepoScope — overlapping repositories", () => {
	it("assigns a path to the innermost repository when a tracked directory becomes a repository", { skip }, async () => {
		const fixture = makeGitFixture();
		try {
			fixture.write("tracked/f.ts", "original\n");
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-q", "-m", "track tracked"]);
			const trackedDir = fixture.mkdir("tracked");
			initRepo(fixture, trackedDir);
			const trackedRoot = fs.realpathSync(trackedDir);

			const resolution = await resolveRepoScope(fixture.dir, { depth: 1 });
			const primary = resolution.repos.find((repo) => repo.kind === "primary");
			assert.ok(primary, "the outer repository is still primary");
			const nested = resolution.repos.find((repo) => repo.kind === "nested");
			assert.ok(nested, "the repository created inside a tracked directory is discovered");
			assert.equal(nested.root, trackedRoot);

			assert.equal(
				repoOwner(path.join(trackedRoot, "new-file.ts"), resolution.repos)?.kind,
				"nested",
				"nested ownership wins over the enclosing repository",
			);
			assert.equal(
				repoOwner(path.join(fixture.dir, "outside.ts"), resolution.repos)?.kind,
				"primary",
				"paths outside the nested repository stay with the outer one",
			);
			assert.deepEqual(
				nestedReposOf(primary!, resolution.repos).map((repo: RepoScope) => repo.root),
				[trackedRoot],
				"the outer section can exclude the nested subtree",
			);
			assert.deepEqual(repoOwner(fixture.dir, resolution.repos)?.kind, "primary");
		} finally {
			fixture.remove();
		}
	});
});
