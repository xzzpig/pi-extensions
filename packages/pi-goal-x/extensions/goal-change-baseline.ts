/**
 * Workspace change manifest — baseline capture and storage.
 *
 * The baseline is the goal's execution-window origin: it is captured once,
 * immediately before the first workspace-mutating action of a goal, and it is
 * what both the audit-time delta and `/goal-clear` rollback measure against.
 *
 * Per repository the baseline records:
 *   - HEAD (or an explicit `unborn` marker for a repository without commits)
 *   - `git stash create` on a dirty tree (a dangling commit holding the exact
 *     pre-window content of every already-dirty file), or null on a clean tree
 *   - the complete `status --porcelain -z` entry set, so pre-existing dirt can
 *     be excluded from the window
 *   - recursive submodule paths and HEADs
 *
 * The sidecar lives at `.pi/goals/<goalId>.baseline.json`, is written with
 * create-if-absent (`wx`) semantics, and never throws into a caller: capture is
 * best-effort and its failure must leave goal behavior unchanged.
 *
 * `git stash create` writes objects but never touches the user's stash list
 * (`stash store` is what does that), and this module never runs a git pruning
 * command.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { runGit, resolveRepoScope, type RepoKind, type RepoScope } from "./goal-change-manifest.ts";
import { GOALS_DIR, resolveGoalPath, safeUnlinkGoalFile, type GoalFileContext } from "./storage/goal-files.ts";

/** Bound on stored status entries per repository (see `statusComplete`). */
export const MAX_BASELINE_STATUS_ENTRIES = 1_000;

export const BASELINE_VERSION = 1;

/** One `status --porcelain -z` entry. */
export interface StatusEntry {
	/** Path relative to the repository root, with forward slashes. */
	path: string;
	/** Two-letter porcelain status code (`??` for untracked). */
	code: string;
	/** Original path of a rename/copy entry, when git reported one. */
	origPath?: string;
	/**
	 * Size and mtime for an untracked entry. `git stash create` stores tracked
	 * content only, so an untracked file that existed at baseline carries its
	 * identity here and a later content change is still detectable.
	 */
	stat?: { size: number; mtimeMs: number };
}

export interface SubmoduleBaseline {
	path: string;
	head: string;
}

export interface RepoBaseline {
	root: string;
	kind: RepoKind;
	relativePath?: string;
	parentRoot?: string;
	/** HEAD commit, or null when the repository has no commits yet. */
	head: string | null;
	/** `git stash create` result: pre-window content of an already-dirty tree. */
	stash: string | null;
	/** True when HEAD is unborn; diffing falls back to status-only. */
	unborn: boolean;
	status: StatusEntry[];
	/** False when the entry list was capped: unknown paths are treated as changed. */
	statusComplete: boolean;
	submodules: SubmoduleBaseline[];
}

export interface ChangeBaseline {
	version: number;
	goalId: string;
	capturedAt: string;
	/** What triggered capture, e.g. `tool_call:write` or `task_started`. */
	reason: string;
	/** True when scope resolution or a command deadline cut the snapshot short. */
	truncated: boolean;
	/** Non-fatal capture notes for diagnostics; never rendered into the audit prompt. */
	diagnostics: string[];
	repos: RepoBaseline[];
}

/** Parse NUL-delimited `git status --porcelain -z` output. */
export function parseStatusEntries(stdout: string): StatusEntry[] {
	const fields = stdout.split("\u0000");
	const entries: StatusEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field || field.length < 4) continue;
		const code = field.slice(0, 2);
		const filePath = field.slice(3);
		if (!filePath) continue;
		// A rename/copy record carries the original path in the next field.
		const renamed = code.includes("R") || code.includes("C");
		const origPath = renamed ? fields[index + 1] : undefined;
		if (renamed) index += 1;
		entries.push(origPath ? { path: filePath, code, origPath } : { path: filePath, code });
	}
	return entries;
}

