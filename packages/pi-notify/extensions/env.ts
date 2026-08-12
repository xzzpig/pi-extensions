/**
 * Environment variable expansion adapter pinned to dotenv-expand@13.0.0.
 *
 * The pinned version supports `$VAR`, `${VAR}`, `${VAR:-default}`, recursion
 * and `\$` escaping, and it never interprets `$(...)` as a shell command.
 * Upgrading to the v1000 line (which adds command substitution) is a
 * security-relevant change and MUST be rejected in review.
 *
 * dotenv-expand mutates the `processEnv` object it is given, so every
 * expansion runs against a fresh isolated copy of `process.env`; the real
 * process environment is never written. Config fields cannot reference each
 * other because each string is expanded with a single-key parsed object.
 */
import { expand } from "dotenv-expand";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

let expansionCounter = 0;

/**
 * Deep-clone `value`, expanding every string leaf with the given process
 * environment. Numbers, booleans and null pass through unchanged. Dangerous
 * object keys are skipped entirely.
 */
export function expandConfigStrings<T>(
  value: unknown,
  processEnv: Readonly<Record<string, string | undefined>>,
): T {
  if (typeof value === "string") {
    return expandStringValue(value, processEnv) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandConfigStrings(item, processEnv)) as T;
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      result[key] = expandConfigStrings(entry, processEnv);
    }
    return result as T;
  }

  return value as T;
}

/** Expand a single config string using dotenv-expand 13 semantics. */
export function expandStringValue(
  value: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): string {
  // The parsed key is a fresh, unique private name so a malformed config
  // value can never collide with a real environment entry.
  const parsedKey = `__pi_notify_expand_${(expansionCounter += 1)}__`;
  const isolatedProcessEnv: Record<string, string> = {};
  for (const [key, entry] of Object.entries(processEnv)) {
    if (typeof entry === "string") {
      isolatedProcessEnv[key] = entry;
    }
  }

  const parsed: Record<string, string> = { [parsedKey]: value };
  expand({ parsed, processEnv: isolatedProcessEnv });
  return parsed[parsedKey];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
