import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Where pi-permission-system keeps its global configuration. Mirrors that
 * package's own path contract; this package never writes the file, it only
 * reads the profile names so a picker can offer them.
 */
const PERMISSION_SYSTEM_CONFIG_PATH = [
  "extensions",
  "pi-permission-system",
  "config.json",
] as const;

export interface PermissionProfileRegistry {
  /** Profile names the global configuration defines, sorted. */
  profiles: string[];
  /** Read/parse problem, when the file exists but could not be used. */
  error?: string;
}

/**
 * List the permission profiles a session can select.
 *
 * Profiles are operator-owned and global-only (a project configuration must not
 * define or override one), so only the global file is read. Names are filtered
 * to non-empty strings: a stray key can never become a selection.
 */
export function listGlobalPermissionProfiles(): PermissionProfileRegistry {
  const configPath = join(getAgentDir(), ...PERMISSION_SYSTEM_CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    // No configuration yet is not an error: the picker simply has nothing to
    // offer beyond clearing the selection.
    return { profiles: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      profiles: [],
      error: `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { profiles: [], error: `${configPath} must contain a JSON object.` };
  }

  const profiles = (parsed as { profiles?: unknown }).profiles;
  if (
    typeof profiles !== "object" ||
    profiles === null ||
    Array.isArray(profiles)
  ) {
    return { profiles: [] };
  }
  return {
    profiles: Object.keys(profiles)
      .filter((name) => name.trim().length > 0)
      .sort((left, right) => left.localeCompare(right)),
  };
}
