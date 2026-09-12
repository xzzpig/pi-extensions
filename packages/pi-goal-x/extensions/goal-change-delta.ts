/**
 * Workspace change manifest — window delta computation.
 *
 * The delta is the set of worktree changes that happened between a goal's
 * baseline and now, computed per repository:
 *
 *   - tracked files: `git diff --name-status` + `--numstat` against the
 *     baseline reference (`stash` when the tree was dirty, else `HEAD`), so
 *     already-dirty-before-the-goal files that were not touched are excluded
 *     by construction, and in-window commits still show up
 *   - untracked files: compared against the baseline status snapshot (new
 *     untracked paths are reported; a baseline-untracked path whose size or
 *     mtime changed is reported as modified; an unchanged one is excluded)
 *   - submodules and nested repositories: reported in their own section, never
 *     in the enclosing repository's (innermost repository wins)
 *   - repository HEAD moves: recorded as `headMoved`, never hidden
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { runGit, resolveRepoScope, type RepoKind, type RepoScope } from "./goal-change-manifest.ts";
import {
	attachUntrackedStat,
	parseStatusEntries,
	readChangeBaseline,
	type ChangeBaseline,
	type RepoBaseline,
	type StatusEntry,
} from "./goal-change-baseline.ts";

/** Per-repository bound on reported entries; the renderer adds a "+N more" note. */
export const MAX_DELTA_ENTRIES = 1_000;

export type ChangeEntryStatus =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "type-changed"
	| "untracked"
	| "untracked-modified";

/**
 * Paths pi-goal-x writes itself: goal records, baseline sidecars, ledgers, and
 * pi-subagents runtime directories.
 *
 * These are never workspace work. The baseline sidecar is written *after* the
 * snapshot is taken, so without this filter the manifest would report the
 * extension's own bookkeeping as a change — and the rollback would delete it.
 */
export const GOAL_RUNTIME_DIR_PREFIXES = [".pi/goals/", ".pi-subagents/", ".pi/subagents/"] as const;

/** Exact runtime file paths (not directory prefixes). */
export const GOAL_RUNTIME_FILES = [".pi/goal_events.jsonl", ".pi/.goals-pool-snapshot.json"] as const;

/** True for a repository-relative path that belongs to pi-goal-x runtime state. */
export function isGoalRuntimePath(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
	if ((GOAL_RUNTIME_FILES as readonly string[]).includes(normalized)) return true;
	return GOAL_RUNTIME_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export interface RepoChangeEntry {
	/** Path relative to the repository root, with forward slashes. */
	path: string;
	status: ChangeEntryStatus;
	/** Short code shown in the manifest (`M`, `A`, `D`, `R`, `??`, `??~`). */
	code: string;
	/** Original path of a rename. */
	origPath?: string;
	additions?: number;
	deletions?: number;
	/** True when git reported the change as binary (`-` in numstat). */
	binary?: boolean;
}

export interface RepoDelta {
	root: string;
	kind: RepoKind;
	relativePath?: string;
	/** Baseline reference the diff was taken against. */
	base: string | null;
	baseKind: "stash" | "head" | "status-only";
	/** Set when the repository's HEAD moved inside the window. */
	headMoved: { from: string | null; to: string | null } | null;
	entries: RepoChangeEntry[];
	/** Entries beyond `MAX_DELTA_ENTRIES` that were not listed (diagnostics only). */
	omittedEntries: number;
	/** Capture/diff failure note; the section is then incomplete. */
	error?: string;
}

export interface ChangeDelta {
	goalId: string;
	baselineCapturedAt: string;
	repos: RepoDelta[];
	totalEntries: number;
	/** True when the window contains no change at all (explicitly recorded). */
	empty: boolean;
	/** True when the baseline itself was cut short (scope/timeout). */
	truncated: boolean;
	/** Non-fatal notes for the diagnostics path; never rendered into the prompt. */
	diagnostics: string[];
}

export interface NameStatusEntry {
	status: string;
	path: string;
	origPath?: string;
}

export interface NumstatEntry {
	path: string;
	origPath?: string;
	additions?: number;
	deletions?: number;
	binary: boolean;
}

/** Parse NUL-delimited `git diff --name-status -z` output. */
export function parseNameStatus(stdout: string): NameStatusEntry[] {
	const fields = stdout.split("\u0000");
	const entries: NameStatusEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const code = fields[index];
		if (!code) continue;
		const letter = code.slice(0, 1);
		if (letter === "R" || letter === "C") {
			const from = fields[index + 1];
			const to = fields[index + 2];
			index += 2;
			if (from && to) entries.push({ status: letter, path: to, origPath: from });
			continue;
		}
		const filePath = fields[index + 1];
		index += 1;
		if (filePath) entries.push({ status: letter, path: filePath });
	}
	return entries;
}

