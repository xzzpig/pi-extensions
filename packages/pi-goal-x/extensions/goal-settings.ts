/**
 * Layered global goal settings (clean rewrite of PR #27).
 *
 * Resolution order (per leaf):
 *
 *     environment > project layer > global layer > defaults
 *
 * Fork note: completion-auditor settings live in the nested "auditor" group
 * (agent, provider/model/thinkingLevel, timeout, prompt injections, and
 * definition-level customizations merged into the runtime-registered default
 * goal-auditor). The pre-0.8.0 flat keys (auditorAgent, auditorTimeoutMs,
 * provider, model, thinkingLevel, disabled, changeManifest, changeManifestDepth)
 * keep parsing as deprecated aliases of their auditor.* leaves; the nested
 * spelling always wins within the same file.
 *
 * Files:
 *
 *     global:  ${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-goal-x-settings.json
 *     project: <cwd>/.pi/pi-goal-x-settings.json
 *
 * Overrides: PI_GOAL_GLOBAL_SETTINGS_FILE, PI_GOAL_SETTINGS_FILE, and the
 * per-setting PI_GOAL_* variables.
 *
 * Two distinct types (never one interface for both): GoalSettingsLayer is the
 * SPARSE file content (booleans tri-state, 0 meaningful); GoalSettings is the
 * RESOLVED runtime value with concrete defaults. Layer files are parsed into
 * diagnostics rather than rejected wholesale — unknown keys are reported, and
 * every valid known key still applies.
 *
 * Mutations go through mutateSettingsLayer(): fresh re-read under a filesystem
 * path lock, structured-clone apply, atomic same-dir temp+rename write with
 * mode preservation — concurrent processes never lose each other's keys.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_AUDITOR_AGENT = "goal-auditor";
/**
 * Built-in completion-audit wall-clock cap: 30 minutes. Single source of
 * truth shared by the settings introspection display and the auditor's
 * TERMINAL_TIMEOUT_MS fallback so the displayed default can never drift
 * from the enforced one.
 */
export const DEFAULT_AUDITOR_TIMEOUT_MS = 30 * 60_000;
/**
 * Node.js setTimeout ceiling (2^31 - 1): values above it overflow the timer
 * and fire almost immediately, so auditorTimeoutMs rejects them outright.
 */
export const MAX_AUDITOR_TIMEOUT_MS = 2_147_483_647;
export const AUDITOR_PROJECT_RESOURCES_MIGRATION_NOTICE = "auditorProjectResources is deprecated and ignored. Configure the selected auditor agent's extensions, subagentOnlyExtensions, skills, and tools instead.";

// ── nested completion-auditor settings ──────────────────────────────────────

/** Upper bound for free-text auditor prompt injections (characters). */
export const MAX_AUDITOR_TEXT_LENGTH = 16_384;
/** Upper bound for reportFormat / feedbackNotes (characters). */
export const MAX_AUDITOR_SHORT_TEXT_LENGTH = 4_096;
/** Upper bound for auditor string-list fields (items per list). */
export const MAX_AUDITOR_LIST_ITEMS = 32;
/** Upper bound for each item in an auditor string-list field (characters). */
export const MAX_AUDITOR_LIST_ITEM_LENGTH = 2_048;
/** Upper bound for auditor profile-selector names (mirrors pi-subagents' grammar). */
export const MAX_AUDITOR_PROFILE_NAME_LENGTH = 128;

export const AUDITOR_STRICTNESS_LEVELS = ["balanced", "strict", "lenient"] as const;
export type AuditorStrictness = (typeof AUDITOR_STRICTNESS_LEVELS)[number];

/**
 * Nested completion-auditor settings. Sparse everywhere: every field optional,
 * absent = default behavior. Three effect tiers:
 *
 *   - request tier (read per audit, effective immediately): agent, provider,
 *     model, thinkingLevel, timeoutMs, disabled, changeManifest,
 *     changeManifestDepth, warmContext;
 *   - prompt-injection tier (read per audit, effective immediately):
 *     checklist, checklistExtra, evidenceRequests, strictness, instructions,
 *     reportFormat, feedbackNotes;
 *   - definition tier (read at default-auditor registration; needs a new
 *     session or /reload): systemPromptExtra, extensions,
 *     subagentOnlyExtensions, skills, skillPath, tools, excludeTools,
 *     mcpDirectTools, defaultReads, inheritProjectContext, inheritSkills,
 *     sandbox, permissionProfile.
 */
export interface GoalAuditorSettings {
	// ── request tier ──
	/** Turn the independent completion review off (default false). */
	disabled?: boolean;
	/** pi-subagents agent used for the review; defaults to goal-auditor. */
	agent?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Completion-audit wall-clock cap in milliseconds (1..2_147_483_647). */
	timeoutMs?: number;
	changeManifest?: "auto" | "off";
	changeManifestDepth?: number;
	/** Inject parent-rendered ledger/turn warm context into the audit (default true). */
	warmContext?: boolean;
	// ── prompt-injection tier ──
	/** Free-text operator instructions, injected as an <operator_instructions> block. */
	instructions?: string;
	/** Replaces the built-in audit checklist when set (protocol tail is always kept). */
	checklist?: string[];
	/** Appends items after the (default or replaced) checklist. */
	checklistExtra?: string[];
	/** Evidence the operator asks the auditor to collect proactively. */
	evidenceRequests?: string[];
	/** Posture preset mapped to injected text; "balanced" injects nothing. */
	strictness?: AuditorStrictness;
	/** Report structure/language/length requirements. */
	reportFormat?: string;
	/** Fixed operator note appended to the rejection feedback shown to the executor. */
	feedbackNotes?: string;
	// ── definition tier ──
	/** Appended to the default auditor's system prompt at registration time. */
	systemPromptExtra?: string;
	extensions?: string[];
	/** Unioned with the required child-only progress provider. */
	subagentOnlyExtensions?: string[];
	skills?: string[];
	skillPath?: string[];
	/** Replaces the ordinary tool allowlist (report_auditor_progress is retained). */
	tools?: string[];
	/** Removed from the effective allowlist after tools replacement. */
	excludeTools?: string[];
	mcpDirectTools?: string[];
	defaultReads?: string[];
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	/**
	 * Named pi-sandbox profile selector for the default auditor's native child
	 * (pi-subagents fork). Validated scalar selector only — the actual
	 * network/filesystem rules live in the global pi-sandbox config.
	 */
	sandbox?: string;
	/**
	 * Named pi-permission-system permission profile selector for the default
	 * auditor's native child (pi-subagents fork). Validated scalar selector
	 * only — the actual rules live in pi-permission-system's global profiles
	 * registry.
	 */
	permissionProfile?: string;
}

// ── sparse keybinding layers ────────────────────────────────────────────────

export interface GoalDashboardKeybindings {
	toggleExpand: KeyId;
	scrollUp: KeyId;
	scrollDown: KeyId;
}

/** Sparse dashboard keybindings: only overridden leaves are present. */
export interface GoalDashboardKeybindingsLayer {
	toggleExpand?: KeyId;
	scrollUp?: KeyId;
	scrollDown?: KeyId;
}

export interface GoalKeybindings {
	dashboard: GoalDashboardKeybindings;
}

export interface GoalKeybindingsLayer {
	dashboard?: GoalDashboardKeybindingsLayer;
}

export const DEFAULT_GOAL_KEYBINDINGS: GoalKeybindings = {
	dashboard: {
		toggleExpand: "ctrl+shift+t",
		scrollUp: "ctrl+shift+up",
		scrollDown: "ctrl+shift+down",
	},
};

/**
 * Default ceiling for a single recovery delay; the escalation ladder
 * plateaus here. Configurable via networkRecovery.maxDelayMs.
 */
export const DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS = 80_000;

/** Default downward scan depth for unregistered nested repositories. */
export const DEFAULT_CHANGE_MANIFEST_DEPTH = 1;

export function formatGoalKeybinding(key: string): string {
	return key.split("+").map((part) => ({
		ctrl: "Ctrl",
		control: "Ctrl",
		shift: "Shift",
		alt: "Alt",
		up: "↑",
		down: "↓",
		left: "←",
		right: "→",
		pageup: "PageUp",
		pagedown: "PageDown",
		home: "Home",
		end: "End",
		enter: "Enter",
		escape: "Esc",
	}[part.toLowerCase()] ?? part.toUpperCase())).join("+");
}

// ── resolved settings (runtime shape) ───────────────────────────────────────

export interface GoalSettingsResolvedShape {
	disableTasks?: boolean;
	disableContracts?: boolean;
	subtaskDepth?: number;
	/**
	 * Nested completion-auditor settings. The resolved runtime value always
	 * carries agent/disabled/changeManifest/changeManifestDepth/warmContext/
	 * strictness with concrete defaults; every other leaf is present only when
	 * configured (absent = default behavior). The pre-0.8.0 flat keys
	 * (auditorAgent, auditorTimeoutMs, provider, model, thinkingLevel,
	 * disabled, changeManifest, changeManifestDepth) parse as deprecated
	 * aliases into this group and no longer exist on the resolved shape.
	 */
	auditor?: GoalAuditorSettings;
	autoSelectSingleGoal?: boolean;
	/** @deprecated Retained for compatibility only; auditor resources now come from the selected agent definition. */
	auditorProjectResources?: boolean;
	/** F5: stall detector timeout in minutes (0 = off). */
	stallTimeoutMinutes?: number;
	/** Optional extension-run limit per creation/resume; zero disables, absent inherits (default unlimited). */
	maxAutonomousRuns?: number;
	strictExecutionContract?: boolean;
	/**
	 * Maximum objective length in characters (0/unset = no limit, the
	 * default; >0 caps objectives in create_goal, propose_goal_draft, and
	 * /goal-tweak).
	 */
	objectiveMaxChars?: number;
	/** Keyboard shortcuts for the compact task list and dashboard expansion. */
	keybindings?: GoalKeybindings;
	/** PR #29: suppress the unfocused goal widget + status hint (default false). */
	hideUnfocusedBanner?: boolean;
	/**
	 * Workspace change manifest for the completion audit: "auto" (default)
	 * collects a git-snapshot manifest for the repositories the goal touched;
	 * "off" disables collection entirely, leaving audit input byte-for-byte
	 * identical to the pre-manifest behavior. Invalid values fall back to
	 * "auto".
	 */
	/** Issue #26: opt-in read-only blocker Oracle configuration (sparse). */
	oracle?: GoalOracleSettingsLayer;
	/**
	 * Goal-level provider-error recovery backoff (sparse). maxAttempts 0 or
	 * unset = unbounded retry (default); maxDelayMs caps the delay plateau.
	 */
	networkRecovery?: GoalNetworkRecoverySettingsLayer;
}

