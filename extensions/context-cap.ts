import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * pi-context-cap
 *
 * Enforces a context token budget (default 200k) by forcing compaction,
 * instead of letting pi ride a long-context model up to 1M tokens.
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
 * Known limit: the request that crosses the threshold still goes out before
 * its turn_end fires. Overshoot is bounded to about one request; only a core
 * agent-loop check can remove it.
 */

const DEFAULT_BUDGET = 200_000;
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
	let budget = DEFAULT_BUDGET;
	let reserve = DEFAULT_RESERVE;
	let enabled = true;
	let autoResume = true;

	let compactionInFlight = false;
	let consecutiveFailures = 0;
	let failureDisabled = false;
	let lastFireTokens: number | null = null;

	const compactAt = () => budget - reserve;

	pi.registerFlag("context-cap", {
		type: "string",
		description: `Context token budget enforced by forced compaction (default ${DEFAULT_BUDGET})`,
	});
	pi.registerFlag("context-cap-reserve", {
		type: "string",
		description: `Headroom below the budget before compaction fires (default ${DEFAULT_RESERVE})`,
	});

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!enabled || failureDisabled) {
			ctx.ui.setStatus("context-cap", "cap off");
			return;
		}
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens == null) {
			ctx.ui.setStatus("context-cap", `cap ?/${fmtK(budget)}`);
			return;
		}
		const pct = Math.round((tokens / budget) * 100);
		ctx.ui.setStatus("context-cap", `cap ${fmtK(tokens)}/${fmtK(budget)} (${pct}%)`);
	};

	// Returns true when it started a compaction.
	const compactIfOverBudget = (ctx: ExtensionContext, resumeAfter: boolean): boolean => {
		if (!enabled || failureDisabled || compactionInFlight) return false;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.tokens <= compactAt()) return false;
		if (lastFireTokens !== null && usage.tokens <= lastFireTokens + REFIRE_GROWTH_TOKENS) return false;

		lastFireTokens = usage.tokens;
		compactionInFlight = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`context-cap: ${usage.tokens.toLocaleString()} tokens exceeds ${compactAt().toLocaleString()}, compacting`,
				"info",
			);
		}
		ctx.compact({
			onComplete: () => {
				compactionInFlight = false;
				consecutiveFailures = 0;
				lastFireTokens = null;
				if (ctx.hasUI) ctx.ui.notify("context-cap: compaction completed", "info");
				updateStatus(ctx);
				if (resumeAfter && autoResume) {
					pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
				}
			},
			onError: (error) => {
				compactionInFlight = false;
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
		budget = parseTokens(pi.getFlag("context-cap")) ?? DEFAULT_BUDGET;
		reserve = parseTokens(pi.getFlag("context-cap-reserve")) ?? DEFAULT_RESERVE;
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
				const tokens = usage?.tokens != null ? `${usage.tokens.toLocaleString()} tokens used` : "usage unknown";
				const state = failureDisabled ? "disabled (repeated failures)" : enabled ? "active" : "off";
				const model = ctx.model;
				ctx.ui.notify(
					`context-cap: budget ${budget.toLocaleString()}, compacts at ~${compactAt().toLocaleString()}, resume ${autoResume ? "on" : "off"} — ${tokens}, ${state}. Model ${model ? `${model.provider}/${model.id}` : "none"} window ${model?.contextWindow.toLocaleString() ?? "?"} (untouched).`,
					"info",
				);
				return;
			}

			if (arg === "off") {
				enabled = false;
				updateStatus(ctx);
				ctx.ui.notify("context-cap: off for this session", "info");
				return;
			}

			if (arg === "on") {
				enabled = true;
				failureDisabled = false;
				consecutiveFailures = 0;
				updateStatus(ctx);
				ctx.ui.notify(`context-cap: on, budget ${budget.toLocaleString()}`, "info");
				return;
			}

			if (arg === "resume on" || arg === "resume off") {
				autoResume = arg === "resume on";
				ctx.ui.notify(`context-cap: auto-resume after mid-task compaction ${autoResume ? "on" : "off"}`, "info");
				return;
			}

			const tokens = parseTokens(arg);
			if (tokens === null) {
				ctx.ui.notify(`context-cap: unrecognized argument "${args.trim()}" (use: status | <tokens> | off | on | resume on|off)`, "error");
				return;
			}
			if (tokens <= reserve) {
				ctx.ui.notify(`context-cap: budget must be larger than the reserve (${reserve.toLocaleString()})`, "error");
				return;
			}
			budget = tokens;
			updateStatus(ctx);
			ctx.ui.notify(`context-cap: budget set to ${budget.toLocaleString()} for this session`, "info");
		},
	});
}
