/**
 * Layered pi-notify configuration: built-in defaults -> global agent config
 * -> trusted project overlay.
 *
 * Layers are merged on raw JSON values (objects recurse, plain arrays
 * replace, channels merge by unique id), then string leaves are expanded
 * with dotenv-expand 13 semantics, then the result is validated. Validation
 * is isolated per channel instance: one invalid instance never disables the
 * others.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTIFICATION_EVENT_IDS, type NotificationEventId } from "../api.js";
import { expandConfigStrings } from "./env.js";
import { DEFAULT_SUBSCRIBED_EVENT_IDS } from "./events.js";

export type NotificationProtocol = "osc9" | "osc99" | "osc777";

export const NOTIFICATION_PROTOCOLS: readonly NotificationProtocol[] = [
  "osc9",
  "osc99",
  "osc777",
];

export const DEFAULT_NTFY_SERVER_URL = "https://ntfy.sh";
export const DEFAULT_NTFY_TIMEOUT_MS = 5000;
export const DEFAULT_OSC_FALLBACK: NotificationProtocol = "osc9";
export const DEFAULT_TERM_PROGRAM_PROTOCOLS: Readonly<
  Record<string, NotificationProtocol>
> = {
  ghostty: "osc777",
  "iTerm.app": "osc9",
  WezTerm: "osc777",
  WarpTerminal: "osc777",
  vscode: "osc99",
};

/** Built-in ntfy priority per event, used when the user sets no override. */
export const BUILTIN_EVENT_PRIORITIES: Record<NotificationEventId, number> = {
  "agent-completed": 3,
  "agent-error": 5,
  "input-required": 4,
  "permission-required": 4,
  "context-compacted": 2,
  "task-completed": 3,
  "integration-error": 5,
};

export interface OscChannelConfig {
  fallback: NotificationProtocol;
  termPrograms: Record<string, NotificationProtocol>;
}

export interface NtfyEventOption {
  priority?: number;
  icon?: string | null;
}

export interface NtfyChannelConfig {
  serverUrl: string;
  topic: string;
  token?: string;
  timeoutMs: number;
  /** Explicit instance priority (1-5); undefined = use built-in per event. */
  priority?: number;
  /** Explicit instance icon; undefined = use default. */
  icon?: string | null;
  eventOptions: Partial<Record<NotificationEventId, NtfyEventOption>>;
}

export interface ChannelInstance {
  id: string;
  type: "osc" | "ntfy";
  enabled: boolean;
  events: readonly NotificationEventId[];
  osc?: OscChannelConfig;
  ntfy?: NtfyChannelConfig;
}

export interface PiNotifyConfig {
  version: 1;
  enabled: boolean;
  herdr: { enabled: boolean };
  channels: ChannelInstance[];
}

export interface ParsedConfigResult {
  config?: PiNotifyConfig;
  warnings: string[];
}

export interface LoadConfigOptions {
  agentDir?: string;
  cwd?: string;
  configDirName?: string;
  trusted: boolean;
  processEnv?: Readonly<Record<string, string | undefined>>;
}

export interface LoadedConfig {
  config: PiNotifyConfig;
  warnings: string[];
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "version",
  "enabled",
  "herdr",
  "channels",
]);
const CHANNEL_KEYS = new Set([
  "id",
  "type",
  "enabled",
  "events",
  "osc",
  "ntfy",
]);
const OSC_KEYS = new Set(["fallback", "termPrograms"]);
const NTFY_KEYS = new Set([
  "serverUrl",
  "topic",
  "token",
  "priority",
  "timeoutMs",
  "icon",
  "eventOptions",
]);
const EVENT_OPTION_KEYS = new Set(["priority", "icon"]);

export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-notify", "config.json");
}

export function getProjectConfigPath(
  cwd: string,
  configDirName: string,
): string {
  return join(cwd, configDirName, "pi-notify.json");
}

