/**
 * Workspace change manifest — repository scope resolution.
 *
 * Part of the add-goal-change-manifest-and-rollback change. Resolves the set of
 * git repositories a goal may touch, innermost outward:
 *
 *   1. `primary`   — `git rev-parse --show-toplevel` of the goal's cwd
 *   2. `ancestor`  — enclosing repositories found by an upward `.git` stat walk
 *   3. `submodule` — initialized submodules, enumerated recursively
 *   4. `nested`    — unregistered repositories found by a bounded downward walk
 *
 * Every git call here is read-only, bounded by a per-command timeout, and never
 * throws: resolution degrades to `enabled: false` when the cwd is not inside a
 * git repository, so callers can skip the whole feature silently.
 *
 * Extension-side git runs outside pi's tool permission gate (it is not a tool
 * call), so this module only ever runs a fixed set of subcommands, passes
 * arguments as an argv array, and never builds a shell string.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Per-command ceiling for every git invocation in this change. */
export const GIT_COMMAND_TIMEOUT_MS = 2_000;

/** Whole-scan ceiling for scope resolution, so goal start stays responsive. */
export const SCOPE_RESOLUTION_BUDGET_MS = 5_000;

/** Upward `.git` stat walk bound (a filesystem-root check ends it earlier). */
const MAX_ANCESTOR_WALK = 16;

/**
 * Directory names the downward nested-repo walk never enters: VCS metadata and
 * dependency caches. Gitignored directories are skipped separately via
 * `git check-ignore`.
 */
export const NESTED_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"bower_components",
	".pnpm-store",
	".yarn",
	".venv",
	"venv",
	".tox",
]);

/** How a repository relates to the goal's working directory. */
export type RepoKind = "primary" | "ancestor" | "submodule" | "nested";

/** One repository participating in the manifest's change window. */
export interface RepoScope {
	/** Absolute, symlink-resolved repository root (working tree top level). */
	root: string;
	kind: RepoKind;
	/** Path relative to the enclosing repository root (submodule/nested only). */
	relativePath?: string;
	/** Root of the repository that encloses this one (submodule/nested only). */
	parentRoot?: string;
	/** Directory depth below the scanned repository root (nested only). */
	depth?: number;
	/** HEAD recorded during resolution (submodule only; also stored in the baseline). */
	head?: string;
}

export interface RepoScopeResolution {
	/** False when the cwd is not inside a git repository — the feature stays off. */
	enabled: boolean;
	repos: RepoScope[];
	/** True when a budget deadline cut resolution short; the manifest must not claim completeness. */
	truncated: boolean;
	/** Human-readable, non-fatal notes for the diagnostics path (never the audit prompt). */
	diagnostics: string[];
}

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

export interface GitRunOptions {
	timeoutMs?: number;
	/** Text piped to the child's stdin (used by `check-ignore --stdin`). */
	input?: string;
}

/**
 * Run one git subcommand and always resolve (never throw, never block longer
 * than the timeout). `GIT_OPTIONAL_LOCKS=0` keeps read-only commands from
 * taking the index lock; `GIT_TERMINAL_PROMPT=0` prevents credential prompts
 * from hanging an unattended session.
 */
export async function runGit(
	args: readonly string[],
	cwd: string,
	options: GitRunOptions = {},
): Promise<GitResult> {
	return await new Promise<GitResult>((resolve) => {
		const child = execFile(
			"git",
			[...args],
			{
				cwd,
				timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
				encoding: "utf8",
				windowsHide: true,
				killSignal: "SIGKILL",
				env: {
					...process.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
				},
			},
			(error, stdout, stderr) => {
				const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
				resolve({
					ok: !failure,
					stdout: typeof stdout === "string" ? stdout : "",
					stderr: typeof stderr === "string" ? stderr : "",
					code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
					timedOut: Boolean(
						failure &&
						(failure.killed === true || failure.signal === "SIGKILL" || failure.code === "ETIMEDOUT"),
					),
				});
			},
		);
		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		} else {
			child.stdin?.end();
		}
	});
}

