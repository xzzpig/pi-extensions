/**
 * Fork-only budget policy for pi-context-cap.
 *
 * Why this file exists: the upstream extension computed one fixed budget with a
 * fixed reserve. The fork derives the budget from the active model's
 * `contextWindow`, honours an explicit flag/config budget, reports *why* the
 * guard is off, and gates on a model whitelist plus a session override. Those
 * rules are pure functions over the extension's mutable state, so they live
 * here instead of inside the upstream `extensions/context-cap.ts` factory — the
 * factory keeps one-line wrappers that read the current state.
 *
 * Everything here is side-effect free: each entry point takes the state it
 * needs, so the stateful executor (`compactIfOverBudget`, `updateStatus`,
 * event handlers) stays upstream and can be tested through the real factory.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isModelAllowed } from "./whitelist.js";

/** Budget when the model exposes no `contextWindow`. */
export const DEFAULT_BUDGET = 200_000;
/**
 * Safety margin kept between the compaction point and the model's real
 * contextWindow, mirroring pi-ai's CONTEXT_SAFETY_TOKENS so `max_tokens` is
 * never starved right at the threshold.
 */
export const WINDOW_SAFETY_TOKENS = 4_096;

export type Override = "default" | "on" | "off";

export interface LoadedWhitelist {
  models?: string[];
}

/** Mutable settings the policy reads (owned by the factory). */
export interface BudgetSettings {
  /** `/context-cap <tokens>` override for this session. */
  sessionBudget: number | null;
  /** `--context-cap` flag or config `budget`, resolved at session_start. */
  explicitBudget: number | null;
  reserve: number;
}

/** Budget settings plus the guard state `isActiveForModel`/`activeState` read. */
export interface GuardState extends BudgetSettings {
  override: Override;
  failureDisabled: boolean;
  loadedConfig: LoadedWhitelist;
  patternWarnings: string[];
}

/** The model's configured context window, or null when pi did not expose one. */
export const windowTokens = (ctx: ExtensionContext): number | null => {
  const w = ctx.model?.contextWindow;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null;
};

/**
 * Effective budget for the active model. Explicit settings win; otherwise the
 * budget IS the model's configured contextWindow — the guard then acts as pi's
 * native compaction threshold (`contextWindow - reserveTokens`), enforced
 * mid-loop. The 200000 default only applies when the model exposes no window.
 * Returns null when the window is too small to leave the safety margin (the
 * guard must stay off).
 */
export const effectiveBudget = (
  settings: BudgetSettings,
  ctx: ExtensionContext,
): number | null => {
  if (settings.sessionBudget != null) return settings.sessionBudget;
  if (settings.explicitBudget != null) return settings.explicitBudget;
  const w = windowTokens(ctx);
  if (w === null) return DEFAULT_BUDGET;
  if (w <= WINDOW_SAFETY_TOKENS) return null;
  return w;
};

/**
 * Compaction point: never beyond `budget - reserve`, and never beyond the
 * model's configured contextWindow minus the safety margin.
 */
export const compactAt = (
  settings: BudgetSettings,
  ctx: ExtensionContext,
): number | null => {
  const budget = effectiveBudget(settings, ctx);
  if (budget === null) return null;
  const raw = budget - settings.reserve;
  const w = windowTokens(ctx);
  if (w === null) return raw;
  return Math.min(raw, w - WINDOW_SAFETY_TOKENS);
};

/** Compaction entries on the branch pi has completed so far. */
export const countCompactions = (ctx: ExtensionContext): number =>
  ctx.sessionManager
    ?.getBranch()
    .filter((entry) => entry.type === "compaction").length ?? 0;

/**
 * Whether pi compacted the session since the guard fired.
 *
 * `ctx.compact()` aborts the run before compacting, and that run-end moment
 * lets pi's native auto-compaction check fire: with a window-derived budget the
 * two thresholds are identical, so the native pass can compact first and leave
 * the manual pass nothing to do. Comparing branch compaction entries classifies
 * this by outcome, without matching on error message text.
 */
export const compactedSinceFire = (
  ctx: ExtensionContext,
  compactionsAtFire: number | null,
): boolean =>
  compactionsAtFire !== null && countCompactions(ctx) > compactionsAtFire;

/** Why the guard is off for the active model, or null when it can run. */
export const disabledReason = (
  settings: BudgetSettings,
  ctx: ExtensionContext,
): string | null => {
  const { explicitBudget, reserve } = settings;
  if (explicitBudget !== null && reserve >= explicitBudget) {
    return `config error: reserve (${reserve.toLocaleString()}) must be smaller than budget (${explicitBudget.toLocaleString()})`;
  }
  const w = windowTokens(ctx);
  // A window too small to leave the safety margin cannot host a compaction
  // point, regardless of any explicit budget.
  if (w !== null && w <= WINDOW_SAFETY_TOKENS) {
    return `model window too small to leave the safety margin (contextWindow ≤ ${WINDOW_SAFETY_TOKENS})`;
  }
  const budget = effectiveBudget(settings, ctx);
  if (budget === null) {
    return `model window too small to leave the safety margin (contextWindow ≤ ${WINDOW_SAFETY_TOKENS})`;
  }
  if (reserve >= budget) {
    return `model window too small for the configured reserve (window ≈ ${budget.toLocaleString()})`;
  }
  return null;
};

/** Whether the guard enforces for the active model (whitelist + override). */
export const isActiveForModel = (
  state: GuardState,
  ctx: ExtensionContext,
): boolean => {
  if (disabledReason(state, ctx) !== null) return false;
  if (state.override === "on") return true;
  if (state.override === "off") return false;
  const model = ctx.model;
  return isModelAllowed(model?.provider, model?.id, state.loadedConfig);
};

/** One-line guard state for `/context-cap status`. */
export const activeState = (state: GuardState, ctx: ExtensionContext): string => {
  const reason = disabledReason(state, ctx);
  if (reason !== null) return `disabled (${reason})`;
  if (state.failureDisabled) return "disabled (repeated failures)";
  if (state.override === "on") return "active (session override)";
  if (state.override === "off") return "off (session override)";
  const model = ctx.model;
  const allowed = isModelAllowed(model?.provider, model?.id, state.loadedConfig);
  return allowed
    ? "active (whitelisted model)"
    : `off (model not whitelisted${state.patternWarnings.length ? "; " + state.patternWarnings.join("; ") : ""})`;
};
