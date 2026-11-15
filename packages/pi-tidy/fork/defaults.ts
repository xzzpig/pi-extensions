import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig, type TidyConfig } from "../src/config.ts";

export interface ForkTidyConfig extends TidyConfig {
  /** Draw pi-tidy's own tool frames. The fork leaves them to pi-tool-display by default. */
  frameTools: boolean;
  /** Leave thinking rendering to Pi and pi-thinking-collapse instead of tidy's own row. */
  nativeThinking: boolean;
}

export type ForkSettingsFile = {
  tidy?: RecordLike;
  toolbox?: RecordLike;
};

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordLike) : undefined;
}

/** Settings values are decoded once at this I/O boundary. */
function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readSettings(): ForkSettingsFile | undefined {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    const root = asRecord(parsed);
    return root ? { tidy: asRecord(root.tidy), toolbox: asRecord(root.toolbox) } : undefined;
  } catch {
    return undefined;
  }
}

function tidyOptions(settings: ForkSettingsFile | undefined): RecordLike {
  return settings?.tidy ?? settings?.toolbox ?? {};
}

/**
 * Apply fork defaults without mutating the upstream config or overriding an
 * explicitly configured value. Upstream loadConfig() has already resolved and
 * validated the user's values; the raw settings are only used to distinguish
 * an omitted key from an upstream default.
 */
export function applyForkDefaults(
  config: TidyConfig,
  settings: ForkSettingsFile | undefined = readSettings(),
): ForkTidyConfig {
  const userOptions = tidyOptions(settings);
  const configuredOr = <K extends keyof TidyConfig>(key: K, fallback: TidyConfig[K]): TidyConfig[K] =>
    Object.hasOwn(userOptions, key) ? config[key] : fallback;

  return {
    ...config,
    frameTools: readBoolean(userOptions.frameTools) ?? false,
    nativeThinking: readBoolean(userOptions.nativeThinking) ?? true,
    highlightBash: configuredOr("highlightBash", false),
    frameMessages: configuredOr("frameMessages", true),
    userMessageStyle: configuredOr("userMessageStyle", "frame"),
    collapseTurns: configuredOr("collapseTurns", "off"),
    finalReplyStyle:
      Object.hasOwn(userOptions, "finalReplyStyle") || Object.hasOwn(userOptions, "frameFinalReply")
        ? config.finalReplyStyle
        : "frame",
    groupTools: configuredOr("groupTools", false),
    backgroundJobs: configuredOr("backgroundJobs", false),
    dedupeErrors: configuredOr("dedupeErrors", true),
    cleanCopy: configuredOr("cleanCopy", false),
    splitDiff: configuredOr("splitDiff", false),
    codeBlocks: configuredOr("codeBlocks", true),
    hexSwatches: configuredOr("hexSwatches", true),
    toolColors: configuredOr("toolColors", {}),
  };
}

/** Load the upstream configuration and apply the fork's omission-only defaults. */
export function loadForkConfig(): ForkTidyConfig {
  return applyForkDefaults(loadConfig());
}