export interface ResolveRepoScopeOptions {
	/** Downward scan depth below each repository root (0 = no downward scan). */
	depth?: number;
	budgetMs?: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

/**
 * Resolve every repository the manifest should cover.
 *
 * Never throws and never mutates: a non-repository cwd short-circuits to
 * `enabled: false`, and a git failure at any phase degrades that phase to
 * "not discovered" rather than failing the caller.
 */
export async function resolveRepoScope(
	cwd: string,
	options: ResolveRepoScopeOptions = {},
): Promise<RepoScopeResolution> {
	const now = options.now ?? Date.now;
	const deadline = now() + (options.budgetMs ?? SCOPE_RESOLUTION_BUDGET_MS);
	const expired = (): boolean => now() >= deadline;
	const maxDepth = Math.max(0, Math.trunc(options.depth ?? 0));
	const diagnostics: string[] = [];

	const primaryRoot = await repoRootFor(cwd);
	if (!primaryRoot) {
		return {
			enabled: false,
			repos: [],
			truncated: false,
			diagnostics: ["cwd is not inside a git repository; the change manifest is disabled"],
		};
	}

	const repos: RepoScope[] = [];
	const seen = new Set<string>();
	const add = (repo: RepoScope): boolean => {
		if (seen.has(repo.root)) return false;
		seen.add(repo.root);
		repos.push(repo);
		return true;
	};

	add({ root: primaryRoot, kind: "primary" });

	// Phase 2: enclosing repositories, nearest first.
	let truncated = false;
	let cursor = path.dirname(primaryRoot);
	for (let level = 0; level < MAX_ANCESTOR_WALK; level++) {
		const parent = path.dirname(cursor);
		if (parent === cursor) break; // reached the filesystem root; never walk past it
		if (expired()) {
			truncated = true;
			diagnostics.push("scope resolution budget exhausted during the ancestor walk");
			break;
		}
		if (isRepoRootSync(cursor)) {
			const root = await repoRootFor(cursor);
			// Only accept a directory that is itself a repository root; a `.git`
			// entry can otherwise belong to an enclosing repository higher up.
			if (root && path.resolve(root) === path.resolve(cursor)) add({ root, kind: "ancestor" });
		}
		cursor = parent;
	}

	// Phase 3 + 4: submodules and unregistered nested repositories, iterated to a
	// fixpoint so a repository discovered late is scanned the same way.
	const queue = [...repos];
	for (let index = 0; index < queue.length; index++) {
		const repo = queue[index];
		if (!repo) continue;
		if (expired()) {
			truncated = true;
			diagnostics.push("scope resolution budget exhausted before every repository was scanned");
			break;
		}
		for (const submodule of await enumerateSubmodules(repo.root)) {
			if (add(submodule)) queue.push(submodule);
		}
		const nested = await discoverNestedRepos(repo.root, maxDepth, seen, expired);
		if (nested.truncated) {
			truncated = true;
			diagnostics.push(`nested repository scan was cut short below ${repo.root}`);
		}
		for (const candidate of nested.repos) {
			if (add(candidate)) queue.push(candidate);
		}
	}

	return { enabled: true, repos, truncated, diagnostics };
}

/**
 * Innermost-repository ownership: the repository with the longest root that is
 * a prefix of `filePath`. Overlapping outer repositories must not claim a path
 * that belongs to a nested/submodule repository.
 */
export function repoOwner(filePath: string, repos: readonly RepoScope[]): RepoScope | undefined {
	const abs = path.resolve(filePath);
	let owner: RepoScope | undefined;
	for (const repo of repos) {
		if (abs !== repo.root && !abs.startsWith(repo.root + path.sep)) continue;
		if (!owner || repo.root.length > owner.root.length) owner = repo;
	}
	return owner;
}

/** Repositories nested inside `repo`, innermost first (deepest root wins). */
export function nestedReposOf(repo: RepoScope, repos: readonly RepoScope[]): RepoScope[] {
	return repos
		.filter((candidate) => candidate.root !== repo.root)
		.filter((candidate) => candidate.root.startsWith(repo.root + path.sep))
		.sort((a, b) => b.root.length - a.root.length);
}

/** Repository root for `dir`, or undefined when it is not inside a repository. */
async function repoRootFor(dir: string): Promise<string | undefined> {
	const result = await runGit(["rev-parse", "--show-toplevel"], dir);
	if (!result.ok) return undefined;
	const root = result.stdout.trim();
	if (!root) return undefined;
	return normalizeRoot(root);
}

function normalizeRoot(root: string): string {
	try {
		return fs.realpathSync(root);
	} catch {
		return path.resolve(root);
	}
}

function isRepoRootSync(dir: string): boolean {
	try {
		return fs.existsSync(path.join(dir, ".git"));
	} catch {
		return false;
	}
}

/** Initialized submodules of `root`, recursively, with their recorded HEAD. */
async function enumerateSubmodules(root: string): Promise<RepoScope[]> {
	const result = await runGit(["submodule", "status", "--recursive"], root);
	if (!result.ok) return [];
	const submodules: RepoScope[] = [];
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trimEnd();
		if (!trimmed) continue;
		// "<status><sha> <path> (<describe>)": a leading "-" marks an
		// uninitialized submodule, which contributes nothing to the manifest.
		const status = trimmed[0];
		if (status === "-") continue;
		const rest = trimmed.slice(1);
		const spaceAt = rest.indexOf(" ");
		if (spaceAt <= 0) continue;
		const recordedSha = rest.slice(0, spaceAt);
		const describeAt = rest.indexOf(" (", spaceAt);
		const relativePath = (describeAt === -1 ? rest.slice(spaceAt + 1) : rest.slice(spaceAt + 1, describeAt)).trim();
		if (!relativePath) continue;
		const abs = path.join(root, relativePath);
		if (!fs.existsSync(abs)) continue; // uninitialized or removed working tree
		const head = await runGit(["rev-parse", "HEAD"], abs);
		submodules.push({
			root: normalizeRoot(abs),
			kind: "submodule",
			relativePath: relativePath.split(path.sep).join("/"),
			parentRoot: root,
			head: head.ok ? head.stdout.trim() || recordedSha : recordedSha,
		});
	}
	return submodules;
}

