import { normalizeFlatPermissionValue } from "#src/config/config-loader";
import type { FlatPermissionConfig } from "#src/types";
import type { ProfilePermissionConfig, ScopeConfig } from "#src/types";
import { mergeFlatPermissions } from "./permission-merge";

/**
 * Fork: resolution of the selected permission profile into the scope object
 * the permission-manager merge consumes.
 *
 * Extracted from `PermissionManager.resolvePermissions` so the manager keeps
 * its upstream shape (loader calls, scope merge, cache); this module owns the
 * fork's profile-scope insertion between the project and agent scopes.
 */

/** The profile-selection sources and the registries the selection is looked up in. */
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
  /**
   * The project scope's named-profiles registry, if any.
   *
   * Project profiles only exist for a trusted project: the policy loader
   * withholds the project cwd when the project is untrusted (#644), so
   * callers that resolve through that loader naturally pass `undefined` here.
   * `projectTrusted` is an explicit second gate for callers that hold both
   * values independently.
   */
  readonly projectProfiles?: Record<string, ProfilePermissionConfig> | undefined;
  /**
   * Explicit project-trust assertion. `false` forces `projectProfiles` to
   * behave as empty regardless of its value; `true`/omitted trusts the passed
   * registry. Defaults to `true` for caller compatibility.
   */
  readonly projectTrusted?: boolean;
}

/**
 * The resolved profile scope, plus the selection name when it failed closed.
 *
 * Project entries are combined with the global same-named profile at the
 * `(surface, pattern)` level (project wins per pattern, unmentioned patterns
 * keep the global value) when both exist and the project is trusted.
 */
export interface ProfileScopeResolution {
  /**
   * The merged profile's scope — `{ permission }` when the profile resolved to
   * a non-empty ruleset, `{ invalid: true }` when it failed closed; `undefined`
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
 * Resolve the selected profile into its merged scope object and fail-closed
 * name.
 *
 * Compatible thin wrapper over {@link resolveProfileScopes}: folds the ordered
 * two-layer scopes (global below, trusted project above) back into the single
 * merged scope the legacy call site consumes.
 */
export function resolveProfileScope(
  selection: ProfileScopeSelection,
): ProfileScopeResolution {
  const { scopes, invalidProfileName } = resolveProfileScopes(selection);
  if (invalidProfileName !== undefined) {
    return { profileScope: { invalid: true }, invalidProfileName };
  }
  if (scopes.length === 0) {
    return { profileScope: undefined, invalidProfileName: undefined };
  }
  // Fold low→high: each layer's permission overrides the previous per pattern.
  let merged: FlatPermissionConfig = {};
  let hasRules = false;
  for (const [, scope] of scopes) {
    if (scope.permission) {
      merged = mergeFlatPermissions(merged, scope.permission);
      hasRules = true;
    }
  }
  return {
    profileScope:
      hasRules && Object.keys(merged).length > 0
        ? { permission: merged }
        : { invalid: true },
    invalidProfileName: undefined,
  };
}

/** Merge-order label for each profile scope layer, lowest precedence first. */
export type ProfileScopeOrigin = "profile-global" | "profile-project";

/** The two-layer profile resolution the permission-manager merge consumes. */
export interface ProfileScopesResolution {
  /**
   * Ordered scope entries (lowest → highest precedence): the global same-named
   * profile first, then the trusted project same-named profile. Spread into
   * `mergeScopesWithOrigins` so each layer keeps its own origin.
   */
  readonly scopes: readonly (readonly [ProfileScopeOrigin, ScopeConfig])[];
  /**
   * The selected name when no layer resolved (unknown name or empty ruleset),
   * so the fail-closed notice can name it; else `undefined`.
   */
  readonly invalidProfileName: string | undefined;
  /**
   * Operator warnings collected during resolution — currently the
   * «N project profiles not applied (project untrusted)» notice.
   */
  readonly warnings: readonly string[];
}

/**
 * Resolve the selected profile into its two ordered scope layers and
 * fail-closed name.
 *
 * The launcher env wins — it carries the validated selection of the effective
 * agent definition — then the project agent file, then the global agent file
 * (the same precedence the scopes themselves have).
 *
 * When a trusted project defines a same-named profile, both layers are
 * returned (global first, project second) so the caller's scope merge folds
 * the project patterns over the global ones while tracking each layer's
 * origin. An untrusted project contributes no project layer, and its registry
 * existence is reported as a warning with the profile count.
 *
 * Unknown name or empty rulesets fail this scope closed: the agent must never
 * silently run without the intended policy (an unknown name must not degrade
 * to the unselected baseline, and an empty profile is an operator mistake).
 */
export function resolveProfileScopes(
  selection: ProfileScopeSelection,
): ProfileScopesResolution {
  const profileName =
    selection.envProfileName ??
    selection.projectAgentProfileName ??
    selection.agentProfileName;

  const warnings: string[] = [];
  if (
    selection.projectTrusted === false &&
    selection.projectProfiles !== undefined &&
    Object.keys(selection.projectProfiles).length > 0
  ) {
    const count = Object.keys(selection.projectProfiles).length;
    warnings.push(
      `Project defines ${count} permission profile${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not applied (project is not trusted).`,
    );
  }

  if (!profileName) {
    return { scopes: [], invalidProfileName: undefined, warnings };
  }

  const globalScope = scopeFromProfile(selection.profiles?.[profileName]);
  const projectScope =
    selection.projectTrusted === false
      ? undefined
      : scopeFromProfile(selection.projectProfiles?.[profileName]);

  const scopes: (readonly [ProfileScopeOrigin, ScopeConfig])[] = [];
  if (globalScope) scopes.push(["profile-global", globalScope]);
  if (projectScope) scopes.push(["profile-project", projectScope]);

  if (scopes.length === 0) {
    return { scopes, invalidProfileName: profileName, warnings };
  }
  return { scopes, invalidProfileName: undefined, warnings };
}

/** A profile's scope, or `undefined` when it has no non-empty ruleset. */
function scopeFromProfile(
  profile: ProfilePermissionConfig | undefined,
): ScopeConfig | undefined {
  const permission = normalizeFlatPermissionValue(profile?.permission);
  return permission !== undefined && Object.keys(permission).length > 0
    ? { permission }
    : undefined;
}
