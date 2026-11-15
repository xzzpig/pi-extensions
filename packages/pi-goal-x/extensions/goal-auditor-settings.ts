/**
 * Fork-only completion-auditor settings: the schema (constants, types, leaf
 * table) behind the nested `auditor` group.
 *
 * Why this file exists: `goal-settings.ts` is an upstream file, and the fork's
 * auditor settings used to be enumerated six times inside it — the interface,
 * the ALLOWED key set, the parse switch, the resolve/assemble block, the
 * persisted-layer builder and the `/goal-status` provenance rows. Every new
 * leaf meant six edits, and every upstream sync replayed them by hand. The
 * leaf table below is now the single enumeration; `goal-settings.ts` keeps
 * only the thin drivers (parse, resolve, persist, report) that read it.
 *
 * Tier meaning (unchanged from the resolved-settings doc):
 *   - request tier: read per audit, effective immediately;
 *   - prompt-injection tier: read per audit, injected into the audit prompt;
 *   - definition tier: read at default-auditor registration (needs a new
 *     session or /reload).
 */

/** pi-subagents agent used for the review when none is configured. */
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
export const AUDITOR_PROJECT_RESOURCES_MIGRATION_NOTICE =
  "auditorProjectResources is deprecated and ignored. Configure the selected auditor agent's extensions, subagentOnlyExtensions, skills, and tools instead.";

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

/** Thinking levels the auditor request may ask for. Mirrors GOAL_THINKING_LEVELS. */
export const AUDITOR_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AuditorThinkingLevel = (typeof AUDITOR_THINKING_LEVELS)[number];

/** Default downward scan depth for unregistered nested repositories. */
export const DEFAULT_CHANGE_MANIFEST_DEPTH = 1;

export type AuditorTier = "request" | "prompt" | "definition";
/** How a leaf is written back into the sparse layer file. */
export type AuditorPersistence =
  /** write whenever the resolved value is not undefined */
  | "defined"
  /** write only when it differs from the documented default */
  | "nonDefault"
  /** write only when truthy (non-empty string) */
  | "truthy"
  /** write a copy whenever defined (lists) */
  | "list";

export type AuditorFieldKind =
  | "bool"
  | "int"
  | "timerInt"
  | "manifest"
  | "thinkingLevel"
  | "strictness"
  | "shortText"
  | "text"
  | "profile"
  | "list";

export interface AuditorFieldDescriptor {
  readonly key: keyof GoalAuditorSettings;
  /** Accepted spelling that normalizes onto {@link key} (e.g. thinking_level). */
  readonly alias?: string;
  readonly kind: AuditorFieldKind;
  readonly tier: AuditorTier;
  /** Resolved default; undefined means "absent from the resolved shape". */
  readonly defaultValue?: unknown;
  readonly persistence: AuditorPersistence;
  /** `/goal-status` row label. */
  readonly statusLabel: string;
  /** How the status row renders the value. */
  readonly statusFormat: "string" | "defaultText" | "textPresence" | "listPresence" | "boolean";
  /** Fallback text for `defaultText` when the leaf is unset. */
  readonly statusFallback?: string;
  /** Diagnostic text for an invalid value (the value itself is not echoed). */
  readonly invalidMessage: string;
}

/**
 * Nested completion-auditor settings. Sparse everywhere: every field optional,
 * absent = default behavior.
 */
