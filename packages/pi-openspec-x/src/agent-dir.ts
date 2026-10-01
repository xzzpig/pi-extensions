/**
 * Agent directory resolution for pi-openspec-x.
 *
 * Mirrors the semantics pi-goal-x established for this monorepo: the
 * `PI_CODING_AGENT_DIR` environment variable overrides the default
 * `<homeDir>/.pi/agent` location. Absolute overrides are normalized;
 * relative overrides resolve against `homeDir`. Nothing in this package may
 * hardcode the default path — always go through `resolveAgentDir`.
 */
import * as os from "node:os";
import * as path from "node:path";

/** Environment variable overriding the pi agent directory. */
const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolve the pi agent dir honoring PI_CODING_AGENT_DIR (absolute or ~-relative to homeDir). */
export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const override = asNonEmptyString(env[PI_CODING_AGENT_DIR_ENV]);
  if (override) {
    return path.isAbsolute(override)
      ? path.normalize(override)
      : path.resolve(homeDir, override);
  }
  return path.join(homeDir, ".pi", "agent");
}

/** Cache root for this extension under the agent dir. */
function openspecXCacheRoot(agentDir: string): string {
  return path.join(agentDir, "cache", "pi-openspec-x");
}

/**
 * Versioned skills cache directory: the CLI version is the cache key, so a
 * CLI upgrade regenerates instead of reusing stale skills.
 */
export function openspecXSkillsDir(
  agentDir: string,
  cliVersion: string,
): string {
  return path.join(openspecXCacheRoot(agentDir), "skills", cliVersion);
}
