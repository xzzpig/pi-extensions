import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { GoalRecord, GoalTaskList } from "./goal-record.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { normalizeAgentTweakCandidate, projectTweakCandidate, type TweakProjectionContext } from "./goal-tweak-projection.ts";
import { buildTweakComparison, buildTweakPresentation, type TweakPresentation } from "./goal-tweak-diff.ts";
import { convertFlatTasks, type FlatTaskInput } from "./goal-task-tools.ts";
import { showTweakProposalDialog, type TweakProposalDialogResult } from "./goal-tweak-confirmation.ts";
import { sanitizeTweakReason } from "./goal-agent-tweak.ts";

interface TweakRenderContext { cwd?: string; state?: { tweakReviewed?: boolean; tweakPending?: boolean }; invalidate(): void }
interface ReviewScope { review?: TweakReview }
export type TweakReason = string | undefined;
interface ReviewResult { isError?: boolean; content: Array<{ type: string; text?: string }>; details?: unknown; terminate?: boolean }
const reviews = new AsyncLocalStorage<ReviewScope>();

/** Execution-local scope: no cross-tool/core mutable presentation cache. */
export async function withTweakReview<T extends ReviewResult>(execute: () => Promise<T>): Promise<T> {
	return reviews.run({}, async () => {
		try {
			const result = await execute();
			return reviews.getStore()?.review?.attach(result) ?? result;
		} catch (error) {
			const review = reviews.getStore()?.review;
			if (!review) throw error;
			return review.attach({ isError: true, content: [{ type: "text", text: error instanceof StaleTweakError
				? "Goal tweak was not applied: the reviewed goal changed; review and propose again."
				: "Goal tweak execution failed; application is not confirmed. Inspect the goal before retrying." }] }) as T;
		}
	});
}

function comparable(goal: GoalRecord): string {
	const taskList = goal.taskList ? { tasks: goal.taskList.tasks, blockCompletion: goal.taskList.blockCompletion } : undefined;
	return JSON.stringify({ objective: goal.objective, verificationContract: goal.verificationContract, taskList,
		tokenBudget: goal.tokenBudget, skipAuditor: goal.skipAuditor === true, status: goal.status,
		currentTaskId: goal.currentTaskId, autoContinue: goal.autoContinue, stopReason: goal.stopReason,
		pauseReason: goal.pauseReason, pauseSuggestedAction: goal.pauseSuggestedAction });
}

export class StaleTweakError extends Error {}

export class TweakReview {
	private readonly before: GoalRecord;
	private readonly context: TweakProjectionContext;
	private choice: TweakProposalDialogResult;
	private readonly ctx: ExtensionContext;
	private readonly objective: string;
	private readonly taskList: GoalTaskList | undefined;
	private readonly tokenBudget: number | null | undefined;
	private readonly reason: TweakReason;
	private readonly agentInitiated: boolean;
	constructor(ctx: ExtensionContext, target: GoalRecord, objective: string,
		taskList: GoalTaskList | undefined, tokenBudget: number | null | undefined,
		auditorEnabled: boolean, reason?: TweakReason, agentInitiated = false) {
		this.agentInitiated = agentInitiated;
		this.ctx = ctx; this.objective = objective; this.taskList = taskList; this.tokenBudget = tokenBudget;
		const clean = typeof reason === "string" ? sanitizeTweakReason(reason).trim() : "";
		this.reason = clean || undefined;
		this.before = structuredClone(target);
		const settings = loadGoalSettings(ctx.cwd);
		this.context = { disableContracts: settings.disableContracts === true, sessionId: ctx.sessionManager.getSessionId(),
			maxAutonomousRuns: settings.maxAutonomousRuns, now: new Date().toISOString(), schedulerGeneration: randomUUID() };
		this.choice = { decision: "continue", auditorEnabled, unavailable: false };
		const scope = reviews.getStore();
		if (scope) scope.review = this;
	}
	private project(goal: GoalRecord, auditorEnabled: boolean, context = this.context) {
		const projected = projectTweakCandidate(goal, { objective: this.objective, taskList: this.taskList, tokenBudget: this.tokenBudget, auditorEnabled }, context);
		return this.agentInitiated ? { ...projected, candidate: normalizeAgentTweakCandidate(projected.candidate) } : projected;
	}
	presentation(auditorEnabled: boolean): TweakPresentation {
		return buildTweakPresentation(this.before, this.project(this.before, auditorEnabled).candidate);
	}
	async confirm(signal?: AbortSignal): Promise<TweakProposalDialogResult> {
		return showTweakProposalDialog(this.ctx, { defaultAuditorEnabled: this.choice.auditorEnabled, reason: this.reason, signal, presentation: (enabled) => {
			const { presentation, entries, fullUiText } = buildTweakComparison(this.before, this.project(this.before, enabled).candidate);
			return { ...presentation, diffEntries: entries, fullUiText };
		} });
	}
	record(choice: TweakProposalDialogResult): string {
		this.choice = choice;
		return this.presentation(choice.auditorEnabled).diffText;
	}
	/** Record a dialog/transport failure as an explicit error outcome, not "continue". */
	recordFailure(_error: unknown): string {
		this.choice = { decision: "cancel", auditorEnabled: this.choice.auditorEnabled, unavailable: true };
		return this.presentation(this.choice.auditorEnabled).diffText;
	}
	mutate(goal: GoalRecord, auditorEnabled: boolean) {
		const settings = loadGoalSettings(this.ctx.cwd);
		const projected = this.project(goal, auditorEnabled, { ...this.context, disableContracts: settings.disableContracts === true,
			maxAutonomousRuns: settings.maxAutonomousRuns });
		if (goal.id !== this.before.id || goal.revision !== this.before.revision
			|| (this.agentInitiated && (comparable(goal) !== comparable(this.before)
				|| JSON.stringify([goal.sisyphus, goal.activePath, goal.archivedPath, goal.scheduler]) !== JSON.stringify([this.before.sisyphus, this.before.activePath, this.before.archivedPath, this.before.scheduler])))
			|| comparable(projected.candidate) !== comparable(this.project(this.before, auditorEnabled).candidate)) {
			throw new StaleTweakError("The reviewed goal changed; propose again.");
		}
		return projected;
	}
	attach<T extends ReviewResult>(result: T): T {
		const presentation = this.presentation(this.choice.auditorEnabled);
		const applied = result.terminate === true && this.choice.decision === "confirm";
		const outcome = result.isError ? "error" : applied ? "applied" : this.choice.unavailable ? "unavailable" : this.choice.decision === "confirm" ? "not-applied" : this.choice.decision;
		const reasonSection = this.reason ? `调整原因：\n${this.reason}\n\n` : "";
		const content = result.content.map(item => item.type !== "text" || !item.text ? item : { ...item, text: reasonSection + item.text
			.replace(/Draft cancelled; no goal was created\.[^\n]*/, "Goal tweak cancelled; the current goal was not changed.")
			.replace(/The goal was NOT created/g, "The goal was NOT changed") });
		const hasDiff = content.some(item => item.text?.includes(presentation.diffText));
		if (!hasDiff) content.unshift({ type: "text", text: presentation.diffText });
		return { ...result, content, details: { ...(result.details && typeof result.details === "object" ? result.details : {}),
			tweakReview: { version: 1, goalId: this.before.id, revision: this.before.revision, outcome, ...(this.reason ? { reason: this.reason } : {}), ...presentation } } };
	}
}

