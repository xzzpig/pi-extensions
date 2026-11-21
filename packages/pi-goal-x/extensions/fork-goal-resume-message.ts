import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { otherOpenGoalCount } from "./goal-pool.ts";
import type { GoalCore } from "./goal-state.ts";

export type GoalResumeContext = ExtensionContext & Partial<Pick<ExtensionCommandContext, "waitForIdle">>;

interface ResumeIdleWatch {
	current(): Promise<void>;
	dispose(): void;
}

function watchGoalResumeIdle(core: GoalCore, ctx: GoalResumeContext): ResumeIdleWatch | undefined {
	const waitForIdle = ctx.waitForIdle?.bind(ctx);
	if (!waitForIdle) return;
	let pending = waitForIdle();
	// While the chooser is open, capture each run's wait while Pi is still busy.
	// Once agent_settled starts, a fresh waitForIdle can resolve too early.
	const dispose = core.pi.on("before_agent_start", () => { pending = waitForIdle(); });
	return { current: () => pending, dispose };
}

async function resumeWhenReady(
	core: GoalCore, ctx: GoalResumeContext, goalId: string, idle: ResumeIdleWatch | undefined, resume: () => void,
): Promise<void> {
	if (!ctx.waitForIdle) {
		ctx.ui.notify("Resuming with a message requires a Pi command context.", "warning");
		return;
	}
	const owner = core.sessionOwner;
	const focus = core.focusedOperationToken(goalId);
	while (true) {
		const observed = idle?.current();
		await Promise.all([observed, ctx.waitForIdle()]);
		if (core.sessionOwner !== owner) break;
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.isFocusedOperationCurrent(focus) || core.state.goal?.id !== goalId) break;
		// Pi marks a new run busy before we receive before_agent_start.
		if (observed !== idle?.current() || !ctx.isIdle()) continue;
		resume();
		return;
	}
	ctx.ui.notify("Goal or session changed while waiting; nothing was resumed or sent.", "warning");
}

export async function resumeGoalWithMessage(
	core: GoalCore,
	ctx: GoalResumeContext,
	message: string,
	chooseGoal: (onSelected: (goalId: string) => void) => Promise<unknown>,
	resume: () => boolean,
): Promise<void> {
	const resumeAndSend = () => {
		if (resume()) core.pi.sendUserMessage(message);
	};
	const goal = core.state.goal;
	if (goal) return resumeWhenReady(core, ctx, goal.id, undefined, resumeAndSend);
	if (otherOpenGoalCount(core.goalsById, null) === 0) {
		ctx.ui.notify("No goal is focused.", "warning");
		return;
	}
	const idle = watchGoalResumeIdle(core, ctx);
	try {
		let pending: Promise<void> | undefined;
		await chooseGoal(goalId => { pending = resumeWhenReady(core, ctx, goalId, idle, resumeAndSend); });
		if (pending) await pending;
	} finally {
		idle?.dispose();
	}
}
