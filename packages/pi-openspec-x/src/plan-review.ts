/**
 * Plan review loop: verdict-driven decisions, the append-only plan ledger, and
 * the `reviews.md` projection (design D3/D6; openspec change add-pi-openspec-x,
 * task 7.2).
 *
 * The plan flow's facts live in an append-only JSONL ledger under the change
 * directory (`.opsx-plan-review.jsonl`): gap analyses, plan-review verdicts
 * with their rounds and blockers, delegation usage, and escalations.
 * `reviews.md` is a human-readable projection of that ledger — the ledger is
 * the source of truth, the markdown is derived.
 *
 * Gate decisions are purely structural (never parsed from free text):
 * - OKAY passes.
 * - ITERATE revises, but at most {@link MAX_ITERATE_ROUNDS} consecutive
 *   iterations before the user takes over.
 * - REJECT revises; a blocker that repeats from the previous round escalates
 *   immediately, because a review that raises the same blocker is not making
 *   progress.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { type ApprovalVia } from "./approval-gate.ts";

export type PlanVerdict = "OKAY" | "ITERATE" | "REJECT";

/** Structural view of pi-subagents' terminal delegation usage. */
export interface DelegationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
}

export interface PlanReviewRound {
  /** 1-based review round. */
  round: number;
  verdict: PlanVerdict;
  blockers: string[];
  summary?: string;
  usage?: DelegationUsage;
}

export const MAX_ITERATE_ROUNDS = 2;

export type ReviewAction =
  | { kind: "dispatch"; reason: string }
  | { kind: "pass"; round: number }
  | { kind: "revise"; round: number; reason: string }
  | { kind: "escalate"; round: number; reason: string };

function consecutiveIterates(history: readonly PlanReviewRound[]): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.verdict !== "ITERATE") break;
    count += 1;
  }
  return count;
}

/**
 * Normalize a blocker for the repeat check. Verdicts come from an LLM reviewer,
 * so the same finding routinely returns with different casing, padding, or
 * spacing between rounds; exact string equality would under-report repeats and
 * let a stuck loop keep "progressing". Comparison is therefore case-insensitive
 * on trimmed, whitespace-collapsed text.
 */
function normalizeBlocker(blocker: string): string {
  return blocker.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Decide what the plan flow does after the recorded verdicts. An empty history
 * means the first plan review still has to be dispatched.
 */
export function nextReviewAction(
  history: readonly PlanReviewRound[],
): ReviewAction {
  if (history.length === 0) {
    return {
      kind: "dispatch",
      reason: "No plan review has run yet; dispatch opsx-plan-review.",
    };
  }
  const last = history[history.length - 1]!;

  if (last.verdict === "OKAY") {
    return { kind: "pass", round: last.round };
  }

  if (last.verdict === "ITERATE") {
    const iterations = consecutiveIterates(history);
    if (iterations >= MAX_ITERATE_ROUNDS) {
      return {
        kind: "escalate",
        round: last.round,
        reason: `${iterations} consecutive ITERATE rounds reached the limit (${MAX_ITERATE_ROUNDS}); the user takes over.`,
      };
    }
    return {
      kind: "revise",
      round: last.round,
      reason: `ITERATE round ${last.round} of at most ${MAX_ITERATE_ROUNDS}; revise the plan and re-review.`,
    };
  }

  // REJECT: a blocker repeated from the previous round means the loop is stuck.
  const previous = history[history.length - 2];
  const previousBlockers = new Set(
    previous?.blockers.map(normalizeBlocker) ?? [],
  );
  const repeated = previous
    ? last.blockers.filter((blocker) =>
        previousBlockers.has(normalizeBlocker(blocker)),
      )
    : [];
  if (repeated.length > 0) {
    return {
      kind: "escalate",
      round: last.round,
      reason: `REJECT repeated blocker(s) from round ${previous!.round}: ${repeated.join("; ")}. The user takes over.`,
    };
  }
  return {
    kind: "revise",
    round: last.round,
    reason: `REJECT round ${last.round} with new blocker(s); revise the plan and re-review.`,
  };
}

// ── append-only ledger ──────────────────────────────────────────────────────

export type PlanReviewEntryType =
  | "gap_analysis"
  | "plan_review_verdict"
  | "plan_approval"
  | "escalation";

/** The user's plan decision, mirrored from the approval gate. */
export type PlanApprovalDecision =
  | "approved"
  | "revise"
  | "rejected"
  | "pending";

export interface PlanReviewEntry {
  /** ISO timestamp. */
  at: string;
  type: PlanReviewEntryType;
  round?: number;
  verdict?: PlanVerdict;
  /** The user's decision on a `plan_approval` entry. */
  decision?: PlanApprovalDecision;
  /** How the approval was requested (pi-ask / select / text). */
  via?: string;
  /** Gap-analysis findings, or the escalation reason. */
  findings?: string[];
  blockers?: string[];
  summary?: string;
  usage?: DelegationUsage;
}

/** Ledger file name inside the change directory. */
export const PLAN_REVIEW_LEDGER_FILE = ".opsx-plan-review.jsonl";
/** Human-readable projection file name inside the change directory. */
export const PLAN_REVIEWS_FILE = "reviews.md";

export function planReviewLedgerPath(changeDir: string): string {
  return path.join(changeDir, PLAN_REVIEW_LEDGER_FILE);
}

export function planReviewsPath(changeDir: string): string {
  return path.join(changeDir, PLAN_REVIEWS_FILE);
}

/** Append one entry to the change's plan ledger. Creates the directory. */
export function appendPlanReviewEntry(
  changeDir: string,
  entry: PlanReviewEntry,
): void {
  fs.mkdirSync(changeDir, { recursive: true });
  fs.appendFileSync(
    planReviewLedgerPath(changeDir),
    `${JSON.stringify(entry)}\n`,
    "utf-8",
  );
}

/**
 * Read the plan ledger. Malformed lines are skipped (an interrupted append
 * must not take the flow down); a missing file yields an empty ledger.
 */
export function readPlanReviewLedger(changeDir: string): PlanReviewEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(planReviewLedgerPath(changeDir), "utf-8");
  } catch {
    return [];
  }
  const entries: PlanReviewEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PlanReviewEntry;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.type === "string"
      ) {
        entries.push(parsed);
      }
    } catch {
      // Skip the damaged line; the ledger stays usable.
    }
  }
  return entries;
}