/** Built-in defaults: exactly the fixed `terminal` OSC instance. */
export function makeDefaultRawConfig(): unknown {
  return {
    version: 1,
    enabled: true,
    herdr: { enabled: true },
    channels: [{ id: "terminal", type: "osc" }],
  };
}

export function makeDefaultConfig(): PiNotifyConfig {
  const parsed = parsePiNotifyConfig(makeDefaultRawConfig());
  return (
    parsed.config ?? {
      version: 1,
      enabled: true,
      herdr: { enabled: true },
      channels: [],
    }
  );
}

/** Resolve the effective ntfy priority: event option > instance > built-in. */
export function resolveNtfyPriority(
  eventId: NotificationEventId,
  config: NtfyChannelConfig,
): number {
  const eventPriority = config.eventOptions[eventId]?.priority;
  if (eventPriority !== undefined) {
    return eventPriority;
  }
  if (config.priority !== undefined) {
    return config.priority;
  }

  return BUILTIN_EVENT_PRIORITIES[eventId];
}

/** Resolve the effective ntfy icon: event > instance > default. null disables. */
export function resolveNtfyIcon(
  eventId: NotificationEventId,
  config: NtfyChannelConfig,
  defaultIcon: string,
): string | null {
  const eventOption = config.eventOptions[eventId];
  if (eventOption && "icon" in eventOption) {
    return eventOption.icon === null ? null : (eventOption.icon as string);
  }
  if (config.icon !== undefined) {
    return config.icon === null ? null : config.icon;
  }

  return defaultIcon;
}

export interface ReadConfigFileResult {
  raw?: unknown;
  error?: string;
}

export function readConfigFile(path: string): ReadConfigFileResult {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return { raw: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function collectChannelIdConflicts(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.channels)) {
    return [];
  }

  const seen = new Set<string>();
  const conflicts: string[] = [];
  for (const entry of raw.channels) {
    const id = isRecord(entry) ? entry.id : undefined;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      conflicts.push(id);
    } else {
      seen.add(id);
    }
  }
  return conflicts;
}

/** Load, merge, expand and validate the layered configuration. */
export function loadPiNotifyConfig(options: LoadConfigOptions): LoadedConfig {
  const warnings: string[] = [];
  const layers: unknown[] = [makeDefaultRawConfig()];

  if (options.agentDir) {
    const layer = loadConfigLayer(
      getGlobalConfigPath(options.agentDir),
      "global",
      warnings,
    );
    if (layer !== undefined) {
      layers.push(layer);
    }
  }

  if (options.trusted && options.cwd) {
    const layer = loadConfigLayer(
      getProjectConfigPath(options.cwd, options.configDirName ?? ".pi"),
      "project",
      warnings,
    );
    if (layer !== undefined) {
      layers.push(layer);
    }
  }

  const merged = mergeConfigLayers(...layers);
  const expanded = expandConfigStrings(
    merged,
    options.processEnv ?? process.env,
  );
  const parsed = parsePiNotifyConfig(expanded);
  if (!parsed.config) {
    warnings.push(...parsed.warnings);
    return { config: makeDefaultConfig(), warnings };
  }

  return { config: parsed.config, warnings: [...warnings, ...parsed.warnings] };
}

/** Merge raw config layers: objects recurse, arrays replace, channels by id. */
export function mergeConfigLayers(...layers: unknown[]): unknown {
  let result: unknown = {};
  for (const layer of layers) {
    result = mergeValue(result, layer);
  }
  return result;
}

export function mergeValue(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) {
    return overlay;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!DANGEROUS_KEYS.has(key)) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    result[key] =
      key === "channels"
        ? mergeChannels(result[key], value)
        : mergeValue(result[key], value);
  }
  return result;
}

/**
 * Merge channel arrays by unique id. An overlay channel with the same id
 * inherits the base channel's common fields (id/enabled/events) and type
 * object; when the overlay changes `type`, the inherited old type object is
 * discarded and only the new type object survives.
 */
