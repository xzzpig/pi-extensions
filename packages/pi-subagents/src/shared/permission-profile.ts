/** Shared wire contract for selecting a pi-permission-system profile in a child Pi process. */
export const SUBAGENT_PERMISSION_PROFILE_ENV = "PI_SUBAGENT_PERMISSION_PROFILE";

/**
 * Marks a child process whose profile selection was pinned by its launcher.
 *
 * The selection key alone cannot express "this child was launched with no
 * profile": clearing it looks exactly like a host session that never selected
 * one. pi-permission-system therefore freezes the launcher's selection only when
 * this marker is present, which keeps a host session reading the value live so a
 * mid-session role change still applies.
 */
export const SUBAGENT_PERMISSION_PROFILE_PINNED_ENV =
	"PI_SUBAGENT_PERMISSION_PROFILE_PINNED";

const MAX_PERMISSION_PROFILE_NAME_LENGTH = 128;
const PERMISSION_PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Validate a raw `permission-profile` selection value into a normalized name.
 * Only a bare identifier is accepted — objects (agent files must never carry
 * inline policy), the literal `false`, path components, whitespace, and
 * over-long values are all rejected at agent-load time.
 */
export function validatePermissionProfileName(
	value: unknown,
	label = "permission profile",
): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		throw new Error(`${label} must be a non-empty profile name without surrounding whitespace.`);
	}
	if (value === "false") {
		throw new Error(`${label} must select a named profile; the literal false is not supported.`);
	}
	if (value.length > MAX_PERMISSION_PROFILE_NAME_LENGTH) {
		throw new Error(`${label} must be at most ${MAX_PERMISSION_PROFILE_NAME_LENGTH} characters.`);
	}
	if (!PERMISSION_PROFILE_NAME_PATTERN.test(value)) {
		throw new Error(`${label} must contain only letters, digits, underscores, or hyphens and start with a letter or digit.`);
	}
	return value;
}
