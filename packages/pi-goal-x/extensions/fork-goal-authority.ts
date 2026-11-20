/**
 * Fork-only authoritative goal reads for agent-initiated tweaks.
 *
 * Goal-X's shared parse cache keys on (mtime,size), which can collide when an
 * external writer changes a goal in the same clock tick. Its cache is also an
 * unbounded Map keyed by file path, so synthetic cache keys would leak. These
 * helpers read and parse the ACTUAL file bytes with an independent parser and
 * never touch the shared cache.
 */
import { readFileSync, lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { findJsonObjectEnd, extractObjectiveFromBody, GOALS_DIR, resolveGoalPath } from "./storage/goal-files.ts";
import { normalizeGoalRecord, type GoalRecord } from "./goal-record.ts";

/**
 * A turn-buffer flush must not overwrite authoritative lifecycle state that
 * changed while the buffer was open. Compare disk against the original base,
 * not the buffered status, which may represent an intentional transition.
 */
export function canFlushBufferedGoal(freshDisk: GoalRecord | null, buffered: GoalRecord, base: GoalRecord, agentReview = false): boolean {
	return !!freshDisk
		&& freshDisk.id === buffered.id && freshDisk.id === base.id
		&& (!agentReview || (freshDisk.activePath === base.activePath && isDeepStrictEqual(freshDisk.scheduler, base.scheduler)))
		&& isDeepStrictEqual(JSON.parse(JSON.stringify(goalDefinition(freshDisk))), JSON.parse(JSON.stringify(goalDefinition(base))));
}
function goalDefinition(goal: GoalRecord) {
	return { objective: goal.objective, verificationContract: goal.verificationContract,
		status: goal.status, tokenBudget: goal.tokenBudget, autoContinue: goal.autoContinue,
		sisyphus: goal.sisyphus, taskList: goal.taskList?.tasks.length ? goal.taskList : undefined, currentTaskId: goal.currentTaskId,
		skipAuditor: goal.skipAuditor === true, stopReason: goal.stopReason,
		pauseReason: goal.pauseReason, pauseSuggestedAction: goal.pauseSuggestedAction };
}
import type { GoalCore } from "./goal-state.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Parse raw active-goal file bytes without consulting or mutating the shared parse cache. */
export function parseAuthoritativeGoalContent(content: string): GoalRecord | null {
	const end = findJsonObjectEnd(content);
	if (end < 0) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(content.slice(0, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	const objective = extractObjectiveFromBody(content.slice(end + 1)) ?? raw.objective;
	return normalizeGoalRecord({ ...raw, objective });
}

/** Read an active goal file at a known path from disk, bypassing the shared mtime cache. */
export function readAuthoritativeGoalAtPath(filePath: string, expectedActivePath?: string): GoalRecord | null {
	try {
		const stat = lstatSync(filePath);
		if (stat.isSymbolicLink()) return null;
		const goal = parseAuthoritativeGoalContent(readFileSync(filePath, "utf8"));
		return expectedActivePath !== undefined && goal?.activePath !== expectedActivePath ? null : goal;
	} catch {
		return null;
	}
}

/** Read the focused goal's active file directly from disk, bypassing the shared mtime cache. */
export function readAuthoritativeGoal(ctx: ExtensionContext, core: GoalCore): GoalRecord | null {
	const current = core.state.goal;
	if (!current?.activePath) return null;
	return readAuthoritativeGoalAtPath(resolveGoalPath(ctx, GOALS_DIR, current.activePath), current.activePath);
}