export function mergeChannels(base: unknown, overlay: unknown): unknown {
  if (!Array.isArray(base) || !Array.isArray(overlay)) {
    return overlay;
  }

  const merged = new Map<string, Record<string, unknown>>();
  for (const entry of base) {
    const record = asRecord(entry);
    if (record && typeof record.id === "string" && record.id.length > 0) {
      merged.set(record.id, { ...record });
    }
  }

  for (const entry of overlay) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "string" || record.id.length === 0) {
      continue;
    }
    const existing = merged.get(record.id);
    merged.set(
      record.id,
      existing ? mergeChannel(existing, record) : { ...record },
    );
  }

  return [...merged.values()];
}

function mergeChannel(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const newType = typeof overlay.type === "string" ? overlay.type : undefined;
  if (newType !== undefined && newType !== base.type) {
    // Type switch: keep common fields only, drop the old type-specific object.
    const common: Record<string, unknown> = {};
    for (const key of ["id", "enabled", "events"]) {
      if (key in base) {
        common[key] = base[key];
      }
    }
    return mergeValue(common, overlay) as Record<string, unknown>;
  }

  return mergeValue(base, overlay) as Record<string, unknown>;
}

/** Parse and validate a fully merged (already env-expanded) raw config. */
export function parsePiNotifyConfig(value: unknown): ParsedConfigResult {
  const warnings: string[] = [];
  if (!isRecord(value)) {
    warnings.push("pi-notify: config must be a JSON object; using defaults");
    return { warnings };
  }

  const unknownTopLevel = unknownKeys(value, TOP_LEVEL_KEYS);
  if (unknownTopLevel.length > 0) {
    warnings.push(
      `pi-notify: ignoring unknown config fields: ${unknownTopLevel.join(", ")}`,
    );
  }

  if (value.version !== undefined && value.version !== 1) {
    warnings.push(
      `pi-notify: unsupported config version ${JSON.stringify(value.version)}; using defaults`,
    );
    return { warnings };
  }

  const enabled = parseBoolean(value.enabled, "enabled", warnings, true);
  const herdr = isRecord(value.herdr)
    ? {
      enabled: parseBoolean(
        value.herdr.enabled,
        "herdr.enabled",
        warnings,
        true,
      ),
    }
    : { enabled: true };

  let channels: ChannelInstance[];
  const terminalInstance = parseChannel(
    { id: "terminal", type: "osc" },
    warnings,
  ).instance;
  if (value.channels === undefined) {
    channels = terminalInstance ? [terminalInstance] : [];
  } else if (!Array.isArray(value.channels)) {
    warnings.push(
      "pi-notify: channels must be an array; using the built-in terminal channel",
    );
    channels = terminalInstance ? [terminalInstance] : [];
  } else {
    channels = [];
    const seenIds = new Set<string>();
    for (const entry of value.channels) {
      const parsed = parseChannel(entry, warnings);
      if (parsed.instance) {
        if (seenIds.has(parsed.instance.id)) {
          warnings.push(
            `pi-notify: duplicate channel id "${parsed.instance.id}"; keeping the first entry`,
          );
          continue;
        }
        seenIds.add(parsed.instance.id);
        channels.push(parsed.instance);
      }
    }
  }

  return {
    config: { version: 1, enabled, herdr, channels },
    warnings,
  };
}