export interface GoalAuditorSettings {
  // ── request tier ──
  /** Turn the independent completion review off (default false). */
  disabled?: boolean;
  /** pi-subagents agent used for the review; defaults to goal-auditor. */
  agent?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: AuditorThinkingLevel;
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

const boolField = (
  key: keyof GoalAuditorSettings,
  tier: AuditorTier,
  statusLabel: string,
  defaultValue: boolean | undefined,
  persistence: AuditorPersistence,
): AuditorFieldDescriptor => ({
  key,
  kind: "bool",
  tier,
  defaultValue,
  persistence,
  statusLabel,
  statusFormat: "boolean",
  invalidMessage: `auditor.${key} must be true or false`,
});

const textField = (
  key: keyof GoalAuditorSettings,
  tier: AuditorTier,
  statusLabel: string,
  statusFormat: AuditorFieldDescriptor["statusFormat"],
  persistence: AuditorPersistence,
): AuditorFieldDescriptor => ({
  key,
  kind: "shortText",
  tier,
  persistence,
  statusLabel,
  statusFormat,
  statusFallback: "(default)",
  invalidMessage: `auditor.${key}`,
});

const listField = (
  key: keyof GoalAuditorSettings,
  tier: AuditorTier,
  statusLabel: string,
): AuditorFieldDescriptor => ({
  key,
  kind: "list",
  tier,
  persistence: "list",
  statusLabel,
  statusFormat: "listPresence",
  invalidMessage: `auditor.${key}`,
});

/**
 * Source of truth for every `auditor.*` leaf, in the order `/goal-status`
 * prints them. Order is user-visible: keep existing rows in place when adding.
 */
export const AUDITOR_FIELDS: readonly AuditorFieldDescriptor[] = [
  boolField("disabled", "request", "auditor disabled", false, "defined"),
  {
    key: "agent",
    kind: "shortText",
    tier: "request",
    defaultValue: DEFAULT_AUDITOR_AGENT,
    persistence: "nonDefault",
    statusLabel: "auditor agent",
    statusFormat: "defaultText",
    statusFallback: DEFAULT_AUDITOR_AGENT,
    invalidMessage: "auditor.agent",
  },
  {
    key: "timeoutMs",
    kind: "timerInt",
    tier: "request",
    persistence: "defined",
    statusLabel: "auditor timeout (ms)",
    statusFormat: "defaultText",
    statusFallback: String(DEFAULT_AUDITOR_TIMEOUT_MS),
    invalidMessage: `auditor.timeoutMs must be an integer between 1 and ${MAX_AUDITOR_TIMEOUT_MS} (milliseconds)`,
  },
  textField("provider", "request", "auditor provider", "defaultText", "defined"),
  textField("model", "request", "auditor model", "defaultText", "defined"),
  {
    key: "thinkingLevel",
    alias: "thinking_level",
    kind: "thinkingLevel",
    tier: "request",
    persistence: "defined",
    statusLabel: "auditor thinking_level",
    statusFormat: "defaultText",
    statusFallback: "(default)",
    invalidMessage: `auditor.thinkingLevel must be one of: ${AUDITOR_THINKING_LEVELS.join(", ")}`,
  },
  {
    key: "changeManifest",
    kind: "manifest",
    tier: "request",
    defaultValue: "auto",
    persistence: "defined",
    statusLabel: "auditor change manifest",
    statusFormat: "defaultText",
    statusFallback: "auto",
    invalidMessage: "auditor.changeManifest must be one of: auto, off",
  },
  {
    key: "changeManifestDepth",
    kind: "int",
    tier: "request",
    defaultValue: DEFAULT_CHANGE_MANIFEST_DEPTH,
    persistence: "defined",
    statusLabel: "auditor change manifest scan depth",
    statusFormat: "defaultText",
    statusFallback: String(DEFAULT_CHANGE_MANIFEST_DEPTH),
    invalidMessage: "auditor.changeManifestDepth must be an integer >= 0 (0 = no downward scan)",
  },
  boolField("warmContext", "request", "auditor warm context", true, "nonDefault"),
  {
    key: "strictness",
    kind: "strictness",
    tier: "prompt",
    defaultValue: "balanced",
    persistence: "nonDefault",
    statusLabel: "auditor strictness",
    statusFormat: "defaultText",
    statusFallback: "balanced",
    invalidMessage: `auditor.strictness must be one of: ${AUDITOR_STRICTNESS_LEVELS.join(", ")}`,
  },
  {
    ...textField("instructions", "prompt", "auditor instructions", "textPresence", "truthy"),
    kind: "text",
  },
  listField("checklist", "prompt", "auditor checklist (replaces default)"),
  listField("checklistExtra", "prompt", "auditor extra checklist items"),
  listField("evidenceRequests", "prompt", "auditor evidence requests"),
  textField("reportFormat", "prompt", "auditor report format", "textPresence", "truthy"),
  textField("feedbackNotes", "prompt", "auditor feedback notes", "textPresence", "truthy"),
  {
    ...textField(
      "systemPromptExtra",
      "definition",
      "auditor system prompt extra (next session)",
      "textPresence",
      "truthy",
    ),
    kind: "text",
  },
  listField("extensions", "definition", "auditor extensions (next session)"),
  listField("subagentOnlyExtensions", "definition", "auditor subagent-only extensions (next session)"),
  listField("skills", "definition", "auditor skills (next session)"),
  listField("skillPath", "definition", "auditor skill paths (next session)"),
  listField("tools", "definition", "auditor tools (next session)"),
  listField("excludeTools", "definition", "auditor excluded tools (next session)"),
  listField("mcpDirectTools", "definition", "auditor MCP direct tools (next session)"),
  listField("defaultReads", "definition", "auditor default reads (next session)"),
  boolField("inheritProjectContext", "definition", "auditor inherits project context (next session)", undefined, "defined"),
  boolField("inheritSkills", "definition", "auditor inherits skills (next session)", undefined, "defined"),
  {
    key: "sandbox",
    kind: "profile",
    tier: "definition",
    persistence: "defined",
    statusLabel: "auditor sandbox profile (next session)",
    statusFormat: "defaultText",
    statusFallback: "(unset)",
    invalidMessage: "auditor.sandbox",
  },
  {
    key: "permissionProfile",
    kind: "profile",
    tier: "definition",
    persistence: "defined",
    statusLabel: "auditor permission profile (next session)",
    statusFormat: "defaultText",
    statusFallback: "(unset)",
    invalidMessage: "auditor.permissionProfile",
  },
];

/** Canonical key for a configured spelling (`thinking_level` → `thinkingLevel`). */
export function auditorCanonicalKey(spelling: string): string | undefined {
  for (const field of AUDITOR_FIELDS) {
    if (field.key === spelling || field.alias === spelling) return field.key;
  }
  return undefined;
}

/** Every accepted `auditor.*` spelling (canonical keys plus aliases). */
export const ALLOWED_AUDITOR_KEYS: ReadonlySet<string> = new Set(
  AUDITOR_FIELDS.flatMap((field) => (field.alias ? [field.key as string, field.alias] : [field.key as string])),
);

/** Leaves that always carry a concrete resolved value. */
export const AUDITOR_DEFAULTED_FIELDS = AUDITOR_FIELDS.filter((field) => field.defaultValue !== undefined);

export const AUDITOR_FIELD_BY_KEY: ReadonlyMap<string, AuditorFieldDescriptor> = new Map(
  AUDITOR_FIELDS.map((field) => [field.key as string, field]),
);

/** Spelling (canonical key or alias) → descriptor, as written in the layer file. */
export const AUDITOR_FIELD_BY_SPELLING: ReadonlyMap<string, AuditorFieldDescriptor> = new Map(
  AUDITOR_FIELDS.flatMap((field) =>
    field.alias
      ? ([[field.key as string, field], [field.alias, field]] as const)
      : ([[field.key as string, field]] as const),
  ),
);