/**
 * Parse NUL-delimited `git diff --numstat -z` output. A rename record carries
 * its two paths (old, new) in the two fields that follow the counts.
 */
export function parseNumstat(stdout: string): NumstatEntry[] {
	const fields = stdout.split("\u0000");
	const entries: NumstatEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		const firstTab = field.indexOf("\t");
		if (firstTab === -1) continue;
		const secondTab = field.indexOf("\t", firstTab + 1);
		if (secondTab === -1) continue;
		const additionsText = field.slice(0, firstTab);
		const deletionsText = field.slice(firstTab + 1, secondTab);
		const pathInField = field.slice(secondTab + 1);
		const counts = {
			additions: additionsText === "-" ? undefined : Number(additionsText),
			deletions: deletionsText === "-" ? undefined : Number(deletionsText),
			binary: additionsText === "-" || deletionsText === "-",
		};
		if (pathInField) {
			entries.push({ path: pathInField, ...counts });
			continue;
		}
		const from = fields[index + 1];
		const to = fields[index + 2];
		index += 2;
		if (from && to) entries.push({ path: to, origPath: from, ...counts });
	}
	return entries;
}

/** Map a `--name-status` letter to a manifest status. */
function classifyDiffStatus(letter: string): ChangeEntryStatus {
	switch (letter) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "added";
		case "T":
			return "type-changed";
		case "U":
			return "modified";
		default:
			return "modified";
	}
}

/** True when a baseline-untracked file's content is (or may be) different now. */
function untrackedChanged(before: StatusEntry, now: StatusEntry): boolean {
	if (!before.stat || !now.stat) return true; // missing evidence counts as changed
	return before.stat.size !== now.stat.size || before.stat.mtimeMs !== now.stat.mtimeMs;
}

/** Delta for one repository. Never throws; failures land in `error`. */
export async function computeRepoDelta(
	repo: RepoBaseline,
	options: { timeoutMs?: number } = {},
): Promise<RepoDelta> {
	const baseKind: RepoDelta["baseKind"] = repo.stash ? "stash" : repo.head ? "head" : "status-only";
	const base = repo.stash ?? repo.head;
	const delta: RepoDelta = {
		root: repo.root,
		kind: repo.kind,
		...(repo.relativePath ? { relativePath: repo.relativePath } : {}),
		base,
		baseKind,
		headMoved: null,
		entries: [],
		omittedEntries: 0,
	};

	const headNow = await runGit(["rev-parse", "--verify", "HEAD"], repo.root, options);
	const headTo = headNow.ok ? headNow.stdout.trim() || null : null;
	if (repo.head !== headTo) delta.headMoved = { from: repo.head, to: headTo };

	const byPath = new Map<string, RepoChangeEntry>();
	if (base) {
		const nameStatus = await runGit(
			["diff", "--name-status", "-z", "--find-renames", base],
			repo.root,
			options,
		);
		const numstat = await runGit(["diff", "--numstat", "-z", "--find-renames", base], repo.root, options);
		if (!nameStatus.ok) {
			delta.error = nameStatus.stderr.trim() || "git diff failed";
		} else {
			const counts = new Map(parseNumstat(numstat.stdout).map((entry) => [entry.path, entry]));
			for (const entry of parseNameStatus(nameStatus.stdout)) {
				if (isGoalRuntimePath(entry.path)) continue; // never report our own bookkeeping
				const count = counts.get(entry.path);
				const change: RepoChangeEntry = {
					path: entry.path,
					status: classifyDiffStatus(entry.status),
					code: entry.status,
					...(entry.origPath ? { origPath: entry.origPath } : {}),
					...(count?.additions !== undefined ? { additions: count.additions } : {}),
					...(count?.deletions !== undefined ? { deletions: count.deletions } : {}),
					...(count?.binary ? { binary: true } : {}),
				};
				byPath.set(change.path, change);
			}
		}
	}

	const statusNow = await runGit(
		["status", "--porcelain", "-z", "--untracked-files=all"],
		repo.root,
		options,
	);
	if (statusNow.ok) {
		const current = new Map(
			parseStatusEntries(statusNow.stdout)
				// The baseline snapshot carries a stat for untracked entries, so the
				// current side needs one too or every pre-existing untracked file would
				// look modified.
				.map((entry) => attachUntrackedStat(repo.root, entry))
				.map((entry) => [entry.path, entry]),
		);
		const baselineEntries = new Map(repo.status.map((entry) => [entry.path, entry]));

		for (const [filePath, entry] of current) {
			if (entry.code !== "??" || byPath.has(filePath)) continue;
			if (isGoalRuntimePath(filePath)) continue; // the baseline sidecar lands after capture
			const before = baselineEntries.get(filePath);
			if (!before) {
				byPath.set(filePath, { path: filePath, status: "untracked", code: "??" });
				continue;
			}
			// Identical to the baseline snapshot: pre-existing dirt, not a window change.
			if (!untrackedChanged(before, entry)) continue;
			byPath.set(filePath, { path: filePath, status: "untracked-modified", code: "??~" });
		}

		// A baseline-untracked file that is gone now was deleted inside the window.
		for (const [filePath, before] of baselineEntries) {
			if (before.code !== "??" || current.has(filePath) || byPath.has(filePath)) continue;
			if (isGoalRuntimePath(filePath)) continue;
			byPath.set(filePath, { path: filePath, status: "deleted", code: "??-" });
		}
	} else {
		delta.error = statusNow.stderr.trim() || "git status failed";
	}

	delta.entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
	return delta;
}

