// Fork-only module. Per-goal completion-auditor override registry (S1 of the
// double fork seam described in openspec/changes/add-pi-openspec-x design D10).
//
// The completion transaction reads the GLOBAL `settings.auditor` at a single
// point (goal-completion.ts). This module lets a consumer extension (for
// example pi-openspec-x) attach an auditor-settings override to ONE goal id so
// the completion audit for that goal merges goal-level values over the global
// settings, leaf by leaf (goal-level wins). Goals without an override get the
// exact global settings object back — the plain /goal path is byte-identical.
//
// Storage is an in-process registry on globalThis keyed by Symbol.for (same
// pattern as pi-sandbox's fork-profile-registry), keyed by goalId. It is
// deliberately NOT a GoalRecord field: normalizeGoalRecord rebuilds records
// field-by-field (the upstream serialization core), so a persisted field would
// need an upstream seam there and would leak fork-specific data into
// upstream-format goal files. The goal's owner (pi-openspec-x) replays
// overrides after a restart — it owns the goal↔override mapping.
//
// Only the request tier and the prompt-injection tier of GoalAuditorSettings
// are overridable per goal: those are the leaves the completion-audit request
// consumes per audit (delegation overrides, terminal timeout, warm context,
// and the buildGoalAuditorPrompt injections). The definition tier
// (systemPromptExtra, tools, extensions, sandbox, ...) only ever feeds the
// default goal-auditor registration and is therefore rejected here — an
// agent-level customization belongs to the cross-extension resolver's
// RuntimeAgentDefinition (see ./goal-auditor-agent-resolver.ts).
import {
	AUDITOR_STRICTNESS_LEVELS,
	MAX_AUDITOR_LIST_ITEMS,
	MAX_AUDITOR_LIST_ITEM_LENGTH,
	MAX_AUDITOR_SHORT_TEXT_LENGTH,
	MAX_AUDITOR_TEXT_LENGTH,
	MAX_AUDITOR_TIMEOUT_MS,
	type AuditorStrictness,
	type GoalSettings,
	type ThinkingLevel,
	loadGoalSettings,
} from "./goal-settings.ts";

/** Mirrors the ThinkingLevel union in goal-settings.ts for read-time validation. */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const CHANGE_MANIFEST_MODES: readonly ("auto" | "off")[] = ["auto", "off"];

/**
 * Per-goal override of the completion-auditor settings: a sparse subset of the
 * `auditor.*` group (request tier + prompt-injection tier). Every present leaf
 * replaces the global value for this goal's completion audit; absent leaves
 * keep the global resolution.
 */
export interface GoalAuditorOverride {
	// ── request tier ──
	disabled?: boolean;
	agent?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	timeoutMs?: number;
	changeManifest?: "auto" | "off";
	changeManifestDepth?: number;
	warmContext?: boolean;
	// ── prompt-injection tier ──
	instructions?: string;
	checklist?: string[];
	checklistExtra?: string[];
	evidenceRequests?: string[];
	strictness?: AuditorStrictness;
	reportFormat?: string;
	feedbackNotes?: string;
}

const OVERRIDE_REGISTRY_KEY = Symbol.for("@xzzpig/pi-goal-x/auditor-overrides");

type OverrideRegistry = Map<string, GoalAuditorOverride>;

function overrideRegistry(): OverrideRegistry {
	const scope = globalThis as typeof globalThis & Record<symbol, OverrideRegistry | undefined>;
	const existing = scope[OVERRIDE_REGISTRY_KEY];
	if (existing instanceof Map) return existing;
	const created: OverrideRegistry = new Map();
	scope[OVERRIDE_REGISTRY_KEY] = created;
	return created;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() && value.trim() === value ? value.trim() : undefined;
}

function asBoundedString(value: unknown, maxLength: number): string | undefined {
	const text = asNonEmptyString(value);
	return text !== undefined && text.length <= maxLength ? text : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function asList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (value.length === 0 || value.length > MAX_AUDITOR_LIST_ITEMS) return undefined;
	const items: string[] = [];
	for (const entry of value) {
		const item = asBoundedString(entry, MAX_AUDITOR_LIST_ITEM_LENGTH);
		if (item === undefined) return undefined;
		items.push(item);
	}
	return items;
}

/**
 * Validate one override leaf. Returns the leaf's value when valid, undefined
 * when invalid (read time: the leaf falls back to global; write time: the
 * whole call is rejected).
 */
function validatedLeaf<K extends keyof GoalAuditorOverride>(key: K, value: unknown): GoalAuditorOverride[K] | undefined {
	switch (key) {
		case "disabled":
		case "warmContext":
			return asBoolean(value) as GoalAuditorOverride[K] | undefined;
		case "agent":
		case "provider":
		case "model":
		case "reportFormat":
		case "feedbackNotes":
			return asBoundedString(value, MAX_AUDITOR_SHORT_TEXT_LENGTH) as GoalAuditorOverride[K] | undefined;
		case "instructions":
			return asBoundedString(value, MAX_AUDITOR_TEXT_LENGTH) as GoalAuditorOverride[K] | undefined;
		case "thinkingLevel":
			return asEnum(value, THINKING_LEVELS) as GoalAuditorOverride[K] | undefined;
		case "changeManifest":
			return asEnum(value, CHANGE_MANIFEST_MODES) as GoalAuditorOverride[K] | undefined;
		case "strictness":
			return asEnum(value, AUDITOR_STRICTNESS_LEVELS) as GoalAuditorOverride[K] | undefined;
		case "timeoutMs":
			return (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AUDITOR_TIMEOUT_MS ? value : undefined) as GoalAuditorOverride[K] | undefined;
		case "changeManifestDepth":
			return (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined) as GoalAuditorOverride[K] | undefined;
		case "checklist":
		case "checklistExtra":
		case "evidenceRequests":
			return asList(value) as GoalAuditorOverride[K] | undefined;
		default:
			return undefined;
	}
}