/** Reads a saved snapshot only; later goal changes cannot rewrite prior reviews. */
export function renderTweakReview(result: { details?: unknown; content?: Array<{ type: string; text?: string }> }, expanded: boolean, theme: Theme, context?: TweakRenderContext): Text | undefined {
	const details = result.details as { tweakReview?: { summary?: string; diffText?: string; fullText?: string; outcome?: string; reason?: string } } | undefined;
	const review = details?.tweakReview;
	if (!review || typeof review.diffText !== "string" || typeof review.fullText !== "string") {
		if (result.details && context?.state && context.state.tweakReviewed !== false) {
			context.state.tweakReviewed = false;
			context.state.tweakPending = false;
			context.invalidate();
		}
		return undefined;
	}
	if (context?.state && !context.state.tweakReviewed) { context.state.tweakReviewed = true; context.invalidate(); }
	const report = (result.content ?? []).filter(item => item.type === "text").map(item => item.text ?? "").join("\n").replace(review.diffText, "").trim();
	const heading = `Goal tweak — ${review.outcome ?? "not-applied"}: ${review.summary ?? ""}`;
	const reasonSection = review.reason ? `调整原因：\n${review.reason}\n\n` : "";
	return new Text(theme.fg("toolOutput", expanded ? `${heading}\n\n${reasonSection}${review.diffText}\n\nModified goal (full):\n${review.fullText}\n\n${report}` : heading), 0, 0);
}

/** Keep a tweak call row classified after drafting clears, including session replay. */
interface PendingTweak { target?: GoalRecord | null; auditorEnabled: boolean; agentInitiated?: boolean; args: { objective?: string; tasks?: FlatTaskInput[]; block_completion?: boolean; token_budget?: number | null; tweak?: unknown } }
export function renderTweakCall(active: boolean, theme: Theme, context?: TweakRenderContext, pending?: PendingTweak): Text | undefined {
	if (context?.state?.tweakReviewed === false && !pending?.args.tweak) return undefined;
	if (active && context?.state) context.state.tweakPending = true;
	if (!active && !context?.state?.tweakReviewed && !context?.state?.tweakPending) return undefined;
	let preview = "";
	if (!context?.state?.tweakReviewed && pending?.target && typeof pending.args.objective === "string") {
		const settings = loadGoalSettings(context?.cwd ?? process.cwd());
		const tasks = pending.args.tasks === undefined ? undefined : convertFlatTasks(pending.args.tasks, { maxSubtaskDepth: settings.subtaskDepth ?? 1 });
		if (!tasks || tasks.ok) {
			const candidate = projectTweakCandidate(pending.target, { objective: pending.args.objective.trim(), tokenBudget: pending.args.token_budget,
				taskList: tasks?.ok ? { tasks: tasks.tasks, blockCompletion: pending.args.block_completion === true, proposedAt: "" } : undefined,
				auditorEnabled: pending.auditorEnabled }, { disableContracts: settings.disableContracts === true, maxAutonomousRuns: settings.maxAutonomousRuns,
				now: "", schedulerGeneration: "pending" }).candidate;
			preview = "\n\n" + buildTweakPresentation(pending.target, pending.agentInitiated || pending.args.tweak ? normalizeAgentTweakCandidate(candidate) : candidate).diffText;
		}
	}
	return new Text(theme.fg("muted", context?.state?.tweakReviewed
		? "Goal tweak — review snapshot below (expand for diff and modified goal)."
		: "Goal tweak — pending authoritative validation; the complete diff is shown in the review dialog." + preview), 0, 0);
}
