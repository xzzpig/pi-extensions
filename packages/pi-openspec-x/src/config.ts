import * as fs from "node:fs";
import * as path from "node:path";

import { resolveAgentDir } from "./agent-dir.ts";

/**
 * Configuration surface for pi-openspec-x.
 *
 * The three allow-write lists map to the sandbox profiles used by the
 * openspec workflow subagents (see design D4). Each list defaults to the
 * corresponding constant below when the field is omitted.
 */
export interface OpsxConfig {
  /** Write allowlist for the agent subagent's sandbox profile. */
  agentAllowWrite?: string[];
  /** Write allowlist for the planner subagent's sandbox profile. */
  plannerAllowWrite?: string[];
  /** Write allowlist for the reviewer subagent's sandbox profile. */
  reviewerAllowWrite?: string[];
}

/** Default write allowlist for the agent subagent. */
export const DEFAULT_AGENT_ALLOW_WRITE: string[] = [
  "openspec/**",
  "node_modules/**",
  "dist/**",
  "coverage/**",
  ".cache/**",
];

/** Default write allowlist for the planner subagent. */
export const DEFAULT_PLANNER_ALLOW_WRITE: string[] = ["openspec/**"];

/** Default write allowlist for the reviewer subagent. */
export const DEFAULT_REVIEWER_ALLOW_WRITE: string[] = [];

/** Config file name, read from the agent dir and from the project. */
export const OPSX_CONFIG_FILE = "pi-openspec-x.json";

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "",
  );
}

function readConfigFile(filePath: string): OpsxConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const config: OpsxConfig = {};
  const agent = stringArray(record.agentAllowWrite);
  if (agent) config.agentAllowWrite = agent;
  const planner = stringArray(record.plannerAllowWrite);
  if (planner) config.plannerAllowWrite = planner;
  const reviewer = stringArray(record.reviewerAllowWrite);
  if (reviewer) config.reviewerAllowWrite = reviewer;
  return config;
}

/**
 * Load the opsx configuration. `<agentDir>/pi-openspec-x.json` is the global
 * layer and `<cwd>/.pi/pi-openspec-x.json` overrides it field by field. Any
 * read or parse failure is ignored: a missing or malformed file can never stop
 * the extension from loading, it only leaves that field at its default.
 */
export function loadOpsxConfig(
  options: {
    agentDir?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): OpsxConfig {
  const agentDir =
    options.agentDir ?? resolveAgentDir(options.env ?? process.env);
  const cwd = options.cwd ?? process.cwd();
  return {
    ...readConfigFile(path.join(agentDir, OPSX_CONFIG_FILE)),
    ...readConfigFile(path.join(cwd, ".pi", OPSX_CONFIG_FILE)),
  };
}