/**
 * Compute the window delta for a baseline. `repos` in the result mirrors the
 * baseline's repository order, and an empty window is reported explicitly
 * (`empty: true`) rather than by omitting the section.
 */
export async function computeChangeDelta(
	baseline: ChangeBaseline,
	options: { timeoutMs?: number } = {},
): Promise<ChangeDelta> {
	const repos: RepoDelta[] = [];
	for (const repo of baseline.repos) {
		const delta = await computeRepoDelta(repo, options);
		// Innermost repository wins: only repositories *inside* this one can own a
		// path this section would otherwise report. Filtering by “any other root”
		// would discard a nested repository's own files, because its paths always
		// sit under its ancestors’ roots too.
		const nested = baseline.repos.filter(
			(candidate) => candidate.root !== repo.root && candidate.root.startsWith(repo.root + path.sep),
		);
		delta.entries = delta.entries.filter((entry) => {
			const abs = path.resolve(repo.root, entry.path);
			return !nested.some((candidate) => abs === candidate.root || abs.startsWith(candidate.root + path.sep));
		});
		delta.omittedEntries = Math.max(0, delta.entries.length - MAX_DELTA_ENTRIES);
		if (delta.omittedEntries > 0) delta.entries = delta.entries.slice(0, MAX_DELTA_ENTRIES);
		repos.push(delta);
	}

	const totalEntries = repos.reduce((sum, repo) => sum + repo.entries.length, 0);
	const diagnostics = [...baseline.diagnostics];
	for (const repo of repos) {
		if (repo.error) diagnostics.push(`diff failed for ${repo.root}: ${repo.error}`);
		if (repo.omittedEntries > 0) diagnostics.push(`${repo.root}: ${repo.omittedEntries} entries omitted`);
	}

	return {
		goalId: baseline.goalId,
		baselineCapturedAt: baseline.capturedAt,
		repos,
		totalEntries,
		empty: totalEntries === 0,
		truncated: baseline.truncated,
		diagnostics,
	};
}

/**
 * Read the goal's baseline, compute the window delta, and render the manifest
 * body. Returns null (no manifest block at all) when the feature is off, the
 * cwd is not a git repository, no baseline was captured, or anything fails —
 * the audit then sees exactly the input it saw before this feature existed.
 */
export async function renderGoalChangeManifest(
	ctx: { cwd: string },
	goalId: string,
): Promise<string | null> {
	try {
		const baseline = readChangeBaseline(ctx, goalId);
		if (!baseline) return null;
		const delta = await computeChangeDelta(baseline);
		return renderChangeManifestBody(delta);
	} catch {
		return null;
	}
}

/** Cheap existence probe used by tests and diagnostics. */
export function repoScopeOf(repo: RepoDelta): RepoScope {
	return {
		root: repo.root,
		kind: repo.kind,
		...(repo.relativePath ? { relativePath: repo.relativePath } : {}),
	};
}

