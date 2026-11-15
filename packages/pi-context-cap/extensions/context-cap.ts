import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  activeState as policyActiveState,
  compactAt as policyCompactAt,
  compactedSinceFire as policyCompactedSinceFire,
  countCompactions,
  DEFAULT_BUDGET,
  disabledReason as policyDisabledReason,
  effectiveBudget as policyEffectiveBudget,
  type GuardState,
  isActiveForModel as policyIsActiveForModel,
  type Override,
  windowTokens,
} from "./budget-policy.js";
import { loadConfig, parseTokens as parseTokensStrict } from "./config.js";
import { invalidPatterns } from "./whitelist.js";

/**
 * pi-context-cap (fork of @lukeramsden/pi-context-cap)
 *
 * Enforces a context token budget by forcing compaction, instead of letting
 * pi ride a long-context model up to 1M tokens. Without an explicit budget
 * (flag, config file, `/context-cap <tokens>`), the budget is the active
 * model's configured contextWindow — the guard then acts as pi's native
 * compaction threshold (contextWindow - reserve), enforced mid-loop — and
 * the 200000 default only applies when the model does not expose a window.
 * The compaction point is always clamped to contextWindow - 4096.
 *
 * This deliberately does NOT lower `model.contextWindow`. Pi clamps every
 * request's output budget to `contextWindow - estimatedInput - 4096` (pi-ai
 * `clampMaxTokensToContext`, floor 1 token). A lowered window strangles
 * max_tokens as usage nears the cap, causing "maximum output token limit"
 * truncations right before compaction. Leaving the real window intact keeps
 * max_tokens at the model's full output size; the budget lives only here.
 *
 * Pi (as of 0.83.0) checks auto-compaction only after a full agent run and
 * before a new user prompt, never between LLM calls in a tool loop (pi issues
 * #2871, #5512, #6879; enabling hook tracked in #7299 / PR #7367). So this
 * extension triggers compaction itself:
 *
 * - turn_end (turn produced tool results): the loop would continue; compact
 *   now. ctx.compact() aborts the run, so a follow-up prompt is sent to
 *   resume the task. getContextUsage() includes estimated trailing
 *   tool-result tokens, which pi's own check misses.
 * - agent_settled: the run is done and pi will not continue on its own;
 *   compact quietly so the next prompt starts under budget.
 * - session_start: a resumed session may already be over budget; compact.
 *
 * The abort above opens pi's run-end auto-compaction check mid-loop: with a
 * window-derived budget both thresholds are identical, so the native pass can
 * compact first and our manual pass fails with "nothing to compact". That
 * outcome is detected by comparing branch compaction entries (never by error
 * text) and treated as success — pi already continued the run.
 *
 * Fork additions (see README fork notice):
 * - Model whitelist config (`context-cap.json` in the pi agent dir and the
 *   project dir), matching `provider/modelId` or bare `modelId` globs.
 * - Tri-state session toggle: `/context-cap on|off` overrides the whitelist
 *   for the current session (default = follow the whitelist).
 *
 * Known limit: the request that crosses the threshold still goes out before
 * its turn_end fires. Overshoot is bounded to about one request; only a core
 * agent-loop check can remove it.
 */

// Headroom below the budget, mirroring pi's default compaction reserveTokens.
const DEFAULT_RESERVE = 16_384;
// After a triggered compaction fails, require this much token growth before
// firing again. Bounds summarization churn if compaction cannot get under
// budget.
const REFIRE_GROWTH_TOKENS = 20_000;

const CONTINUE_PROMPT =
	"Context was auto-compacted mid-task to stay within the configured context budget. Continue the task from the compaction summary and remaining context.";

