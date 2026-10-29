import { SUBAGENT_PERMISSION_PROFILE_ENV, SUBAGENT_PERMISSION_PROFILE_PINNED_ENV } from "../../shared/permission-profile.ts";

/** The local unset-profile pin does not apply to a fresh remote Pi process.
 * Any explicit profile, bindings, or other local environment remains forbidden.
 */
export function hasUnsupportedPlacedProcessEnv(env: Record<string, string | undefined> | undefined): boolean {
	if (!env) return false;
	return Object.entries(env).some(([key, value]) => {
		if (value === undefined || value === "__none__") return false;
		return !(key === SUBAGENT_PERMISSION_PROFILE_PINNED_ENV && value === "1" && env[SUBAGENT_PERMISSION_PROFILE_ENV] === undefined);
	});
}