const OVERRIDE_LEAVES = [
	"disabled",
	"agent",
	"provider",
	"model",
	"thinkingLevel",
	"timeoutMs",
	"changeManifest",
	"changeManifestDepth",
	"warmContext",
	"instructions",
	"checklist",
	"checklistExtra",
	"evidenceRequests",
	"strictness",
	"reportFormat",
	"feedbackNotes",
] as const;

function isOverrideLeaf(key: string): key is keyof GoalAuditorOverride {
	return (OVERRIDE_LEAVES as readonly string[]).includes(key);
}

/** Deep-ish copy so a stored override can never be mutated through the caller's object. */
function copyOverride(override: GoalAuditorOverride): GoalAuditorOverride {
	const copy: GoalAuditorOverride = { ...override };
	for (const key of ["checklist", "checklistExtra", "evidenceRequests"] as const) {
		if (copy[key]) copy[key] = [...copy[key]];
	}
	return copy;
}

/**
 * Validate a raw override for WRITE. Returns the validated copy, or an error
 * message naming the first offending leaf. Unknown (definition-tier or
 * misspelled) leaves are errors: per-goal overrides drive the audit REQUEST,
 * and agent-definition customization belongs to the S2 resolver.
 */
function validateOverrideForWrite(value: unknown): { override?: GoalAuditorOverride; error?: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { error: "goal auditor override must be an object of auditor.* leaves." };
	}
	const record = value as Record<string, unknown>;
	const validated: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(record)) {
		if (!isOverrideLeaf(key)) {
			return { error: `unknown goal auditor override leaf '${key}': per-goal overrides cover the request and prompt-injection tiers only; agent-definition customization belongs to the auditor agent resolver (registerAuditorAgentResolver).` };
		}
		const parsed = validatedLeaf(key, raw);
		if (parsed === undefined) {
			return { error: `invalid goal auditor override leaf '${key}'.` };
		}
		validated[key] = parsed;
	}
	if (Object.keys(validated).length === 0) {
		return { error: "goal auditor override must set at least one auditor leaf; use clearGoalAuditorOverride to remove an override." };
	}
	return { override: copyOverride(validated as GoalAuditorOverride) };
}

/**
 * Validate a stored override for READ. A corrupt entry (planted out of band,
 * or an object whose leaves lost their shape) degrades to the global settings
 * leaf-by-leaf — never throws, never blocks a completion.
 */
function validateOverrideForRead(value: unknown): GoalAuditorOverride | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const validated: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(record)) {
		if (!isOverrideLeaf(key)) continue;
		const parsed = validatedLeaf(key, raw);
		if (parsed !== undefined) validated[key] = parsed;
	}
	return Object.keys(validated).length > 0 ? validated as GoalAuditorOverride : undefined;
}

/**
 * Attach an auditor-settings override to one goal id. Throws on any invalid
 * leaf (atomic: the registry is left untouched) so a bad registration can
 * never partially apply. Registering again for the same goal replaces the
 * previous override (latter wins), so session-init code can re-apply
 * idempotently.
 */
export function setGoalAuditorOverride(goalId: string, override: GoalAuditorOverride): void {
	if (typeof goalId !== "string" || !goalId.trim() || goalId.trim() !== goalId) {
		throw new Error("goal auditor override goalId must be a non-empty string without surrounding whitespace.");
	}
	const { override: validated, error } = validateOverrideForWrite(override);
	if (error || !validated) throw new Error(error ?? "invalid goal auditor override.");
	overrideRegistry().set(goalId, copyOverride(validated));
}

/** Remove the override for one goal id (no-op when absent). */
export function clearGoalAuditorOverride(goalId: string): void {
	overrideRegistry().delete(goalId);
}

/** The stored override for a goal id, as a copy, or undefined when none. */
export function getGoalAuditorOverride(goalId: string): GoalAuditorOverride | undefined {
	const stored = overrideRegistry().get(goalId);
	return stored ? copyOverride(stored) : undefined;
}

/**
 * Merge the goal's auditor override over the resolved settings. With no (or an
 * empty/fully-corrupt) override this returns the INPUT settings object
 * unchanged — the exact object and reference the plain /goal path has always
 * seen. With an override it returns a shallow copy whose `auditor` carries the
 * goal-level leaves over the global resolution; every non-overridden leaf
 * keeps the global value.
 */
export function mergeGoalAuditorOverride(settings: GoalSettings, goalId: string): GoalSettings {
	const override = validateOverrideForRead(overrideRegistry().get(goalId));
	if (!override) return settings;
	return {
		...settings,
		auditor: { ...(settings.auditor ?? {}), ...override },
	};
}

/**
 * The completion seam: load the global settings and merge the goal's auditor
 * override over them. This is the single function goal-completion.ts calls in
 * place of loadGoalSettings(ctx.cwd).
 */
export function loadGoalSettingsWithAuditorOverride(cwd: string, goalId: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	return mergeGoalAuditorOverride(loadGoalSettings(cwd, env), goalId);
}