function parseTokens(raw: unknown): number | null {
	if (raw === undefined || raw === null) return null;
	const n = Number.parseInt(String(raw).replace(/[_,]/g, ""), 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function fmtK(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

export default function (pi: ExtensionAPI) {
  // Explicit budget for the session: `--context-cap` flag or config `budget`
  // (resolved at session_start) overridden by `/context-cap <tokens>`. Null
  // means the budget follows the active model's contextWindow.
  let explicitBudget: number | null = null;
  let sessionBudget: number | null = null;
	let reserve = DEFAULT_RESERVE;
  // Session switch: "default" follows the whitelist, "on" forces active,
  // "off" forces inactive. Reset at session_start, never persisted.
  let override: Override = "default";
	let autoResume = true;

	let compactionInFlight = false;
	let consecutiveFailures = 0;
	let failureDisabled = false;
	let lastFireTokens: number | null = null;
  // Compaction-entry count on the branch captured when a compaction was
  // triggered; used to detect "a compaction already completed since we
  // fired" without matching on error message text.
  let compactionsAtFire: number | null = null;
  // Config-load warnings (bad JSON/types, bad flag values) — reported once at
  // session_start, unrelated to the whitelist state.
  let configWarnings: string[] = [];
  // Invalid whitelist patterns — treated as non-matching, so they belong in
  // the whitelist reason alongside "model not whitelisted".
  let patternWarnings: string[] = [];

  // Budget policy lives in the fork-only `budget-policy.ts`; these wrappers read
  // the current factory state so call sites stay unchanged.
  const budgetState = (): GuardState => ({
    sessionBudget,
    explicitBudget,
    reserve,
    override,
    failureDisabled,
    loadedConfig,
    patternWarnings,
  });
  const effectiveBudget = (ctx: ExtensionContext) =>
    policyEffectiveBudget(budgetState(), ctx);
  const compactAt = (ctx: ExtensionContext) =>
    policyCompactAt(budgetState(), ctx);
  const compactedSinceFire = (ctx: ExtensionContext) =>
    policyCompactedSinceFire(ctx, compactionsAtFire);
  const disabledReason = (ctx: ExtensionContext) =>
    policyDisabledReason(budgetState(), ctx);
  const isActiveForModel = (ctx: ExtensionContext) =>
    policyIsActiveForModel(budgetState(), ctx);
  const activeState = (ctx: ExtensionContext) =>
    policyActiveState(budgetState(), ctx);

  // Loaded whitelist config (kept separate from budget/reserve which are
  // merged with flags below).
  let loadedConfig: { models?: string[] } = {};

	pi.registerFlag("context-cap", {
		type: "string",
    description: `Context token budget enforced by forced compaction (default: the model's configured contextWindow; ${DEFAULT_BUDGET} when unknown)`,
	});
	pi.registerFlag("context-cap-reserve", {
		type: "string",
		description: `Headroom below the budget before compaction fires (default ${DEFAULT_RESERVE})`,
	});

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
    if (!isActiveForModel(ctx) || failureDisabled) {
			ctx.ui.setStatus("context-cap", "cap off");
			return;
		}
    const budget = effectiveBudget(ctx);
		const tokens = ctx.getContextUsage()?.tokens;
    if (tokens == null || budget === null) {
      ctx.ui.setStatus(
        "context-cap",
        `cap ?/${budget == null ? "-" : fmtK(budget)}`,
      );
			return;
		}
		const pct = Math.round((tokens / budget) * 100);
    ctx.ui.setStatus(
      "context-cap",
      `cap ${fmtK(tokens)}/${fmtK(budget)} (${pct}%)`,
    );
	};

	// Returns true when it started a compaction.
  const compactIfOverBudget = (
    ctx: ExtensionContext,
    resumeAfter: boolean,
  ): boolean => {
    if (!isActiveForModel(ctx) || failureDisabled || compactionInFlight)
      return false;
		const usage = ctx.getContextUsage();
    const at = compactAt(ctx);
    if (at === null) return false;
    if (!usage || usage.tokens === null || usage.tokens <= at) return false;
    if (
      lastFireTokens !== null &&
      usage.tokens <= lastFireTokens + REFIRE_GROWTH_TOKENS
    )
      return false;

		lastFireTokens = usage.tokens;
    compactionsAtFire = countCompactions(ctx);
		compactionInFlight = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
        `context-cap: ${usage.tokens.toLocaleString()} tokens exceeds ${at.toLocaleString()}, compacting`,
				"info",
			);
		}
		ctx.compact({
			onComplete: () => {
				compactionInFlight = false;
				consecutiveFailures = 0;
				lastFireTokens = null;
        compactionsAtFire = null;
        if (ctx.hasUI)
          ctx.ui.notify("context-cap: compaction completed", "info");
				updateStatus(ctx);
				if (resumeAfter && autoResume) {
					pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
				}
			},
			onError: (error) => {
				compactionInFlight = false;
        if (compactedSinceFire(ctx)) {
          // The goal (staying under budget) was already achieved by the other
          // compaction, and pi continued the run itself, so no resume prompt
          // is needed. Not a failure: don't count it towards disabling.
          consecutiveFailures = 0;
          lastFireTokens = null;
          compactionsAtFire = null;
          if (ctx.hasUI) {
            ctx.ui.notify(
              "context-cap: context was already compacted; nothing to do",
              "info",
            );
            updateStatus(ctx);
          }
          return;
        }
        compactionsAtFire = null;
				consecutiveFailures += 1;
				if (consecutiveFailures >= 2) {
					failureDisabled = true;
				}
				if (ctx.hasUI) {
					ctx.ui.notify(
						`context-cap: compaction failed: ${error.message}${failureDisabled ? " — disabled for this session" : ""}`,
						"error",
					);
					updateStatus(ctx);
				}
			},
		});
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		compactionInFlight = false;
		consecutiveFailures = 0;
		failureDisabled = false;
		lastFireTokens = null;
    compactionsAtFire = null;
    override = "default";
    autoResume = true;

    // Load config files first (global + trusted project), then let CLI
    // flags act as the session baseline, then command changes win.
    const { config, warnings } = loadConfig(ctx);
    configWarnings = [...warnings];
    patternWarnings = invalidPatterns(config).map(
      (p) => `invalid pattern "${p}"`,
    );
    loadedConfig = { models: config.models };

    const flagBudgetRaw = pi.getFlag("context-cap");
    const flagReserveRaw = pi.getFlag("context-cap-reserve");
    explicitBudget = parseTokensStrict(flagBudgetRaw) ?? config.budget ?? null;
    sessionBudget = null;
    reserve = parseTokensStrict(flagReserveRaw) ?? config.reserve ?? DEFAULT_RESERVE;
    if (flagBudgetRaw != null && parseTokensStrict(flagBudgetRaw) === null) {
      configWarnings.push(
        `--context-cap "${flagBudgetRaw}" must be a positive token count; ignoring it`,
      );
    }
    if (flagReserveRaw != null && parseTokensStrict(flagReserveRaw) === null) {
      configWarnings.push(
        `--context-cap-reserve "${flagReserveRaw}" must be a positive token count; ignoring it`,
      );
    }

    if (disabledReason(ctx) !== null) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `context-cap: ${disabledReason(ctx)}; guard disabled for this session`,
          "error",
        );
      }
      for (const warning of configWarnings) {
        if (ctx.hasUI) ctx.ui.notify(`context-cap: ${warning}`, "warning");
      }
      updateStatus(ctx);
      return;
    }

    for (const warning of [...configWarnings, ...patternWarnings]) {
      if (ctx.hasUI) ctx.ui.notify(`context-cap: ${warning}`, "warning");
    }
		updateStatus(ctx);
		// A resumed session may already be over budget.
		compactIfOverBudget(ctx, false);
	});

	// Mid-loop backpressure. turn_end fires after each LLM response in a tool
	// loop; act when the loop would continue (the turn produced tool results).
	pi.on("turn_end", (event, ctx) => {
		updateStatus(ctx);
		if (!event.toolResults || event.toolResults.length === 0) return;
		compactIfOverBudget(ctx, true);
	});

	// Run finished and pi will not continue on its own. Pi's own threshold
	// check measures against the model's real window, so enforce the budget
	// here for the final turn's growth. No resume needed.
	pi.on("agent_settled", (_event, ctx) => {
		updateStatus(ctx);
		compactIfOverBudget(ctx, false);
	});

	pi.registerCommand("context-cap", {
		description: "Context budget: status | <tokens> | off | on | resume on|off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "" || arg === "status") {
				const usage = ctx.getContextUsage();
        const tokens =
          usage?.tokens != null
            ? `${usage.tokens.toLocaleString()} tokens used`
            : "usage unknown";
				const model = ctx.model;
        const budget = effectiveBudget(ctx);
        const at = compactAt(ctx);
        // Annotate where the budget came from when it was not set explicitly.
        let source = "";
        if (sessionBudget == null && explicitBudget == null) {
          source =
            windowTokens(ctx) !== null ? " (model window)" : " (default)";
        }
				ctx.ui.notify(
          `context-cap: budget ${budget?.toLocaleString() ?? "n/a"}${source}, compacts at ~${at?.toLocaleString() ?? "n/a"}, resume ${autoResume ? "on" : "off"} — ${tokens}, ${activeState(ctx)}. Model ${model ? `${model.provider}/${model.id}` : "none"} window ${model?.contextWindow?.toLocaleString() ?? "?"} (untouched).`,
					"info",
				);
				return;
			}

			if (arg === "off") {
        override = "off";
				updateStatus(ctx);
				ctx.ui.notify("context-cap: off for this session", "info");
				return;
			}

			if (arg === "on") {
        override = "on";
				failureDisabled = false;
				consecutiveFailures = 0;
				updateStatus(ctx);
        const budget = effectiveBudget(ctx);
        ctx.ui.notify(
          `context-cap: on (forced), budget ${budget?.toLocaleString() ?? "n/a"}`,
          "info",
        );
        return;
      }

      if (arg === "default") {
        override = "default";
				updateStatus(ctx);
        ctx.ui.notify(
          "context-cap: back to default (follow model whitelist) for this session",
          "info",
        );
				return;
			}

			if (arg === "resume on" || arg === "resume off") {
				autoResume = arg === "resume on";
        ctx.ui.notify(
          `context-cap: auto-resume after mid-task compaction ${autoResume ? "on" : "off"}`,
          "info",
        );
				return;
			}

			const tokens = parseTokens(arg);
			if (tokens === null) {
        ctx.ui.notify(
          `context-cap: unrecognized argument "${args.trim()}" (use: status | <tokens> | off | on | default | resume on|off)`,
          "error",
        );
				return;
			}
			if (tokens <= reserve) {
        ctx.ui.notify(
          `context-cap: budget must be larger than the reserve (${reserve.toLocaleString()})`,
          "error",
        );
				return;
			}
      sessionBudget = tokens;
			updateStatus(ctx);
      ctx.ui.notify(
        `context-cap: budget set to ${tokens.toLocaleString()} for this session`,
        "info",
      );
		},
	});
}
