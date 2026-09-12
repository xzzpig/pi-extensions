/**
 * Workspace change manifest — `/goal-clear` rollback.
 *
 * When the user clears a goal, they may also roll the workspace back to the
 * goal's baseline. The window delta (see `goal-change-delta.ts`) is the single
 * source of truth for what changed, so the audit and the rollback can never
 * disagree about the change set.
 *
 * Safety model (see design D11–D13):
 *   1. plan     — derive restore/delete/unrecoverable actions from the delta;
 *   2. backup   — write the discarded changes into the goal's archive directory
 *                 (per-repo `git diff --binary` patch plus copies of every file
 *                 the rollback will delete). The worktree is not touched until
 *                 the whole backup is on disk — a partially written backup
 *                 aborts the rollback (fail-closed);
 *   3. execute  — `git restore --source=<base> --worktree` (never the index),
 *                 delete window-created files, prune emptied directories, and
 *                 never reset any repository HEAD;
 *   4. report   — per-repo counts, every failure with its path, every item that
 *                 could not be rolled back, and the backup location.
 *
 * Nothing here writes to the user's stash list or runs a git pruning command.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { runGit } from "./goal-change-manifest.ts";
import type { RepoChangeEntry, RepoDelta, ChangeDelta } from "./goal-change-delta.ts";
import { ARCHIVED_GOALS_DIR, ensureDirectory, isSafeRelativeUnder, type GoalFileContext } from "./storage/goal-files.ts";

/** Total backup size ceiling; exceeding it aborts the rollback (never a partial backup). */
export const MAX_ROLLBACK_BACKUP_BYTES = 32 * 1024 * 1024;

export type RollbackActionKind = "restore" | "delete" | "unrecoverable" | "head-moved";

export interface RollbackAction {
	kind: RollbackActionKind;
	/** Path relative to the repository root (forward slashes). */
	path: string;
	/** Original path for a rename. */
	origPath?: string;
	/** Human-readable reason, required for `unrecoverable`/`head-moved`. */
	reason?: string;
}

export interface RepoRollbackPlan {
	root: string;
	kind: RepoDelta["kind"];
	relativePath?: string;
	/** Baseline reference to restore from (null = status-only baseline). */
	base: string | null;
	baseKind: RepoDelta["baseKind"];
	actions: RollbackAction[];
}

export interface RollbackPlan {
	goalId: string;
	repos: RepoRollbackPlan[];
	restoreCount: number;
	deleteCount: number;
	unrecoverableCount: number;
}

export interface RollbackRepoResult {
	root: string;
	restored: number;
	deleted: number;
	failures: Array<{ path: string; reason: string }>;
	unrecoverable: RollbackAction[];
	headMoved: RollbackAction[];
}

export interface RollbackBackupResult {
	ok: boolean;
	/** Absolute backup directory, when a backup was written. */
	dir: string | null;
	/** Why the backup failed (fail-closed: no rollback is attempted). */
	reason?: string;
	bytes: number;
}

const ROLLBACK_DIR_PREFIX = "rollback_";

/** `rollback_<timestamp>_<goalId>/`, mirroring `makeArchivedGoalPath`'s naming. */
export function rollbackBackupDirName(goalId: string, at: Date = new Date()): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	const stamp = [
		at.getFullYear(),
		pad(at.getMonth() + 1),
		pad(at.getDate()),
		pad(at.getHours()),
		pad(at.getMinutes()),
		pad(at.getSeconds()),
		pad(Math.floor(at.getMilliseconds() / 10)),
	].join("");
	const safeId = goalId.replace(/[^A-Za-z0-9._-]/g, "_");
	return `${ROLLBACK_DIR_PREFIX}${stamp}_${safeId}`;
}

/** Filename-safe repository slug (path-derived, never contains separators). */
function repoSlug(root: string, index: number): string {
	const name = path.basename(root).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
	return `${index + 1}-${name}`;
}