function parseChannel(
  value: unknown,
  warnings: string[],
): { instance?: ChannelInstance } {
  if (!isRecord(value)) {
    warnings.push("pi-notify: skipping a channel that is not an object");
    return {};
  }

  const id = recordString(value.id, warnings, "channel id");
  const type =
    value.type === "osc" || value.type === "ntfy" ? value.type : undefined;
  const unknown = unknownKeys(value, CHANNEL_KEYS);
  if (unknown.length > 0) {
    warnings.push(
      `pi-notify: ignoring unknown channel fields: ${unknown.join(", ")}`,
    );
  }
  if (!id) {
    return {};
  }
  if (!type) {
    warnings.push(`pi-notify: channel "${id}" has an unknown type; skipping`);
    return {};
  }

  const enabled = parseBoolean(
    value.enabled,
    `channel "${id}" enabled`,
    warnings,
    true,
  );

  let events: readonly NotificationEventId[];
  if (value.events === undefined) {
    events = DEFAULT_SUBSCRIBED_EVENT_IDS;
  } else {
    if (!Array.isArray(value.events)) {
      warnings.push(
        `pi-notify: channel "${id}" events must be an array; skipping`,
      );
      return {};
    }
    events = parseEventList(value.events, id, warnings);
  }

  const instance: ChannelInstance = { id, type, enabled, events };
  if (type === "osc") {
    const osc = parseOscConfig(value.osc, id, warnings);
    instance.osc = osc;
    if ("ntfy" in value) {
      warnings.push(
        `pi-notify: channel "${id}" ignores the ntfy object for type "osc"`,
      );
    }
  } else {
    const ntfy = parseNtfyConfig(value.ntfy, id, warnings);
    if (!ntfy) {
      return {};
    }
    instance.ntfy = ntfy;
    if ("osc" in value) {
      warnings.push(
        `pi-notify: channel "${id}" ignores the osc object for type "ntfy"`,
      );
    }
  }

  return { instance };
}

function parseOscConfig(
  value: unknown,
  id: string,
  warnings: string[],
): OscChannelConfig {
  const unknown = isRecord(value) ? unknownKeys(value, OSC_KEYS) : [];
  if (unknown.length > 0) {
    warnings.push(
      `pi-notify: channel "${id}" ignoring unknown osc fields: ${unknown.join(", ")}`,
    );
  }

  const fallback =
    parseProtocol(isRecord(value) ? value.fallback : undefined, warnings) ??
    DEFAULT_OSC_FALLBACK;

  const termPrograms: Record<string, NotificationProtocol> = {
    ...DEFAULT_TERM_PROGRAM_PROTOCOLS,
  };
  if (isRecord(value) && isRecord(value.termPrograms)) {
    for (const [termProgram, rawProtocol] of Object.entries(
      value.termPrograms,
    )) {
      const normalized = termProgram.trim();
      const protocol = parseProtocol(rawProtocol, warnings);
      if (normalized && protocol) {
        termPrograms[normalized] = protocol;
      } else if (normalized) {
        warnings.push(
          `pi-notify: channel "${id}" ignoring invalid protocol for termProgram "${normalized}"`,
        );
      }
    }
  } else if (isRecord(value) && value.termPrograms !== undefined) {
    warnings.push(
      `pi-notify: channel "${id}" termPrograms must be an object; using defaults`,
    );
  }

  return { fallback, termPrograms };
}

function parseNtfyConfig(
  value: unknown,
  id: string,
  warnings: string[],
): NtfyChannelConfig | undefined {
  if (!isRecord(value)) {
    warnings.push(
      `pi-notify: channel "${id}" ntfy config must be an object; skipping`,
    );
    return undefined;
  }

  const unknown = unknownKeys(value, NTFY_KEYS);
  if (unknown.length > 0) {
    warnings.push(
      `pi-notify: channel "${id}" ignoring unknown ntfy fields: ${unknown.join(", ")}`,
    );
  }

  const serverUrlRaw: unknown = value.serverUrl;
  let serverUrl = DEFAULT_NTFY_SERVER_URL;
  if (serverUrlRaw !== undefined) {
    if (typeof serverUrlRaw !== "string" || !isNtfyServerUrl(serverUrlRaw)) {
      warnings.push(
        `pi-notify: channel "${id}" has an invalid serverUrl; skipping`,
      );
      return undefined;
    }
    serverUrl = serverUrlRaw;
  }

  const topicRaw = value.topic;
  if (typeof topicRaw !== "string" || !isValidTopic(topicRaw)) {
    warnings.push(
      `pi-notify: channel "${id}" has an invalid or missing topic; skipping`,
    );
    return undefined;
  }

  const token =
    typeof value.token === "string" && value.token.length > 0
      ? value.token
      : undefined;

  const config: NtfyChannelConfig = {
    serverUrl,
    topic: topicRaw,
    timeoutMs: DEFAULT_NTFY_TIMEOUT_MS,
    eventOptions: {},
  };
  if (token) {
    config.token = token;
  }

  if (!parseNtfyOptionalFields(value, id, warnings, config)) {
    return undefined;
  }

  return config;
}

