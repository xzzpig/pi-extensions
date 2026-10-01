/**
 * Restricted-mode activation channel for pi-openspec-x (design D4).
 *
 * Entering a restricted mode writes the same session-entry channel
 * pi-agent-role owns — the `active_agent` custom entry, byte-identical in
 * shape — so pi-permission-system resolves the identity without knowing about
 * this package. The sharing is one-way at the channel level only: `/role`'s
 * agent enumeration lists configured agents, not runtime agents (verified in
 * the 5.3 investigation), so an opsx mode never appears in its menu. Adopt,
 * inspect, or clear an opsx mode through the opsx commands; only the entry
 * shape, not the `/role` surface, is shared:
 *
 * 1. the `active_agent` session identity entry, byte-identical in shape to
 *    pi-agent-role's (`{ name: string | null }`);
 * 2. pi-sandbox's per-session `SandboxService.setProfile` with the matching
 *    opsx profile.
 *
 * Stale-entry cleanup on `session_start` copies pi-agent-role's semantics
 * verbatim (see `clearStaleActiveAgentIdentity`): entries are deliberately
 * indistinguishable across the two packages, and a session start means the
 * selection that produced any persisted identity no longer exists.
 *
 * Fail-closed asymmetry: entering throws a typed
 * {@link OpsxDependencyMissingError} when pi-sandbox is unavailable — a
 * restricted mode must never run unsandboxed. Leaving never throws for a
 * missing dependency: exiting only removes restrictions, so it must always
 * be possible and is reported as an outcome instead.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
  describeError,
  loadSessionSandboxService,
  OpsxDependencyMissingError,
  requireRestrictedModeSupport,
  SANDBOX_MISSING_CONSEQUENCE,
  type SandboxServiceLike,
} from "./dependencies.ts";

/**
 * Entry type pi-permission-system resolves into an agent identity; the exact
 * contract pi-agent-role broadcasts on (broadcast.ts ACTIVE_AGENT_ENTRY_TYPE).
 */
export const ACTIVE_AGENT_ENTRY_TYPE = "active_agent";

/** Restricted modes available to the opsx workflow (each maps 1:1 to a profile). */
export type OpsxMode = "planner" | "agent";

/**
 * Identity (active_agent name) and sandbox profile per restricted mode. The
 * names equal the registered profile names so /role interop and pi-sandbox
 * resolve the same string.
 */
const MODE_IDS: Record<
  OpsxMode,
  { agentName: string; sandboxProfile: string }
> = {
  planner: { agentName: "opsx-planner", sandboxProfile: "opsx-planner" },
  agent: { agentName: "opsx-agent", sandboxProfile: "opsx-agent" },
};

export interface OpsxModeNotice {
  message: string;
  severity: "warning" | "error";
}

export interface OpsxModeOutcome {
  /** True when no channel reported an error. */
  ok: boolean;
  notices: OpsxModeNotice[];
}

export interface OpsxModeDeps {
  /**
   * Session id provider, defaulting to none (pi-sandbox then resolves the
   * service only when exactly one session published one). Command handlers
   * pass `() => ctx.sessionManager.getSessionId()`.
   */
  sessionId?: () => string | undefined;
  /** Injectable service locator (tests); defaults to the recorded pi-sandbox module. */
  loadService?: (
    sessionId: string | undefined,
  ) => Promise<SandboxServiceLike | undefined>;
}

function defaultLoadService(
  sessionId: string | undefined,
): Promise<SandboxServiceLike | undefined> {
  return loadSessionSandboxService(sessionId);
}

function resolveSessionId(deps: OpsxModeDeps): string | undefined {
  try {
    return deps.sessionId?.();
  } catch {
    return undefined;
  }
}

/**
 * Enter a restricted mode: apply the sandbox profile first, then record the
 * `active_agent` identity. All-or-nothing — on any failure nothing (or
 * nothing observable) is applied and the session stays unrestricted:
 *
 * - dependency missing → typed {@link OpsxDependencyMissingError}, nothing done;
 * - profile rejected by pi-sandbox → error, no identity entry written;
 * - identity entry write fails → the profile is rolled back before throwing.
 *
 * A succeeded selection that carries a message (pi-sandbox warns when the
 * sandbox switch is currently off) is returned as a warning notice: the mode
 * is recorded, and the caller must surface that isolation is not active.
 */
