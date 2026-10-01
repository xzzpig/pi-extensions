/**
 * The three sandbox profiles the opsx workflow runs its subagents under
 * (design D4, openspec change add-pi-openspec-x).
 *
 * The definitions are code constants registered into pi-sandbox's runtime
 * profile registry at extension init (see index.ts); registration is
 * in-memory for the session lifetime and never writes a user's sandbox.json.
 * Resolution order is user configuration > runtime registration, so an
 * operator can pin or refine any of these names by defining the same profile
 * in sandbox.json.
 *
 * allowRead is the whole project ("."), and every other field keeps inheriting
 * the operator's baseline (inheritGlobalConfig defaults to true, so the
 * configured deny lists stay in force): only the write boundary differs
 * per role.
 */
import type { SandboxProfileDefinition } from "@xzzpig/pi-sandbox";

import {
  DEFAULT_AGENT_ALLOW_WRITE,
  DEFAULT_PLANNER_ALLOW_WRITE,
  DEFAULT_REVIEWER_ALLOW_WRITE,
  type OpsxConfig,
} from "./config.ts";

/** Project-wide read access, shared by all three profiles. */
const PROJECT_WIDE_READ = ["."];

/** The configured write list, or the role default; always a fresh array. */
function writeAllowList(
  configured: string[] | undefined,
  fallback: string[],
): string[] {
  return [...(configured ?? fallback)];
}

/**
 * Build the three opsx profile definitions from the configuration surface.
 * Each OpsxConfig allow-write list overrides its role's default when present.
 */
export function buildSandboxProfiles(
  config: OpsxConfig = {},
): Record<string, SandboxProfileDefinition> {
  return {
    "opsx-planner": {
      filesystem: {
        allowRead: [...PROJECT_WIDE_READ],
        allowWrite: writeAllowList(
          config.plannerAllowWrite,
          DEFAULT_PLANNER_ALLOW_WRITE,
        ),
      },
    },
    "opsx-agent": {
      filesystem: {
        allowRead: [...PROJECT_WIDE_READ],
        allowWrite: writeAllowList(
          config.agentAllowWrite,
          DEFAULT_AGENT_ALLOW_WRITE,
        ),
      },
    },
    "opsx-reviewer": {
      filesystem: {
        allowRead: [...PROJECT_WIDE_READ],
        allowWrite: writeAllowList(
          config.reviewerAllowWrite,
          DEFAULT_REVIEWER_ALLOW_WRITE,
        ),
      },
    },
  };
}
