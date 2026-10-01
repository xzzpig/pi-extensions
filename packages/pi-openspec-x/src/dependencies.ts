/**
 * Dependency state for pi-openspec-x (design D7; spec "可选依赖降级与受限模式
 * fail-closed").
 *
 * `@xzzpig/pi-sandbox` is a peer dependency, but the extension must load and
 * serve the official-track skills even when it cannot be imported. This module
 * is the single place that touches it:
 *
 * - `probeSandboxDependency` performs the lazy dynamic import at extension
 *   init. Success records the module facet; failure records a reason and never
 *   throws past the probe, so `resources_discover` and everything else keep
 *   working (the official track is unaffected by a missing sandbox).
 * - `requireRestrictedModeSupport` is the fail-closed gate for restricted
 *   modes (opsx planner / agent): it throws a typed
 *   {@link OpsxDependencyMissingError} when the sandbox is unavailable, so a
 *   restricted mode is refused instead of running unsandboxed.
 * - `probeSubagentsDependency` / `requireSubagentsSupport` are the same
 *   pattern for `@xzzpig/pi-subagents` (the runtime subagent registry): a
 *   missing pi-subagents only costs the four opsx subagents — the official
 *   track and direct main-session implementation are unaffected.
 *
 * The module specifier is kept as a plain string and resolved only through
 * `await import(...)`: a static value import would fail the whole extension
 * load when an optional peer is missing. (Type-only imports are erased at
 * runtime and stay.) Tests simulate a missing or broken module by injecting a
 * loader — node_modules is never touched.
 */
import type { SandboxProfileDefinition } from "@xzzpig/pi-sandbox";
import type { registerAgentViaEvents } from "@xzzpig/pi-subagents/agents";

import type { GoalStorageContextLike } from "./goal-base.ts";
import type {
  GoalChangeBaselineHandle,
  ReviewWindowDelta,
} from "./review-scope.ts";

/** The optional peer this module probes and records state for. */
export const SANDBOX_DEPENDENCY = "@xzzpig/pi-sandbox";

/** The optional peer backing the four opsx runtime subagents. */
export const SUBAGENTS_DEPENDENCY = "@xzzpig/pi-subagents";

/** The pi-subagents public entry the runtime registration goes through. */
const SUBAGENTS_AGENTS_MODULE = "@xzzpig/pi-subagents/agents";

/**
 * The slice of pi-sandbox this package uses after a successful load: runtime
 * profile registration (D4) and the per-session service lookup.
 */
export interface SandboxModuleFacet {
  registerSandboxProfiles(
    profiles: Record<string, SandboxProfileDefinition>,
  ): void;
  getSandboxService(sessionId?: string): SandboxServiceLike | null | undefined;
}

/** Minimal structural view of pi-sandbox's per-session SandboxService. */
export interface SandboxServiceLike {
  setProfile(
    profileName: string | undefined,
  ): Promise<{ ok: boolean; message?: string }>;
}

/** Injectable dynamic-import seam; tests reject it to simulate a missing module. */
export type SandboxModuleLoader = () => Promise<unknown>;

/**
 * What exactly stops working without the dependency: the message must be
 * self-explanatory about what is refused and what keeps working. The sandbox
 * consequence is exported because the per-session service lookup (mode.ts)
 * raises the same typed error through a second call site.
 */
export const SANDBOX_MISSING_CONSEQUENCE =
  "Restricted modes (opsx planner / agent) are refused (fail-closed); direct main-session implementation and the official openspec skills are unaffected.";
const SUBAGENTS_MISSING_CONSEQUENCE =
  "The four opsx subagents (opsx-gap-analysis, opsx-plan-review, opsx-worker, opsx-reviewer) cannot be registered or dispatched, so /opsx:plan review gates and agent implementation are unavailable (fail-closed); the official openspec skills and direct main-session implementation are unaffected.";

/**
 * A missing dependency must be a typed, self-explanatory failure: the
 * message names what is absent, says what is refused, and states what keeps
 * working without it.
 */
export class OpsxDependencyMissingError extends Error {
  /** The dependency that is missing, e.g. "@xzzpig/pi-sandbox". */
  readonly dependency: string;
  /** Why it is considered missing (import failure, service not published, ...). */
  readonly reason: string;

