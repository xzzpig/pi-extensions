/**
 * Static same-name skill detection for pi-openspec-x.
 *
 * The official static skills that `openspec init` writes under the project's
 * `.pi/skills/openspec-` skill directories collide with the dynamically
 * generated skills this extension provides. When both exist, the static
 * copies are redundant. This module only detects and reports — it never
 * deletes or modifies project files.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENSPEC_SKILL_NAMES } from "./skills.ts";

/** customType of the static-conflict notice sent to the session. */
export const STATIC_CONFLICT_CUSTOM_TYPE =
  "pi-openspec-x/static-skill-conflict";

/**
 * Return the absolute paths of `<cwd>/.pi/skills/<name>` directories that
 * exist for the generated skill names, in skill order.
 */
export function findStaticSkillConflicts(
  cwd: string,
  skillNames: readonly string[] = OPENSPEC_SKILL_NAMES,
): string[] {
  const hits: string[] = [];
  for (const name of skillNames) {
    const candidate = path.join(cwd, ".pi", "skills", name);
    try {
      if (fs.statSync(candidate).isDirectory()) hits.push(candidate);
    } catch {}
  }
  return hits;
}

/** Build the notice text listing the conflicting paths and the recommendation. */
export function staticConflictMessage(
  conflictPaths: readonly string[],
): string {
  return [
    "pi-openspec-x provides generated OpenSpec skills with the same names as static skill directories found in this project:",
    "",
    ...conflictPaths.map((conflictPath) => `- ${conflictPath}`),
    "",
    "The extension's skills are generated from the installed OpenSpec CLI and provided automatically; these static copies are redundant and may shadow or duplicate them. Consider removing the directories listed above (pi-openspec-x never deletes or modifies project files itself).",
  ].join("\n");
}

export interface WarnStaticSkillConflictsOptions {
  /**
   * Send at most one notice per cwd for the lifetime of the passed memo set.
   * Defaults to true; pass false to always re-check-and-send.
   */
  oncePerCwd?: boolean;
  /** Memo set of cwds already warned about; owned by the caller. */
  warned?: Set<string>;
}

/**
 * Detect static same-name skills under `cwd` and, when found, send one
 * custom-message notice through `pi.sendMessage`. Returns true when a notice
 * was sent. Best-effort: sendMessage failures are swallowed.
 */
export function warnStaticSkillConflicts(
  pi: Pick<ExtensionAPI, "sendMessage">,
  cwd: string,
  options: WarnStaticSkillConflictsOptions = {},
): boolean {
  const conflictPaths = findStaticSkillConflicts(cwd);
  if (conflictPaths.length === 0) return false;
  if (options.oncePerCwd !== false) {
    if (options.warned?.has(cwd)) return false;
    options.warned?.add(cwd);
  }
  try {
    pi.sendMessage(
      {
        customType: STATIC_CONFLICT_CUSTOM_TYPE,
        content: staticConflictMessage(conflictPaths),
        display: true,
      },
      { deliverAs: "followUp" },
    );
  } catch {
    // Notification is best-effort; never break discovery.
  }
  return true;
}
