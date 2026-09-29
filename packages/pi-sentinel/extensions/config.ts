import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Declarative sentinel configuration.
 *
 * Loads `sentinel.json` from two file scopes and merges them:
 *
 *   1. Global:  `<pi agent dir>/sentinel.json`      (e.g. ~/.pi/agent/)
 *   2. Project: `<project cwd>/.pi/sentinel.json`   (only when trusted)
 *
 * `defaults` merge per key (project > global), `rules` merge by `name`
 * (a higher scope's same-name rule replaces the lower one entirely), and
 * `fleetKeybindings` merges per key. A third, session-level scope is layered on
 * top by `session-store.ts` using the same `mergeRules` primitive.
 *
 * Invalid files and invalid rules never abort a session: a bad file is skipped
 * with a warning, and a bad rule is skipped while its siblings still load.
 */

export const TRIGGER_TYPES = [
  "tool_call",
  "tool_result",
  "turn_end",
  "agent_end",
  "context_tokens",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const EXECUTION_MODES = ["blocking", "background"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const OVERLAP_STRATEGIES = [
  "parallel",
  "serial",
  "ignore",
  "replace",
] as const;
export type OverlapStrategy = (typeof OVERLAP_STRATEGIES)[number];

export const FAILURE_POLICIES = ["open", "closed"] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/**
 * Host built-in tools an auditor may be granted (v1 boundary).
 *
 * Extension-registered and MCP tools only expose a name and schema to
 * extensions, not an executable instance, so they can never be auditor tools;
 * they remain valid as `trigger.tools` match patterns.
 */
export const BUILTIN_AUDITOR_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
] as const;
export type BuiltinAuditorTool = (typeof BUILTIN_AUDITOR_TOOLS)[number];

export const CONFIG_SCOPES = ["global", "project", "session"] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export interface SentinelWindow {
  messages?: number;
  tokens?: number;
  full?: boolean;
}

export interface SentinelTrigger {
  type: TriggerType;
  /** minimatch patterns matched against the reported tool name. */
  tools?: string[];
  /** Required for `context_tokens`: fire once per crossed multiple. */
  threshold?: number;
}

export interface SentinelRule {
  name: string;
  trigger: SentinelTrigger;
  mode: ExecutionMode;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevelName;
  tools?: BuiltinAuditorTool[];
  maxTurns?: number;
  window?: SentinelWindow;
  overlap?: OverlapStrategy;
  onFailure?: FailurePolicy;
  cache?: boolean;
  cacheTtlMs?: number;
  timeoutMs?: number;
  enabled?: boolean;
  dedupe?: boolean;
  includeThinking?: boolean;
  includeToolInputs?: boolean;
  includeToolOutputs?: boolean;
}

/** A rule together with the scope it was loaded from. */
export interface SourcedRule extends SentinelRule {
  source: ConfigScope;
}

export interface ConfigureDefaults {
  model?: string;
}

export interface SentinelDefaults {
  model?: string;
  thinking?: ThinkingLevelName;
  timeoutMs?: number;
  cache?: boolean;
  cacheTtlMs?: number;
  maxConcurrent?: number;
  dedupeCooldownMs?: number;
  maxWindowTokens?: number;
  configure?: ConfigureDefaults;
}

/** Built-in defaults, applied when neither file scope sets a key. */
export const BUILT_IN_DEFAULTS = {
  thinking: "off",
  cache: true,
  cacheTtlMs: 600_000,
  maxConcurrent: 3,
  dedupeCooldownMs: 600_000,
  maxWindowTokens: 20_000,
} as const satisfies SentinelDefaults;

/** Per-trigger timeout defaults when neither rule nor defaults set one. */
export const DEFAULT_TIMEOUT_MS = {
  blocking: 30_000,
  background: 60_000,
} as const;

export const FLEET_KEYBINDING_ACTIONS = [
  "selectUp",
  "selectDown",
  "steer",
  "refresh",
  "close",
] as const;
export type FleetKeybindingAction = (typeof FLEET_KEYBINDING_ACTIONS)[number];

export type FleetKeybindings = Partial<Record<FleetKeybindingAction, string[]>>;

export const DEFAULT_FLEET_KEYBINDINGS: Record<
  FleetKeybindingAction,
  string[]
> = {
  selectUp: ["up", "k"],
  selectDown: ["down", "j"],
  steer: ["s"],
  refresh: ["r"],
  close: ["escape", "ctrl+c", "q"],
};

export interface SentinelFileConfig {
  defaults?: SentinelDefaults;
  rules?: SentinelRule[];
  fleetKeybindings?: FleetKeybindings;
}

export interface ResolvedSentinelConfig {
  defaults: SentinelDefaults;
  rules: SourcedRule[];
  fleetKeybindings: Record<FleetKeybindingAction, string[]>;
}

export interface LoadedSentinelConfig extends ResolvedSentinelConfig {
  warnings: string[];
}

const TOP_LEVEL_KEYS = new Set(["defaults", "rules", "fleetKeybindings"]);
const DEFAULT_KEYS = new Set([
  "model",
  "thinking",
  "timeoutMs",
  "cache",
  "cacheTtlMs",
  "maxConcurrent",
  "dedupeCooldownMs",
  "maxWindowTokens",
  "configure",
]);
const RULE_KEYS = new Set([
  "name",
  "trigger",
  "mode",
  "prompt",
  "model",
  "thinking",
  "tools",
  "maxTurns",
  "window",
  "overlap",
  "onFailure",
  "cache",
  "cacheTtlMs",
  "timeoutMs",
  "enabled",
  "dedupe",
  "includeThinking",
  "includeToolInputs",
  "includeToolOutputs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

/** Result of validating a single rule: either a rule or a human-readable reason. */
export type RuleValidation =
  | { ok: true; rule: SentinelRule }
  | { ok: false; error: string };

/**
 * Validate one rule object against the full field table.
 *
 * Unknown fields, illegal enum values, invalid `trigger`/`mode` combinations,
 * non-builtin auditor tools, and malformed windows all fail the rule so the
 * caller can skip just this entry.
 */
export function validateRule(raw: unknown): RuleValidation {
  if (!isRecord(raw)) return { ok: false, error: "rule must be a JSON object" };

  const unknownKeys = Object.keys(raw).filter((key) => !RULE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  if (!isNonEmptyString(raw.name))
    return { ok: false, error: "`name` must be a non-empty string" };
  if (!isNonEmptyString(raw.prompt)) {
    return { ok: false, error: "`prompt` must be a non-empty string" };
  }
  if (!isRecord(raw.trigger))
    return { ok: false, error: "`trigger` must be an object" };
  if (!oneOf(TRIGGER_TYPES, raw.trigger.type)) {
    return {
      ok: false,
      error: `\`trigger.type\` must be one of ${TRIGGER_TYPES.join(" | ")}`,
    };
  }
  if (!oneOf(EXECUTION_MODES, raw.mode)) {
    return {
      ok: false,
      error: `\`mode\` must be one of ${EXECUTION_MODES.join(" | ")}`,
    };
  }

  const triggerType = raw.trigger.type;
  const mode = raw.mode;
  if (mode === "blocking" && triggerType !== "tool_call") {
    return {
      ok: false,
      error: "`blocking` mode only supports the `tool_call` trigger",
    };
  }

  const unknownTriggerKeys = Object.keys(raw.trigger).filter(
    (key) => key !== "type" && key !== "tools" && key !== "threshold",
  );
  if (unknownTriggerKeys.length > 0) {
    return {
      ok: false,
      error: `unknown trigger field(s): ${unknownTriggerKeys.join(", ")}`,
    };
  }

  const toolTrigger =
    triggerType === "tool_call" || triggerType === "tool_result";
  const trigger: SentinelTrigger = { type: triggerType };

  if (raw.trigger.tools !== undefined) {
    if (!toolTrigger) {
      return {
        ok: false,
        error: "`trigger.tools` is only valid for tool_call/tool_result",
      };
    }
    if (
      !Array.isArray(raw.trigger.tools) ||
      raw.trigger.tools.some((pattern) => !isNonEmptyString(pattern))
    ) {
      return {
        ok: false,
        error: "`trigger.tools` must be an array of non-empty strings",
      };
    }
    trigger.tools = raw.trigger.tools as string[];
  }

  if (raw.trigger.threshold !== undefined) {
    if (triggerType !== "context_tokens") {
      return {
        ok: false,
        error: "`trigger.threshold` is only valid for context_tokens",
      };
    }
    if (!isPositiveInt(raw.trigger.threshold)) {
      return {
        ok: false,
        error: "`trigger.threshold` must be a positive integer",
      };
    }
    trigger.threshold = raw.trigger.threshold;
  }
  if (triggerType === "context_tokens" && trigger.threshold === undefined) {
    return {
      ok: false,
      error: "`trigger.threshold` is required for context_tokens",
    };
  }

  const rule: SentinelRule = {
    name: raw.name,
    trigger,
    mode,
    prompt: raw.prompt,
  };

  if (raw.model !== undefined) {
    if (!isNonEmptyString(raw.model))
      return { ok: false, error: "`model` must be a non-empty string" };
    rule.model = raw.model;
  }
  if (raw.thinking !== undefined) {
    if (!oneOf(THINKING_LEVELS, raw.thinking)) {
      return {
        ok: false,
        error: `\`thinking\` must be one of ${THINKING_LEVELS.join(" | ")}`,
      };
    }
    rule.thinking = raw.thinking;
  }
  if (raw.tools !== undefined) {
    if (
      !Array.isArray(raw.tools) ||
      raw.tools.some((tool) => !isNonEmptyString(tool))
    ) {
      return {
        ok: false,
        error: "`tools` must be an array of non-empty strings",
      };
    }
    const invalid = (raw.tools as string[]).filter(
      (tool) => !(BUILTIN_AUDITOR_TOOLS as readonly string[]).includes(tool),
    );
    if (invalid.length > 0) {
      return {
        ok: false,
        error: `auditor tools must be host built-in tools (${BUILTIN_AUDITOR_TOOLS.join(
          ", ",
        )}); extension/MCP tools cannot be auditor tools: ${invalid.join(", ")}`,
      };
    }
    rule.tools = raw.tools as BuiltinAuditorTool[];
  }
  if (raw.maxTurns !== undefined) {
    if (!isPositiveInt(raw.maxTurns))
      return { ok: false, error: "`maxTurns` must be a positive integer" };
    rule.maxTurns = raw.maxTurns;
  }
  if (raw.window !== undefined) {
    if (!isRecord(raw.window))
      return { ok: false, error: "`window` must be an object" };
    const windowKeys = Object.keys(raw.window);
    const unknownWindowKeys = windowKeys.filter(
      (key) => key !== "messages" && key !== "tokens" && key !== "full",
    );
    if (unknownWindowKeys.length > 0) {
      return {
        ok: false,
        error: `unknown window field(s): ${unknownWindowKeys.join(", ")}`,
      };
    }
    if (windowKeys.length !== 1) {
      return {
        ok: false,
        error: "`window` must set exactly one of messages/tokens/full",
      };
    }
    const window: SentinelWindow = {};
    if (raw.window.messages !== undefined) {
      if (!isPositiveInt(raw.window.messages)) {
        return {
          ok: false,
          error: "`window.messages` must be a positive integer",
        };
      }
      window.messages = raw.window.messages;
    } else if (raw.window.tokens !== undefined) {
      if (!isPositiveInt(raw.window.tokens)) {
        return {
          ok: false,
          error: "`window.tokens` must be a positive integer",
        };
      }
      window.tokens = raw.window.tokens;
    } else if (raw.window.full !== true) {
      return { ok: false, error: "`window.full` must be true" };
    } else {
      window.full = true;
    }
    rule.window = window;
  }
  if (raw.overlap !== undefined) {
    if (!oneOf(OVERLAP_STRATEGIES, raw.overlap)) {
      return {
        ok: false,
        error: `\`overlap\` must be one of ${OVERLAP_STRATEGIES.join(" | ")}`,
      };
    }
    rule.overlap = raw.overlap;
  }
  if (raw.onFailure !== undefined) {
    if (!oneOf(FAILURE_POLICIES, raw.onFailure)) {
      return {
        ok: false,
        error: `\`onFailure\` must be one of ${FAILURE_POLICIES.join(" | ")}`,
      };
    }
    rule.onFailure = raw.onFailure;
  }
  for (const key of [
    "cache",
    "enabled",
    "dedupe",
    "includeThinking",
    "includeToolInputs",
    "includeToolOutputs",
  ] as const) {
    if (raw[key] !== undefined) {
      if (!isBoolean(raw[key]))
        return { ok: false, error: `\`${key}\` must be a boolean` };
      rule[key] = raw[key];
    }
  }
  for (const key of ["cacheTtlMs", "timeoutMs"] as const) {
    if (raw[key] !== undefined) {
      if (!isPositiveInt(raw[key]))
        return { ok: false, error: `\`${key}\` must be a positive integer` };
      rule[key] = raw[key];
    }
  }

  return { ok: true, rule };
}

/** Validate a `defaults` object, returning accepted keys plus warnings. */
export function validateDefaults(
  raw: unknown,
  where: string,
): {
  defaults: SentinelDefaults;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    warnings.push(`${where}: "defaults" must be an object; ignoring it`);
    return { defaults: {}, warnings };
  }

  const defaults: SentinelDefaults = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!DEFAULT_KEYS.has(key)) {
      warnings.push(`${where}: unknown defaults key "${key}"; ignoring it`);
      continue;
    }
    if (key === "configure") {
      if (!isRecord(value)) {
        warnings.push(
          `${where}: "defaults.configure" must be an object; ignoring it`,
        );
        continue;
      }
      const configure: ConfigureDefaults = {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerKey !== "model") {
          warnings.push(
            `${where}: unknown defaults.configure key "${innerKey}"; ignoring it`,
          );
          continue;
        }
        if (!isNonEmptyString(innerValue)) {
          warnings.push(
            `${where}: "defaults.configure.model" must be a non-empty string; ignoring it`,
          );
          continue;
        }
        configure.model = innerValue;
      }
      defaults.configure = configure;
      continue;
    }
    if (key === "model") {
      if (!isNonEmptyString(value)) {
        warnings.push(
          `${where}: "defaults.model" must be a non-empty string; ignoring it`,
        );
        continue;
      }
      defaults.model = value;
      continue;
    }
    if (key === "thinking") {
      if (!oneOf(THINKING_LEVELS, value)) {
        warnings.push(
          `${where}: "defaults.thinking" must be one of ${THINKING_LEVELS.join(" | ")}; ignoring it`,
        );
        continue;
      }
      defaults.thinking = value;
      continue;
    }
    if (key === "cache") {
      if (!isBoolean(value)) {
        warnings.push(
          `${where}: "defaults.cache" must be a boolean; ignoring it`,
        );
        continue;
      }
      defaults.cache = value;
      continue;
    }
    if (!isPositiveInt(value)) {
      warnings.push(
        `${where}: "defaults.${key}" must be a positive integer; ignoring it`,
      );
      continue;
    }
    (defaults as Record<string, unknown>)[key] = value;
  }
  return { defaults, warnings };
}

/** Validate a `fleetKeybindings` object, returning accepted keys plus warnings. */
export function validateFleetKeybindings(
  raw: unknown,
  where: string,
): {
  keybindings: FleetKeybindings;
  warnings: string[];
} {
  const warnings: string[] = [];
  const keybindings: FleetKeybindings = {};
  if (!isRecord(raw)) {
    warnings.push(
      `${where}: "fleetKeybindings" must be an object; ignoring it`,
    );
    return { keybindings, warnings };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(FLEET_KEYBINDING_ACTIONS as readonly string[]).includes(key)) {
      warnings.push(
        `${where}: unknown fleetKeybindings action "${key}"; ignoring it`,
      );
      continue;
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((k) => !isNonEmptyString(k))
    ) {
      warnings.push(
        `${where}: "fleetKeybindings.${key}" must be a non-empty array of strings; ignoring it`,
      );
      continue;
    }
    keybindings[key as FleetKeybindingAction] = value as string[];
  }
  return { keybindings, warnings };
}

