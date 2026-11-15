/**
 * Fork-only usage projection for the goal completion audit.
 *
 * Why this file exists: the fork reports the independent auditor's child spend
 * in pi's own tool-result `Usage` shape plus the supervisor side-channel spend,
 * so the host footer/`/session` accounts the audit. That is fork-only behaviour
 * that used to sit in the upstream `extensions/goal-completion.ts`; it is a
 * cohesion unit with no dependency on the completion lifecycle, so it lives
 * here and the upstream flow imports it.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationUsage } from "@xzzpig/pi-subagents/delegation";

import { formatAuditUsage } from "./goal-format.ts";
import type { GoalAuditorSupervisorHandoff } from "./goal-auditor-delegation.ts";

/**
 * Project pi-subagents child usage into pi's tool-result `Usage` shape so the
 * host accounts the audit spend in this session (footer `$`, `/session` Cost,
 * `getSessionStats`). pi only counts a tool result that carries `totalTokens`
 * and an object `cost` with a `total`; pi-subagents' own `Usage` reports `cost`
 * as a plain number, so it cannot be attached as-is. Absent usage leaves the
 * result untouched, so every completion branch keeps its previous shape when
 * the delegation reported no usage.
 */
export function withAuditorUsage<T extends AgentToolResult<unknown>>(result: T, usage: SubagentDelegationUsage | undefined): T {
	if (!usage) return result;
	return {
		...result,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
		},
	};
}

/**
 * Add the independent side-channel spend to the tool's own usage projection.
 * `totalTokens` and `cost.total` keep their meaning, so host session statistics
 * recognise the combined figure; the goal's parent-turn budget
 * (`goal.usage.tokensUsed`) is never touched by this path.
 */
export function withSupervisorUsage<T extends AgentToolResult<unknown>>(
	result: T,
	usage: GoalAuditorSupervisorHandoff["usage"] | undefined,
): T {
	if (!usage || usage.turns <= 0) return result;
	// The side counters themselves must be representable before anything is summed.
	const sideCounters = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.tokens, usage.costUsd];
	if (!sideCounters.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return result;
	const current = (result as { usage?: Record<string, unknown> }).usage;
	const currentCost = (current?.cost as { total?: unknown } | undefined)?.total;
	const numeric = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
	const cost = numeric(currentCost);
	const projected = {
		input: numeric(current?.input) + usage.inputTokens,
		output: numeric(current?.output) + usage.outputTokens,
		cacheRead: numeric(current?.cacheRead) + usage.cacheReadTokens,
		cacheWrite: numeric(current?.cacheWrite) + usage.cacheWriteTokens,
		totalTokens: numeric(current?.totalTokens) + usage.tokens,
	};
	const costTotal = cost + usage.costUsd;
	// A sum can still overflow even when every addend is finite: never publish an
	// Infinity/NaN usage to host statistics; fall back to the auditor's own usage.
	if (![...Object.values(projected), costTotal].every((value) => Number.isFinite(value))) return result;
	return {
		...result,
		usage: {
			...projected,
			cost: {
				...(current?.cost as object | undefined),
				total: costTotal,
			},
		},
	} as T;
}

/** Total child tokens the auditor burned, across every counter the child reported. */
export function auditorTokens(usage: SubagentDelegationUsage | undefined): number {
	if (!usage) return 0;
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Audit-card line for the child spend, or undefined when the child reported none. */
export function auditorUsageLine(usage: SubagentDelegationUsage | undefined): string | undefined {
	if (!usage) return undefined;
	return formatAuditUsage({ tokens: auditorTokens(usage), costUsd: usage.cost, turns: usage.turns });
}
