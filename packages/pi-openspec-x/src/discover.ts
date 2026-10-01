/**
 * resources_discover wiring for pi-openspec-x.
 *
 * The handler returned by `createResourcesDiscoverHandler`:
 * - ensures the versioned official-track skills are generated under the agent
 *   dir cache and returns that directory as a `skillPaths` entry;
 * - warns once per cwd when static `<cwd>/.pi/skills/openspec-*` directories
 *   collide with the generated skills;
 * - never throws: when the openspec CLI is missing (or generation fails for
 *   any other reason) it returns an empty result and sends a one-time notice.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
} from "@earendil-works/pi-coding-agent";
import { isOpenspecCliMissingError } from "./cli.ts";
import {
  ensureOpenspecSkills,
  type EnsureOpenspecSkillsOptions,
} from "./skills.ts";
import {
  STATIC_CONFLICT_CUSTOM_TYPE,
  warnStaticSkillConflicts,
} from "./static-conflict.ts";

/** customType of the one-time CLI-missing notice. */
export const CLI_MISSING_NOTICE_CUSTOM_TYPE =
  "pi-openspec-x/cli-missing-notice";

export interface ResourcesDiscoverDeps
  extends Partial<EnsureOpenspecSkillsOptions> {
  /**
   * Working directory for the static-conflict check, defaulting to the
   * event's cwd. Kept separate from the CLI child-process cwd, which stays
   * unset (schemas/templates/version do not depend on it).
   */
  conflictCwd?: string;
}

// One-time flags live at module level so they survive extension reloads
// within the same pi process. Reset via resetResourcesDiscoverStateForTests.
let cliMissingNoticeSent = false;
const staticConflictWarned = new Set<string>();

/** Reset the one-time notice state. Test-only. */
export function resetResourcesDiscoverStateForTests(): void {
  cliMissingNoticeSent = false;
  staticConflictWarned.clear();
}

function sendCliMissingNotice(
  pi: Pick<ExtensionAPI, "sendMessage">,
  error: unknown,
): void {
  const detail = isOpenspecCliMissingError(error)
    ? error.message
    : `pi-openspec-x could not generate the official OpenSpec skills: ${error instanceof Error ? error.message : String(error)}`;
  try {
    pi.sendMessage(
      {
        customType: CLI_MISSING_NOTICE_CUSTOM_TYPE,
        content: `${detail}\n\nThe extension will register no OpenSpec skills for this session. Install the openspec CLI (or fix the error above) and reload to enable the official workflow.`,
        display: true,
      },
      { deliverAs: "followUp" },
    );
  } catch {
    // Notification is best-effort; never break discovery.
  }
}

/**
 * Build the resources_discover handler. `pi` is used only for one-time
 * notices; skill generation goes through `ensureOpenspecSkills` with the
 * given deps (env/homeDir/agentDir/spawnImpl are injectable for tests).
 */
export function createResourcesDiscoverHandler(
  pi: Pick<ExtensionAPI, "sendMessage">,
  deps: ResourcesDiscoverDeps = {},
): ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult> {
  const ensureOptions: EnsureOpenspecSkillsOptions = {
    env: deps.env,
    homeDir: deps.homeDir,
    agentDir: deps.agentDir,
    spawnImpl: deps.spawnImpl,
  };
  return (
    event: ResourcesDiscoverEvent,
    _ctx: ExtensionContext,
  ): ResourcesDiscoverResult => {
    const cwd = deps.conflictCwd ?? event.cwd;
    warnStaticSkillConflicts(pi, cwd, {
      oncePerCwd: true,
      warned: staticConflictWarned,
    });
    try {
      const result = ensureOpenspecSkills(ensureOptions);
      return { skillPaths: [result.skillsDir] };
    } catch (error) {
      if (!cliMissingNoticeSent) {
        cliMissingNoticeSent = true;
        sendCliMissingNotice(pi, error);
      }
      return { skillPaths: [] };
    }
  };
}

export { STATIC_CONFLICT_CUSTOM_TYPE };
