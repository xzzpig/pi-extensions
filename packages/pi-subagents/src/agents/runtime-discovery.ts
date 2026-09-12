import {
	discoverAgentSnapshot,
	discoverAgents,
	type AgentConfig,
	type AgentDiscoveryResult,
	type AgentScope,
} from "./agents.ts";
import { listRuntimeAgentConfigs, mergeRuntimeAgents, type RuntimeAgentOwner } from "./runtime-agent-registry.ts";

/**
 * Discover agents exactly as the runtime sees them: file-based discovery
 * (builtin, package, user, project) merged with agents registered in-process
 * through the runtime agent registry.
 *
 * Callers outside this extension — for example an extension that lets the user
 * pick a role for the interactive session — need the same merged view the
 * subagent executor uses. When nothing is registered at runtime this is a thin
 * wrapper around `discoverAgents`, so the registry stays a pure addition.
 */
export function discoverAgentsWithRuntime(
	pi: RuntimeAgentOwner,
	cwd: string,
	scope: AgentScope,
	preferredModelProvider?: string,
): AgentDiscoveryResult {
	if (listRuntimeAgentConfigs(pi).length === 0) return discoverAgents(cwd, scope, preferredModelProvider);
	const snapshot = discoverAgentSnapshot(cwd, scope, preferredModelProvider, { includeChains: false });
	const discovered = snapshot.effective;
	const all = snapshot.all;
	const configuredAgents: AgentConfig[] = [...all.builtin, ...all.package, ...all.user, ...all.project];
	const merged = mergeRuntimeAgents(pi, discovered, configuredAgents);
	if (discovered.maxThinking === undefined) return merged;
	return {
		...merged,
		agents: merged.agents.map((agent) =>
			agent.maxThinking === discovered.maxThinking ? agent : { ...agent, maxThinking: discovered.maxThinking },
		),
	};
}