export interface ParsedConfigFile {
  defaults: SentinelDefaults;
  rules: SentinelRule[];
  fleetKeybindings: FleetKeybindings;
  warnings: string[];
}

function parseConfigObject(raw: unknown, where: string): ParsedConfigFile {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return {
      defaults: {},
      rules: [],
      fleetKeybindings: {},
      warnings: [`${where}: must be a JSON object; ignoring it`],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`${where}: unknown key "${key}"; ignoring it`);
    }
  }

  const { defaults, warnings: defaultWarnings } =
    raw.defaults === undefined
      ? { defaults: {} as SentinelDefaults, warnings: [] as string[] }
      : validateDefaults(raw.defaults, where);
  warnings.push(...defaultWarnings);

  const { keybindings, warnings: keybindingWarnings } =
    raw.fleetKeybindings === undefined
      ? { keybindings: {} as FleetKeybindings, warnings: [] as string[] }
      : validateFleetKeybindings(raw.fleetKeybindings, where);
  warnings.push(...keybindingWarnings);

  const rules: SentinelRule[] = [];
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) {
      warnings.push(`${where}: "rules" must be an array; ignoring it`);
    } else {
      raw.rules.forEach((entry, index) => {
        const result = validateRule(entry);
        if (!result.ok) {
          const name =
            isRecord(entry) && typeof entry.name === "string"
              ? `"${entry.name}"`
              : `#${index}`;
          warnings.push(`${where}: rule ${name} skipped: ${result.error}`);
          return;
        }
        const existing = rules.findIndex(
          (rule) => rule.name === result.rule.name,
        );
        if (existing >= 0) rules[existing] = result.rule;
        else rules.push(result.rule);
      });
    }
  }

  return { defaults, rules, fleetKeybindings: keybindings, warnings };
}

