import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Module specifier kept as a plain string on purpose: the dependency is
 * optional, so TypeScript must not resolve (and therefore must not type-check)
 * pi-subagents' sources from this package's compiler options.
 */
const SUBAGENTS_AGENTS_MODULE: string = "@xzzpig/pi-subagents/agents";

/** One agent the role picker can offer. */
export interface RoleAgentCandidate {
  name: string;
  description: string;
  aliases: string[];
  source: string;
  /** Sandbox profile the agent declares, if any. */
  sandboxProfile?: string;
  /** Permission profile the agent declares, if any. */
  permissionProfile?: string;
  /**
   * True when the agent comes from this project — either a project agent file
   * or a project-scoped settings override. Such an agent may only be adopted
   * when the project is trusted.
   */
  projectScoped: boolean;
}

export interface RoleAgentList {
  agents: RoleAgentCandidate[];
  /** Discovery problems reported by the agent loader, for diagnostics. */
  diagnostics: string[];
  /** Directory project agents were discovered from, when discovery ran. */
  projectAgentsDir?: string;
}

export type AgentDiscoveryUnavailable = { error: string };

const SUBAGENTS_MISSING_MESSAGE =
  "pi-agent-role needs @xzzpig/pi-subagents to list agents. Install it and run /reload.";

/** The subset of pi-subagents' discovery result this package reads. */
interface DiscoveredAgent {
  name: string;
  description?: string;
  aliases?: string[];
  source: string;
  disabled?: boolean;
  sandbox?: string;
  permissionProfile?: string;
  override?: { scope?: string };
}

interface DiscoveryDiagnostic {
  source?: string;
  name?: string;
  runtimeName?: string;
  error?: string;
}

interface DiscoveryResult {
  agents: DiscoveredAgent[];
  agentDiagnostics?: DiscoveryDiagnostic[];
  projectAgentsDir?: string;
}

interface AgentDiscoveryModule {
  discoverAgentsWithRuntime(
    pi: ExtensionAPI,
    cwd: string,
    scope: string,
    preferredModelProvider?: string,
  ): DiscoveryResult;
}

/**
 * Load pi-subagents' agent discovery lazily.
 *
 * The dependency is optional — every other command still works without it — so
 * a missing or incompatible module is reported instead of thrown at load time.
 * The dynamic import is the I/O boundary: its result is decoded here, and the
 * rest of the module only ever sees the narrow shape declared above.
 */
async function loadAgentDiscovery(): Promise<
  AgentDiscoveryModule | AgentDiscoveryUnavailable
> {
  let loaded: unknown;
  try {
    loaded = await import(SUBAGENTS_AGENTS_MODULE);
  } catch {
    return { error: SUBAGENTS_MISSING_MESSAGE };
  }
  // Boundary decode: the module either exposes a callable discovery entry point
  // or this optional dependency is unusable, and only the former is trusted.
  const candidate = loaded as Partial<AgentDiscoveryModule> | null;
  const discover = candidate?.discoverAgentsWithRuntime;
  if (typeof discover !== "function")
    return { error: SUBAGENTS_MISSING_MESSAGE };
  return { discoverAgentsWithRuntime: discover };
}

/**
 * Narrow a discovery result — the raw module or the list built from it — down to
 * the "dependency unavailable" answer.
 */
export function isAgentDiscoveryUnavailable<T extends object>(
  value: T | AgentDiscoveryUnavailable,
): value is AgentDiscoveryUnavailable {
  return "error" in value;
}

/**
 * List the agents a session can adopt, using the same merged view the subagent
 * executor uses: file-discovered agents plus anything another extension
 * registered at runtime.
 */
export async function listRoleAgents(
  pi: ExtensionAPI,
  cwd: string,
  loadModule: () => Promise<
    AgentDiscoveryModule | AgentDiscoveryUnavailable
  > = loadAgentDiscovery,
): Promise<RoleAgentList | AgentDiscoveryUnavailable> {
  const discovery = await loadModule();
  if (isAgentDiscoveryUnavailable(discovery)) return discovery;

  const result = discovery.discoverAgentsWithRuntime(pi, cwd, "both");
  const agents: RoleAgentCandidate[] = [];
  for (const agent of result.agents) {
    if (agent.disabled === true) continue;
    const candidate: RoleAgentCandidate = {
      name: agent.name,
      description: agent.description ?? "",
      aliases: agent.aliases ?? [],
      source: agent.source,
      projectScoped:
        agent.source === "project" || agent.override?.scope === "project",
    };
    if (agent.sandbox) candidate.sandboxProfile = agent.sandbox;
    if (agent.permissionProfile)
      candidate.permissionProfile = agent.permissionProfile;
    agents.push(candidate);
  }

  const list: RoleAgentList = {
    agents,
    diagnostics: (result.agentDiagnostics ?? []).map(
      (diagnostic) =>
        `${diagnostic.name ?? diagnostic.runtimeName ?? diagnostic.source ?? "agent"}: ${diagnostic.error ?? "unknown error"}`,
    ),
  };
  if (result.projectAgentsDir) list.projectAgentsDir = result.projectAgentsDir;
  return list;
}

/**
 * Find one candidate by name or alias, mirroring how the subagent launcher
 * resolves an agent reference.
 */
export function findRoleAgent(
  agents: readonly RoleAgentCandidate[],
  reference: string,
): RoleAgentCandidate | undefined {
  const trimmed = reference.trim();
  return agents.find(
    (agent) => agent.name === trimmed || agent.aliases.includes(trimmed),
  );
}