/** Guard: a planned path must stay inside its repository root. */
function resolveInsideRepo(root: string, relativePath: string): string | undefined {
	const abs = path.resolve(root, relativePath);
	if (abs !== root && !abs.startsWith(root + path.sep)) return undefined;
	return abs;
}

/**
 * Turn the window delta into concrete rollback actions.
 *
 * - modified / renamed / type-changed tracked files → restore from the baseline
 * - deleted tracked files → restore from the baseline
 * - files created inside the window (added / untracked, and the new side of a
 *   rename) → delete
 * - baseline-untracked files whose content changed, and baseline-untracked files
 *   deleted in the window → unrecoverable: the stash baseline stores tracked
 *   content only, so the pre-window bytes no longer exist anywhere. The file is
 *   left alone and reported instead of being guessed at.
 * - moved HEADs → never reset
 */
export function planRollback(delta: ChangeDelta): RollbackPlan {
	const repos: RepoRollbackPlan[] = delta.repos.map((repo) => {
		const actions: RollbackAction[] = [];
		for (const entry of repo.entries) {
			actions.push(...planEntry(entry));
		}
		if (repo.headMoved) {
			actions.push({
				kind: "head-moved",
				path: repo.relativePath ?? ".",
				reason: `HEAD moved ${short(repo.headMoved.from)} -> ${short(repo.headMoved.to)}; commit history is never rewritten`,
			});
		}
		return {
			root: repo.root,
			kind: repo.kind,
			...(repo.relativePath ? { relativePath: repo.relativePath } : {}),
			base: repo.base,
			baseKind: repo.baseKind,
			actions,
		};
	});
	const all = repos.flatMap((repo) => repo.actions);
	return {
		goalId: delta.goalId,
		repos,
		restoreCount: all.filter((action) => action.kind === "restore").length,
		deleteCount: all.filter((action) => action.kind === "delete").length,
		unrecoverableCount: all.filter((action) => action.kind === "unrecoverable").length,
	};
}

function planEntry(entry: RepoChangeEntry): RollbackAction[] {
	switch (entry.status) {
		case "modified":
		case "type-changed":
			return [action("restore", entry.path)];
		case "deleted":
			// `??-`: the file was untracked at baseline, so its bytes are gone.
			return entry.code === "??-"
				? [action("unrecoverable", entry.path, "untracked at baseline and deleted in the window; no pre-window copy exists")]
				: [action("restore", entry.path)];
		case "renamed":
			// Restore the original content and remove the new name; the index is left alone.
			return [
				...(entry.origPath ? [{ kind: "restore" as const, path: entry.origPath }] : []),
				{ kind: "delete" as const, path: entry.path },
			];
		case "added":
		case "untracked":
			return [action("delete", entry.path)];
		case "untracked-modified":
			return [action("unrecoverable", entry.path, "untracked at baseline and modified in the window; the stash baseline stores tracked content only")];
		default:
			return [];
	}
}

function action(kind: RollbackActionKind, filePath: string, reason?: string): RollbackAction {
	return reason ? { kind, path: filePath, reason } : { kind, path: filePath };
}

function short(sha: string | null): string {
	return sha ? sha.slice(0, 10) : "(none)";
}

/** Files the rollback will delete inside one repository. */
function deletablePaths(
	repo: RepoRollbackPlan,
): Array<{ relativePath: string; abs: string }> {
	const output: Array<{ relativePath: string; abs: string }> = [];
	for (const entry of repo.actions) {
		if (entry.kind !== "delete") continue;
		const abs = resolveInsideRepo(repo.root, entry.path);
		if (!abs) continue;
		output.push({ relativePath: entry.path, abs });
	}
	return output;
}

/**
 * Write the rollback backup: per-repo patch of the window delta plus a copy of
 * every file the rollback would delete. The caller MUST treat `ok: false` as
 * "do not touch the worktree".
 */
