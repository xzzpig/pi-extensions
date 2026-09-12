import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  applyRoleSelection,
  roleTrustError,
  sessionIdOf,
  type RoleNotice,
} from "./broadcast.ts";
import {
  findRoleAgent,
  isAgentDiscoveryUnavailable,
  listRoleAgents,
  type RoleAgentCandidate,
} from "./discovery.ts";
import { listGlobalPermissionProfiles } from "./permission-profiles.ts";
import { loadSandboxService } from "./sandbox-service.ts";
import {
  agentRoleDeclaration,
  clearAgent,
  formatRoleStatus,
  isEmptyRole,
  resolveEffectiveRole,
  selectAgent,
  selectPermissionProfile,
  selectSandboxProfile,
  type AgentRoleDeclaration,
  type RoleSelection,
} from "./state.ts";
import { pickOption, type PickerOption } from "./ui.ts";

/** Entry type pi-permission-system already resolves into an agent identity. */
const ACTIVE_AGENT_ENTRY_TYPE = "active_agent";
/** Picker value and argument keyword for "clear this selection". */
const NONE_VALUE = "__none__";
/** Argument keyword that clears a selection. */
const CLEAR_KEYWORD = "none";

/** True when a command argument asks to clear the selection. */
function isClearArgument(reference: string): boolean {
  return reference.toLowerCase() === CLEAR_KEYWORD;
}
/** Footer status key owned by this extension. */
const STATUS_KEY = "role";

/**
 * Session roles for the interactive session.
 *
 * A role decides which sandbox profile and permission profile the session runs
 * with, mirroring what a subagent gets from its agent definition. It is
 * session-scoped on purpose: nothing is persisted, so a restart starts from no
 * role instead of silently inheriting one.
 */