/** Parse the optional ntfy fields; returns false when the channel must be dropped. */
function parseNtfyOptionalFields(
  value: Record<string, unknown>,
  id: string,
  warnings: string[],
  config: NtfyChannelConfig,
): boolean {
  if (value.priority !== undefined) {
    if (!isPriority(value.priority)) {
      warnings.push(
        `pi-notify: channel "${id}" priority must be an integer 1-5; skipping`,
      );
      return false;
    }
    config.priority = value.priority as number;
  }

  if (value.timeoutMs !== undefined) {
    if (!isPositiveFiniteInteger(value.timeoutMs)) {
      warnings.push(
        `pi-notify: channel "${id}" timeoutMs must be a positive finite integer; skipping`,
      );
      return false;
    }
    config.timeoutMs = value.timeoutMs as number;
  }

  if ("icon" in value) {
    const icon = parseIcon(value.icon, warnings, `channel "${id}" icon`);
    if (icon.valid) {
      if (icon.value === null) {
        config.icon = null;
      } else if (icon.value) {
        config.icon = icon.value;
      }
    }
  }

  if (value.eventOptions !== undefined && isRecord(value.eventOptions)) {
    config.eventOptions = parseEventOptions(value.eventOptions, id, warnings);
    return true;
  }
  if (value.eventOptions !== undefined) {
    warnings.push(
      `pi-notify: channel "${id}" eventOptions must be an object; ignoring`,
    );
  }
  return true;
}

function parseEventOptions(
  value: Record<string, unknown>,
  id: string,
  warnings: string[],
): Partial<Record<NotificationEventId, NtfyEventOption>> {
  const result: Partial<Record<NotificationEventId, NtfyEventOption>> = {};
  for (const [eventId, rawOption] of Object.entries(value)) {
    if (!NOTIFICATION_EVENT_IDS.includes(eventId as NotificationEventId)) {
      warnings.push(
        `pi-notify: channel "${id}" eventOptions ignores unknown event "${eventId}"`,
      );
      continue;
    }
    if (!isRecord(rawOption)) {
      warnings.push(
        `pi-notify: channel "${id}" eventOptions["${eventId}"] must be an object; ignoring`,
      );
      continue;
    }

    const unknown = unknownKeys(rawOption, EVENT_OPTION_KEYS);
    if (unknown.length > 0) {
      warnings.push(
        `pi-notify: channel "${id}" eventOptions["${eventId}"] ignoring unknown fields: ${unknown.join(", ")}`,
      );
    }

    const option: NtfyEventOption = {};
    if (rawOption.priority !== undefined) {
      if (isPriority(rawOption.priority)) {
        option.priority = rawOption.priority as number;
      } else {
        warnings.push(
          `pi-notify: channel "${id}" eventOptions["${eventId}"] priority must be an integer 1-5; ignoring`,
        );
      }
    }
    if ("icon" in rawOption) {
      const icon = parseIcon(
        rawOption.icon,
        warnings,
        `channel "${id}" eventOptions["${eventId}"] icon`,
      );
      if (icon.valid) {
        if (icon.value === null) {
          option.icon = null;
        } else if (icon.value) {
          option.icon = icon.value;
        }
      }
    }
    result[eventId as NotificationEventId] = option;
  }
  return result;
}