export async function enterOpsxMode(
  pi: ExtensionAPI,
  mode: OpsxMode,
  deps: OpsxModeDeps = {},
): Promise<OpsxModeOutcome> {
  const { agentName, sandboxProfile } = MODE_IDS[mode];
  // Fail-closed gate first: no identity entry may claim a mode whose sandbox
  // cannot back it.
  requireRestrictedModeSupport();

  const service = await (deps.loadService ?? defaultLoadService)(
    resolveSessionId(deps),
  );
  if (!service) {
    throw new OpsxDependencyMissingError(
      "pi-sandbox session service",
      "no sandbox service is published for this session (pi-sandbox not loaded, or its session_start has not run)",
      SANDBOX_MISSING_CONSEQUENCE,
    );
  }

  // Profile before entry: "restricted mode entered" must mean both channels
  // applied, and a rejected profile must leave the session untouched.
  let result: { ok: boolean; message?: string };
  try {
    result = await service.setProfile(sandboxProfile);
  } catch (error) {
    throw new Error(
      `Sandbox profile '${sandboxProfile}' could not be applied; refusing to enter restricted mode '${agentName}' (fail-closed): ${describeError(error)}`,
    );
  }
  if (!result.ok) {
    throw new Error(
      `Sandbox profile '${sandboxProfile}' was rejected; refusing to enter restricted mode '${agentName}' (fail-closed): ${result.message ?? "unknown reason"}`,
    );
  }

  try {
    pi.appendEntry(ACTIVE_AGENT_ENTRY_TYPE, { name: agentName });
  } catch (error) {
    // Roll the profile back so nothing claims a restriction the identity
    // entry denies.
    try {
      await service.setProfile(undefined);
    } catch {
      // Best effort; the thrown error below is what the caller sees.
    }
    throw new Error(
      `Could not record the ${agentName} session identity: ${describeError(error)}`,
    );
  }

  return {
    ok: true,
    notices: result.message
      ? [{ message: result.message, severity: "warning" }]
      : [],
  };
}

/**
 * Leave the restricted mode, mirroring pi-agent-role's exit (applyRoleSelection
 * with a cleared selection): null the identity entry and clear the sandbox
 * profile back to the session default. Best-effort by design — every failure
 * becomes a notice, never an exception, so exiting is always possible.
 */
export async function exitOpsxMode(
  pi: ExtensionAPI,
  deps: OpsxModeDeps = {},
): Promise<OpsxModeOutcome> {
  const notices: OpsxModeNotice[] = [];

  try {
    pi.appendEntry(ACTIVE_AGENT_ENTRY_TYPE, { name: null });
  } catch (error) {
    notices.push({
      message: `Could not clear the session agent identity: ${describeError(error)}`,
      severity: "error",
    });
  }

  const service = await (deps.loadService ?? defaultLoadService)(
    resolveSessionId(deps),
  );
  if (!service) {
    notices.push({
      message:
        "pi-sandbox is unavailable in this session; there is no sandbox profile to restore.",
      severity: "warning",
    });
  } else {
    try {
      const result = await service.setProfile(undefined);
      if (!result.ok) {
        notices.push({
          message: result.message ?? "Sandbox profile could not be cleared.",
          severity: "error",
        });
      }
    } catch (error) {
      notices.push({
        message: `Sandbox profile could not be cleared: ${describeError(error)}`,
        severity: "error",
      });
    }
  }

  return {
    ok: notices.every((notice) => notice.severity !== "error"),
    notices,
  };
}

/**
 * Build the `session_start` handler that drops an `active_agent` identity a
 * previous session persisted in the same session file. Register alongside the
 * resources_discover handler; the semantics are pi-agent-role's, unmodified.
 */
export function createOpsxSessionStartHandler(
  pi: ExtensionAPI,
): ExtensionHandler<SessionStartEvent> {
  return (_event: SessionStartEvent, ctx: ExtensionContext): void => {
    clearStaleActiveAgentIdentity(pi, ctx);
  };
}

/**
 * Remove an `active_agent` identity left behind by a previous session in the
 * same session file (pi-agent-role's semantics, kept byte-compatible because
 * the entries are shared): every session starts from no role, so a tail entry
 * with a non-empty name is stale — without the cleanup the permission system
 * would keep applying an agent scope that no longer has a role behind it.
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