/** Capture one repository's baseline. Never throws. */
export async function captureRepoBaseline(
	repo: RepoScope,
	options: { timeoutMs?: number } = {},
): Promise<RepoBaseline> {
	const baseline: RepoBaseline = {
		root: repo.root,
		kind: repo.kind,
		...(repo.relativePath ? { relativePath: repo.relativePath } : {}),
		...(repo.parentRoot ? { parentRoot: repo.parentRoot } : {}),
		head: null,
		stash: null,
		unborn: true,
		status: [],
		statusComplete: true,
		submodules: [],
	};

	const head = await runGit(["rev-parse", "--verify", "HEAD"], repo.root, options);
	if (head.ok) {
		baseline.head = head.stdout.trim() || null;
		baseline.unborn = baseline.head === null;
	}

	const status = await runGit(
		["status", "--porcelain", "-z", "--untracked-files=all"],
		repo.root,
		options,
	);
	if (status.ok) {
		const entries = parseStatusEntries(status.stdout);
		baseline.statusComplete = entries.length <= MAX_BASELINE_STATUS_ENTRIES;
		baseline.status = entries.slice(0, MAX_BASELINE_STATUS_ENTRIES).map((entry) => attachUntrackedStat(repo.root, entry));
	}

	// An unborn HEAD cannot be diffed against, so only the status snapshot is kept.
	if (!baseline.unborn) {
		const stash = await runGit(["stash", "create"], repo.root, options);
		const sha = stash.ok ? stash.stdout.trim() : "";
		baseline.stash = sha || null;
	}

	if (fs.existsSync(path.join(repo.root, ".gitmodules"))) {
		const submodules = await runGit(["submodule", "status", "--recursive"], repo.root, options);
		if (submodules.ok) {
			for (const line of submodules.stdout.split("\n")) {
				const trimmed = line.trimEnd();
				if (!trimmed || trimmed.startsWith("-")) continue;
				const rest = trimmed.slice(1);
				const spaceAt = rest.indexOf(" ");
				if (spaceAt <= 0) continue;
				const describeAt = rest.indexOf(" (", spaceAt);
				const subPath = (describeAt === -1 ? rest.slice(spaceAt + 1) : rest.slice(spaceAt + 1, describeAt)).trim();
				if (subPath) baseline.submodules.push({ path: subPath, head: rest.slice(0, spaceAt) });
			}
		}
	}

	return baseline;
}

/** Attach size/mtime to an untracked entry (see `StatusEntry.stat`). */
export function attachUntrackedStat(root: string, entry: StatusEntry): StatusEntry {
	if (entry.code !== "??") return entry;
	try {
		const stat = fs.statSync(path.join(root, entry.path));
		if (!stat.isFile()) return entry;
		return { ...entry, stat: { size: stat.size, mtimeMs: stat.mtimeMs } };
	} catch {
		return entry;
	}
}

/**
 * Capture a full baseline across every repository in scope. Returns undefined
 * when the working directory is not inside a git repository (feature off).
 */
export async function captureChangeBaseline(
	ctx: GoalFileContext,
	goalId: string,
	options: { depth: number; reason: string; now?: () => number },
): Promise<ChangeBaseline | undefined> {
	const scope = await resolveRepoScope(ctx.cwd, { depth: options.depth });
	if (!scope.enabled) return undefined;

	const repos: RepoBaseline[] = [];
	for (const repo of scope.repos) {
		repos.push(await captureRepoBaseline(repo));
	}

	return {
		version: BASELINE_VERSION,
		goalId,
		capturedAt: new Date((options.now ?? Date.now)()).toISOString(),
		reason: options.reason,
		truncated: scope.truncated,
		diagnostics: scope.diagnostics,
		repos,
	};
}

/**
 * Sidecar path relative to the project cwd. The storage helpers take a
 * cwd-relative path plus the owning root directory, so the full
 * `.pi/goals/<goalId>.baseline.json` path is what callers pass here.
 */