/**
 * Manifest length bound. The renderer never inlines diff bodies: it lists paths
 * with line counts and hands the auditor a directly executable command per
 * repository, so the auditor pulls content only for what it wants to check.
 */
export const MAX_CHANGE_MANIFEST_CHARS = 6_000;

/**
 * Command the auditor can run verbatim to expand this repository's changes.
 * Uses `git -C <root>`, which is correct for the primary repository, ancestors,
 * submodules, and nested repositories alike.
 */
export function changeManifestExpandCommand(repo: RepoDelta): string {
	return repo.base
		? `git -C ${repo.root} diff ${repo.base}`
		: `git -C ${repo.root} status --porcelain --untracked-files=all`;
}

function shortSha(sha: string | null): string {
	return sha ? sha.slice(0, 10) : "(none)";
}

function formatChangeEntry(entry: RepoChangeEntry): string {
	const lineCount = entry.binary
		? " (binary)"
		: entry.additions !== undefined || entry.deletions !== undefined
			? ` (+${entry.additions ?? 0}/-${entry.deletions ?? 0})`
			: "";
	const target = entry.origPath ? `${entry.origPath} -> ${entry.path}` : entry.path;
	const note = entry.status === "untracked-modified"
		? " (untracked at baseline, content changed)"
		: entry.status === "deleted" && entry.code === "??-"
			? " (untracked at baseline, deleted in window)"
			: "";
	return `  ${entry.code.padEnd(3)} ${target}${lineCount}${note}`;
}

function truncateManifest(lines: readonly string[], maxChars: number): string {
	let text = lines.join("\n");
	if (text.length <= maxChars) return text;
	const note = "… entry list truncated to fit the manifest length limit; use the expand commands above for full content.";
	const body = lines.slice();
	while (body.length > 0) {
		text = [...body, note].join("\n");
		if (text.length <= maxChars) return text;
		body.pop();
	}
	return note;
}

/**
 * Render the manifest body (no `<change_manifest>` tags): the caller wraps it
 * and escapes it like every other untrusted payload, so a file name can never
 * forge prompt markup.
 *
 * A window with no changes still renders an explicit "no changes" record
 * rather than an empty string, so the auditor can tell "nothing changed" from
 * "the manifest was not collected".
 */
export function renderChangeManifestBody(
	delta: ChangeDelta,
	options: { maxChars?: number } = {},
): string {
	const maxChars = options.maxChars ?? MAX_CHANGE_MANIFEST_CHARS;
	const lines: string[] = [
		"Machine-collected workspace evidence for this goal's execution window (git snapshot diff).",
		"This is not the executor's claim: verify entries against the repository before relying on them.",
		"",
		`Baseline captured: ${delta.baselineCapturedAt} (before the goal's first execution turn).`,
		`Repositories in scope: ${delta.repos.length}.`,
	];
	if (delta.truncated) {
		lines.push("Note: the baseline scan was cut short, so this manifest may be incomplete.");
	}
	if (delta.empty) {
		lines.push("", "No workspace changes were detected in this window.");
	}

	for (let index = 0; index < delta.repos.length; index += 1) {
		const repo = delta.repos[index];
		if (!repo) continue;
		lines.push("");
		const relative = repo.relativePath ? ` (relative: ${repo.relativePath})` : "";
		lines.push(`[repo ${index + 1}/${delta.repos.length}] ${repo.kind} — ${repo.root}${relative}`);
		lines.push(`baseline: ${repo.baseKind} ${shortSha(repo.base)}`);
		lines.push(`expand: ${changeManifestExpandCommand(repo)}`);
		if (repo.headMoved) {
			lines.push(`HEAD moved in this window: ${shortSha(repo.headMoved.from)} -> ${shortSha(repo.headMoved.to)}`);
		}
		if (repo.error) lines.push(`incomplete: ${repo.error}`);
		if (repo.entries.length === 0) {
			lines.push("changes (0): none");
			continue;
		}
		lines.push(`changes (${repo.entries.length}):`);
		for (const entry of repo.entries) lines.push(formatChangeEntry(entry));
		if (repo.omittedEntries > 0) {
			lines.push(`  … +${repo.omittedEntries} more entries not listed`);
		}
	}

	return truncateManifest(lines, maxChars);
}

/** True when the path exists in the repository's working tree. */
export function entryExists(root: string, entry: RepoChangeEntry): boolean {
	try {
		return fs.existsSync(path.join(root, entry.path));
	} catch {
		return false;
	}
}