function readConfigFile(path: string, label: string): ParsedConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { defaults: {}, rules: [], fleetKeybindings: {}, warnings: [] };
    }
    return {
      defaults: {},
      rules: [],
      fleetKeybindings: {},
      warnings: [
        `${label} (${path}) could not be read: ${(error as Error).message}`,
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      defaults: {},
      rules: [],
      fleetKeybindings: {},
      warnings: [
        `${label} (${path}) has invalid JSON: ${(error as Error).message}`,
      ],
    };
  }

  return parseConfigObject(raw, `${label} (${path})`);
}

/** Global config path: `<pi agent dir>/sentinel.json`. */
export function globalConfigPath(): string {
  return join(getAgentDir(), "sentinel.json");
}

/** Project config path: `<project cwd>/.pi/sentinel.json`. */
export function projectConfigPath(ctx: ExtensionContext): string {
  return join(ctx.cwd ?? process.cwd(), CONFIG_DIR_NAME, "sentinel.json");
}

export interface ConfigFilePaths {
  globalPath: string;
  /** null when the project is untrusted (project config is not read at all). */
  projectPath: string | null;
}

/** Resolve the file paths for a context, honoring project trust. */
export function resolveConfigFilePaths(ctx: ExtensionContext): ConfigFilePaths {
  const trusted =
    typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
  return {
    globalPath: globalConfigPath(),
    projectPath: trusted ? projectConfigPath(ctx) : null,
  };
}