/** The review rounds in the ledger, in order. */
export function planReviewRounds(
  entries: readonly PlanReviewEntry[],
): PlanReviewRound[] {
  return entries
    .filter((entry) => entry.type === "plan_review_verdict" && entry.verdict)
    .map((entry) => ({
      round: entry.round ?? 0,
      verdict: entry.verdict!,
      blockers: entry.blockers ?? [],
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.usage ? { usage: entry.usage } : {}),
    }));
}

/** Sum delegation usage across the ledger's verdict rounds. */
export function totalDelegationUsage(
  entries: readonly PlanReviewEntry[],
): DelegationUsage {
  const total: DelegationUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turns: 0,
  };
  for (const entry of entries) {
    if (!entry.usage) continue;
    total.input += entry.usage.input;
    total.output += entry.usage.output;
    total.cacheRead += entry.usage.cacheRead;
    total.cacheWrite += entry.usage.cacheWrite;
    total.turns += entry.usage.turns;
  }
  return total;
}

/** Render the `reviews.md` projection of the ledger. */
export function renderReviewsMarkdown(
  entries: readonly PlanReviewEntry[],
): string {
  const lines = [
    "# Plan review record",
    "",
    "Projected from `.opsx-plan-review.jsonl` (append-only).",
    "",
  ];
  if (entries.length === 0) {
    lines.push("_No review entries yet._", "");
    return lines.join("\n");
  }
  for (const entry of entries) {
    if (entry.type === "gap_analysis") {
      lines.push(`## Gap analysis — ${entry.at}`, "");
      if (entry.summary) lines.push(entry.summary, "");
      for (const finding of entry.findings ?? []) lines.push(`- ${finding}`);
      lines.push("");
      continue;
    }
    if (entry.type === "plan_review_verdict") {
      lines.push(
        `## Plan review verdict — round ${entry.round ?? "?"} — ${entry.verdict ?? "?"} — ${entry.at}`,
        "",
      );
      if (entry.summary) lines.push(entry.summary, "");
      for (const blocker of entry.blockers ?? [])
        lines.push(`- Blocker: ${blocker}`);
      if (entry.usage) {
        lines.push(
          "",
          `Usage: input ${entry.usage.input}, output ${entry.usage.output}, turns ${entry.usage.turns}`,
        );
      }
      lines.push("");
      continue;
    }
    if (entry.type === "plan_approval") {
      lines.push(
        `## Plan approval — ${entry.decision ?? "?"} — ${entry.at}`,
        "",
        `Requested via: ${entry.via ?? "?"}`,
        "",
      );
      continue;
    }
    lines.push(`## Escalation — ${entry.at}`, "");
    for (const finding of entry.findings ?? []) lines.push(`- ${finding}`);
    lines.push("");
  }
  const total = totalDelegationUsage(entries);
  lines.push(
    "## Delegation usage (total)",
    "",
    `input ${total.input}, output ${total.output}, cacheRead ${total.cacheRead}, cacheWrite ${total.cacheWrite}, turns ${total.turns}`,
    "",
  );
  return lines.join("\n");
}

