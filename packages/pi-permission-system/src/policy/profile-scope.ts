import { normalizeFlatPermissionValue } from "#src/config/config-loader";
import type { ProfilePermissionConfig, ScopeConfig } from "#src/types";

/**
 * Fork: resolution of the selected permission profile into the scope object
 * the permission-manager merge consumes.
 *
 * Extracted from `PermissionManager.resolvePermissions` so the manager keeps
 * its upstream shape (loader calls, scope merge, cache); this module owns the
 * fork's profile-scope insertion between the project and agent scopes.
 */

/** The profile-selection sources and the registry the selection is looked up in. */
export interface ProfileScopeSelection {
  /**
   * Launcher-provided selection: the live env value, or the value frozen for
   * a child session by the permission-manager's env-profile snapshot.
   */
  readonly envProfileName: string | undefined;
  /** The project agent file's `permission-profile:` selection, if any. */
  readonly projectAgentProfileName: string | undefined;
  /** The global agent file's `permission-profile:` selection, if any. */
  readonly agentProfileName: string | undefined;
  /** The global scope's named-profiles registry, if any. */
  readonly profiles: Record<string, ProfilePermissionConfig> | undefined;
}

/** The resolved profile scope, plus the selection name when it failed closed. */
export interface ProfileScopeResolution {
  /**
   * The profile's own scope — `{ permission }` when the profile resolved to a
   * non-empty ruleset, `{ invalid: true }` when it failed closed; `undefined`
   * when no profile is selected at all.
   */
  readonly profileScope: ScopeConfig | undefined;
  /**
   * The selected name when the profile scope failed closed (unknown name or
   * empty ruleset), so the fail-closed notice can name it; else `undefined`.
   */
  readonly invalidProfileName: string | undefined;
}

/**
 * Resolve the selected profile into its scope object and fail-closed name.
 *
 * The launcher env wins — it carries the validated selection of the effective
 * agent definition, which also covers runtime-defined agents with no
 * frontmatter file — then the project agent file, then the global agent file
 * (the same precedence the scopes themselves have).
 *
 * Unknown name or an empty ruleset fails this scope closed: the agent must
 * never silently run without the intended policy (an unknown name must not
 * degrade to the unselected baseline, and an empty profile is an operator
 * mistake, not an intent to inherit everything).
 */
export function resolveProfileScope(
  selection: ProfileScopeSelection,
): ProfileScopeResolution {
  const profileName =
    selection.envProfileName ??
    selection.projectAgentProfileName ??
    selection.agentProfileName;

  if (!profileName) {
    return { profileScope: undefined, invalidProfileName: undefined };
  }

  const profile = selection.profiles?.[profileName];
  const permission = normalizeFlatPermissionValue(profile?.permission);
  const profileScope: ScopeConfig =
    permission !== undefined && Object.keys(permission).length > 0
      ? { permission }
      : { invalid: true };
  return {
    profileScope,
    invalidProfileName:
      profileScope.invalid === true ? profileName : undefined,
  };
}