export function baselineRelativePath(goalId: string): string {
	return `${GOALS_DIR}/${goalId}.baseline.json`;
}

export function changeBaselinePath(ctx: GoalFileContext, goalId: string): string {
	return resolveGoalPath(ctx, GOALS_DIR, baselineRelativePath(goalId));
}

/** Read a goal's baseline, or undefined when absent/unreadable/invalid. */
export function readChangeBaseline(ctx: GoalFileContext, goalId: string): ChangeBaseline | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(changeBaselinePath(ctx, goalId), "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as ChangeBaseline;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.repos)) return undefined;
		if (parsed.version !== BASELINE_VERSION) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * Create the sidecar only when it does not exist yet (`wx`), so a duplicate
 * trigger or a second process can never overwrite the first baseline.
 * Returns true when this call created the file.
 */
export function writeChangeBaselineIfAbsent(ctx: GoalFileContext, baseline: ChangeBaseline): boolean {
	const filePath = changeBaselinePath(ctx, baseline.goalId);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	try {
		fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/**
 * Delete a goal's baseline. Best-effort and never throws: a terminal transition
 * (completion, archive, clear) must not be blocked by cleanup, so a failure
 * here is reported as "nothing removed". Returns true when a file was removed.
 */
export function deleteChangeBaseline(ctx: GoalFileContext, goalId: string): boolean {
	try {
		const filePath = changeBaselinePath(ctx, goalId);
		if (!fs.existsSync(filePath)) return false;
		safeUnlinkGoalFile(ctx, GOALS_DIR, baselineRelativePath(goalId));
		return true;
	} catch {
		return false;
	}
}

/** Goal ids that currently have a baseline sidecar on disk. */
export function listBaselineGoalIds(ctx: GoalFileContext): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(path.resolve(ctx.cwd, GOALS_DIR));
	} catch {
		return [];
	}
	const suffix = ".baseline.json";
	return names
		.filter((name) => name.endsWith(suffix))
		.map((name) => name.slice(0, -suffix.length))
		.filter(Boolean);
}
/** Per-session capture bookkeeping: one attempt per goal, success or not. */
export interface BaselineCaptureState {
	attemptedGoals: Set<string>;
}

export function createBaselineCaptureState(): BaselineCaptureState {
	return { attemptedGoals: new Set<string>() };
}

export type BaselineCaptureOutcome = "captured" | "skipped" | "disabled" | "failed";

export interface BaselineCaptureRequest {
	ctx: GoalFileContext;
	goalId: string | null | undefined;
	/** Resolved `changeManifest` setting. */
	mode: "auto" | "off";
	/** Resolved `changeManifestDepth` setting. */
	depth: number;
	reason: string;
	now?: () => number;
}

/**
 * Capture the baseline at most once per goal, and never let a git failure,
 * timeout, or write error reach the caller.
 *
 * The caller is the first workspace-mutating action of the goal (a `tool_call`
 * handler, or the task-start fallback), so capture lands exactly before the
 * first change: the first edit itself is inside the audit window.
 */
export async function maybeCaptureBaseline(
	state: BaselineCaptureState,
	request: BaselineCaptureRequest,
): Promise<BaselineCaptureOutcome> {
	if (!request.goalId) return "skipped";
	if (request.mode === "off") return "disabled";
	if (state.attemptedGoals.has(request.goalId)) return "skipped";
	state.attemptedGoals.add(request.goalId);
	try {
		if (readChangeBaseline(request.ctx, request.goalId)) return "skipped";
		const baseline = await captureChangeBaseline(request.ctx, request.goalId, {
			depth: request.depth,
			reason: request.reason,
			...(request.now ? { now: request.now } : {}),
		});
		if (!baseline) return "disabled";
		return writeChangeBaselineIfAbsent(request.ctx, baseline) ? "captured" : "skipped";
	} catch {
		// Best-effort: a failed capture must never affect goal execution.
		return "failed";
	}
}
