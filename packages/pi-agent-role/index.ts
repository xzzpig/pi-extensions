export { default } from "./src/extension.ts";
export {
  findRoleAgent,
  listRoleAgents,
  type RoleAgentCandidate,
  type RoleAgentList,
} from "./src/discovery.ts";
export {
  agentRoleDeclaration,
  clearAgent,
  isEmptyRole,
  resolveEffectiveRole,
  selectAgent,
  selectPermissionProfile,
  selectSandboxProfile,
  type AgentRoleDeclaration,
  type EffectiveRole,
  type RoleSelection,
} from "./src/state.ts";