function mergeDefaults(
  base: SentinelDefaults,
  overlay: SentinelDefaults,
): SentinelDefaults {
  const merged: SentinelDefaults = { ...base, ...overlay };
  if (base.configure || overlay.configure) {
    merged.configure = { ...base.configure, ...overlay.configure };
  }
  return merged;
}

/**
 * Merge rule lists by `name`: overlay rules replace same-name base rules in
 * place, and new names are appended in overlay order.
 */
export function mergeRules<T extends SentinelRule>(
  base: T[],
  overlay: T[],
): T[] {
  const merged = [...base];
  for (const rule of overlay) {
    const index = merged.findIndex((existing) => existing.name === rule.name);
    if (index >= 0) merged[index] = rule;
    else merged.push(rule);
  }
  return merged;
}

/** Layer the built-in defaults under a file-level `defaults` object. */
export function resolveDefaults(defaults: SentinelDefaults): SentinelDefaults {
  const merged = mergeDefaults(BUILT_IN_DEFAULTS as SentinelDefaults, defaults);
  if (!merged.configure) merged.configure = {};
  return merged;
}

/**
 * Load and merge global + project files. The session scope is layered by the
 * caller. Project config is only read when the project is trusted.
 */
export function loadConfig(ctx: ExtensionContext): LoadedSentinelConfig {
  return loadConfigFromPaths(resolveConfigFilePaths(ctx));
}