export async function writeRollbackBackup(
	ctx: GoalFileContext,
	plan: RollbackPlan,
	options: { now?: Date; maxBytes?: number } = {},
): Promise<RollbackBackupResult> {
	const maxBytes = options.maxBytes ?? MAX_ROLLBACK_BACKUP_BYTES;
	const dirName = rollbackBackupDirName(plan.goalId, options.now ?? new Date());
	const relDir = `${ARCHIVED_GOALS_DIR}/${dirName}`;
	if (!isSafeRelativeUnder(ctx, ARCHIVED_GOALS_DIR, relDir)) {
		return { ok: false, dir: null, reason: `unsafe backup path: ${relDir}`, bytes: 0 };
	}
	let dir: string;
	try {
		ensureDirectory(ctx, relDir);
		dir = path.resolve(ctx.cwd, relDir);
	} catch (error) {
		return { ok: false, dir: null, reason: `cannot create backup directory: ${messageOf(error)}`, bytes: 0 };
	}

	let bytes = 0;
	const total = (): number => bytes;
	try {
		const manifest: Record<string, unknown> = {
			version: 1,
			goalId: plan.goalId,
			createdAt: (options.now ?? new Date()).toISOString(),
			files: [] as string[],
			repos: [] as unknown[],
			unrecoverable: [] as unknown[],
		};
		const files: string[] = manifest.files as string[];
		const repos: unknown[] = manifest.repos as unknown[];

		for (let index = 0; index < plan.repos.length; index += 1) {
			const repo = plan.repos[index];
			if (!repo) continue;
			const slug = repoSlug(repo.root, index);
			let patchFile: string | null = null;

			// A patch of the window delta: applying it restores the pre-rollback
			// state of every tracked file the rollback touches.
			if (repo.base) {
				const diff = await runGit(["diff", "--binary", "--no-color", repo.base], repo.root);
				if (!diff.ok) {
					return { ok: false, dir, reason: `git diff failed for ${repo.root}: ${diff.stderr.trim() || "unknown error"}`, bytes: total() };
				}
				if (diff.stdout.length > 0) {
					patchFile = `${slug}.patch`;
					fs.writeFileSync(path.join(dir, patchFile), diff.stdout, "utf8");
					bytes += Buffer.byteLength(diff.stdout);
					// The cap covers patch bytes too: an oversized backup must refuse
					// before any delete/restore is attempted.
					if (bytes > maxBytes) {
						return {
							ok: false,
							dir,
							reason: `backup exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB cap; rollback refused so nothing is lost`,
							bytes: total(),
						};
					}
				}
			}

			const copied: string[] = [];
			for (const target of deletablePaths(repo)) {
				// lstat: a symlink must be preserved as a link, never followed out of the repo.
				const stat = fs.existsSync(target.abs) ? fs.lstatSync(target.abs) : undefined;
				if (!stat) continue; // already gone: nothing to preserve
				const destination = path.join(dir, "files", slug, ...target.relativePath.split("/"));
				fs.mkdirSync(path.dirname(destination), { recursive: true });
				if (stat.isSymbolicLink()) {
					fs.writeFileSync(destination, fs.readlinkSync(target.abs), "utf8");
				} else if (stat.isFile()) {
					fs.copyFileSync(target.abs, destination);
				} else {
					continue; // directories are not copied; their files are listed individually
				}
				bytes += stat.size;
				if (bytes > maxBytes) {
					return {
						ok: false,
						dir,
						reason: `backup exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB cap; rollback refused so nothing is lost`,
						bytes: total(),
					};
				}
				copied.push(target.relativePath);
				files.push(`${slug}/${target.relativePath}`);
			}

			repos.push({
				root: repo.root,
				kind: repo.kind,
				base: repo.base,
				baseKind: repo.baseKind,
				patch: patchFile,
				copiedFiles: copied,
				unrecoverable: repo.actions.filter((entry) => entry.kind === "unrecoverable"),
				headMoved: repo.actions.filter((entry) => entry.kind === "head-moved"),
			});
		}

		fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
		return { ok: true, dir, bytes: total() };
	} catch (error) {
		return { ok: false, dir, reason: `backup write failed: ${messageOf(error)}`, bytes: total() };
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Apply the plan. Every failure is collected per path instead of aborting, so a
 * partial rollback is reported precisely rather than silently half-done.
 */
export async function executeRollback(plan: RollbackPlan): Promise<RollbackRepoResult[]> {
	const results: RollbackRepoResult[] = [];
	for (const repo of plan.repos) {
		const result: RollbackRepoResult = {
			root: repo.root,
			restored: 0,
			deleted: 0,
			failures: [],
			unrecoverable: repo.actions.filter((entry) => entry.kind === "unrecoverable"),
			headMoved: repo.actions.filter((entry) => entry.kind === "head-moved"),
		};

		for (const entry of repo.actions) {
			if (entry.kind === "restore") {
				const abs = resolveInsideRepo(repo.root, entry.path);
				if (!abs) {
					result.failures.push({ path: entry.path, reason: "path escapes the repository root" });
					continue;
				}
				if (!repo.base) {
					result.failures.push({ path: entry.path, reason: "no baseline reference to restore from" });
					continue;
				}
				// Worktree only: the index and the user's commit history stay untouched.
				const restored = await runGit(
					["restore", `--source=${repo.base}`, "--worktree", "--", entry.path],
					repo.root,
				);
				if (restored.ok) result.restored += 1;
				else result.failures.push({ path: entry.path, reason: restored.stderr.trim() || "git restore failed" });
				continue;
			}
			if (entry.kind === "delete") {
				const abs = resolveInsideRepo(repo.root, entry.path);
				if (!abs) {
					result.failures.push({ path: entry.path, reason: "path escapes the repository root" });
					continue;
				}
				try {
					if (!fs.existsSync(abs)) continue; // already gone
					fs.rmSync(abs, { force: true });
					pruneEmptyParents(path.dirname(abs), repo.root);
					result.deleted += 1;
				} catch (error) {
					result.failures.push({ path: entry.path, reason: messageOf(error) });
				}
			}
		}
		results.push(result);
	}
	return results;
}

/** Remove directories left empty by the rollback, stopping at the first non-empty one. */
function pruneEmptyParents(start: string, root: string): void {
	let dir = start;
	while (dir !== root && dir.startsWith(root + path.sep)) {
		try {
			if (fs.readdirSync(dir).length > 0) return;
			fs.rmdirSync(dir);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

/** Compact human-readable rollback result, including the backup location. */
export function formatRollbackReport(
	plan: RollbackPlan,
	results: readonly RollbackRepoResult[],
	backupDir: string | null,
): string {
	const restored = results.reduce((sum, result) => sum + result.restored, 0);
	const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
	const failures = results.flatMap((result) => result.failures.map((failure) => ({ root: result.root, ...failure })));
	const unrecoverable = results.flatMap((result) => result.unrecoverable);
	const headMoved = results.flatMap((result) => result.headMoved);

	const lines: string[] = [
		`Rolled back ${restored} file(s) and deleted ${deleted} file(s) created during this goal.`,
	];
	if (plan.repos.length > 1) {
		for (const result of results) {
			lines.push(`  ${result.root}: restored ${result.restored}, deleted ${result.deleted}`);
		}
	}
	if (failures.length > 0) {
		lines.push(`${failures.length} path(s) could not be rolled back:`);
		for (const failure of failures) lines.push(`  ${failure.root} ${failure.path} — ${failure.reason}`);
	}
	if (unrecoverable.length > 0) {
		lines.push(`${unrecoverable.length} change(s) were left in place (not restorable from the baseline):`);
		for (const entry of unrecoverable) lines.push(`  ${entry.path} — ${entry.reason}`);
	}
	if (headMoved.length > 0) {
		lines.push(`${headMoved.length} repository/repositories had a moved HEAD and were not reset:`);
		for (const entry of headMoved) lines.push(`  ${entry.path} — ${entry.reason}`);
	}
	lines.push(backupDir ? `Backup (can be replayed with git apply): ${backupDir}` : "No backup was written.");
	return lines.join("\n");
}