/**
 * Project the ledger to `reviews.md` in the change directory. Returns the
 * written path. The projection is derived state: callers may regenerate it at
 * any time.
 */
export function writeReviewsProjection(changeDir: string): string {
  const entries = readPlanReviewLedger(changeDir);
  const target = planReviewsPath(changeDir);
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(target, renderReviewsMarkdown(entries), "utf-8");
  return target;
}

/**
 * Record one gap analysis and refresh the projection. Gap analysis is advisory:
 * it never gates, so no decision is returned.
 */
export function recordGapAnalysis(
  changeDir: string,
  input: { findings: string[]; summary?: string; at?: string },
): PlanReviewEntry {
  const entry: PlanReviewEntry = {
    at: input.at ?? new Date().toISOString(),
    type: "gap_analysis",
    findings: [...input.findings],
    ...(input.summary ? { summary: input.summary } : {}),
  };
  appendPlanReviewEntry(changeDir, entry);
  writeReviewsProjection(changeDir);
  return entry;
}

/**
 * Record one plan-review verdict (round derived from the ledger), refresh the
 * projection, and return the gate decision the orchestrator must follow. The
 * caller never recomputes the round or the escalation policy.
 */
export function recordPlanReviewVerdict(
  changeDir: string,
  input: {
    verdict: PlanVerdict;
    blockers: string[];
    summary?: string;
    usage?: DelegationUsage;
    at?: string;
  },
): { entry: PlanReviewEntry; action: ReviewAction } {
  const rounds = planReviewRounds(readPlanReviewLedger(changeDir));
  const round = rounds.length + 1;
  const entry: PlanReviewEntry = {
    at: input.at ?? new Date().toISOString(),
    type: "plan_review_verdict",
    round,
    verdict: input.verdict,
    blockers: [...input.blockers],
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
  appendPlanReviewEntry(changeDir, entry);
  const action = nextReviewAction([
    ...rounds,
    { round, verdict: input.verdict, blockers: input.blockers },
  ]);
  writeReviewsProjection(changeDir);
  return { entry, action };
}

/** Record one escalation (the loop gave up and the user takes over). */
export function recordEscalation(
  changeDir: string,
  input: { reason: string; round?: number; at?: string },
): PlanReviewEntry {
  const entry: PlanReviewEntry = {
    at: input.at ?? new Date().toISOString(),
    type: "escalation",
    ...(input.round === undefined ? {} : { round: input.round }),
    findings: [input.reason],
  };
  appendPlanReviewEntry(changeDir, entry);
  writeReviewsProjection(changeDir);
  return entry;
}

/**
 * Record the user's plan decision in the ledger and refresh the projection.
 */
export function recordPlanApproval(
  changeDir: string,
  input: {
    changeId: string;
    decision: PlanApprovalDecision;
    via: string;
    at?: string;
  },
): PlanReviewEntry {
  const entry: PlanReviewEntry = {
    at: input.at ?? new Date().toISOString(),
    type: "plan_approval",
    decision: input.decision,
    via: input.via,
  };
  appendPlanReviewEntry(changeDir, entry);
  writeReviewsProjection(changeDir);
  return entry;
}

/** Narrow a stored `via` string to the approval gate's closed union. */
function asApprovalVia(value: string | undefined): ApprovalVia {
  return value === "pi-ask" || value === "select" || value === "text"
    ? value
    : "text";
}

/** The most recent recorded plan approval, if any (change id is the caller's). */
export function readPlanApproval(changeDir: string):
  | {
      decision: PlanApprovalDecision;
      via: ApprovalVia;
      at: string;
    }
  | undefined {
  const entries = readPlanReviewLedger(changeDir);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "plan_approval" || !entry.decision) continue;
    return {
      decision: entry.decision,
      via: asApprovalVia(entry.via),
      at: entry.at,
    };
  }
  return undefined;
}