// Resolved Oracle settings are attached to the resolved runtime shape below
// (see ResolvedGoalOracleSettings).

/**
 * Issue #26: sparse per-leaf Oracle settings. Every leaf inherits
 * independently (project > global > default); enabled defaults false.
 */
export interface GoalOracleSettingsLayer {
	enabled?: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	projectResources?: boolean;
	maxFailedAttemptsPerBlocker?: number;
}

export interface ResolvedGoalOracleSettings {
	enabled: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	projectResources: boolean;
	maxFailedAttemptsPerBlocker: number;
}

/** Sparse per-leaf network-recovery settings (maxAttempts 0 = unbounded). */
export interface GoalNetworkRecoverySettingsLayer {
	maxAttempts?: number;
	maxDelayMs?: number;
}

/** Resolved network-recovery settings (concrete defaults). */
export interface ResolvedGoalNetworkRecoverySettings {
	maxAttempts: number;
	maxDelayMs: number;
}

/**
 * Sparse settings layer: exactly what a settings FILE may contain. Every
 * field optional; explicit false/0 preserved so lower layers can override
 * higher ones. Never passed to prompt/runtime code — that consumes the
 * resolved GoalSettings below.
 */
export interface GoalSettingsLayer extends GoalSettingsResolvedShape {}

/**
 * Fully resolved runtime settings (defaults filled). Exported as an alias for
 * compatibility: all existing consumers keep importing GoalSettings.
 */
export interface ResolvedGoalSettingsShape extends GoalSettingsResolvedShape {
	/** Issue #26: resolved opt-in blocker Oracle configuration. */
	oracle?: ResolvedGoalOracleSettings;
	/** Resolved goal-level provider-error recovery configuration. */
	networkRecovery?: ResolvedGoalNetworkRecoverySettings;
}

export type ResolvedGoalSettings = ResolvedGoalSettingsShape;

/** Compatibility alias: runtime code keeps importing GoalSettings. */
export type GoalSettings = ResolvedGoalSettings;

export const PI_GOAL_SETTINGS_FILE_ENV = "PI_GOAL_SETTINGS_FILE";
export const PI_GOAL_GLOBAL_SETTINGS_FILE_ENV = "PI_GOAL_GLOBAL_SETTINGS_FILE";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CHANGE_MANIFEST_MODES = new Set(["auto", "off"]);

// ── pure path resolution ────────────────────────────────────────────────────

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolve the pi agent dir honoring PI_CODING_AGENT_DIR (absolute or ~-relative to homeDir). */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
	const override = asNonEmptyString(env.PI_CODING_AGENT_DIR);
	if (override) {
		return path.isAbsolute(override) ? path.normalize(override) : path.resolve(homeDir, override);
	}
	return path.join(homeDir, ".pi", "agent");
}

/**
 * Global settings path: PI_GOAL_GLOBAL_SETTINGS_FILE if set (absolute or
 * relative to homeDir), else <agentDir>/pi-goal-x-settings.json.
 */
export function goalGlobalSettingsPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
	const override = asNonEmptyString(env[PI_GOAL_GLOBAL_SETTINGS_FILE_ENV]);
	if (override) {
		return path.isAbsolute(override) ? path.normalize(override) : path.resolve(homeDir, override);
	}
	return path.join(resolveAgentDir(env, homeDir), "pi-goal-x-settings.json");
}

/**
 * Project settings path: PI_GOAL_SETTINGS_FILE if set (absolute or relative
 * to cwd), else <cwd>/.pi/pi-goal-x-settings.json.
 */
export function goalSettingsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = asNonEmptyString(env[PI_GOAL_SETTINGS_FILE_ENV]);
	if (override) {
		return path.isAbsolute(override) ? override : path.join(cwd, override);
	}
	return path.join(cwd, ".pi", "pi-goal-x-settings.json");
}

// ── diagnostics ─────────────────────────────────────────────────────────────

export type SettingsScope = "global" | "project";

export type SettingsDiagnosticCode =
	| "invalid_json"
	| "not_object"
	| "unknown_key"
	| "invalid_value"
	| "invalid_nested_key";

export interface SettingsDiagnostic {
	scope: SettingsScope;
	path: string;
	settingPath?: string;
	code: SettingsDiagnosticCode;
	message: string;
}

export interface SettingsLayerRead {
	scope: SettingsScope;
	path: string;
	status: "ok" | "missing" | "invalid";
	layer: GoalSettingsLayer;
	diagnostics: SettingsDiagnostic[];
	fingerprint: string;
}

// ── zero-op cache ───────────────────────────────────────────────────────────

interface SettingsFileCacheEntry {
	/** Missing/malformed file: cached so repeated loads are zero-op too. */
	missing?: boolean;
	read?: SettingsLayerRead;
}

const settingsFileCache = new Map<string, SettingsFileCacheEntry>();

/**
 * Session boundary (session_start / resume): drop the zero-op settings cache
 * so a new session always reads both layers fresh from disk.
 */
export function invalidateGoalSettingsCache(): void {
	settingsFileCache.clear();
	resolvedSettingsCache.length = 0;
}

function invalidateSettingsCachePath(target: string): void {
	settingsFileCache.delete(target);
	resolvedSettingsCache.length = 0;
}

// ── leaf parsers (diagnostic-producing, never throwing) ─────────────────────

function asBool(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	if (typeof value === "string") {
		const n = parseInt(value, 10);
		if (!isNaN(n) && n >= 1) return n;
	}
	return undefined;
}

/** Positive-integer-or-zero parser (for settings where 0 = off / no limit). */
function asNonNegativeInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	if (typeof value === "string") {
		const n = parseInt(value, 10);
		if (!isNaN(n) && n >= 0) return n;
	}
	return undefined;
}

/** Positive-integer parser capped at the Node.js timer ceiling. */
function asTimerSafePositiveInt(value: unknown): number | undefined {
	const parsed = asPositiveInt(value);
	if (parsed === undefined || parsed > MAX_AUDITOR_TIMEOUT_MS) return undefined;
	return parsed;
}

function asKeybinding(value: unknown): KeyId | undefined {
	const key = asNonEmptyString(value);
	if (!key) return undefined;
	return key as KeyId;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}

function asChangeManifestMode(value: unknown): "auto" | "off" | undefined {
	const text = asNonEmptyString(value);
	return text && CHANGE_MANIFEST_MODES.has(text) ? text as "auto" | "off" : undefined;
}

function asStrictness(value: unknown): AuditorStrictness | undefined {
	const text = asNonEmptyString(value);
	return text && (AUDITOR_STRICTNESS_LEVELS as readonly string[]).includes(text) ? text as AuditorStrictness : undefined;
}

/** Bounded free-text leaf: trimmed, non-empty, length-capped. */
function asBoundedText(value: unknown, maxLength: number): { text?: string; error?: string } {
	if (typeof value !== "string" || !value.trim()) return { error: "must be a non-empty string" };
	const text = value.trim();
	if (text.length > maxLength) return { error: `must be at most ${maxLength} characters` };
	return { text };
}

/**
 * Profile-selector leaf (auditor.sandbox / auditor.permissionProfile): a
 * validated scalar selector mirroring pi-subagents' fork grammar for sandbox
 * / permission profile names (safe identifier, no surrounding whitespace,
 * never the literal "false", capped at MAX_AUDITOR_PROFILE_NAME_LENGTH). Only
 * the bare name is accepted — inline policy or path components are rejected.
 */
function asProfileName(value: unknown): { name?: string; error?: string } {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		return { error: "must be a non-empty profile name without surrounding whitespace" };
	}
	if (value === "false") return { error: "must select a named profile; the literal false is not supported" };
	if (value.length > MAX_AUDITOR_PROFILE_NAME_LENGTH) {
		return { error: `must be at most ${MAX_AUDITOR_PROFILE_NAME_LENGTH} characters` };
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
		return { error: "must contain only letters, digits, underscores, or hyphens and start with a letter or digit" };
	}
	return { name: value };
}

/** Bounded string-list leaf: arrays of trimmed non-empty strings, size-capped. */
function asBoundedStringList(value: unknown, itemMaxLength: number): { items?: string[]; error?: string } {
	if (!Array.isArray(value)) return { error: "must be an array of strings" };
	if (value.length > MAX_AUDITOR_LIST_ITEMS) return { error: `must contain at most ${MAX_AUDITOR_LIST_ITEMS} items` };
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !entry.trim()) return { error: "must be an array of non-empty strings" };
		const text = entry.trim();
		if (text.length > itemMaxLength) return { error: `each item must be at most ${itemMaxLength} characters` };
		items.push(text);
	}
	return { items };
}

const ALLOWED_NETWORK_RECOVERY_KEYS = new Set(["maxAttempts", "maxDelayMs"]);
const ALLOWED_ORACLE_KEYS = new Set([
	"enabled",
	"provider",
	"model",
	"thinkingLevel",
	"thinking_level",
	"projectResources",
	"maxFailedAttemptsPerBlocker",
]);

const ALLOWED_KEYBINDING_KEYS = new Set(["dashboard"]);
const ALLOWED_DASHBOARD_KEYBINDING_KEYS = new Set(["toggleExpand", "scrollUp", "scrollDown"]);

/**
 * Parse raw JSON content into a sparse layer plus diagnostics. Unknown keys
 * and invalid values produce diagnostics; they never erase valid known keys
 * in the same file, and this never throws for content problems.
 */
