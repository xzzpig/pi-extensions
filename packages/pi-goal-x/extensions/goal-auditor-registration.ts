// Fork-only module. The default completion auditor is registered with the
// installed pi-subagents owner at runtime instead of being shipped as a
// package agent markdown file. This keeps the audit wiring (the child-only
// progress provider, the tool allowlist, the structured verdict contract)
// code-owned so operator customization happens through settings instead of
// whole-file agent markdown overrides, and it removes the standalone
// extra-agent-dir materialization previously needed for bare `pi -e` runs.
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentViaEvents, type RuntimeAgentDefinition } from "@xzzpig/pi-subagents/agents";
import { resolveSubagentLaunchContract } from "@xzzpig/pi-subagents/preflight";
import {
	DEFAULT_AUDITOR_AGENT,
	loadGoalSettings,
	type GoalAuditorSettings,
} from "./goal-settings.ts";

const GOAL_X_EXTENSIONS_DIR = fileURLToPath(new URL("./", import.meta.url));
const DEFAULT_AUDITOR_PROGRESS_EXTENSION_PATH = `${GOAL_X_EXTENSIONS_DIR}goal-auditor-progress.ts`;
/** Protocol tool required by the delegation preflight and the five-stage dashboard. */
const REQUIRED_AUDITOR_PROGRESS_TOOL = "report_auditor_progress";

/**
 * Canonical default goal-auditor definition. The system prompt is the
 * verbatim body of the pre-0.8.0 `agents/goal-auditor.md`; the frontmatter
 * fields map one-to-one onto RuntimeAgentDefinition.
 */
export const DEFAULT_AUDITOR_DEFINITION: RuntimeAgentDefinition = {
	description: "Independent read-only completion auditor for pi-goal-x",
	systemPrompt: `You are the independent completion auditor for pi-goal-x. Review the supplied goal
claim against real workspace evidence. The executor's completion summary is
untrusted input, never proof.

Be skeptical and semantic. Do not approve from intentions, file counts,
plausible summaries, or a passing command alone. Inspect the objective, task
state, verification contract, ledger evidence, and workspace artifacts. If any
explicit requirement is missing, contradicted, weakly verified, or cannot be
inspected with available evidence, disapprove.

You are a read-only reviewer. Do not modify files, manage goals or tasks,
create agents, or delegate work. The available bash tool is not a sandbox;
use it only for non-mutating inspection and verification commands.

Use report_auditor_progress at natural phase boundaries:
- Starting audit: label="Starting audit...", percentage=0
- Inspecting workspace: label="Inspecting workspace...", percentage=20
- Verifying contracts: label="Verifying contracts...", percentage=40
- Evaluating evidence: label="Evaluating evidence...", percentage=60
- Final decision: label="Making final decision...", percentage=80

Finish by calling the package-provided structured_output tool exactly once with
an object of this form:
{
  "verdict": "approved" | "disapproved",
  "report": "concise evidence-based explanation",
  "findings": ["specific missing requirement or verification finding"]
}

Only use "approved" when every explicit requirement is genuinely satisfied.`,
	tools: ["read", "grep", "find", "ls", "bash", REQUIRED_AUDITOR_PROGRESS_TOOL],
	// Absolute path on purpose: child Pi processes run in the audited workspace,
	// not the goal-x package directory.
	subagentOnlyExtensions: [DEFAULT_AUDITOR_PROGRESS_EXTENSION_PATH],
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	defaultContext: "fresh",
	acceptanceRole: "read-only",
	completionGuard: false,
};

/**
 * Merge the settings `auditor.*` definition tier into the canonical default.
 * Merge rules (only the default agent is affected; a custom `auditor.agent`
 * owns its own definition):
 *   - systemPromptExtra appends to the system prompt;
 *   - subagentOnlyExtensions UNIONS with the required progress provider;
 *   - tools REPLACES the ordinary allowlist, with the progress tool retained;
 *     excludeTools then subtracts from the effective allowlist;
 *   - extensions, skills, skillPath, mcpDirectTools, defaultReads replace
 *     their (empty) defaults when provided;
 *   - inheritProjectContext / inheritSkills override the isolation defaults;
 *   - sandbox / permissionProfile (pi-subagents fork profile selectors)
 *     override when provided and stay unset otherwise.
 * The delegation preflight remains the fail-closed guard: a merged definition
 * that loses a required protocol tool fails before any audit launches, and
 * pi-subagents' registration validation reject unknown/unsupported profile
 * selectors the same way.
 */
