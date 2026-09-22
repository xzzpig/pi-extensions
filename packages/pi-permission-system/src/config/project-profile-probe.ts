import { existsSync, readFileSync } from "node:fs";
import { stripJsonComments } from "./config-loader";
import { getProjectConfigPath } from "./config-paths";

/**
 * Fork-only helper (project-permission-profiles).
 *
 * Silently count the entries in a project's permission config `profiles`
 * registry without loading any rules. Used to warn that an untrusted project's
 * profiles were not applied: the permission-manager's loader withholds the
 * project cwd for untrusted projects (#644), so only this cwd-held peek can
 * observe how many named profiles exist to surface in the warning.
 *
 * Absent, unreadable, or malformed files count as zero — the warning is
 * best-effort and must never fail config loading.
 */
export function countProjectConfigProfiles(cwd: string): number {
  const path = getProjectConfigPath(cwd);
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("profiles" in parsed)
    ) {
      return 0;
    }
    const profiles = (parsed as Record<string, unknown>).profiles;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
      return 0;
    }
    return Object.keys(profiles).length;
  } catch {
    return 0;
  }
}

/**
 * The untrusted-project warning text, matching the wording produced by
 * `resolveProfileScopes` so both channels (getConfigIssues and UI notify)
 * surface the same message.
 */
export function untrustedProjectProfilesWarning(count: number): string {
  return `Project defines ${count} permission profile${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not applied (project is not trusted).`;
}