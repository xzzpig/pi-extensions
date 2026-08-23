import type { AgentConfig } from "../agents/agents.ts";
import { isAgentAllowedByCapabilityCeiling, type ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";

/**
 * Marker used to detect an already-injected block so repeated injections
 * (forked or resumed sessions replaying chained system prompts) stay idempotent.
 */
export const SUBAGENT_INJECTION_MARKER = "<available_subagents>";

/** One compact line per advertised agent inside the injected block. */
export interface InjectableAgentSummary {
	name: string;
	description: string;
}

export interface ResolveInjectableAgentsInput {
	/** Merged discovered agents across scopes (builtin, package, user, project). */
	agents: readonly AgentConfig[];
	/** Names (canonical or alias) listed by the `subagents.injectAgents` setting. */
	injectAgents?: readonly string[];
	/** Current session capability ceiling; restricted agents are never advertised. */
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling | undefined;
}

export interface ResolveInjectableAgentsResult {
	agents: InjectableAgentSummary[];
	/** Setting entries that matched no discovered agent, trimmed, discovery order preserved. */
	unknownNames: string[];
}

function normalizeDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}

function buildNameLookup(agents: readonly AgentConfig[]): Map<string, AgentConfig> {
	const lookup = new Map<string, AgentConfig>();
	for (const agent of agents) {
		if (!lookup.has(agent.name)) lookup.set(agent.name, agent);
		for (const alias of agent.aliases ?? []) {
			if (!lookup.has(alias)) lookup.set(alias, agent);
		}
	}
	return lookup;
}

/**
 * Union of settings-listed agents (`subagents.injectAgents`) and agents whose
 * frontmatter opts in with `injectToContext: true`. Settings names resolve
 * against canonical names and aliases; unresolved entries are reported through
 * `unknownNames` instead of failing discovery. Disabled agents and agents
 * restricted by the session capability ceiling are never advertised.
 */
export function resolveInjectableAgents(input: ResolveInjectableAgentsInput): ResolveInjectableAgentsResult {
	const { agents, injectAgents, capabilityCeiling } = input;
	const lookup = buildNameLookup(agents);
	const selected = new Map<string, InjectableAgentSummary>();
	const unknownNames: string[] = [];

	const advertise = (agent: AgentConfig): void => {
		if (agent.disabled === true) return;
		if (!isAgentAllowedByCapabilityCeiling(agent.name, capabilityCeiling)) return;
		if (selected.has(agent.name)) return;
		selected.set(agent.name, { name: agent.name, description: normalizeDescription(agent.description) });
	};

	for (const rawName of injectAgents ?? []) {
		const name = rawName.trim();
		if (!name) continue;
		const resolved = lookup.get(name);
		if (!resolved) {
			if (!unknownNames.includes(name)) unknownNames.push(name);
			continue;
		}
		advertise(resolved);
	}

	for (const agent of agents) {
		if (agent.injectToContext === true) advertise(agent);
	}

	return {
		agents: Array.from(selected.values()).sort((a, b) => a.name.localeCompare(b.name)),
		unknownNames,
	};
}

/**
 * Append the session-snapshot block to this turn's system prompt.
 * Returns `undefined` when nothing should change: empty block, or a prompt
 * that already carries the marker (forked/resumed chains replaying history).
 */
export function applyInjectionBlock(input: { systemPrompt: string; block: string }): string | undefined {
	const { systemPrompt, block } = input;
	if (!block) return undefined;
	if (systemPrompt.includes(SUBAGENT_INJECTION_MARKER)) return undefined;
	return `${systemPrompt}\n\n${block}`;
}

/**
 * Render the deterministic `<available_subagents>` block appended to the parent
 * system prompt. Pure function of its input: stable sort order and a fixed
 * template guarantee byte-identical output across turns so provider prompt
 * caching stays effective. Descriptions are collapsed to a single line so a
 * multi-line frontmatter description cannot break the compact format. Returns
 * an empty string when nothing is advertised.
 */
export function renderInjectionBlock(agents: readonly InjectableAgentSummary[]): string {
	if (agents.length === 0) return "";
	const lines = [
		SUBAGENT_INJECTION_MARKER,
		"The following pre-declared subagents are available.",
		"Launch them with the subagent tool when a task matches their description.",
		"",
		...agents.map((agent) => `- ${agent.name}: ${normalizeDescription(agent.description)}`),
		"</available_subagents>",
	];
	return lines.join("\n");
}
