import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Fork configuration for pi-context-cap.
 *
 * Loads a `context-cap.json` from two locations and merges them per key:
 *
 *   1. Global:  <pi agent dir>/context-cap.json        (e.g. ~/.pi/agent/)
 *   2. Project: <project cwd>/.pi/context-cap.json     (only when the project
 *                is trusted)
 *
 * Project values override global values on a per-key basis. Invalid files
 * (broken JSON, wrong types) are skipped with a user-visible warning instead
 * of failing the session.
 */

export interface ContextCapConfig {
  /** Model whitelist: minimatch patterns against `provider/modelId` or a bare `modelId`. Empty = all models. */
  models?: string[];
  /** Token budget enforced by forced compaction. */
  budget?: number;
  /** Headroom below the budget before compaction fires. */
  reserve?: number;
}

export interface LoadedConfig {
  config: ContextCapConfig;
  warnings: string[];
}

function parseTokens(raw: unknown): number | null {
  // Strict positive-integer parse: reject floats and suffix strings ("200k")
  // instead of silently truncating them to a wrong value.
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[_,\s]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number.parseInt(digits, 10);
  return n > 0 ? n : null;
}

function readConfigFile(path: string): {
  config: ContextCapConfig;
  warning: string | null;
} {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Missing file is the normal case; skip silently.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, warning: null };
    }
    return {
      config: {},
      warning: `could not read ${path}: ${(error as Error).message}`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      config: {},
      warning: `invalid JSON in ${path}: ${(error as Error).message}`,
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      config: {},
      warning: `${path} must contain a JSON object`,
    };
  }

  const obj = raw as Record<string, unknown>;
  const config: ContextCapConfig = {};
  const warnings: string[] = [];
  // Messages are surfaced through notify sites that add the "context-cap: "
  // prefix themselves, so none of them carry it here.
  const bad = (key: string, expected: string) =>
    warnings.push(`"${key}" in ${path} must be ${expected}; ignoring it`);

  if (obj.models !== undefined && obj.models !== null) {
    if (
      Array.isArray(obj.models) &&
      obj.models.every((m) => typeof m === "string" && m.length > 0)
    ) {
      config.models = obj.models as string[];
    } else {
      bad("models", "a non-empty array of strings");
    }
  }

  // JSON null means "not set" (a common placeholder in generated configs,
  // e.g. home-manager); treat it exactly like an absent key, silently.
  const budget = parseTokens(obj.budget);
  if (obj.budget != null && budget === null) {
    bad("budget", "a positive token count");
  } else if (budget !== null) {
    config.budget = budget;
  }

  const reserve = parseTokens(obj.reserve);
  if (obj.reserve != null && reserve === null) {
    bad("reserve", "a positive token count");
  } else if (reserve !== null) {
    config.reserve = reserve;
  }

  return { config, warning: warnings.join("; ") || null };
}

/** Global config path: <pi agent dir>/context-cap.json */
export function globalConfigPath(): string {
  return join(getAgentDir(), "context-cap.json");
}

/** Project config path: <project cwd>/.pi/context-cap.json */
export function projectConfigPath(ctx: ExtensionContext): string {
  return join(ctx.cwd ?? process.cwd(), CONFIG_DIR_NAME, "context-cap.json");
}

/**
 * Load and merge global + project config files (project wins per key).
 * Uses `ctx.isProjectTrusted()` so a cloned repo cannot inject config into an
 * untrusted project. Returns warnings for invalid files to surface via notify.
 */
export function loadConfig(ctx: ExtensionContext): LoadedConfig {
  const merged: ContextCapConfig = {};
  const warnings: string[] = [];

  const global = readConfigFile(globalConfigPath());
  if (global.warning) warnings.push(global.warning);
  Object.assign(merged, global.config);

  if (typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted()) {
    const project = readConfigFile(projectConfigPath(ctx));
    if (project.warning) warnings.push(project.warning);
    Object.assign(merged, project.config);
  }

  return { config: merged, warnings };
}
