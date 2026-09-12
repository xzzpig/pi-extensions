/**
 * Session role state.
 *
 * A role is deliberately session-scoped: nothing here is written to settings,
 * config files, or the session transcript beyond the identity entry the
 * permission system already understands. Closing Pi and starting a new session
 * therefore returns to "no role" with no cleanup step.
 */
export interface RoleSelection {
  /** Agent whose declared role configuration applies to this session. */
  agentName?: string;
  /** Explicit sandbox profile selection; overrides the agent declaration. */
  sandboxProfile?: string;
  /** Explicit permission profile selection; overrides the agent declaration. */
  permissionProfile?: string;
}

/** What an agent definition declares for whichever session adopts it. */
export interface AgentRoleDeclaration {
  sandboxProfile?: string;
  permissionProfile?: string;
}

/** The configuration a session actually runs with, after precedence. */
export interface EffectiveRole {
  agentName?: string;
  sandboxProfile?: string;
  permissionProfile?: string;
}

export function agentRoleDeclaration(agent: {
  sandbox?: string;
  permissionProfile?: string;
}): AgentRoleDeclaration {
  const declaration: AgentRoleDeclaration = {};
  if (agent.sandbox) declaration.sandboxProfile = agent.sandbox;
  if (agent.permissionProfile)
    declaration.permissionProfile = agent.permissionProfile;
  return declaration;
}

/**
 * Resolve what the session actually runs with.
 *
 * Precedence is explicit selection > agent declaration > nothing: a profile the
 * user picked by hand must survive the agent's own declaration, and an agent
 * that declares nothing simply contributes nothing.
 */
export function resolveEffectiveRole(
  selection: RoleSelection,
  declaration?: AgentRoleDeclaration,
): EffectiveRole {
  const role: EffectiveRole = {};
  if (selection.agentName) role.agentName = selection.agentName;
  const sandboxProfile =
    selection.sandboxProfile ?? declaration?.sandboxProfile;
  if (sandboxProfile) role.sandboxProfile = sandboxProfile;
  const permissionProfile =
    selection.permissionProfile ?? declaration?.permissionProfile;
  if (permissionProfile) role.permissionProfile = permissionProfile;
  return role;
}

/**
 * Adopt an agent.
 *
 * Selecting an agent is a full re-dress, so explicit profile overrides are
 * dropped: the agent's own declaration becomes the only source, which is what
 * users expect when they pick a different role.
 */
export function selectAgent(agentName: string): RoleSelection {
  return { agentName };
}

/** Clear the agent while keeping explicit profile selections. */
export function clearAgent(selection: RoleSelection): RoleSelection {
  return withField(selection, "agentName", undefined);
}

export function selectSandboxProfile(
  selection: RoleSelection,
  sandboxProfile: string | undefined,
): RoleSelection {
  return withField(selection, "sandboxProfile", sandboxProfile);
}

export function selectPermissionProfile(
  selection: RoleSelection,
  permissionProfile: string | undefined,
): RoleSelection {
  return withField(selection, "permissionProfile", permissionProfile);
}

export function isEmptyRole(selection: RoleSelection): boolean {
  return (
    selection.agentName === undefined &&
    selection.sandboxProfile === undefined &&
    selection.permissionProfile === undefined
  );
}

/**
 * Footer text for the current role.
 *
 * Pi renders only the status *text*, not the key it was registered under, so the
 * label is part of the text. An adopted agent is shown by name alone (its
 * profiles are detail for the picker); with no agent, the hand-picked profiles
 * are what the session runs with, so they are named.
 *
 * Returns undefined when there is no role, which clears the status line.
 */
export function formatRoleStatus(selection: RoleSelection): string | undefined {
  if (selection.agentName) return `role: ${selection.agentName}`;
  const parts: string[] = [];
  if (selection.sandboxProfile)
    parts.push(`sandbox ${selection.sandboxProfile}`);
  if (selection.permissionProfile)
    parts.push(`perm ${selection.permissionProfile}`);
  return parts.length > 0 ? `role: ${parts.join(" · ")}` : undefined;
}

function withField<K extends keyof RoleSelection>(
  selection: RoleSelection,
  key: K,
  value: RoleSelection[K],
): RoleSelection {
  const next: RoleSelection = { ...selection };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
