/**
 * Tests for the plan review loop (task 7.2): the verdict-driven escalation
 * policy, the append-only ledger, and the reviews.md projection.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendPlanReviewEntry,
  MAX_ITERATE_ROUNDS,
  nextReviewAction,
  planReviewLedgerPath,
  planReviewRounds,
  planReviewsPath,
  readPlanReviewLedger,
  recordGapAnalysis,
  recordPlanReviewVerdict,
  renderReviewsMarkdown,
  totalDelegationUsage,
  writeReviewsProjection,
  type PlanReviewEntry,
  type PlanReviewRound,
} from "../src/plan-review.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openspec-x-review-"));
  roots.push(root);
  return root;
}

function round(
  value: number,
  verdict: PlanReviewRound["verdict"],
  blockers: string[] = [],
): PlanReviewRound {
  return { round: value, verdict, blockers };
}

describe("nextReviewAction", () => {
  it("dispatches the first review when no verdict exists", () => {
    expect(nextReviewAction([])).toMatchObject({ kind: "dispatch" });
  });

  it("passes on OKAY", () => {
    expect(nextReviewAction([round(1, "OKAY")])).toEqual({
      kind: "pass",
      round: 1,
    });
  });

  it("revises once and escalates after two consecutive ITERATE rounds", () => {
    expect(
      nextReviewAction([round(1, "ITERATE", ["missing ref"])]),
    ).toMatchObject({ kind: "revise", round: 1 });
    const escalated = nextReviewAction([
      round(1, "ITERATE", ["missing ref"]),
      round(2, "ITERATE", ["thin tasks"]),
    ]);
    expect(escalated).toMatchObject({ kind: "escalate", round: 2 });
    expect(MAX_ITERATE_ROUNDS).toBe(2);
  });

  it("resets the ITERATE count after a non-ITERATE round", () => {
    expect(
      nextReviewAction([
        round(1, "ITERATE", ["a"]),
        round(2, "REJECT", ["b"]),
        round(3, "ITERATE", ["c"]),
      ]),
    ).toMatchObject({ kind: "revise", round: 3 });
  });

  it("revises a REJECT with new blockers and escalates a repeated blocker", () => {
    expect(
      nextReviewAction([
        round(1, "REJECT", ["undefined symbol foo"]),
        round(2, "REJECT", ["undefined symbol bar"]),
      ]),
    ).toMatchObject({ kind: "revise", round: 2 });

    const escalated = nextReviewAction([
      round(1, "REJECT", ["undefined symbol foo"]),
      round(2, "REJECT", ["undefined symbol foo"]),
    ]);
    expect(escalated).toMatchObject({ kind: "escalate", round: 2 });
    if (escalated.kind !== "escalate") return;
    expect(escalated.reason).toContain("undefined symbol foo");
  });

  it("compares blockers normalized, so a reworded repeat still escalates", () => {
    // Same finding with different casing, padding, and inner spacing — an LLM
    // reviewer's repeat must not read as progress.
    const escalated = nextReviewAction([
      round(1, "REJECT", ["Undefined symbol:   foo"]),
      round(2, "REJECT", ["undefined symbol: foo"]),
    ]);
    expect(escalated).toMatchObject({ kind: "escalate", round: 2 });

    // A genuinely different blocker still revises.
    expect(
      nextReviewAction([
        round(1, "REJECT", ["undefined symbol foo"]),
        round(2, "REJECT", ["Undefined   SYMBOL foo bar"]),
      ]),
    ).toMatchObject({ kind: "revise", round: 2 });
  });
});

describe("plan review ledger", () => {
  it("appends, reads back, and skips a damaged line", () => {
    const dir = makeDir();
    appendPlanReviewEntry(dir, {
      at: "2026-09-30T00:00:00.000Z",
      type: "gap_analysis",
      findings: ["no rollback plan"],
    });
    appendPlanReviewEntry(dir, {
      at: "2026-09-30T00:01:00.000Z",
      type: "plan_review_verdict",
      round: 1,
      verdict: "ITERATE",
      blockers: ["thin tasks"],
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, turns: 3 },
    });
    fs.appendFileSync(
      path.join(dir, ".opsx-plan-review.jsonl"),
      "{ not json\n",
      "utf-8",
    );
    appendPlanReviewEntry(dir, {
      at: "2026-09-30T00:02:00.000Z",
      type: "plan_review_verdict",
      round: 2,
      verdict: "OKAY",
      blockers: [],
    });

    const entries = readPlanReviewLedger(dir);
    expect(entries).toHaveLength(3);
    expect(planReviewLedgerPath(dir)).toBe(
      path.join(dir, ".opsx-plan-review.jsonl"),
    );
    expect(planReviewRounds(entries).map((round) => round.verdict)).toEqual([
      "ITERATE",
      "OKAY",
    ]);
    expect(totalDelegationUsage(entries)).toEqual({
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 2,
      turns: 3,
    });
  });

  it("returns an empty ledger when the file is absent", () => {
    expect(readPlanReviewLedger(makeDir())).toEqual([]);
  });

  it("projects the ledger into reviews.md", () => {
    const dir = makeDir();
    const entries: PlanReviewEntry[] = [
      {
        at: "2026-09-30T00:00:00.000Z",
        type: "gap_analysis",
        findings: ["missing acceptance criterion"],
      },
      {
        at: "2026-09-30T00:01:00.000Z",
        type: "plan_review_verdict",
        round: 1,
        verdict: "REJECT",
        blockers: ["undefined symbol foo"],
        summary: "Not executable.",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          turns: 4,
        },
      },
      {
        at: "2026-09-30T00:02:00.000Z",
        type: "escalation",
        findings: ["repeated blocker"],
      },
    ];
    for (const entry of entries) appendPlanReviewEntry(dir, entry);

    const markdown = renderReviewsMarkdown(readPlanReviewLedger(dir));
    expect(markdown).toContain("# Plan review record");
    expect(markdown).toContain("Gap analysis");
    expect(markdown).toContain("missing acceptance criterion");
    expect(markdown).toContain("Plan review verdict — round 1 — REJECT");
    expect(markdown).toContain("Blocker: undefined symbol foo");
    expect(markdown).toContain("Usage: input 100");
    expect(markdown).toContain("## Escalation");
    expect(markdown).toContain("input 100, output 20");

    const written = writeReviewsProjection(dir);
    expect(written).toBe(planReviewsPath(dir));
    expect(fs.readFileSync(written, "utf-8")).toBe(markdown);
  });

  it("renders an explicit empty projection", () => {
    expect(renderReviewsMarkdown([])).toContain("_No review entries yet._");
  });
});

describe("recordPlanReviewVerdict / recordGapAnalysis", () => {
  it("derives rounds from the ledger and returns the gate action", () => {
    const dir = makeDir();
    const first = recordPlanReviewVerdict(dir, {
      verdict: "ITERATE",
      blockers: ["thin tasks"],
      summary: "Needs detail.",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, turns: 1 },
      at: "2026-09-30T00:00:00.000Z",
    });
    expect(first.entry.round).toBe(1);
    expect(first.action).toMatchObject({ kind: "revise", round: 1 });

    const second = recordPlanReviewVerdict(dir, {
      verdict: "ITERATE",
      blockers: ["still thin"],
      at: "2026-09-30T00:01:00.000Z",
    });
    expect(second.entry.round).toBe(2);
    expect(second.action).toMatchObject({ kind: "escalate", round: 2 });

    const third = recordPlanReviewVerdict(dir, {
      verdict: "OKAY",
      blockers: [],
      at: "2026-09-30T00:02:00.000Z",
    });
    expect(third.entry.round).toBe(3);
    expect(third.action).toMatchObject({ kind: "pass", round: 3 });

    const projection = fs.readFileSync(planReviewsPath(dir), "utf-8");
    expect(projection).toContain("Plan review verdict — round 3 — OKAY");
    expect(projection).toContain("input 10, output 2");
  });

  it("records gap-analysis findings as advisory entries", () => {
    const dir = makeDir();
    recordGapAnalysis(dir, {
      findings: ["no rollback plan"],
      summary: "One gap.",
      at: "2026-09-30T00:00:00.000Z",
    });
    const entries = readPlanReviewLedger(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("gap_analysis");
    expect(fs.readFileSync(planReviewsPath(dir), "utf-8")).toContain(
      "no rollback plan",
    );
  });
});
