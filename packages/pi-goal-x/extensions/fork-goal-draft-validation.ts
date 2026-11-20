/**
 * Fork-only parameter validation for propose_goal_draft.
 *
 * Keeps the upstream tool seam small: all pure checks that must run before a
 * transaction buffer flush live here. The caller supplies read-only getters so
 * this module never mutates state.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGoalSettings } from "./goal-settings.ts";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { validateTokenBudgetInput } from "./goal-record.ts";
import type { GoalTaskList } from "./goal-record.ts";
import type { FlatTaskInput } from "./goal-task-tools.ts";

export interface ValidationPorts {
	rawObjective(): string;
	tokenBudget(): number | null | undefined;
	tasks(): FlatTaskInput[] | undefined;
	blockCompletion(): boolean | undefined;
	sisyphus(): boolean | undefined;
	mode(): string | undefined;
	convertTasks(tasks: FlatTaskInput[] | undefined, blockCompletion: boolean | undefined): { ok: true; value?: GoalTaskList } | { ok: false; message: string };
}

export type ValidationResult =
	| { ok: true; objective: string; taskResult: { ok: true; value?: GoalTaskList }; extracted: { objective: string; verificationContract?: string } }
	| { ok: false; message: string };

export function validateDraftParams(ports: ValidationPorts, ctx: ExtensionContext, agentTweak = false): ValidationResult {
	const budget = ports.tokenBudget();
	if (budget !== undefined && budget !== null) {
		const v = validateTokenBudgetInput(budget);
		if (!v.ok) return { ok: false, message: v.message };
	}
	const objective = ports.rawObjective().trim();
	if (!objective) return { ok: false, message: "The proposed objective must be at least 1 character." };
	const maxChars = loadGoalSettings(ctx.cwd).objectiveMaxChars ?? 0;
	if (maxChars > 0 && objective.length > maxChars) {
		return { ok: false, message: `The proposed objective must be at most ${maxChars} characters (${objective.length} given).` };
	}
	const taskResult = ports.convertTasks(ports.tasks(), ports.blockCompletion());
	if (!taskResult.ok) return { ok: false, message: taskResult.message };
	const mode = ports.mode();
	if (mode && mode !== "tweak" && ((ports.sisyphus() === true) !== (mode === "sisyphus"))) {
		return { ok: false, message: "Proposal mode does not match the command that began this draft." };
	}
	if (mode === "sisyphus" && !sisyphusObjectiveSufficient(objective)) {
		return { ok: false, message: "A Sisyphus goal needs ordered steps with explicit per-step done criteria. Refine the objective with numbered steps (1) ..., 2) ...) or Step N: blocks before proposing again." };
	}
	const settings = loadGoalSettings(ctx.cwd);
	const extracted = settings.disableContracts
		? { objective, verificationContract: undefined }
		: extractVerificationContract(objective);
	if (agentTweak && !extracted.objective.trim()) return { ok: false, message: "The proposal must include a complete objective, not only a verification contract." };
	return { ok: true, objective, taskResult, extracted };
}
