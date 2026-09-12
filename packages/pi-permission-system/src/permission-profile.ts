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

/**
 * Launcher marker meaning "the selection in {@link PERMISSION_PROFILE_ENV} is
 * authoritative for this process".
 *
 * The selection key cannot express "launched with no profile": an explicitly
 * cleared key looks exactly like a host session that never selected one. A
 * launcher therefore marks the launch, and only a marked process freezes the
 * value (see `PermissionManager.freezeEnvProfileSelection`).
 */
export const PERMISSION_PROFILE_PINNED_ENV =
  "PI_SUBAGENT_PERMISSION_PROFILE_PINNED";

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

/**
 * Whether this process was launched with a pinned profile selection.
 *
 * Only the launching side can answer this, so it is an explicit marker rather
 * than a guess about subagent identity: a host session also carries subagent
 * environment hints (pi-subagents sets `PI_SUBAGENT_PARENT_SESSION` in the root
 * session so its children inherit the value), and treating those as "this is a
 * child" would freeze the host's own selection and silently drop a mid-session
 * role change.
 */
export function isPermissionProfilePinned(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[PERMISSION_PROFILE_PINNED_ENV] === "1";
}