function parseIcon(
  value: unknown,
  warnings: string[],
  label: string,
): { valid: boolean; value?: string | null } {
  if (value === null) {
    return { valid: true, value: null };
  }
  if (typeof value === "string" && isHttpUrl(value)) {
    return { valid: true, value };
  }

  warnings.push(`pi-notify: ${label} must be an http(s) URL or null; ignoring`);
  return { valid: false };
}

function parseEventList(
  value: unknown[],
  id: string,
  warnings: string[],
): readonly NotificationEventId[] {
  const events: NotificationEventId[] = [];
  const seen = new Set<NotificationEventId>();
  for (const entry of value) {
    if (!NOTIFICATION_EVENT_IDS.includes(entry as NotificationEventId)) {
      warnings.push(
        `pi-notify: channel "${id}" ignores unknown event "${String(entry)}"`,
      );
      continue;
    }
    const eventId = entry as NotificationEventId;
    if (seen.has(eventId)) {
      warnings.push(
        `pi-notify: channel "${id}" ignores duplicate event "${eventId}"`,
      );
      continue;
    }
    seen.add(eventId);
    events.push(eventId);
  }
  return events;
}

function loadConfigLayer(
  path: string,
  label: string,
  warnings: string[],
): unknown | undefined {
  const { raw, error } = readConfigFile(path);
  if (error) {
    warnings.push(
      `pi-notify: ignored ${label} config (unreadable or invalid JSON)`,
    );
    return undefined;
  }
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    warnings.push(`pi-notify: ignored ${label} config (must be an object)`);
    return undefined;
  }
  if (raw.version !== undefined && raw.version !== 1) {
    warnings.push(
      `pi-notify: ignored ${label} config (unsupported version ${JSON.stringify(raw.version)})`,
    );
    return undefined;
  }

  const conflicts = collectChannelIdConflicts(raw);
  for (const conflictId of conflicts) {
    warnings.push(
      `pi-notify: ${label} config has duplicate channel id "${conflictId}"; keeping the first entry`,
    );
  }
  return dedupeChannels(raw, conflicts);
}

function dedupeChannels(
  raw: Record<string, unknown>,
  conflicts: string[],
): unknown {
  if (conflicts.length === 0 || !Array.isArray(raw.channels)) {
    return raw;
  }

  const seen = new Set<string>();
  const result: Record<string, unknown> = { ...raw };
  result.channels = raw.channels.filter((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      return true;
    }
    if (!conflicts.includes(entry.id)) {
      return true;
    }
    // Keep only the first occurrence of a conflicting id.
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
  return result;
}

function parseBoolean(
  value: unknown,
  label: string,
  warnings: string[],
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }

  warnings.push(`pi-notify: ${label} must be a boolean; using ${fallback}`);
  return fallback;
}

function parseProtocol(
  value: unknown,
  warnings: string[],
): NotificationProtocol | undefined {
  if (
    typeof value === "string" &&
    NOTIFICATION_PROTOCOLS.includes(value as NotificationProtocol)
  ) {
    return value as NotificationProtocol;
  }
  if (value !== undefined) {
    warnings.push(
      `pi-notify: invalid notification protocol ${JSON.stringify(value)}; using fallback`,
    );
  }
  return undefined;
}

function recordString(
  value: unknown,
  warnings: string[],
  label: string,
): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value !== undefined) {
    warnings.push(`pi-notify: ${label} must be a non-empty string`);
  }
  return undefined;
}

function isPriority(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

function isPositiveFiniteInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isValidTopic(value: string): boolean {
  return value.length <= 64 && /^[-_A-Za-z0-9]+$/.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * ntfy server URLs must not carry a query string or fragment: the topic is
 * appended as a path segment, so `?`/`#` would redirect it into the query
 * or fragment and silently target the wrong endpoint. Icons are not
 * restricted this way (never path-concatenated).
 */
function isNtfyServerUrl(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function unknownKeys(
  value: Record<string, unknown>,
  known: Set<string>,
): string[] {
  return Object.keys(value).filter((key) => !known.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