interface NestedWalkResult {
	repos: RepoScope[];
	truncated: boolean;
}

/**
 * Bounded breadth-first walk below `root`, looking for `.git` directories at
 * most `maxDepth` directory levels down. Never descends into a known
 * repository root (that subtree belongs to another manifest section), into the
 * skip list, or into a directory git ignores.
 */
async function discoverNestedRepos(
	root: string,
	maxDepth: number,
	known: Set<string>,
	expired: () => boolean,
): Promise<NestedWalkResult> {
	const repos: RepoScope[] = [];
	if (maxDepth <= 0) return { repos, truncated: false };
	// Walk-local copy: the caller owns the shared set, and adding here would make
	// the caller treat a freshly discovered repository as already known.
	const knownHere = new Set(known);

	let frontier: string[] = [root];
	let level = 0;
	while (frontier.length > 0 && level < maxDepth) {
		if (expired()) return { repos, truncated: true };
		level += 1;
		const candidates: Array<{ abs: string; rel: string }> = [];
		for (const dir of frontier) {
			for (const name of listSubdirectories(dir)) {
				if (NESTED_SCAN_SKIP_DIRS.has(name)) continue;
				const abs = path.join(dir, name);
				if (knownHere.has(abs) || knownHere.has(normalizeRootSafe(abs))) continue;
				const rel = path.relative(root, abs).split(path.sep).join("/");
				candidates.push({ abs, rel });
			}
		}
		if (candidates.length === 0) break;
		const ignored = await ignoredPaths(root, candidates.map((candidate) => candidate.rel));
		const next: string[] = [];
		for (const candidate of candidates) {
			if (ignored.has(candidate.rel)) continue;
			if (isRepoRootSync(candidate.abs)) {
				const verified = await repoRootFor(candidate.abs);
				if (verified && path.resolve(verified) === path.resolve(candidate.abs)) {
					knownHere.add(verified);
					repos.push({
						root: verified,
						kind: "nested",
						relativePath: candidate.rel,
						parentRoot: root,
						depth: level,
					});
					// The discovered repository gets its own scan pass; never
					// descend into it from the enclosing one.
					continue;
				}
			}
			next.push(candidate.abs);
		}
		frontier = next;
	}
	return { repos, truncated: false };
}

function normalizeRootSafe(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

function listSubdirectories(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			// Symlinked directories are skipped: following them can escape the
			// repository or loop back into it.
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** Subset of `relativePaths` that git ignores, in one `check-ignore` call. */
async function ignoredPaths(root: string, relativePaths: readonly string[]): Promise<Set<string>> {
	if (relativePaths.length === 0) return new Set();
	const result = await runGit(["check-ignore", "-z", "--stdin"], root, {
		input: relativePaths.map((rel) => `${rel}/\u0000`).join(""),
	});
	if (!result.stdout) return new Set();
	return new Set(
		result.stdout
			.split("\u0000")
			.map((entry) => entry.replace(/\/$/, ""))
			.filter(Boolean),
	);
}
