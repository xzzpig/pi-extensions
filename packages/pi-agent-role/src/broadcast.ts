import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  loadSandboxService,
  type SandboxServiceLike,
} from "./sandbox-service.ts";
import type { EffectiveRole, RoleSelection } from "./state.ts";

/** Entry type pi-permission-system already resolves into an agent identity. */
export const ACTIVE_AGENT_ENTRY_TYPE = "active_agent";

/**
 * Environment key pi-permission-system reads on every decision. Writing it in
 * this process only affects this session: a subagent runs in its own process and
 * inherits the value it was launched with, never this one.
 */
export const PERMISSION_PROFILE_ENV = "PI_SUBAGENT_PERMISSION_PROFILE";

/** A problem the user must see; a role never looks applied when it is not. */
export interface RoleNotice {
  message: string;
  severity: "warning" | "error";
}

export interface ApplyRoleOutcome {
  /** True when no channel reported an error. */
  ok: boolean;
  notices: RoleNotice[];
}

/**
 * Decide whether an agent may be adopted in the current project.
 *
 * Only project-scoped agents are gated: an explicit profile selection is not,
 * because profile registries are global and operator-owned.
 */
export function roleTrustError(
  candidate: { name: string; projectScoped: boolean },
  projectTrusted: boolean,
): string | undefined {
  if (!candidate.projectScoped || projectTrusted) return undefined;
  return `Agent '${candidate.name}' comes from this project, but the project is not trusted. Trust the project and retry.`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sessionIdOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

/**
 * Push a role selection into the systems that enforce it.
 *
 * Three channels, each using the contract its owner already supports:
 *   1. the session identity entry pi-permission-system resolves agent scope from;
 *   2. the permission-profile environment key that package reads per decision;
 *   3. pi-sandbox's SandboxService, which resolves the profile name itself.
 *
 * Nothing but names crosses these boundaries, and every problem is reported to
 * the caller instead of being swallowed.
 */
export async function applyRoleSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection: RoleSelection,
  effective: EffectiveRole,
  loadService: (
    sessionId: string | undefined,
  ) => Promise<SandboxServiceLike | undefined> = loadSandboxService,
): Promise<ApplyRoleOutcome> {
  const notices: RoleNotice[] = [];

  try {
    pi.appendEntry(ACTIVE_AGENT_ENTRY_TYPE, {
      name: selection.agentName ?? null,
    });
  } catch (error) {
    notices.push({
      message: `Could not update the session agent identity: ${describeError(error)}`,
      severity: "error",
    });
  }

  if (effective.permissionProfile)
    process.env[PERMISSION_PROFILE_ENV] = effective.permissionProfile;
  else delete process.env[PERMISSION_PROFILE_ENV];

  const service = await loadService(sessionIdOf(ctx));
  if (!service) {
    if (effective.sandboxProfile) {
      notices.push({
        message: `Selected sandbox profile '${effective.sandboxProfile}', but pi-sandbox is unavailable in this session. No sandbox isolation was applied.`,
        severity: "error",
      });
    }
  } else {
    try {
      const result = await service.setProfile(effective.sandboxProfile);
      if (!result.ok) {
        notices.push({
          message: result.message ?? "Sandbox profile could not be applied.",
          severity: "error",
        });
      } else if (result.message) {
        notices.push({ message: result.message, severity: "warning" });
      }
    } catch (error) {
      notices.push({
        message: `Sandbox profile could not be applied: ${describeError(error)}`,
        severity: "error",
      });
    }
  }

  return {
    ok: notices.every((notice) => notice.severity !== "error"),
    notices,
  };
}
