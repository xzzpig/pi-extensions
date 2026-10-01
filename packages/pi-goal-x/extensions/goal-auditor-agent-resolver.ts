// Fork-only module. Cross-extension auditor-agent resolver registry (S2 of the
// double fork seam described in openspec/changes/add-pi-openspec-x design D10).
//
// The completion-audit launch preflight resolves the configured auditor agent
// through FILE-BASED discovery only (resolveSubagentLaunchContract →
// discoverAgentSnapshot). Agents that another extension registered at runtime
// live in pi-subagents' registry keyed by the OWNER's ExtensionAPI object (a
// per-owner WeakMap), so the preflight cannot see them and fails with
// `missing_agent` — historically fatal for any agent other than pi-goal-x's own
// locally-registered default goal-auditor.
//
// This module is the escape hatch: a consumer extension (for example
// pi-openspec-x, at extension init) registers a resolver that answers agent
// names with an equivalent RuntimeAgentDefinition. When the preflight reports
// missing_agent for a configured agent, goal-auditor-delegation.ts consults
// this registry BEFORE the local default-registration fallback; a hit takes the
// exact same local-registration path (protocol-tool enforcement on the
// supplied definition, structured_output guaranteed by the delegation request
// shape), while a miss leaves the original fallback byte-identical.
//
// The registry lives on globalThis keyed by Symbol.for (same pattern as
// pi-sandbox's fork-profile-registry) so duplicated installs and in-process
// consumers share one table. Nothing touches disk; entries die with the
// process. Resolvers are a declaration of equivalence for the owner's OWN
// agents — name-keyed lookup, first registered match wins.
import type { RuntimeAgentDefinition } from "@xzzpig/pi-subagents/agents";

/**
 * A resolver supplied by a consumer extension: given the configured auditor
 * agent name, return the equivalent definition this extension registered (or
 * can launch) in the same process, or undefined when the name is not one of
 * its own agents. Must be synchronous and side-effect free.
 */
export type AuditorAgentResolver = (agentName: string) => RuntimeAgentDefinition | undefined;

const RESOLVER_REGISTRY_KEY = Symbol.for("@xzzpig/pi-goal-x/auditor-agent-resolvers");

type ResolverRegistry = AuditorAgentResolver[];

function resolverRegistry(): ResolverRegistry {
	const scope = globalThis as typeof globalThis & Record<symbol, ResolverRegistry | undefined>;
	const existing = scope[RESOLVER_REGISTRY_KEY];
	if (Array.isArray(existing)) return existing;
	const created: ResolverRegistry = [];
	scope[RESOLVER_REGISTRY_KEY] = created;
	return created;
}

/**
 * Register a cross-extension auditor-agent resolver. Registration order is
 * preserved; registering the SAME function reference again is a no-op
 * (idempotent per session init). Returns a dispose function that removes the
 * resolver; calling dispose twice is safe.
 */
export function registerAuditorAgentResolver(resolver: AuditorAgentResolver): () => void {
	if (typeof resolver !== "function") {
		throw new Error("Auditor agent resolver must be a function: (agentName: string) => RuntimeAgentDefinition | undefined.");
	}
	const registry = resolverRegistry();
	if (!registry.includes(resolver)) registry.push(resolver);
	return () => {
		const current = resolverRegistry();
		const index = current.indexOf(resolver);
		if (index >= 0) current.splice(index, 1);
	};
}

/**
 * Minimal shape check on a resolver's answer: the delegation fallback path
 * reads `definition.tools`/`excludeTools` for protocol enforcement, and a
 * garbage return must degrade to a miss (the original fallback stays
 * reachable), never crash the audit.
 */
function asRuntimeAgentDefinition(value: unknown): RuntimeAgentDefinition | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<RuntimeAgentDefinition>;
	if (typeof candidate.description !== "string" || !candidate.description.trim()) return undefined;
	if (typeof candidate.systemPrompt !== "string" || !candidate.systemPrompt) return undefined;
	return value as RuntimeAgentDefinition;
}

/**
 * Resolve a configured auditor agent through the registered cross-extension
 * resolvers. First registered match wins; a resolver that throws or returns a
 * non-definition is treated as a miss so the original preflight fallback stays
 * reachable. Undefined when no resolver answers.
 */
export function resolveExternalAuditorAgentDefinition(agentName: string): RuntimeAgentDefinition | undefined {
	if (typeof agentName !== "string" || !agentName.trim()) return undefined;
	for (const resolver of [...resolverRegistry()]) {
		let resolved: unknown;
		try {
			resolved = resolver(agentName);
		} catch {
			continue;
		}
		const definition = asRuntimeAgentDefinition(resolved);
		if (definition) return definition;
	}
	return undefined;
}