export function parseSettingsLayer(
	raw: unknown,
	scope: SettingsScope,
	filePath: string,
): { layer: GoalSettingsLayer; diagnostics: SettingsDiagnostic[] } {
	const diagnostics: SettingsDiagnostic[] = [];
	const diagnostic = (
		code: SettingsDiagnosticCode,
		message: string,
		settingPath?: string,
	): SettingsDiagnostic => ({ scope, path: filePath, settingPath, code, message });

	if (raw === null || raw === undefined) return { layer: {}, diagnostics };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push(diagnostic("not_object", "settings file must contain a JSON object"));
		return { layer: {}, diagnostics };
	}
	const record = raw as Record<string, unknown>;
	const layer: GoalSettingsLayer = {};
	// Deprecated flat aliases accumulate here and merge UNDER the nested
	// auditor group after the loop, so the nested spelling wins within the
	// same file regardless of key order.
	const legacyAuditor: GoalAuditorSettings = {};

	for (const [key, value] of Object.entries(record)) {
		switch (key) {
			case "strictExecutionContract":
			case "disableTasks":
			case "disableContracts":
			case "autoSelectSingleGoal":
			case "auditorProjectResources":
			case "hideUnfocusedBanner": {
				const parsed = asBool(value);
				if (parsed === undefined) {
					if (value !== undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be true or false`, key));
				} else {
					layer[key] = parsed;
				}
				break;
			}
			case "disabled": {
				const parsed = asBool(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be true or false`, key));
				else legacyAuditor.disabled = parsed;
				break;
			}
			case "subtaskDepth": {
				const parsed = asPositiveInt(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be an integer >= 1`, key));
				else layer.subtaskDepth = parsed;
				break;
			}
			case "maxAutonomousRuns": {
				const n = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value) : NaN;
				if (!Number.isSafeInteger(n) || n < 0) diagnostics.push(diagnostic("invalid_value", "maxAutonomousRuns must be a nonnegative safe integer (0 disables automatic continuation)", key));
				else layer.maxAutonomousRuns = n;
				break;
			}
			case "stallTimeoutMinutes":
			case "objectiveMaxChars": {
				const parsed = asNonNegativeInt(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be an integer >= 0`, key));
				else layer[key] = parsed;
				break;
			}
			case "changeManifest": {
				const parsed = asChangeManifestMode(value);
				if (parsed === undefined) {
					diagnostics.push(diagnostic("invalid_value", `${key} must be one of: auto, off`, key));
				} else {
					legacyAuditor.changeManifest = parsed;
				}
				break;
			}
			case "changeManifestDepth": {
				const parsed = asNonNegativeInt(value);
				if (parsed === undefined) {
					diagnostics.push(diagnostic("invalid_value", `${key} must be an integer >= 0 (0 = no downward scan)`, key));
				} else {
					legacyAuditor.changeManifestDepth = parsed;
				}
				break;
			}
			case "auditorTimeoutMs": {
				const parsed = asTimerSafePositiveInt(value);
				if (parsed === undefined) {
					diagnostics.push(diagnostic("invalid_value", `${key} must be an integer between 1 and ${MAX_AUDITOR_TIMEOUT_MS} (milliseconds)`, key));
				} else {
					legacyAuditor.timeoutMs = parsed;
				}
				break;
			}
			case "provider":
			case "model": {
				const parsed = asNonEmptyString(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be a non-empty string`, key));
				else legacyAuditor[key] = parsed;
				break;
			}
			case "auditorAgent": {
				const parsed = asNonEmptyString(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be a non-empty string`, key));
				else legacyAuditor.agent = parsed;
				break;
			}
			case "thinkingLevel":
			case "thinking_level": {
				const parsed = asThinkingLevel(value);
				if (parsed === undefined) {
					diagnostics.push(diagnostic("invalid_value", `${key} must be one of: ${[...THINKING_LEVELS].join(", ")}`, key));
				} else {
					legacyAuditor.thinkingLevel = parsed;
				}
				break;
			}
			case "auditor": {
				const parsed = parseAuditorSettingsLayer(value, diagnostic);
				if (parsed.fields) layer.auditor = parsed.fields;
				diagnostics.push(...parsed.diagnostics);
				break;
			}
			case "keybindings": {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					diagnostics.push(diagnostic("invalid_nested_key", "keybindings must be an object", key));
					break;
				}
				const kbRecord = value as Record<string, unknown>;
				const sparse: GoalKeybindingsLayer = {};
				for (const [kbKey, kbValue] of Object.entries(kbRecord)) {
					if (!ALLOWED_KEYBINDING_KEYS.has(kbKey)) {
						diagnostics.push(diagnostic("unknown_key", `unknown keybindings key: ${kbKey}`, `keybindings.${kbKey}`));
						continue;
					}
					if (kbKey !== "dashboard") continue;
					if (!kbValue || typeof kbValue !== "object" || Array.isArray(kbValue)) {
						diagnostics.push(diagnostic("invalid_nested_key", "keybindings.dashboard must be an object", "keybindings.dashboard"));
						continue;
					}
					const dash: GoalDashboardKeybindingsLayer = {};
					for (const [dashKey, dashValue] of Object.entries(kbValue as Record<string, unknown>)) {
						if (!ALLOWED_DASHBOARD_KEYBINDING_KEYS.has(dashKey)) {
							diagnostics.push(diagnostic("unknown_key", `unknown dashboard keybinding: ${dashKey}`, `keybindings.dashboard.${dashKey}`));
							continue;
						}
						const bound = asKeybinding(dashValue);
						if (bound === undefined) {
							diagnostics.push(diagnostic("invalid_value", `${dashKey} must be a non-empty key id`, `keybindings.dashboard.${dashKey}`));
							continue;
						}
						dash[dashKey as keyof GoalDashboardKeybindingsLayer] = bound;
					}
					sparse.dashboard = dash;
				}
				// SAFETY: `sparse` is built key-by-key above through the validated
				// parse/normalize path, so its runtime shape is a GoalKeybindings.
				layer.keybindings = sparse as unknown as GoalKeybindings;
				break;
			}
			case "oracle": {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					diagnostics.push(diagnostic("invalid_nested_key", "oracle must be an object", key));
					break;
				}
				const oracleRecord = value as Record<string, unknown>;
				const oracle: GoalOracleSettingsLayer = {};
				for (const [oKey, oValue] of Object.entries(oracleRecord)) {
					if (!ALLOWED_ORACLE_KEYS.has(oKey)) {
						diagnostics.push(diagnostic("unknown_key", `unknown oracle key: ${oKey}`, `oracle.${oKey}`));
						continue;
					}
					switch (oKey) {
						case "enabled":
						case "projectResources": {
							const parsed = asBool(oValue);
							if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `oracle.${oKey} must be true or false`, `oracle.${oKey}`));
							else oracle[oKey] = parsed;
							break;
						}
						case "provider":
						case "model": {
							const parsed = asNonEmptyString(oValue);
							if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `oracle.${oKey} must be a non-empty string`, `oracle.${oKey}`));
							else oracle[oKey] = parsed;
							break;
						}
						case "thinkingLevel":
						case "thinking_level": {
							const parsed = asThinkingLevel(oValue);
							if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `oracle.${oKey} must be one of: ${[...THINKING_LEVELS].join(", ")}`, `oracle.${oKey}`));
							else oracle.thinkingLevel = parsed;
							break;
						}
						case "maxFailedAttemptsPerBlocker": {
							const parsed = asPositiveInt(oValue);
							if (parsed === undefined || parsed > 3) {
								diagnostics.push(diagnostic("invalid_value", "oracle.maxFailedAttemptsPerBlocker must be an integer between 1 and 3", `oracle.${oKey}`));
							} else {
								oracle.maxFailedAttemptsPerBlocker = parsed;
							}
							break;
						}
					}
				}
				layer.oracle = oracle;
				break;
			}
			case "networkRecovery": {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					diagnostics.push(diagnostic("invalid_nested_key", "networkRecovery must be an object", key));
					break;
				}
				const nrRecord = value as Record<string, unknown>;
				const nr: GoalNetworkRecoverySettingsLayer = {};
				for (const [nKey, nValue] of Object.entries(nrRecord)) {
					if (!ALLOWED_NETWORK_RECOVERY_KEYS.has(nKey)) {
						diagnostics.push(diagnostic("unknown_key", `unknown networkRecovery key: ${nKey}`, `networkRecovery.${nKey}`));
						continue;
					}
					if (nKey === "maxAttempts") {
						const parsed = asNonNegativeInt(nValue);
						if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", "networkRecovery.maxAttempts must be an integer >= 0 (0 = unbounded)", `networkRecovery.${nKey}`));
						else nr.maxAttempts = parsed;
					} else {
						const parsed = asNonNegativeInt(nValue);
						if (parsed === undefined || parsed < 1_000) diagnostics.push(diagnostic("invalid_value", "networkRecovery.maxDelayMs must be an integer >= 1000", `networkRecovery.${nKey}`));
						else nr.maxDelayMs = parsed;
					}
				}
				if (Object.keys(nr).length > 0) layer.networkRecovery = nr;
				break;
			}
			default:
				diagnostics.push(diagnostic("unknown_key", `unknown settings key: ${key}`, key));
				break;
		}
	}
	if (Object.keys(legacyAuditor).length > 0) {
		layer.auditor = { ...legacyAuditor, ...layer.auditor };
	}
	return { layer, diagnostics };
}

const ALLOWED_AUDITOR_KEYS = new Set([
	// request tier
	"disabled",
	"agent",
	"provider",
	"model",
	"thinkingLevel",
	"thinking_level",
	"timeoutMs",
	"changeManifest",
	"changeManifestDepth",
	"warmContext",
	// prompt-injection tier
	"instructions",
	"checklist",
	"checklistExtra",
	"evidenceRequests",
	"reportFormat",
	"strictness",
	"feedbackNotes",
	// definition tier
	"systemPromptExtra",
	"extensions",
	"subagentOnlyExtensions",
	"skills",
	"skillPath",
	"tools",
	"excludeTools",
	"mcpDirectTools",
	"defaultReads",
	"inheritProjectContext",
	"inheritSkills",
	"sandbox",
	"permissionProfile",
]);

/**
 * Parse the nested "auditor" settings group. Diagnostics never erase valid
 * sibling leaves, and this never throws for content problems.
 */