/** Load and merge config from explicit paths (used by tests and reload paths). */
export function loadConfigFromPaths(
  paths: ConfigFilePaths,
): LoadedSentinelConfig {
  const warnings: string[] = [];

  const global = readConfigFile(paths.globalPath, "global config");
  warnings.push(...global.warnings);

  let defaults = global.defaults;
  let rules: SourcedRule[] = global.rules.map((rule) => ({
    ...rule,
    source: "global" as const,
  }));
  let fleetKeybindings = global.fleetKeybindings;

  if (paths.projectPath) {
    const project = readConfigFile(paths.projectPath, "project config");
    warnings.push(...project.warnings);
    defaults = mergeDefaults(defaults, project.defaults);
    rules = mergeRules(
      rules,
      project.rules.map((rule) => ({ ...rule, source: "project" as const })),
    );
    fleetKeybindings = { ...fleetKeybindings, ...project.fleetKeybindings };
  }

  return {
    defaults: resolveDefaults(defaults),
    rules,
    fleetKeybindings: { ...DEFAULT_FLEET_KEYBINDINGS, ...fleetKeybindings },
    warnings,
  };
}

export interface FileConfigWrite {
  defaults?: SentinelDefaults;
  rules?: SentinelRule[];
  fleetKeybindings?: FleetKeybindings;
}