  constructor(dependency: string, reason: string, consequence: string) {
    super(
      `${dependency} is not available in this session: ${reason}. ${consequence}`,
    );
    this.name = "OpsxDependencyMissingError";
    this.dependency = dependency;
    this.reason = reason;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recorded state. `undefined` module + `undefined` reason means "not probed
 * yet", which is itself a refusal reason: restricted modes require a probe.
 */
let sandboxModule: SandboxModuleFacet | undefined;
let sandboxMissingReason: string | undefined;

export interface SandboxAvailability {
  available: boolean;
  /** Why the sandbox is unavailable; undefined when available or not probed. */
  reason?: string;
}

export function sandboxAvailability(): SandboxAvailability {
  if (sandboxModule) return { available: true };
  return {
    available: false,
    reason:
      sandboxMissingReason ??
      "pi-sandbox has not been probed yet (extension not initialized)",
  };
}

/**
 * Fail-closed gate for restricted modes. Returns the recorded module facet so
 * the caller can proceed without a second lookup; throws a typed
 * {@link OpsxDependencyMissingError} otherwise.
 */
export function requireRestrictedModeSupport(): SandboxModuleFacet {
  if (sandboxModule) return sandboxModule;
  throw new OpsxDependencyMissingError(
    SANDBOX_DEPENDENCY,
    sandboxMissingReason ??
      "pi-sandbox has not been probed yet (extension not initialized)",
    SANDBOX_MISSING_CONSEQUENCE,
  );
}

/**
 * Resolve the sandbox service published for this session.
 *
 * Returns undefined — never throws — when the module was not loaded, the
 * service lookup fails, or the published object does not expose `setProfile`.
 * Callers must treat undefined as "sandbox controls unavailable" and refuse
 * restricted modes instead of assuming success.
 */
export async function loadSessionSandboxService(
  sessionId: string | undefined,
): Promise<SandboxServiceLike | undefined> {
  if (!sandboxModule) return undefined;
  let service: SandboxServiceLike | null | undefined;
  try {
    service = sandboxModule.getSandboxService(sessionId);
  } catch {
    return undefined;
  }
  if (!service || typeof service.setProfile !== "function") return undefined;
  return service;
}

/**
 * Record a sandbox failure discovered outside the probe (e.g. profile
 * registration threw at init). Downgrades the recorded state so the
 * fail-closed gate keeps refusing restricted modes with the actual reason.
 */
export function noteSandboxUnavailable(reason: string): void {
  sandboxModule = undefined;
  sandboxMissingReason = reason;
}

export interface SandboxProbeResult {
  available: boolean;
  /** Present (with `module`) when available; the refusal reason otherwise. */
  reason?: string;
  module?: SandboxModuleFacet;
}

function defaultLoader(): Promise<unknown> {
  return import(SANDBOX_DEPENDENCY);
}

/**
 * Probe pi-sandbox through an injectable dynamic import and record the result.
 * A missing or shape-incompatible module is recorded as dependency state and
 * returned as a plain result — this function never throws past the loader.
 */
export async function probeSandboxDependency(
  loader: SandboxModuleLoader = defaultLoader,
): Promise<SandboxProbeResult> {
  let loaded: unknown;
  try {
    loaded = await loader();
  } catch (error) {
    noteSandboxUnavailable(`dynamic import failed: ${describeError(error)}`);
    return { available: false, reason: sandboxMissingReason };
  }
  const facet = loaded as Partial<SandboxModuleFacet> | null | undefined;
  if (
    typeof facet?.registerSandboxProfiles !== "function" ||
    typeof facet.getSandboxService !== "function"
  ) {
    noteSandboxUnavailable(
      "module loaded but the expected exports (registerSandboxProfiles, getSandboxService) are missing; the installed pi-sandbox is incompatible",
    );
    return { available: false, reason: sandboxMissingReason };
  }
  sandboxModule = {
    registerSandboxProfiles: facet.registerSandboxProfiles,
    getSandboxService: facet.getSandboxService,
  };
  sandboxMissingReason = undefined;
  return { available: true, module: sandboxModule };
}

/** Reset the recorded dependency state. Test-only. */
export function resetDependencyStateForTests(): void {
  sandboxModule = undefined;
  sandboxMissingReason = undefined;
  subagentsModule = undefined;
  subagentsMissingReason = undefined;
  goalXModule = undefined;
  goalXMissingReason = undefined;
}

/**
 * The slice of pi-subagents this package uses after a successful load:
 * runtime agent registration through the installed owner's event bus.
 */
export interface SubagentsModuleFacet {
  registerAgentViaEvents: typeof registerAgentViaEvents;
}

/** Recorded subagents state, mirroring {@link SandboxAvailability}. */
export interface SubagentsAvailability {
  available: boolean;
  /** Why pi-subagents is unavailable; undefined when available or not probed. */
  reason?: string;
}

let subagentsModule: SubagentsModuleFacet | undefined;
let subagentsMissingReason: string | undefined;

/**
 * Fail-closed gate for everything that needs the runtime subagent registry
 * (agent registration now, delegation later). Returns the recorded module
 * facet; throws a typed {@link OpsxDependencyMissingError} otherwise.
 */
export function requireSubagentsSupport(): SubagentsModuleFacet {
  if (subagentsModule) return subagentsModule;
  throw new OpsxDependencyMissingError(
    SUBAGENTS_DEPENDENCY,
    subagentsMissingReason ??
      "pi-subagents has not been probed yet (extension not initialized)",
    SUBAGENTS_MISSING_CONSEQUENCE,
  );
}

function defaultSubagentsLoader(): Promise<unknown> {
  return import(SUBAGENTS_AGENTS_MODULE);
}

/**
 * Probe pi-subagents through an injectable dynamic import and record the
 * result. Same contract as {@link probeSandboxDependency}: never throws past
 * the loader; a missing or shape-incompatible module is recorded as
 * dependency state. A missing pi-subagents costs only the four opsx
 * subagents — the official track keeps working (spec "可选依赖降级").
 */
export async function probeSubagentsDependency(
  loader: SandboxModuleLoader = defaultSubagentsLoader,
): Promise<
  | { available: true; module: SubagentsModuleFacet }
  | { available: false; reason: string }
> {
  let loaded: unknown;
  try {
    loaded = await loader();
  } catch (error) {
    subagentsMissingReason = `dynamic import failed: ${describeError(error)}`;
    return { available: false, reason: subagentsMissingReason };
  }
  const facet = loaded as Partial<SubagentsModuleFacet> | null | undefined;
  if (typeof facet?.registerAgentViaEvents !== "function") {
    subagentsMissingReason =
      "module loaded but the expected export (registerAgentViaEvents) is missing; the installed pi-subagents is incompatible";
    return { available: false, reason: subagentsMissingReason };
  }
  subagentsModule = { registerAgentViaEvents: facet.registerAgentViaEvents };
  subagentsMissingReason = undefined;
  return { available: true, module: subagentsModule };
}

/**
 * The optional peer `/opsx:implement` runs on. Its absence must refuse the
 * implementation flow (fail-closed) while the official track and `/opsx:plan`
 * keep working.
 */
export const GOAL_X_DEPENDENCY = "@xzzpig/pi-goal-x";

const GOAL_X_MISSING_CONSEQUENCE =
  "/opsx:implement is refused (fail-closed); the official openspec skills and /opsx:plan are unaffected.";

/**
 * The slice of goal-x the implementation flow consumes: the per-goal auditor
 * override and cross-extension resolver (the S1/S2 fork seams) plus the
 * change-window delta used for the final review scope.
 */
export interface GoalXModuleFacet {
  setGoalAuditorOverride(
    goalId: string,
    override: Record<string, unknown>,
  ): void;
  clearGoalAuditorOverride(goalId: string): void;
  registerAuditorAgentResolver(
    resolver: (agentName: string) => object | undefined,
  ): () => void;
  readChangeBaseline(
    ctx: GoalStorageContextLike,
    goalId: string,
  ): GoalChangeBaselineHandle | undefined;
  computeChangeDelta(
    baseline: GoalChangeBaselineHandle,
    options?: { timeoutMs?: number },
  ): Promise<ReviewWindowDelta>;
}

/** Injectable dynamic-import seam; tests reject it to simulate a missing module. */
export type GoalXModuleLoader = () => Promise<Partial<GoalXModuleFacet>>;

const GOAL_X_OVERRIDE_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-auditor-override.ts";
const GOAL_X_RESOLVER_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-auditor-agent-resolver.ts";
const GOAL_X_BASELINE_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-change-baseline.ts";
const GOAL_X_DELTA_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-change-delta.ts";

async function defaultGoalXLoader(): Promise<Partial<GoalXModuleFacet>> {
  const overrideModule = (await import(
    GOAL_X_OVERRIDE_MODULE
  )) as Partial<GoalXModuleFacet>;
  const resolverModule = (await import(
    GOAL_X_RESOLVER_MODULE
  )) as Partial<GoalXModuleFacet>;
  const baselineModule = (await import(
    GOAL_X_BASELINE_MODULE
  )) as Partial<GoalXModuleFacet>;
  const deltaModule = (await import(
    GOAL_X_DELTA_MODULE
  )) as Partial<GoalXModuleFacet>;
  return {
    setGoalAuditorOverride: overrideModule.setGoalAuditorOverride,
    clearGoalAuditorOverride: overrideModule.clearGoalAuditorOverride,
    registerAuditorAgentResolver: resolverModule.registerAuditorAgentResolver,
    readChangeBaseline: baselineModule.readChangeBaseline,
    computeChangeDelta: deltaModule.computeChangeDelta,
  };
}

let goalXModule: GoalXModuleFacet | undefined;
let goalXMissingReason: string | undefined;

export interface GoalXAvailability {
  available: boolean;
  reason?: string;
}

export function goalXAvailability(): GoalXAvailability {
  if (goalXModule) return { available: true };
  return {
    available: false,
    reason:
      goalXMissingReason ??
      "pi-goal-x has not been probed yet (extension not initialized)",
  };
}

/**
 * Fail-closed gate for `/opsx:implement`. Returns the recorded goal-x facet;
 * throws a typed {@link OpsxDependencyMissingError} otherwise. The official
 * track and `/opsx:plan` never call this.
 */
export function requireGoalXSupport(): GoalXModuleFacet {
  if (goalXModule) return goalXModule;
  throw new OpsxDependencyMissingError(
    GOAL_X_DEPENDENCY,
    goalXMissingReason ??
      "pi-goal-x has not been probed yet (extension not initialized)",
    GOAL_X_MISSING_CONSEQUENCE,
  );
}

const GOAL_X_REQUIRED_EXPORTS = [
  "setGoalAuditorOverride",
  "clearGoalAuditorOverride",
  "registerAuditorAgentResolver",
  "readChangeBaseline",
  "computeChangeDelta",
] as const;

/** Narrow a partially-loaded goal-x facet to the full API this plugin needs. */
function isGoalXModuleFacet(
  value: Partial<GoalXModuleFacet>,
): value is GoalXModuleFacet {
  return GOAL_X_REQUIRED_EXPORTS.every(
    (name) => typeof value[name] === "function",
  );
}

/**
 * Probe pi-goal-x through an injectable dynamic import and record the result.
 * Never throws past the loader. A module that loads but lacks the fork APIs
 * the implementation flow requires (the S1 override, the S2 resolver, the
 * window delta) is recorded as incompatible — the same fail-closed outcome as
 * a missing module.
 */
export async function probeGoalXDependency(
  loader: GoalXModuleLoader = defaultGoalXLoader,
): Promise<
  | { available: true; module: GoalXModuleFacet }
  | { available: false; reason: string }
> {
  let facet: Partial<GoalXModuleFacet>;
  try {
    facet = await loader();
  } catch (error) {
    goalXMissingReason = `dynamic import failed: ${describeError(error)}`;
    return { available: false, reason: goalXMissingReason };
  }
  if (!isGoalXModuleFacet(facet)) {
    const missing = GOAL_X_REQUIRED_EXPORTS.filter(
      (name) => typeof facet[name] !== "function",
    );
    goalXMissingReason = `pi-goal-x loaded but required export(s) are missing: ${missing.join(
      ", ",
    )}; the installed pi-goal-x is incompatible with this plugin`;
    return { available: false, reason: goalXMissingReason };
  }
  goalXModule = facet;
  goalXMissingReason = undefined;
  return { available: true, module: facet };
}