export default function registerAgentRoleExtension(pi: ExtensionAPI): void {
  let selection: RoleSelection = {};
  let declaration: AgentRoleDeclaration = {};

  const effective = () => resolveEffectiveRole(selection, declaration);

  const describeCurrent = (): string => {
    const role = effective();
    return [
      `agent ${role.agentName ?? "none"}`,
      `sandbox ${role.sandboxProfile ?? "none"}`,
      `perm ${role.permissionProfile ?? "none"}`,
    ].join("  ·  ");
  };

  /**
   * Footer status is cosmetic: the TUI theme is unavailable in headless modes,
   * and a failed status write must never change the role itself.
   */
  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setStatus(STATUS_KEY, formatRoleStatus(selection));
    } catch {
      // Ignore cosmetic status failures.
    }
  };

  const report = (
    ctx: ExtensionContext,
    notices: readonly RoleNotice[],
  ): void => {
    for (const notice of notices)
      ctx.ui.notify(notice.message, notice.severity);
  };

  /** Push the current selection into every enforcing system, then refresh the footer. */
  const applyAndReport = async (ctx: ExtensionContext): Promise<void> => {
    const outcome = await applyRoleSelection(pi, ctx, selection, effective());
    report(ctx, outcome.notices);
    updateStatus(ctx);
  };

  const adoptAgent = async (
    ctx: ExtensionContext,
    candidate: RoleAgentCandidate,
  ): Promise<void> => {
    const trustError = roleTrustError(
      candidate,
      ctx.isProjectTrusted?.() === true,
    );
    if (trustError) {
      ctx.ui.notify(trustError, "error");
      return;
    }
    // Adopting an agent is a full re-dress: explicit profile overrides are
    // dropped so the agent's own declaration is the single source.
    selection = selectAgent(candidate.name);
    declaration = agentRoleDeclaration(candidate);
    await applyAndReport(ctx);
  };

  const dropAgent = async (ctx: ExtensionContext): Promise<void> => {
    selection = clearAgent(selection);
    declaration = {};
    await applyAndReport(ctx);
  };

  const setSandboxProfile = async (
    ctx: ExtensionContext,
    profileName: string | undefined,
  ): Promise<void> => {
    selection = selectSandboxProfile(selection, profileName);
    await applyAndReport(ctx);
  };

  const setPermissionProfile = async (
    ctx: ExtensionContext,
    profileName: string | undefined,
  ): Promise<void> => {
    selection = selectPermissionProfile(selection, profileName);
    await applyAndReport(ctx);
  };

  const agentOption = (agent: RoleAgentCandidate): PickerOption<string> => {
    const badges: string[] = [];
    if (agent.sandboxProfile) badges.push(`sandbox: ${agent.sandboxProfile}`);
    if (agent.permissionProfile)
      badges.push(`perm: ${agent.permissionProfile}`);
    const option: PickerOption<string> = {
      value: agent.name,
      label: agent.name,
      current: selection.agentName === agent.name,
    };
    if (agent.description) option.hint = agent.description;
    if (badges.length > 0) option.badges = badges;
    return option;
  };

  const requireUi = (ctx: ExtensionContext): boolean => {
    if (ctx.hasUI) return true;
    ctx.ui.notify("Session roles need an interactive session.", "warning");
    return false;
  };

  pi.registerCommand("role", {
    description:
      "Adopt an agent as this session's role (no argument shows a picker)",
    handler: async (args, ctx) => {
      if (!requireUi(ctx)) return;
      const reference = args.trim();
      const listed = await listRoleAgents(pi, ctx.cwd);
      if (isAgentDiscoveryUnavailable(listed)) {
        ctx.ui.notify(listed.error, "error");
        return;
      }

      if (reference.length > 0) {
        if (isClearArgument(reference)) {
          await dropAgent(ctx);
          return;
        }
        const candidate = findRoleAgent(listed.agents, reference);
        if (!candidate) {
          ctx.ui.notify(
            `Unknown agent '${reference}'. Use /role to pick from the list.`,
            "error",
          );
          return;
        }
        await adoptAgent(ctx, candidate);
        return;
      }

      if (listed.agents.length === 0) {
        ctx.ui.notify("No agents are available to adopt.", "warning");
        return;
      }

      const options: PickerOption<string>[] = listed.agents.map(agentOption);
      options.push({
        value: NONE_VALUE,
        label: "none — clear the session role",
        current: selection.agentName === undefined,
        danger: true,
      });
      const chosen = await pickOption(
        ctx,
        "Session role",
        options,
        describeCurrent(),
      );
      if (chosen === undefined) return;
      if (chosen === NONE_VALUE) {
        await dropAgent(ctx);
        return;
      }
      const candidate = listed.agents.find((agent) => agent.name === chosen);
      if (candidate) await adoptAgent(ctx, candidate);
    },
  });

  pi.registerCommand("sandbox-profile", {
    description:
      "Select this session's sandbox profile (no argument shows a picker)",
    handler: async (args, ctx) => {
      if (!requireUi(ctx)) return;
      const service = await loadSandboxService(sessionIdOf(ctx));
      if (!service) {
        ctx.ui.notify(
          "pi-sandbox is not available in this session, so sandbox profiles cannot be selected.",
          "error",
        );
        return;
      }
      const available = service.listProfiles?.() ?? [];
      const canValidateName = typeof service.listProfiles === "function";
      const reference = args.trim();
      if (reference.length > 0) {
        if (isClearArgument(reference)) {
          await setSandboxProfile(ctx, undefined);
          return;
        }
        if (canValidateName && !available.includes(reference)) {
          // Reject before touching the selection: an unknown name must not leave
          // the session claiming a profile it never applied.
          ctx.ui.notify(`Unknown sandbox profile '${reference}'.`, "error");
          return;
        }
        await setSandboxProfile(ctx, reference);
        return;
      }

      if (available.length === 0) {
        ctx.ui.notify(
          "No sandbox profiles are defined in the global sandbox configuration.",
          "warning",
        );
        return;
      }

      const options: PickerOption<string>[] = available.map((profile) => ({
        value: profile,
        label: profile,
        current: effective().sandboxProfile === profile,
      }));
      options.push({
        value: NONE_VALUE,
        label: "none — clear the sandbox profile",
        current: effective().sandboxProfile === undefined,
        danger: true,
      });
      const chosen = await pickOption(
        ctx,
        "Sandbox profile",
        options,
        describeCurrent(),
      );
      if (chosen === undefined) return;
      await setSandboxProfile(ctx, chosen === NONE_VALUE ? undefined : chosen);
    },
  });

  pi.registerCommand("permission-profile", {
    description:
      "Select this session's permission profile (no argument shows a picker)",
    handler: async (args, ctx) => {
      if (!requireUi(ctx)) return;
      const registry = listGlobalPermissionProfiles();
      if (registry.error) {
        ctx.ui.notify(registry.error, "error");
        return;
      }
      const reference = args.trim();
      if (reference.length > 0) {
        if (isClearArgument(reference)) {
          await setPermissionProfile(ctx, undefined);
          return;
        }
        if (!registry.profiles.includes(reference)) {
          // Reject before touching the selection: an unknown name must not leave
          // the session claiming a profile it never applied.
          ctx.ui.notify(`Unknown permission profile '${reference}'.`, "error");
          return;
        }
        await setPermissionProfile(ctx, reference);
        return;
      }

      if (registry.profiles.length === 0) {
        ctx.ui.notify(
          "No permission profiles are defined in the global pi-permission-system configuration.",
          "warning",
        );
        return;
      }

      const options: PickerOption<string>[] = registry.profiles.map(
        (profile) => ({
          value: profile,
          label: profile,
          current: effective().permissionProfile === profile,
        }),
      );
      options.push({
        value: NONE_VALUE,
        label: "none — clear the permission profile",
        current: effective().permissionProfile === undefined,
        danger: true,
      });
      const chosen = await pickOption(
        ctx,
        "Permission profile",
        options,
        describeCurrent(),
      );
      if (chosen === undefined) return;
      await setPermissionProfile(
        ctx,
        chosen === NONE_VALUE ? undefined : chosen,
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Every session starts from none, and any identity an earlier session
    // persisted in the same session file is dropped for the same reason: the
    // selection that produced it no longer exists.
    if (!isEmptyRole(selection)) {
      selection = {};
      declaration = {};
    }
    clearStaleActiveAgentIdentity(pi, ctx);
    updateStatus(ctx);
  });
}

/**
 * Remove an `active_agent` identity left behind by a previous session in the
 * same session file. Without this the permission system would keep applying an
 * agent scope that no longer has a role behind it.
 */
function clearStaleActiveAgentIdentity(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!hasPersistedActiveAgent(ctx)) return;
  try {
    pi.appendEntry(ACTIVE_AGENT_ENTRY_TYPE, { name: null });
  } catch {
    // Best effort: the identity is advisory and a session that cannot be
    // written must not fail startup.
  }
}

function hasPersistedActiveAgent(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as {
        type?: string;
        customType?: string;
        data?: { name?: unknown };
      };
      if (
        entry?.type !== "custom" ||
        entry.customType !== ACTIVE_AGENT_ENTRY_TYPE
      )
        continue;
      const name = entry.data?.name;
      return typeof name === "string" && name.length > 0;
    }
  } catch {
    return false;
  }
  return false;
}