function parseAuditorSettingsLayer(
	raw: unknown,
	diagnostic: (code: SettingsDiagnosticCode, message: string, settingPath?: string) => SettingsDiagnostic,
): { fields?: GoalAuditorSettings; diagnostics: SettingsDiagnostic[] } {
	const diagnostics: SettingsDiagnostic[] = [];
	if (raw === null || raw === undefined) return { diagnostics };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push(diagnostic("invalid_nested_key", "auditor must be an object", "auditor"));
		return { diagnostics };
	}
	const record = raw as Record<string, unknown>;
	const fields: GoalAuditorSettings = {};
	const path = (leaf: string): string => `auditor.${leaf}`;

	for (const [key, value] of Object.entries(record)) {
		if (!ALLOWED_AUDITOR_KEYS.has(key)) {
			diagnostics.push(diagnostic("unknown_key", `unknown auditor key: ${key}`, path(key)));
			continue;
		}
		switch (key) {
			case "disabled":
			case "warmContext":
			case "inheritProjectContext":
			case "inheritSkills": {
				const parsed = asBool(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `auditor.${key} must be true or false`, path(key)));
				else fields[key] = parsed;
				break;
			}
			case "strictness": {
				const parsed = asStrictness(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `auditor.${key} must be one of: ${AUDITOR_STRICTNESS_LEVELS.join(", ")}`, path(key)));
				else fields.strictness = parsed;
				break;
			}
			case "changeManifest": {
				const parsed = asChangeManifestMode(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `auditor.${key} must be one of: auto, off`, path(key)));
				else fields.changeManifest = parsed;
				break;
			}
			case "changeManifestDepth": {
				const parsed = asNonNegativeInt(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `auditor.${key} must be an integer >= 0 (0 = no downward scan)`, path(key)));
				else fields.changeManifestDepth = parsed;
				break;
			}
			case "timeoutMs": {
				const parsed = asTimerSafePositiveInt(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `auditor.${key} must be an integer between 1 and ${MAX_AUDITOR_TIMEOUT_MS} (milliseconds)`, path(key)));
				else fields.timeoutMs = parsed;
				break;
			}
			case "thinkingLevel":
			case "thinking_level": {
				const parsed = asThinkingLevel(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `auditor.${key} must be one of: ${[...THINKING_LEVELS].join(", ")}`, path(key)));
				else fields.thinkingLevel = parsed;
				break;
			}
			case "agent":
			case "provider":
			case "model": {
				const parsed = asBoundedText(value, MAX_AUDITOR_SHORT_TEXT_LENGTH);
				if (parsed.error) diagnostics.push(diagnostic("invalid_value", `auditor.${key} ${parsed.error}`, path(key)));
				else fields[key] = parsed.text;
				break;
			}
			case "instructions":
			case "systemPromptExtra": {
				const parsed = asBoundedText(value, MAX_AUDITOR_TEXT_LENGTH);
				if (parsed.error) diagnostics.push(diagnostic("invalid_value", `auditor.${key} ${parsed.error}`, path(key)));
				else fields[key] = parsed.text;
				break;
			}
			case "reportFormat":
			case "feedbackNotes": {
				const parsed = asBoundedText(value, MAX_AUDITOR_SHORT_TEXT_LENGTH);
				if (parsed.error) diagnostics.push(diagnostic("invalid_value", `auditor.${key} ${parsed.error}`, path(key)));
				else fields[key] = parsed.text;
				break;
			}
			case "sandbox":
			case "permissionProfile": {
				const parsed = asProfileName(value);
				if (parsed.error) diagnostics.push(diagnostic("invalid_value", `auditor.${key} ${parsed.error}`, path(key)));
				else fields[key] = parsed.name;
				break;
			}
			case "checklist":
			case "checklistExtra":
			case "evidenceRequests":
			case "extensions":
			case "subagentOnlyExtensions":
			case "skills":
			case "skillPath":
			case "tools":
			case "excludeTools":
			case "mcpDirectTools":
			case "defaultReads": {
				const parsed = asBoundedStringList(value, MAX_AUDITOR_LIST_ITEM_LENGTH);
				if (parsed.error) diagnostics.push(diagnostic("invalid_value", `auditor.${key} ${parsed.error}`, path(key)));
				else fields[key] = parsed.items;
				break;
			}
		}
	}
	if (Object.keys(fields).length === 0) return { diagnostics };
	return { fields, diagnostics };
}

/**
 * Legacy strict parse: throws on unknown keys. Kept for callers that want
 * fail-closed parsing of a whole known-shape object (e.g. tests); layered
 * loading uses parseSettingsLayer instead.
 */
export function parseGoalSettings(raw: unknown): GoalSettings {
	const { layer, diagnostics } = parseSettingsLayer(raw, "project", "(inline)");
	const unknown = diagnostics
		.filter((d) => d.code === "unknown_key" && d.settingPath && !d.settingPath.includes("."))
		.map((d) => d.settingPath!);
	if (unknown.length > 0) throw new Error(`Unknown pi-goal-x-settings.json key(s): ${unknown.join(", ")}`);
	return layer as GoalSettings;
}

// ── layer reads (cache-served, zero-op steady state) ───────────────────────

function fingerprintOf(text: string): string {
	// Cheap stable fingerprint: length + simple rolling sum (not security).
	let hash = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function statusFor(diagnostics: SettingsDiagnostic[], hadContent: boolean): "ok" | "missing" | "invalid" {
	if (diagnostics.some((d) => d.code === "invalid_json" || d.code === "not_object")) return "invalid";
	if (!hadContent) return "missing";
	return diagnostics.length > 0 ? "invalid" : "ok";
}

function readSettingsLayerFresh(target: string, scope: SettingsScope): SettingsLayerRead {
	let rawText: string | undefined;
	try {
		rawText = fs.readFileSync(target, "utf8");
	} catch {
		const read: SettingsLayerRead = {
			scope,
			path: target,
			status: "missing",
			layer: {},
			diagnostics: [],
			fingerprint: "missing",
		};
		settingsFileCache.set(target, { read });
		return read;
	}
	let parsed: unknown;
	let diagnostics: SettingsDiagnostic[] = [];
	let layer: GoalSettingsLayer = {};
	try {
		parsed = JSON.parse(rawText);
	} catch {
		const read: SettingsLayerRead = {
			scope,
			path: target,
			status: "invalid",
			layer: {},
			diagnostics: [{ scope, path: target, code: "invalid_json", message: "settings file is not valid JSON" }],
			fingerprint: fingerprintOf(rawText),
		};
		settingsFileCache.set(target, { read });
		return read;
	}
	const result = parseSettingsLayer(parsed, scope, target);
	layer = result.layer;
	diagnostics = result.diagnostics;
	const read: SettingsLayerRead = {
		scope,
		path: target,
		status: statusFor(diagnostics, rawText.trim().length > 0),
		layer,
		diagnostics,
		fingerprint: fingerprintOf(rawText),
	};
	settingsFileCache.set(target, { read });
	return read;
}

/** Cache-served layer read (zero-op in steady state). */
export function readSettingsLayer(target: string, scope: SettingsScope): SettingsLayerRead {
	const cached = settingsFileCache.get(target);
	if (cached?.read) return cached.read;
	if (cached?.missing) {
		return { scope, path: target, status: "missing", layer: {}, diagnostics: [], fingerprint: "missing" };
	}
	return readSettingsLayerFresh(target, scope);
}

/** Load just one layer's sparse config (compat helper over readSettingsLayer). */
export function loadGoalSettingsFileConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	return readSettingsLayer(goalSettingsPath(cwd, env), "project").layer as GoalSettings;
}

// ── resolution with provenance ──────────────────────────────────────────────

export type SettingsSource = "environment" | "project" | "global" | "default";

export interface ResolvedSetting<T> {
	value: T;
	source: SettingsSource;
	envVar?: string;
}

export interface SettingsSnapshot {
	global: SettingsLayerRead;
	project: SettingsLayerRead;
	value: ResolvedGoalSettings;
	provenance: Map<string, ResolvedSetting<unknown>>;
	diagnostics: SettingsDiagnostic[];
}

/**
 * Resolve one settings leaf across layers (environment > project > global > default).
 *
 * SAFETY: callers passing `undefined as unknown as T` for defaultValue rely on
 * the runtime contract that only `=== undefined` is checked — no T-typed
 * operation is ever performed on the default, so the cast cannot misbehave.
 */
function resolveLeaf<T>(args: {
	envValue?: T;
	projectValue?: T;
	globalValue?: T;
	defaultValue: T;
	envVar?: string;
}): ResolvedSetting<T> {
	if (args.envValue !== undefined) {
		return { value: args.envValue, source: "environment", envVar: args.envVar };
	}
	if (args.projectValue !== undefined) return { value: args.projectValue, source: "project" };
	if (args.globalValue !== undefined) return { value: args.globalValue, source: "global" };
	return { value: args.defaultValue, source: "default" };
}

function pathKey(...parts: Array<string | undefined>): string {
	return parts.filter((p) => p !== undefined).join(".");
}

/**
 * Resolve both layers + env into one snapshot with per-leaf provenance.
 * Nested keybindings resolve leaf-by-leaf from the SPARSE layers.
 */
const resolutionEnvKeys = ["PI_GOAL_DISABLE_TASKS", "PI_GOAL_DISABLE_CONTRACTS", "PI_GOAL_OBJECTIVE_MAX_CHARS", "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS", "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS"] as const;
const resolvedSettingsCache: Array<{global: SettingsLayerRead; project: SettingsLayerRead; environment: Array<string | undefined>; snapshot: SettingsSnapshot}> = [];

