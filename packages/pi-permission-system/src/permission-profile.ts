/**
 * Wire contract and name validation for named permission profiles.
 *
 * A profile is a named permission ruleset in the *global* pi-permission-system
 * config file (`profiles` key). Agents select one via the scalar
 * `permission-profile: <name>` frontmatter key (or, for pi-subagents children,
 * the `PI_SUBAGENT_PERMISSION_PROFILE` environment variable set by the
 * launcher — only the validated name crosses the launch boundary, never the
 * rules themselves).
 */

/** Environment variable carrying the selected profile name into a child process. */
export const PERMISSION_PROFILE_ENV = "PI_SUBAGENT_PERMISSION_PROFILE";

export const MAX_PERMISSION_PROFILE_NAME_LENGTH = 128;

/** Safe profile-name shape: alphanumeric start, then letters/digits/_/-. */
export const PERMISSION_PROFILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Validate a raw frontmatter/env profile selection value into a normalized
 * name string. Throws on anything that is not a safe bare identifier: the
 * literal `"false"` (a boolean in YAML must never be accepted as a name), path
 * components, whitespace, or an over-long value.
 */
export function validatePermissionProfileName(
  value: unknown,
  label = "permission profile",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(
      `${label} must be a non-empty profile name without surrounding whitespace.`,
    );
  }
  if (value === "false") {
    throw new Error(
      `${label} must select a named profile; the literal false is not supported.`,
    );
  }
  if (value.length > MAX_PERMISSION_PROFILE_NAME_LENGTH) {
    throw new Error(
      `${label} must be at most ${MAX_PERMISSION_PROFILE_NAME_LENGTH} characters.`,
    );
  }
  if (!PERMISSION_PROFILE_NAME_PATTERN.test(value)) {
    throw new Error(
      `${label} must contain only letters, digits, underscores, or hyphens and start with a letter or digit.`,
    );
  }
  return value;
}

/**
 * Read the launcher-provided profile selection from the environment.
 * Returns the trimmed name, or `undefined` when the variable is unset or
 * empty (an explicitly-empty value means "no profile", same as unset).
 */
export function readPermissionProfileEnv(): string | undefined {
  const value = process.env[PERMISSION_PROFILE_ENV]?.trim() ?? "";
  return value.length > 0 ? value : undefined;
}