/**
 * Read-merge-write a file scope: same-name rules are replaced, new rules
 * appended, and `removeNames` deleted. Existing unrelated content is preserved.
 */
export function writeFileConfig(
  path: string,
  changes: {
    upsert?: SentinelRule[];
    removeNames?: string[];
    defaults?: SentinelDefaults;
  },
): void {
  const existing = readConfigFile(path, "config");
  const current: SentinelFileConfig = {
    defaults: existing.defaults,
    rules: existing.rules,
  };
  if (Object.keys(existing.fleetKeybindings).length > 0) {
    current.fleetKeybindings = existing.fleetKeybindings;
  }

  let rules = current.rules ?? [];
  if (changes.removeNames && changes.removeNames.length > 0) {
    const remove = new Set(changes.removeNames);
    rules = rules.filter((rule) => !remove.has(rule.name));
  }
  if (changes.upsert && changes.upsert.length > 0) {
    rules = mergeRules(rules, changes.upsert);
  }

  const next: SentinelFileConfig = {};
  if (changes.defaults !== undefined) {
    const merged = { ...(current.defaults ?? {}), ...changes.defaults };
    if (Object.keys(merged).length > 0) next.defaults = merged;
  } else if (current.defaults && Object.keys(current.defaults).length > 0) {
    next.defaults = current.defaults;
  }
  if (rules.length > 0) next.rules = rules;
  if (current.fleetKeybindings)
    next.fleetKeybindings = current.fleetKeybindings;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