function resolvedSettingsSnapshot(cwd: string, env: NodeJS.ProcessEnv): SettingsSnapshot {
	const globalPath = goalGlobalSettingsPath(env);
	const projectPath = goalSettingsPath(cwd, env);
	const global = readSettingsLayer(globalPath, "global");
	const project = readSettingsLayer(projectPath, "project");
	for (const cached of resolvedSettingsCache) {
		if (cached.global === global && cached.project === project && resolutionEnvKeys.every((key, i) => env[key] === cached.environment[i])) return cached.snapshot;
	}

	const provenance = new Map<string, ResolvedSetting<unknown>>();
	const track = <T>(key: string, resolved: ResolvedSetting<T>): T => {
		provenance.set(key, resolved as ResolvedSetting<unknown>);
		return resolved.value;
	};

	const envBool = (name: string): boolean | undefined =>
		asBool(env[name]);
	const envInt = (name: string): number | undefined =>
		asNonNegativeInt(env[name]);

	const disableTasks = track("disableTasks", resolveLeaf<boolean>({
		envValue: envBool("PI_GOAL_DISABLE_TASKS"),
		projectValue: project.layer.disableTasks,
		globalValue: global.layer.disableTasks,
		defaultValue: false,
		envVar: "PI_GOAL_DISABLE_TASKS",
	}));
	const disableContracts = track("disableContracts", resolveLeaf<boolean>({
		envValue: envBool("PI_GOAL_DISABLE_CONTRACTS"),
		projectValue: project.layer.disableContracts,
		globalValue: global.layer.disableContracts,
		defaultValue: false,
		envVar: "PI_GOAL_DISABLE_CONTRACTS",
	}));
	const subtaskDepth = track("subtaskDepth", resolveLeaf<number>({
		projectValue: project.layer.subtaskDepth,
		globalValue: global.layer.subtaskDepth,
		defaultValue: 1,
	}));
	// SAFETY: an `undefined` defaultValue only feeds resolveLeaf's "no default"
	// branch; the type parameter stays phantom, so no value of T is ever read.
	// (Legacy flat auditor keys were folded into layer.auditor at parse time,
	// so every leaf below reads the merged per-layer value directly.)
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorProvider = track("auditor.provider", resolveLeaf<string>({
		projectValue: project.layer.auditor?.provider,
		globalValue: global.layer.auditor?.provider,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorModel = track("auditor.model", resolveLeaf<string>({
		projectValue: project.layer.auditor?.model,
		globalValue: global.layer.auditor?.model,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorThinkingLevel = track("auditor.thinkingLevel", resolveLeaf<ThinkingLevel>({
		projectValue: project.layer.auditor?.thinkingLevel,
		globalValue: global.layer.auditor?.thinkingLevel,
		defaultValue: undefined as unknown as ThinkingLevel,
	}));
	const auditorAgent = track("auditor.agent", resolveLeaf<string>({
		projectValue: project.layer.auditor?.agent,
		globalValue: global.layer.auditor?.agent,
		defaultValue: DEFAULT_AUDITOR_AGENT,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorTimeoutMs = track("auditor.timeoutMs", resolveLeaf<number>({
		projectValue: project.layer.auditor?.timeoutMs,
		globalValue: global.layer.auditor?.timeoutMs,
		defaultValue: undefined as unknown as number,
	}));
	const auditorDisabled = track("auditor.disabled", resolveLeaf<boolean>({
		projectValue: project.layer.auditor?.disabled,
		globalValue: global.layer.auditor?.disabled,
		defaultValue: false,
	}));
	const auditorWarmContext = track("auditor.warmContext", resolveLeaf<boolean>({
		projectValue: project.layer.auditor?.warmContext,
		globalValue: global.layer.auditor?.warmContext,
		defaultValue: true,
	}));
	const auditorStrictness = track("auditor.strictness", resolveLeaf<AuditorStrictness>({
		projectValue: project.layer.auditor?.strictness,
		globalValue: global.layer.auditor?.strictness,
		defaultValue: "balanced",
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorInstructions = track("auditor.instructions", resolveLeaf<string>({
		projectValue: project.layer.auditor?.instructions,
		globalValue: global.layer.auditor?.instructions,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorReportFormat = track("auditor.reportFormat", resolveLeaf<string>({
		projectValue: project.layer.auditor?.reportFormat,
		globalValue: global.layer.auditor?.reportFormat,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorFeedbackNotes = track("auditor.feedbackNotes", resolveLeaf<string>({
		projectValue: project.layer.auditor?.feedbackNotes,
		globalValue: global.layer.auditor?.feedbackNotes,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorSystemPromptExtra = track("auditor.systemPromptExtra", resolveLeaf<string>({
		projectValue: project.layer.auditor?.systemPromptExtra,
		globalValue: global.layer.auditor?.systemPromptExtra,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorChecklist = track("auditor.checklist", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.checklist,
		globalValue: global.layer.auditor?.checklist,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorChecklistExtra = track("auditor.checklistExtra", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.checklistExtra,
		globalValue: global.layer.auditor?.checklistExtra,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorEvidenceRequests = track("auditor.evidenceRequests", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.evidenceRequests,
		globalValue: global.layer.auditor?.evidenceRequests,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorExtensions = track("auditor.extensions", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.extensions,
		globalValue: global.layer.auditor?.extensions,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorSubagentOnlyExtensions = track("auditor.subagentOnlyExtensions", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.subagentOnlyExtensions,
		globalValue: global.layer.auditor?.subagentOnlyExtensions,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorSkills = track("auditor.skills", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.skills,
		globalValue: global.layer.auditor?.skills,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorSkillPath = track("auditor.skillPath", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.skillPath,
		globalValue: global.layer.auditor?.skillPath,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorTools = track("auditor.tools", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.tools,
		globalValue: global.layer.auditor?.tools,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorExcludeTools = track("auditor.excludeTools", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.excludeTools,
		globalValue: global.layer.auditor?.excludeTools,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorMcpDirectTools = track("auditor.mcpDirectTools", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.mcpDirectTools,
		globalValue: global.layer.auditor?.mcpDirectTools,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorDefaultReads = track("auditor.defaultReads", resolveLeaf<string[]>({
		projectValue: project.layer.auditor?.defaultReads,
		globalValue: global.layer.auditor?.defaultReads,
		defaultValue: undefined as unknown as string[],
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorInheritProjectContext = track("auditor.inheritProjectContext", resolveLeaf<boolean>({
		projectValue: project.layer.auditor?.inheritProjectContext,
		globalValue: global.layer.auditor?.inheritProjectContext,
		defaultValue: undefined as unknown as boolean,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorInheritSkills = track("auditor.inheritSkills", resolveLeaf<boolean>({
		projectValue: project.layer.auditor?.inheritSkills,
		globalValue: global.layer.auditor?.inheritSkills,
		defaultValue: undefined as unknown as boolean,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorSandbox = track("auditor.sandbox", resolveLeaf<string>({
		projectValue: project.layer.auditor?.sandbox,
		globalValue: global.layer.auditor?.sandbox,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const auditorPermissionProfile = track("auditor.permissionProfile", resolveLeaf<string>({
		projectValue: project.layer.auditor?.permissionProfile,
		globalValue: global.layer.auditor?.permissionProfile,
		defaultValue: undefined as unknown as string,
	}));
	const auditorChangeManifest = track("auditor.changeManifest", resolveLeaf<"auto" | "off">({
		projectValue: project.layer.auditor?.changeManifest,
		globalValue: global.layer.auditor?.changeManifest,
		defaultValue: "auto",
	}));
	const auditorChangeManifestDepth = track("auditor.changeManifestDepth", resolveLeaf<number>({
		projectValue: project.layer.auditor?.changeManifestDepth,
		globalValue: global.layer.auditor?.changeManifestDepth,
		defaultValue: DEFAULT_CHANGE_MANIFEST_DEPTH,
	}));
	const autoSelectSingleGoal = track("autoSelectSingleGoal", resolveLeaf<boolean>({
		projectValue: project.layer.autoSelectSingleGoal,
		globalValue: global.layer.autoSelectSingleGoal,
		defaultValue: false,
	}));
	const auditorProjectResources = track("auditorProjectResources", resolveLeaf<boolean>({
		projectValue: project.layer.auditorProjectResources,
		globalValue: global.layer.auditorProjectResources,
		defaultValue: false,
	}));
	const hideUnfocusedBanner = track("hideUnfocusedBanner", resolveLeaf<boolean>({
		projectValue: project.layer.hideUnfocusedBanner,
		globalValue: global.layer.hideUnfocusedBanner,
		defaultValue: false,
	}));
	// Issue #26: Oracle leaves resolve per leaf like every other setting.
	const oracleEnabled = track("oracle.enabled", resolveLeaf<boolean>({
		projectValue: project.layer.oracle?.enabled,
		globalValue: global.layer.oracle?.enabled,
		defaultValue: false,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const oracleProvider = track("oracle.provider", resolveLeaf<string>({
		projectValue: project.layer.oracle?.provider,
		globalValue: global.layer.oracle?.provider,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const oracleModel = track("oracle.model", resolveLeaf<string>({
		projectValue: project.layer.oracle?.model,
		globalValue: global.layer.oracle?.model,
		defaultValue: undefined as unknown as string,
	}));
	// SAFETY: phantom default — resolveLeaf only checks === undefined (see its doc).
	const oracleThinkingLevel = track("oracle.thinkingLevel", resolveLeaf<ThinkingLevel>({
		projectValue: project.layer.oracle?.thinkingLevel,
		globalValue: global.layer.oracle?.thinkingLevel,
		defaultValue: undefined as unknown as ThinkingLevel,
	}));
	const oracleProjectResources = track("oracle.projectResources", resolveLeaf<boolean>({
		projectValue: project.layer.oracle?.projectResources,
		globalValue: global.layer.oracle?.projectResources,
		defaultValue: false,
	}));
	const oracleMaxFailedAttemptsPerBlocker = track("oracle.maxFailedAttemptsPerBlocker", resolveLeaf<number>({
		projectValue: project.layer.oracle?.maxFailedAttemptsPerBlocker,
		globalValue: global.layer.oracle?.maxFailedAttemptsPerBlocker,
		defaultValue: 2,
	}));
	const strictExecutionContract = track("strictExecutionContract", resolveLeaf<boolean>({
		projectValue: project.layer.strictExecutionContract,
		globalValue: global.layer.strictExecutionContract,
		defaultValue: false,
	}));
	const maxAutonomousRuns = track("maxAutonomousRuns", resolveLeaf<number | undefined>({
		projectValue: project.layer.maxAutonomousRuns,
		globalValue: global.layer.maxAutonomousRuns,
		defaultValue: undefined,
	}));
	const stallTimeoutMinutes = track("stallTimeoutMinutes", resolveLeaf<number>({
		projectValue: project.layer.stallTimeoutMinutes,
		globalValue: global.layer.stallTimeoutMinutes,
		defaultValue: 0,
	}));
	const objectiveMaxChars = track("objectiveMaxChars", resolveLeaf<number>({
		envValue: envInt("PI_GOAL_OBJECTIVE_MAX_CHARS"),
		projectValue: project.layer.objectiveMaxChars,
		globalValue: global.layer.objectiveMaxChars,
		defaultValue: 0,
		envVar: "PI_GOAL_OBJECTIVE_MAX_CHARS",
	}));
	const networkRecoveryMaxAttempts = track("networkRecovery.maxAttempts", resolveLeaf<number>({
		envValue: envInt("PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS"),
		projectValue: project.layer.networkRecovery?.maxAttempts,
		globalValue: global.layer.networkRecovery?.maxAttempts,
		defaultValue: 0,
		envVar: "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS",
	}));
	const networkRecoveryMaxDelayMs = track("networkRecovery.maxDelayMs", resolveLeaf<number>({
		envValue: envInt("PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS"),
		projectValue: project.layer.networkRecovery?.maxDelayMs,
		globalValue: global.layer.networkRecovery?.maxDelayMs,
		defaultValue: DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS,
		envVar: "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS",
	}));

	const keybindings: GoalKeybindings = {
		dashboard: {
			toggleExpand: track(pathKey("keybindings", "dashboard", "toggleExpand"), resolveLeaf<KeyId>({
				projectValue: project.layer.keybindings?.dashboard?.toggleExpand,
				globalValue: global.layer.keybindings?.dashboard?.toggleExpand,
				defaultValue: DEFAULT_GOAL_KEYBINDINGS.dashboard.toggleExpand,
			})),
			scrollUp: track(pathKey("keybindings", "dashboard", "scrollUp"), resolveLeaf<KeyId>({
				projectValue: project.layer.keybindings?.dashboard?.scrollUp,
				globalValue: global.layer.keybindings?.dashboard?.scrollUp,
				defaultValue: DEFAULT_GOAL_KEYBINDINGS.dashboard.scrollUp,
			})),
			scrollDown: track(pathKey("keybindings", "dashboard", "scrollDown"), resolveLeaf<KeyId>({
				projectValue: project.layer.keybindings?.dashboard?.scrollDown,
				globalValue: global.layer.keybindings?.dashboard?.scrollDown,
				defaultValue: DEFAULT_GOAL_KEYBINDINGS.dashboard.scrollDown,
			})),
		},
	};

	const value: ResolvedGoalSettings = {
		disableTasks,
		disableContracts,
		subtaskDepth,
		auditor: {
			agent: auditorAgent,
			disabled: auditorDisabled,
			...(auditorProvider ? { provider: auditorProvider } : {}),
			...(auditorModel ? { model: auditorModel } : {}),
			...(auditorThinkingLevel ? { thinkingLevel: auditorThinkingLevel } : {}),
			...(auditorTimeoutMs !== undefined ? { timeoutMs: auditorTimeoutMs } : {}),
			changeManifest: auditorChangeManifest,
			changeManifestDepth: auditorChangeManifestDepth,
			warmContext: auditorWarmContext,
			strictness: auditorStrictness,
			...(auditorInstructions ? { instructions: auditorInstructions } : {}),
			...(auditorChecklist !== undefined ? { checklist: auditorChecklist } : {}),
			...(auditorChecklistExtra !== undefined ? { checklistExtra: auditorChecklistExtra } : {}),
			...(auditorEvidenceRequests !== undefined ? { evidenceRequests: auditorEvidenceRequests } : {}),
			...(auditorReportFormat ? { reportFormat: auditorReportFormat } : {}),
			...(auditorFeedbackNotes ? { feedbackNotes: auditorFeedbackNotes } : {}),
			...(auditorSystemPromptExtra ? { systemPromptExtra: auditorSystemPromptExtra } : {}),
			...(auditorExtensions !== undefined ? { extensions: auditorExtensions } : {}),
			...(auditorSubagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: auditorSubagentOnlyExtensions } : {}),
			...(auditorSkills !== undefined ? { skills: auditorSkills } : {}),
			...(auditorSkillPath !== undefined ? { skillPath: auditorSkillPath } : {}),
			...(auditorTools !== undefined ? { tools: auditorTools } : {}),
			...(auditorExcludeTools !== undefined ? { excludeTools: auditorExcludeTools } : {}),
			...(auditorMcpDirectTools !== undefined ? { mcpDirectTools: auditorMcpDirectTools } : {}),
			...(auditorDefaultReads !== undefined ? { defaultReads: auditorDefaultReads } : {}),
			...(auditorInheritProjectContext !== undefined ? { inheritProjectContext: auditorInheritProjectContext } : {}),
			...(auditorInheritSkills !== undefined ? { inheritSkills: auditorInheritSkills } : {}),
			...(auditorSandbox ? { sandbox: auditorSandbox } : {}),
			...(auditorPermissionProfile ? { permissionProfile: auditorPermissionProfile } : {}),
		},
		autoSelectSingleGoal,
		auditorProjectResources,
		hideUnfocusedBanner,
		stallTimeoutMinutes,
		maxAutonomousRuns,
		strictExecutionContract,
		objectiveMaxChars,
		keybindings,
		networkRecovery: {
			maxAttempts: networkRecoveryMaxAttempts,
			maxDelayMs: networkRecoveryMaxDelayMs,
		},
		oracle: {
			enabled: oracleEnabled,
			...(oracleProvider ? { provider: oracleProvider } : {}),
			...(oracleModel ? { model: oracleModel } : {}),
			...(oracleThinkingLevel ? { thinkingLevel: oracleThinkingLevel } : {}),
			projectResources: oracleProjectResources,
			maxFailedAttemptsPerBlocker: oracleMaxFailedAttemptsPerBlocker,
		},
	};

	const snapshot = {
		global,
		project,
		value,
		provenance,
		diagnostics: [...global.diagnostics, ...project.diagnostics],
	};
	if (resolvedSettingsCache.length >= 16) resolvedSettingsCache.shift();
	resolvedSettingsCache.push({global, project, environment: resolutionEnvKeys.map(key => env[key]), snapshot});
	return snapshot;
}

function copyAuditorSettings(auditor: GoalAuditorSettings): GoalAuditorSettings {
	const copy = { ...auditor };
	for (const key of ["checklist", "checklistExtra", "evidenceRequests", "extensions", "subagentOnlyExtensions", "skills", "skillPath", "tools", "excludeTools", "mcpDirectTools", "defaultReads"] as const) {
		if (copy[key]) copy[key] = [...copy[key]];
	}
	return copy;
}

function copyResolvedSettings(value: ResolvedGoalSettings): ResolvedGoalSettings {
	return {...value,
		...(value.auditor ? {auditor: copyAuditorSettings(value.auditor)} : {}),
		...(value.keybindings ? {keybindings: {dashboard: {...value.keybindings.dashboard}}} : {}),
		...(value.networkRecovery ? {networkRecovery: {...value.networkRecovery}} : {}),
		...(value.oracle ? {oracle: {...value.oracle}} : {}),
	};
}

/** Return caller-owned resolved values and provenance; cached layer reads keep their existing contract. */
export function loadSettingsSnapshot(cwd: string, env: NodeJS.ProcessEnv = process.env): SettingsSnapshot {
	const snapshot = resolvedSettingsSnapshot(cwd, env);
	return {...snapshot, value: copyResolvedSettings(snapshot.value), provenance: new Map(Array.from(snapshot.provenance, ([key, value]) => [key, {...value}])), diagnostics: [...snapshot.diagnostics]};
}

/**
 * Load settings with layered resolution:
 * environment > project > global > defaults.
 */
export function loadGoalSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	return copyResolvedSettings(resolvedSettingsSnapshot(cwd, env).value);
}

// ── conflict-safe scoped mutation ───────────────────────────────────────────

export type SettingsMutation =
	| { op: "set"; path: readonly string[]; value: unknown }
	| { op: "unset"; path: readonly string[] };

export interface MutateSettingsInput {
	scope: SettingsScope;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	mutation: SettingsMutation;
}

export class SettingsMutationError extends Error {
	readonly diagnostics?: SettingsDiagnostic[];

	constructor(message: string, diagnostics?: SettingsDiagnostic[]) {
		super(message);
		this.name = "SettingsMutationError";
		this.diagnostics = diagnostics;
	}
}

function sleepMs(ms: number): void {
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface PathLock {
	release(): void;
}

/**
 * Generic filesystem path lock (same discipline as the goal lock): atomic
 * create, bounded retries, stale-TTL/dead-pid recovery. Multiple Pi processes
 * may edit the same global file concurrently.
 */
export function acquirePathLock(
	lockPath: string,
	opts: { attempts?: number; retryMs?: number; staleTtlMs?: number } = {},
): PathLock {
	const attempts = opts.attempts ?? 200;
	const retryMs = opts.retryMs ?? 5;
	const ttlMs = opts.staleTtlMs ?? 30_000;
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			fs.writeFileSync(lockPath, payload, { flag: "wx" });
			let released = false;
			return {
				release(): void {
					if (released) return;
					released = true;
					try {
						fs.unlinkSync(lockPath);
					} catch {
						// Already removed by stale recovery elsewhere.
					}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				const stat = fs.statSync(lockPath);
				let pid: number | undefined;
				try {
					pid = (JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>).pid as number | undefined;
				} catch {
					pid = undefined;
				}
				const stale = Date.now() - stat.mtimeMs > ttlMs || (typeof pid === "number" && !pidAlive(pid));
				if (stale) {
					try {
						fs.unlinkSync(lockPath);
					} catch {
						// Someone else recovered it first; retry.
					}
					continue;
				}
			} catch {
				// Lock vanished between EEXIST and stat (holder released): brief
				// backoff so we never busy-spin against the next holder.
				sleepMs(retryMs);
				continue;
			}
			sleepMs(retryMs);
		}
	}
	throw new SettingsMutationError(`Timed out acquiring the settings lock at ${lockPath}. Another writer may hold it.`);
}

function refuseSymlinkTarget(target: string): void {
	try {
		if (fs.lstatSync(target).isSymbolicLink()) {
			throw new SettingsMutationError(`refusing symlink settings target: ${target}`);
		}
	} catch (err) {
		if (err instanceof SettingsMutationError) throw err;
		// Target does not exist yet — fine.
	}
}

function atomicWriteJson(target: string, value: unknown, options: { defaultMode: number }): void {
	const parent = path.dirname(target);
	fs.mkdirSync(parent, { recursive: true });
	refuseSymlinkTarget(target);

	let mode = options.defaultMode;
	try {
		mode = fs.statSync(target).mode & 0o777;
	} catch {
		// New file: keep default mode.
	}

	const temp = path.join(parent, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temp, "wx", mode);
		fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temp, target);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch { /* best effort */ }
		}
		try {
			fs.unlinkSync(temp);
		} catch { /* best effort */ }
		throw error;
	}
	try {
		fs.fsyncSync(fs.openSync(parent, "r"));
	} catch { /* directory fsync is platform-dependent; best effort */ }
}

function applyPathMutation(layer: GoalSettingsLayer, mutation: SettingsMutation): void {
	if (mutation.path.length === 0) throw new SettingsMutationError("empty settings path");
	// Auditor thinkingLevel accepts the thinking_level alias spelling inside
	// the nested group, mirroring the top-level legacy alias.
	if (mutation.path.length === 2 && mutation.path[0] === "auditor" && (mutation.path[1] === "thinkingLevel" || mutation.path[1] === "thinking_level")) {
		const auditor = (layer.auditor ??= {}) as Record<string, unknown>;
		if (mutation.op === "set") auditor.thinkingLevel = mutation.value;
		else {
			delete auditor.thinkingLevel;
			delete auditor.thinking_level;
		}
		return;
	}
	// SAFETY: `layer` comes from parseSettingsLayer (JSON-object input), so its
	// runtime shape is a plain record keyed by settings names.
	let container: Record<string, unknown> = layer as unknown as Record<string, unknown>;
	for (let i = 0; i < mutation.path.length - 1; i += 1) {
		const key = mutation.path[i]!;
		const next = container[key];
		if (!next || typeof next !== "object") {
			if (mutation.op === "unset") return; // nothing to unset
			container[key] = {};
		}
		container = container[key] as Record<string, unknown>;
	}
	const last = mutation.path[mutation.path.length - 1]!;
	// thinkingLevel/thinking_level are accepted aliases on read; writes operate
	// on BOTH spellings so unset clears hand-edited variants too.
	if (last === "thinkingLevel" || last === "thinking_level") {
		if (mutation.op === "set") container.thinkingLevel = mutation.value;
		else {
			delete container.thinkingLevel;
			delete container.thinking_level;
		}
		return;
	}
	if (mutation.op === "set") container[last] = mutation.value;
	else delete container[last];
}

/** Canonicalize the persisted spelling of aliased keys before writing. */
function canonicalizeAliases(layer: Record<string, unknown>): void {
	if (layer.thinkingLevel !== undefined) {
		layer.thinking_level = layer.thinkingLevel;
		delete layer.thinkingLevel;
	}
	const auditor = layer.auditor;
	if (auditor && typeof auditor === "object" && !Array.isArray(auditor)) {
		const aud = auditor as Record<string, unknown>;
		// Inside the nested group the modern spelling is canonical on disk;
		// parse still accepts the alias so hand-edited files keep working.
		if (aud.thinking_level !== undefined) {
			if (aud.thinkingLevel === undefined) aud.thinkingLevel = aud.thinking_level;
			delete aud.thinking_level;
		}
	}
}

function pruneEmptyObjects(value: unknown): void {
	for (const key of Object.keys(value as Record<string, unknown>)) {
		const child = (value as Record<string, unknown>)[key];
		if (child && typeof child === "object" && !Array.isArray(child)) {
			pruneEmptyObjects(child);
			if (Object.keys(child as Record<string, unknown>).length === 0) delete (value as Record<string, unknown>)[key];
		}
	}
}

/**
 * Apply a scoped mutation under the target's path lock and return a fresh
 * snapshot. Refuses to overwrite an invalid layer; writes atomically;
 * invalidates only the affected cache entry.
 */
export function mutateSettingsLayer(input: MutateSettingsInput): SettingsSnapshot {
	const env = input.env ?? process.env;
	const target = input.scope === "global"
		? goalGlobalSettingsPath(env)
		: goalSettingsPath(input.cwd, env);
	const lock = acquirePathLock(`${target}.lock`);

	try {
		const current = readSettingsLayerFresh(target, input.scope);
		if (current.status === "invalid") {
			throw new SettingsMutationError(
				`Refusing to overwrite invalid ${input.scope} settings at ${target}`,
				current.diagnostics,
			);
		}

		const next = structuredClone(current.layer) as Record<string, unknown>;
		// SAFETY: `next` is a clone of a parseSettingsLayer-produced layer, so it
		// satisfies the GoalSettingsLayer structural contract applyPathMutation
		// mutates against.
		applyPathMutation(next as unknown as GoalSettingsLayer, input.mutation);
		pruneEmptyObjects(next);
		canonicalizeAliases(next);

		const reparsed = parseSettingsLayer(JSON.parse(JSON.stringify(next)), input.scope, target);
		if (reparsed.diagnostics.some((d) => d.code === "invalid_value" || d.code === "invalid_nested_key")) {
			throw new SettingsMutationError(`Mutation produced invalid ${input.scope} settings`, reparsed.diagnostics);
		}

		atomicWriteJson(target, next, { defaultMode: 0o600 });
		invalidateSettingsCachePath(target);
		return loadSettingsSnapshot(input.cwd, env);
	} finally {
		lock.release();
	}
}

// ── legacy whole-file save (routed through the locked mutation path) ────────

/**
 * Save settings to the PROJECT file. Kept for compatibility; internally uses
 * the conflict-safe locked mutation path (replace semantics via unset+set is
 * not needed here: the whole-object replace happens under the same lock with
 * a fresh re-read, so no cached stale object is ever written).
 */
export function saveGoalSettingsFileConfig(cwd: string, settings: GoalSettings): GoalSettings {
	const target = goalSettingsPath(cwd);
	const lock = acquirePathLock(`${target}.lock`);
	try {
		// Fresh re-read under the lock: never persist a cached whole object.
		const current = readSettingsLayerFresh(target, "project");
		if (current.status === "invalid") {
			throw new SettingsMutationError(`Refusing to overwrite invalid project settings at ${target}`, current.diagnostics);
		}
		const clean = buildPersistedLayer(settings);
		atomicWriteJson(target, clean, { defaultMode: 0o600 });
		invalidateSettingsCachePath(target);
		// SAFETY: the persisted layer is the canonical nested settings shape.
		return { ...clean } as unknown as GoalSettings;
	} finally {
		lock.release();
	}
}

/** Canonical persisted form of a resolved/sparse settings object. */
function buildPersistedLayer(settings: GoalSettings): Record<string, unknown> {
	const persisted: Record<string, unknown> = {};
	const auditor = settings.auditor;
	if (auditor) {
		const a: Record<string, unknown> = {};
		// Migrated leaves keep their pre-0.8.0 persistence parity: agent only
		// when non-default, disabled always, timeout only when set.
		if (auditor.agent && auditor.agent !== DEFAULT_AUDITOR_AGENT) a.agent = auditor.agent;
		if (auditor.disabled !== undefined) a.disabled = auditor.disabled;
		if (auditor.provider) a.provider = auditor.provider;
		if (auditor.model) a.model = auditor.model;
		if (auditor.thinkingLevel) a.thinkingLevel = auditor.thinkingLevel;
		if (auditor.timeoutMs !== undefined) a.timeoutMs = auditor.timeoutMs;
		if (auditor.changeManifest !== undefined) a.changeManifest = auditor.changeManifest;
		if (auditor.changeManifestDepth !== undefined) a.changeManifestDepth = auditor.changeManifestDepth;
		// New leaves persist only when they differ from their defaults so
		// routine saves do not grow files with default noise.
		if (auditor.warmContext === false) a.warmContext = false;
		if (auditor.strictness !== undefined && auditor.strictness !== "balanced") a.strictness = auditor.strictness;
		if (auditor.instructions) a.instructions = auditor.instructions;
		if (auditor.checklist !== undefined) a.checklist = [...auditor.checklist];
		if (auditor.checklistExtra !== undefined) a.checklistExtra = [...auditor.checklistExtra];
		if (auditor.evidenceRequests !== undefined) a.evidenceRequests = [...auditor.evidenceRequests];
		if (auditor.reportFormat) a.reportFormat = auditor.reportFormat;
		if (auditor.feedbackNotes) a.feedbackNotes = auditor.feedbackNotes;
		if (auditor.systemPromptExtra) a.systemPromptExtra = auditor.systemPromptExtra;
		for (const key of ["extensions", "subagentOnlyExtensions", "skills", "skillPath", "tools", "excludeTools", "mcpDirectTools", "defaultReads"] as const) {
			if (auditor[key] !== undefined) a[key] = [...auditor[key]];
		}
		if (auditor.inheritProjectContext !== undefined) a.inheritProjectContext = auditor.inheritProjectContext;
		if (auditor.inheritSkills !== undefined) a.inheritSkills = auditor.inheritSkills;
		if (auditor.sandbox !== undefined) a.sandbox = auditor.sandbox;
		if (auditor.permissionProfile !== undefined) a.permissionProfile = auditor.permissionProfile;
		if (Object.keys(a).length > 0) persisted.auditor = a;
	}
	if (settings.disableTasks !== undefined) persisted.disableTasks = settings.disableTasks;
	if (settings.disableContracts !== undefined) persisted.disableContracts = settings.disableContracts;
	if (settings.subtaskDepth !== undefined) persisted.subtaskDepth = settings.subtaskDepth;
	if (settings.autoSelectSingleGoal !== undefined) persisted.autoSelectSingleGoal = settings.autoSelectSingleGoal;
	if (settings.auditorProjectResources !== undefined) persisted.auditorProjectResources = settings.auditorProjectResources;
	if (settings.hideUnfocusedBanner !== undefined) persisted.hideUnfocusedBanner = settings.hideUnfocusedBanner;
	if ((settings as { networkRecovery?: ResolvedGoalNetworkRecoverySettings }).networkRecovery) {
		const nr = (settings as { networkRecovery?: ResolvedGoalNetworkRecoverySettings }).networkRecovery!;
		const o: Record<string, unknown> = {};
		if (nr.maxAttempts !== undefined) o.maxAttempts = nr.maxAttempts;
		if (nr.maxDelayMs !== undefined) o.maxDelayMs = nr.maxDelayMs;
		if (Object.keys(o).length > 0) persisted.networkRecovery = o;
	}
	if ((settings as { oracle?: ResolvedGoalOracleSettings }).oracle) {
		const o: Record<string, unknown> = {};
		const so = (settings as { oracle?: ResolvedGoalOracleSettings }).oracle!;
		if (so.enabled !== undefined) o.enabled = so.enabled;
		if (so.provider !== undefined) o.provider = so.provider;
		if (so.model !== undefined) o.model = so.model;
		if (so.thinkingLevel !== undefined) o.thinking_level = so.thinkingLevel;
		if (so.projectResources !== undefined) o.projectResources = so.projectResources;
		if (so.maxFailedAttemptsPerBlocker !== undefined) o.maxFailedAttemptsPerBlocker = so.maxFailedAttemptsPerBlocker;
		if (Object.keys(o).length > 0) persisted.oracle = o;
	}
	if (settings.strictExecutionContract !== undefined) persisted.strictExecutionContract = settings.strictExecutionContract;
	if (settings.maxAutonomousRuns !== undefined) persisted.maxAutonomousRuns = settings.maxAutonomousRuns;
	if (settings.stallTimeoutMinutes !== undefined) persisted.stallTimeoutMinutes = settings.stallTimeoutMinutes;
	if (settings.objectiveMaxChars !== undefined) persisted.objectiveMaxChars = settings.objectiveMaxChars;
	if (settings.keybindings?.dashboard) {
		persisted.keybindings = { dashboard: { ...settings.keybindings.dashboard } };
	}
	return persisted;
}

// ── reporting ───────────────────────────────────────────────────────────────

/**
 * E2: which env var (if any) overrides a settings key's effective value.
 */
export function envOverrideFor(key: keyof GoalSettings | "settingsFile", env: NodeJS.ProcessEnv = process.env): string | null {
	if (key === "disableTasks" && env.PI_GOAL_DISABLE_TASKS !== undefined) return "PI_GOAL_DISABLE_TASKS";
	if (key === "disableContracts" && env.PI_GOAL_DISABLE_CONTRACTS !== undefined) return "PI_GOAL_DISABLE_CONTRACTS";
	if (key === "objectiveMaxChars" && env.PI_GOAL_OBJECTIVE_MAX_CHARS !== undefined) return "PI_GOAL_OBJECTIVE_MAX_CHARS";
	if (key === "networkRecovery") {
		if (env.PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS !== undefined) return "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS";
		if (env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS !== undefined) return "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS";
	}
	if (key === "settingsFile" && env[PI_GOAL_SETTINGS_FILE_ENV] !== undefined) return PI_GOAL_SETTINGS_FILE_ENV;
	return null;
}

function textPresence(value: string | undefined): string {
	return value ? `(set, ${value.length} chars)` : "(unset)";
}

function listPresence(value: string[] | undefined): string {
	return value ? `${value.length} item(s)` : "(unset)";
}

/**
 * E2: effective-settings report with per-leaf provenance
 * (environment > project > global > default), surfaced by /goal-status.
 */
export function effectiveSettingsReport(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const snapshot = loadSettingsSnapshot(cwd, env);
	const lines = ["Settings (provenance):"];
	const rows: Array<{ key: string; label: string; format: () => string }> = [
		{ key: "autoSelectSingleGoal", label: "autoSelectSingleGoal", format: () => String(snapshot.value.autoSelectSingleGoal) },
		{ key: "disableContracts", label: "disableContracts", format: () => String(snapshot.value.disableContracts) },
		{ key: "disableTasks", label: "disableTasks", format: () => String(snapshot.value.disableTasks) },
		{ key: "subtaskDepth", label: "subtaskDepth", format: () => String(snapshot.value.subtaskDepth) },
		{ key: "auditor.disabled", label: "auditor disabled", format: () => String(snapshot.value.auditor?.disabled) },
		{ key: "auditor.agent", label: "auditor agent", format: () => snapshot.value.auditor?.agent ?? DEFAULT_AUDITOR_AGENT },
		{ key: "auditor.timeoutMs", label: "auditor timeout (ms)", format: () => String(snapshot.value.auditor?.timeoutMs ?? DEFAULT_AUDITOR_TIMEOUT_MS) },
		{ key: "auditor.provider", label: "auditor provider", format: () => snapshot.value.auditor?.provider ?? "(default)" },
		{ key: "auditor.model", label: "auditor model", format: () => snapshot.value.auditor?.model ?? "(default)" },
		{ key: "auditor.thinkingLevel", label: "auditor thinking_level", format: () => snapshot.value.auditor?.thinkingLevel ?? "(default)" },
		{ key: "auditor.changeManifest", label: "auditor change manifest", format: () => snapshot.value.auditor?.changeManifest ?? "auto" },
		{ key: "auditor.changeManifestDepth", label: "auditor change manifest scan depth", format: () => String(snapshot.value.auditor?.changeManifestDepth ?? DEFAULT_CHANGE_MANIFEST_DEPTH) },
		{ key: "auditor.warmContext", label: "auditor warm context", format: () => String(snapshot.value.auditor?.warmContext ?? true) },
		{ key: "auditor.strictness", label: "auditor strictness", format: () => snapshot.value.auditor?.strictness ?? "balanced" },
		{ key: "auditor.instructions", label: "auditor instructions", format: () => textPresence(snapshot.value.auditor?.instructions) },
		{ key: "auditor.checklist", label: "auditor checklist (replaces default)", format: () => listPresence(snapshot.value.auditor?.checklist) },
		{ key: "auditor.checklistExtra", label: "auditor extra checklist items", format: () => listPresence(snapshot.value.auditor?.checklistExtra) },
		{ key: "auditor.evidenceRequests", label: "auditor evidence requests", format: () => listPresence(snapshot.value.auditor?.evidenceRequests) },
		{ key: "auditor.reportFormat", label: "auditor report format", format: () => textPresence(snapshot.value.auditor?.reportFormat) },
		{ key: "auditor.feedbackNotes", label: "auditor feedback notes", format: () => textPresence(snapshot.value.auditor?.feedbackNotes) },
		{ key: "auditor.systemPromptExtra", label: "auditor system prompt extra (next session)", format: () => textPresence(snapshot.value.auditor?.systemPromptExtra) },
		{ key: "auditor.extensions", label: "auditor extensions (next session)", format: () => listPresence(snapshot.value.auditor?.extensions) },
		{ key: "auditor.subagentOnlyExtensions", label: "auditor subagent-only extensions (next session)", format: () => listPresence(snapshot.value.auditor?.subagentOnlyExtensions) },
		{ key: "auditor.skills", label: "auditor skills (next session)", format: () => listPresence(snapshot.value.auditor?.skills) },
		{ key: "auditor.skillPath", label: "auditor skill paths (next session)", format: () => listPresence(snapshot.value.auditor?.skillPath) },
		{ key: "auditor.tools", label: "auditor tools (next session)", format: () => listPresence(snapshot.value.auditor?.tools) },
		{ key: "auditor.excludeTools", label: "auditor excluded tools (next session)", format: () => listPresence(snapshot.value.auditor?.excludeTools) },
		{ key: "auditor.mcpDirectTools", label: "auditor MCP direct tools (next session)", format: () => listPresence(snapshot.value.auditor?.mcpDirectTools) },
		{ key: "auditor.defaultReads", label: "auditor default reads (next session)", format: () => listPresence(snapshot.value.auditor?.defaultReads) },
		{ key: "auditor.inheritProjectContext", label: "auditor inherits project context (next session)", format: () => String(snapshot.value.auditor?.inheritProjectContext ?? false) },
		{ key: "auditor.inheritSkills", label: "auditor inherits skills (next session)", format: () => String(snapshot.value.auditor?.inheritSkills ?? false) },
		{ key: "auditor.sandbox", label: "auditor sandbox profile (next session)", format: () => snapshot.value.auditor?.sandbox ?? "(unset)" },
		{ key: "auditor.permissionProfile", label: "auditor permission profile (next session)", format: () => snapshot.value.auditor?.permissionProfile ?? "(unset)" },
		{ key: "hideUnfocusedBanner", label: "hide unfocused banner", format: () => String(snapshot.value.hideUnfocusedBanner) },
		{ key: "strictExecutionContract", label: "explicit execution contracts (opt-in)", format: () => String(snapshot.value.strictExecutionContract) },
		{ key: "maxAutonomousRuns", label: "autonomous run allowance", format: () => snapshot.value.maxAutonomousRuns === 0 ? "0 (disabled)" : String(snapshot.value.maxAutonomousRuns ?? "unlimited (default)") },
		{ key: "stallTimeoutMinutes", label: "stall timeout (minutes)", format: () => String(snapshot.value.stallTimeoutMinutes) },
		{ key: "objectiveMaxChars", label: "max objective length (0 = none)", format: () => String(snapshot.value.objectiveMaxChars) },
		{ key: "networkRecovery", label: "network recovery attempts (0 = unbounded)", format: () => String(snapshot.value.networkRecovery?.maxAttempts ?? 0) },
		{ key: "networkRecovery", label: "network recovery max delay (ms)", format: () => String(snapshot.value.networkRecovery?.maxDelayMs ?? DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS) },
		{ key: "keybindings", label: "dashboard keybindings", format: () => `${snapshot.value.keybindings!.dashboard.toggleExpand}, ${snapshot.value.keybindings!.dashboard.scrollUp}, ${snapshot.value.keybindings!.dashboard.scrollDown}` },
	];
	for (const row of rows) {
		const resolved = snapshot.provenance.get(row.key);
		let source: string;
		if (resolved?.source === "environment") source = `env (${resolved.envVar})`;
		else source = resolved?.source ?? "default";
		lines.push(`  ${row.label}: ${row.format()} (${source})`);
	}
	if (snapshot.value.auditorProjectResources === true) {
		lines.push(`  NOTE: ${AUDITOR_PROJECT_RESOURCES_MIGRATION_NOTICE}`);
	}
	lines.push(`  project settings file: ${snapshot.project.path}`);
	lines.push(`  global settings file: ${snapshot.global.path}`);
	const fileOverride = envOverrideFor("settingsFile", env);
	if (fileOverride) lines.push(`  (settings file overridden by ${fileOverride})`);
	return lines;
}

export function isAuditorEnabledByDefault(settings: GoalSettings): boolean {
	// Auditor participates unless explicitly disabled at any layer.
	return settings.auditor?.disabled !== true;
}
