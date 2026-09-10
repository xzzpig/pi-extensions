/** Shared wire contract for selecting a pi-sandbox profile in a child Pi process. */
export const SUBAGENT_SANDBOX_PROFILE_ENV = "PI_SUBAGENT_SANDBOX_PROFILE";
/** Parent-authoritative project trust snapshot for profile-aware child config loading. */
export const SUBAGENT_SANDBOX_PROJECT_TRUST_ENV = "PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED";

const MAX_SANDBOX_PROFILE_NAME_LENGTH = 128;
const SANDBOX_PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validateSandboxProfileName(value: unknown, label = "sandbox profile"): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		throw new Error(`${label} must be a non-empty profile name without surrounding whitespace.`);
	}
	if (value === "false") {
		throw new Error(`${label} must select a named profile; the literal false is not supported.`);
	}
	if (value.length > MAX_SANDBOX_PROFILE_NAME_LENGTH) {
		throw new Error(`${label} must be at most ${MAX_SANDBOX_PROFILE_NAME_LENGTH} characters.`);
	}
	if (!SANDBOX_PROFILE_NAME_PATTERN.test(value)) {
		throw new Error(`${label} must contain only letters, digits, underscores, or hyphens and start with a letter or digit.`);
	}
	return value;
}