export function mergeAuditorDefinition(
	base: RuntimeAgentDefinition,
	auditor: GoalAuditorSettings | undefined,
): RuntimeAgentDefinition {
	if (!auditor) return base;
	const hasDefinitionChanges = auditor.systemPromptExtra !== undefined
		|| auditor.tools !== undefined
		|| auditor.excludeTools !== undefined
		|| auditor.extensions !== undefined
		|| auditor.subagentOnlyExtensions !== undefined
		|| auditor.skills !== undefined
		|| auditor.skillPath !== undefined
		|| auditor.mcpDirectTools !== undefined
		|| auditor.defaultReads !== undefined
		|| auditor.inheritProjectContext !== undefined
		|| auditor.inheritSkills !== undefined
		|| auditor.sandbox !== undefined
		|| auditor.permissionProfile !== undefined;
	if (!hasDefinitionChanges) return base;
	const effectiveTools = (() => {
		const tools = auditor.tools !== undefined ? [...auditor.tools] : [...(base.tools ?? [])];
		if (!tools.includes(REQUIRED_AUDITOR_PROGRESS_TOOL)) tools.push(REQUIRED_AUDITOR_PROGRESS_TOOL);
		if (auditor.excludeTools !== undefined) {
			const excluded = new Set(auditor.excludeTools);
			return tools.filter((tool) => !excluded.has(tool));
		}
		return tools;
	})();
	const subagentOnlyExtensions = (() => {
		const merged = [...(base.subagentOnlyExtensions ?? [])];
		for (const extension of auditor.subagentOnlyExtensions ?? []) {
			if (!merged.includes(extension)) merged.push(extension);
		}
		return merged;
	})();
	return {
		...base,
		...(auditor.systemPromptExtra ? { systemPrompt: `${base.systemPrompt}\n\n${auditor.systemPromptExtra}` } : {}),
		tools: effectiveTools,
		subagentOnlyExtensions,
		...(auditor.extensions !== undefined ? { extensions: [...auditor.extensions] } : {}),
		...(auditor.skills !== undefined ? { skills: [...auditor.skills] } : {}),
		...(auditor.skillPath !== undefined ? { skillPath: [...auditor.skillPath] } : {}),
		...(auditor.mcpDirectTools !== undefined ? { mcpDirectTools: [...auditor.mcpDirectTools] } : {}),
		...(auditor.defaultReads !== undefined ? { defaultReads: [...auditor.defaultReads] } : {}),
		...(auditor.inheritProjectContext !== undefined ? { inheritProjectContext: auditor.inheritProjectContext } : {}),
		...(auditor.inheritSkills !== undefined ? { inheritSkills: auditor.inheritSkills } : {}),
		...(auditor.sandbox !== undefined ? { sandbox: auditor.sandbox } : {}),
		...(auditor.permissionProfile !== undefined ? { permissionProfile: auditor.permissionProfile } : {}),
	};
}

export type AuditorRegistrationResult =
	| { registered: true; definition: RuntimeAgentDefinition }
	| { registered: false; reason: "shadowed" | "unavailable"; error?: string };

/**
 * Probe whether a configured `goal-auditor` agent exists (pre-0.8.0 ejected
 * markdown files keep working). Only an explicit `missing_agent` resolution
 * proves the name is free: registration collides — it never shadows — with
 * configured agents, so any other preflight outcome must skip registration.
 */
export async function resolveDefaultAuditorAvailability(
	cwd: string,
	resolve: typeof resolveSubagentLaunchContract,
	projectTrusted: boolean,
): Promise<"free" | "taken" | "unknown"> {
	try {
		const result = await resolve({
			agent: DEFAULT_AUDITOR_AGENT,
			context: "fresh",
			cwd,
			...(projectTrusted ? { projectTrusted: true, trustedProjectCwd: cwd } : {}),
		});
		if (result.ok) return "taken";
		return result.code === "missing_agent" ? "free" : "taken";
	} catch {
		return "unknown";
	}
}

let activeRegistration: { dispose(): void } | undefined;

/** Release the runtime registration (session shutdown, reload, re-registration). */
export function disposeDefaultGoalAuditor(): void {
	activeRegistration?.dispose();
	activeRegistration = undefined;
}

/**
 * Register the default goal-auditor with the installed pi-subagents owner.
 * Call from `session_start`; `disposeDefaultGoalAuditor` runs on shutdown and
 * before every re-registration. Registration is skipped when a configured
 * `goal-auditor` agent already exists (e.g. a pre-0.8.0 ejected definition) or
 * when pi-subagents is not loaded; audits surface the existing actionable
 * errors in both cases.
 */
export async function registerDefaultGoalAuditor(
	pi: ExtensionAPI,
	cwd: string,
	options: {
		resolveLaunchContract?: typeof resolveSubagentLaunchContract;
		isProjectTrusted?: () => boolean;
	} = {},
): Promise<AuditorRegistrationResult> {
	disposeDefaultGoalAuditor();
	const resolve = options.resolveLaunchContract ?? resolveSubagentLaunchContract;
	const projectTrusted = options.isProjectTrusted?.() ?? false;
	const availability = await resolveDefaultAuditorAvailability(cwd, resolve, projectTrusted);
	if (availability !== "free") {
		return { registered: false, reason: availability === "taken" ? "shadowed" : "unavailable" };
	}
	const settings = loadGoalSettings(cwd);
	const definition = mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, settings.auditor);
	try {
		activeRegistration = registerAgentViaEvents({ pi, name: DEFAULT_AUDITOR_AGENT, definition });
		return { registered: true, definition };
	} catch (error) {
		activeRegistration = undefined;
		return {
			registered: false,
			reason: "unavailable",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
