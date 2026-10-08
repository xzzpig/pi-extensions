import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import {
  goalDetails,
  detailedSummary,
  GOAL_AUDIT_ENTRY,
  renderGoalResult,
} from "../extensions/goal-format.ts";
import { statusLabel } from "../extensions/goal-core.ts";
import { goalDetailPage } from "../extensions/goal-detail.ts";
import { newGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import {
  buildGoalCompactSummary,
  buildPostCompactionGoalDelta,
} from "../extensions/goal-compaction.ts";
import {
  buildCompletionReport,
  buildGoalCreatedReport,
} from "../extensions/goal-policy.ts";
import {
  budgetReachedReminderNote,
  goalContextMessagePrompt,
  goalStateSnapshotPrompt,
} from "../extensions/prompts/goal-prompts.ts";
import { createMockTheme } from "./tui-test-utils.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";
import {
  excludeGoalModelAuditUsage,
  goalModelAuditRejectionText,
  goalModelDetailedSummary,
  goalModelPromptParts,
  projectGoalModelLedgerEvents,
} from "../extensions/goal-model-view.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    ...createGoal({
      objective: "Inspect the repository",
      autoContinue: true,
      sisyphus: false,
    }),
    ...overrides,
  };
}

test("active model prompt drops context/time counters and empty limit placeholders", () => {
  const first = goal({
    objective: "Keep working",
    usage: { activeSeconds: 90, tokensUsed: 5000 },
  });
  const second = {
    ...first,
    usage: { activeSeconds: 99_999, tokensUsed: 900_000 },
  };
  const firstParts = goalModelPromptParts(first);
  const secondParts = goalModelPromptParts(second);
  assert.deepEqual(
    firstParts,
    secondParts,
    "unbudgeted lifetime totals cannot perturb the generated request",
  );
  assert.equal(
    firstParts.counters,
    undefined,
    "no empty telemetry tail is generated",
  );
  assert.doesNotMatch(
    firstParts.state,
    /Limits:|Goal snapshot:|Context snapshot:|tokens\)|Usage spans goal turns/,
  );
  assert.match(firstParts.state, /Keep working/);

  const eventsSource = readFileSync(
    new URL("../extensions/goal-events.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    eventsSource,
    /ctx\.getContextUsage\?\.\(\)/,
    "the runtime hook never reads context occupancy",
  );
});

test("real budget, finite runs, zero-run disablement, and waits remain actionable", () => {
  const g = goal({
    tokenBudget: 100,
    usage: { activeSeconds: 75, tokensUsed: 25 },
  });
  const scheduler = newGoalScheduler("session-owner");
  scheduler.used = 3;
  g.scheduler = scheduler;
  const limited = goalModelPromptParts(g, { maxAutonomousRuns: 10 });
  assert.match(limited.state, /Lifetime token budget cap: 100 tokens/);
  assert.match(limited.state, /Maximum autonomous runs: 10/);
  assert.match(limited.state, /newest reading is current/);
  assert.match(
    limited.counters ?? "",
    /Lifetime token budget:.*25\/100 used, 75 remaining/,
  );
  assert.match(limited.counters ?? "", /Autonomous runs: 3\/10/);
  assert.doesNotMatch(
    `${limited.state}\n${limited.counters}`,
    /Context snapshot|Goal snapshot|75s|25 tokens/,
  );

  const hidden = goalModelPromptParts(g, {
    maxAutonomousRuns: 10,
    showAutonomousRuns: false,
  });
  assert.match(hidden.state, /Maximum autonomous runs: 10/);
  assert.doesNotMatch(hidden.counters ?? "", /Autonomous runs: \d+\/\d+/);
  assert.match(hidden.counters ?? "", /Lifetime token budget/);

  const disabled = goalModelPromptParts(g, {
    maxAutonomousRuns: 0,
    showAutonomousRuns: false,
  });
  assert.match(disabled.state, /Automatic continuation is disabled/);
  assert.doesNotMatch(
    `${disabled.state}\n${disabled.counters}`,
    /Autonomous runs: 0\/0/,
  );

  g.scheduler = {
    ...newGoalScheduler("session-owner"),
    phase: "waiting",
    decision: { kind: "wait" },
    wait: {
      id: "wait-1",
      token: "token-1",
      reason: "waiting for upstream artifact",
      deadline: Date.UTC(2026, 9, 8, 12),
      intervalMs: 60_000,
      remainingChecks: 4,
      nextCheckAt: Date.UTC(2026, 9, 8, 11, 30),
    },
  };
  const waiting = goalModelPromptParts(g, { maxAutonomousRuns: 10 });
  assert.match(waiting.state, /Waiting: waiting for upstream artifact/);
  assert.match(waiting.state, /checks remaining/);
});

test("retention resets removed budget constraints and does not grow for unbudgeted usage changes", () => {
  const base = [{ role: "user", content: "start" }];
  const retention = new LiveTailRetention();
  const g = goal({
    tokenBudget: 100,
    usage: { activeSeconds: 20, tokensUsed: 40 },
  });
  const withBudget = goalModelPromptParts(g);
  retention.apply("budget-session", base, withBudget);

  delete g.tokenBudget;
  g.usage = { activeSeconds: 80, tokensUsed: 5000 };
  const withoutBudget = goalModelPromptParts(g);
  const afterRemoval = retention.apply(
    "budget-session",
    [...base, { role: "assistant", content: "work" }],
    withoutBudget,
  );
  assert.doesNotMatch(
    afterRemoval.transientContents.join("\n"),
    /tokenBudget=100|100\/.*used|tokens=100/,
  );
  assert.equal(withoutBudget.counters, undefined);

  const updatedUsage = {
    ...g,
    usage: { activeSeconds: 900, tokensUsed: 900_000 },
  };
  assert.deepEqual(goalModelPromptParts(updatedUsage), withoutBudget);
  const unchanged = retention.apply(
    "budget-session",
    [...base, { role: "assistant", content: "work" }],
    goalModelPromptParts(updatedUsage),
  );
  assert.deepEqual(unchanged.transientContents, afterRemoval.transientContents);
});

test("model detailed summary preserves tasks and actual budget but omits free counters", () => {
  const g = goal({
    objective: "Verify artifacts",
    usage: { activeSeconds: 125, tokensUsed: 81 },
    taskList: {
      tasks: [
        {
          id: "t1",
          title: "Run checks",
          status: "pending",
          verificationContract: "All tests pass",
        },
      ],
      blockCompletion: true,
      proposedAt: "2026-10-07T00:00:00.000Z",
    },
  });
  const summary = goalModelDetailedSummary(g);
  assert.match(summary, /Verify artifacts/);
  assert.match(summary, /Run checks/);
  assert.doesNotMatch(summary, /Time spent:|Tokens used:|125s/);
  g.tokenBudget = 100;
  const budgeted = goalModelDetailedSummary(g);
  assert.match(budgeted, /Lifetime token budget:.*81\/100 used, 19 remaining/);
  assert.doesNotMatch(budgeted, /Time spent:/);
  assert.match(
    detailedSummary(g),
    /Time spent:/,
    "the UI/auditor formatter remains unchanged",
  );
});

test("ledger projection drops audit spend and unbudgeted usage without mutating history", () => {
  const events: GoalLedgerEvent[] = [
    {
      type: "audit_usage",
      goalId: "g1",
      tokens: 77,
      inputTokens: 20,
      outputTokens: 30,
      cacheReadTokens: 27,
      cacheWriteTokens: 0,
      costUsd: 0.25,
      turns: 2,
      at: "2026-10-07T00:00:00.000Z",
    },
    {
      type: "goal_budget_changed",
      goalId: "g1",
      oldBudget: 100,
      newBudget: null,
      tokensUsed: 45,
      at: "2026-10-07T00:00:01.000Z",
    },
    {
      type: "goal_budget_limited",
      goalId: "g1",
      budget: 100,
      tokensUsed: 100,
      at: "2026-10-07T00:00:02.000Z",
    },
    {
      type: "goal_budget_warning",
      goalId: "g1",
      budget: 100,
      tokensUsed: 80,
      pct: 80,
      at: "2026-10-07T00:00:03.000Z",
    },
    {
      type: "task_complete",
      goalId: "g1",
      taskId: "t1",
      evidence: "Tokens used: this phrase belongs to user evidence.",
      at: "2026-10-07T00:00:04.000Z",
    },
  ];
  const raw = structuredClone(events);
  const projected = projectGoalModelLedgerEvents(events);
  assert.equal(projected.length, 4);
  assert.deepEqual(projected[0], {
    type: "goal_budget_changed",
    goalId: "g1",
    oldBudget: 100,
    newBudget: null,
    at: events[1]!.at,
  });
  assert.deepEqual(projected[1], {
    type: "goal_budget_limited",
    goalId: "g1",
    budget: 100,
    at: events[2]!.at,
  });
  assert.deepEqual(projected[2], {
    type: "goal_budget_warning",
    goalId: "g1",
    budget: 100,
    at: events[3]!.at,
  });
  assert.match(
    JSON.stringify(projected),
    /Tokens used: this phrase belongs to user evidence/,
  );
  assert.doesNotMatch(
    JSON.stringify(projected),
    /audit_usage|tokensUsed|cacheReadTokens|costUsd|pct/,
  );
  assert.deepEqual(
    events,
    raw,
    "projection never edits the authoritative ledger objects",
  );
  assert.equal(excludeGoalModelAuditUsage(events).length, 4);

  const budgeted = projectGoalModelLedgerEvents(events, 100);
  assert.equal(budgeted.length, 4);
  assert.match(JSON.stringify(budgeted), /tokensUsed/);
  assert.doesNotMatch(JSON.stringify(budgeted), /audit_usage|costUsd/);
});

test("projected history pages concatenate without loss and stale cursors are rejected", () => {
  const g = goal({ id: "paged-history" });
  const events: GoalLedgerEvent[] = [];
  for (let index = 0; index < 8; index++) {
    events.push({
      type: "audit_usage",
      goalId: g.id,
      tokens: 50,
      inputTokens: 20,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.1,
      turns: 1,
      at: `2026-10-07T00:00:${String(index * 2).padStart(2, "0")}.000Z`,
    });
    events.push({
      type: "task_complete",
      goalId: g.id,
      taskId: `task-${index}`,
      evidence: `Evidence ${index}: ${"preserve-this-source-text ".repeat(35)}`,
      at: `2026-10-07T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
    });
  }
  events.splice(3, 0, {
    type: "goal_budget_warning",
    goalId: g.id,
    budget: 100,
    tokensUsed: 90,
    pct: 90,
    at: "2026-10-07T00:00:02.500Z",
  });
  const original = structuredClone(events);
  const projected = projectGoalModelLedgerEvents(events);

  const pageContents: string[] = [];
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  do {
    const page = goalDetailPage(
      g,
      { section: "history", ...(cursor ? { cursor } : {}) },
      projected,
    );
    assert.equal(page.ok, true);
    if (!page.ok) break;
    pageContents.push(page.content);
    firstCursor ??= page.nextCursor;
    cursor = page.nextCursor;
  } while (cursor);
  assert.ok(pageContents.length > 1, "fixture crosses the page size boundary");
  assert.equal(
    pageContents.join(""),
    projected
      .filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { goalId?: unknown }).goalId === g.id,
      )
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  assert.doesNotMatch(pageContents.join(""), /audit_usage|tokensUsed|pct/);
  assert.match(pageContents.join(""), /Evidence 7: preserve-this-source-text/);
  assert.deepEqual(
    events,
    original,
    "paging uses an in-memory projection and never rewrites the ledger",
  );
  assert.ok(firstCursor);
  const stale = goalDetailPage(
    g,
    { section: "history", cursor: firstCursor },
    projectGoalModelLedgerEvents(events, 100),
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.text, /Invalid or stale cursor/);
});

test("tool UI restores generated usage rows while model-facing content stays minimized", () => {
  const g = goal({
    id: "display-usage",
    objective:
      "Keep the verified plan.\nTokens used: preserve the objective text.",
    tokenBudget: 100,
    usage: { activeSeconds: 61, tokensUsed: 25 },
  });
  const theme = createMockTheme() as unknown as Theme;
  const createText = buildGoalCreatedReport({
    objective: g.objective,
    detailedSummary: goalModelDetailedSummary(g),
    tokenBudget: g.tokenBudget,
  });
  const createResult = {
    content: [{ type: "text", text: createText }],
    details: goalDetails(g),
  };
  const createUi = renderGoalResult(createResult, undefined, theme)
    .render(200)
    .join("\n");
  assert.doesNotMatch(createText, /Time spent:|Tokens used: 25 tokens/);
  assert.match(createUi, /Time spent: 1m01s/);
  assert.match(createUi, /Tokens used: 25 tokens/);
  assert.match(createUi, /Tokens used: preserve the objective text/);
  assert.equal(
    createResult.content[0]!.text,
    createText,
    "UI formatting does not mutate model-facing content",
  );

  const completed = { ...g, status: "complete" as const };
  const completionText = buildCompletionReport({
    detailedSummary: goalModelDetailedSummary(completed),
  });
  const completionResult = {
    content: [{ type: "text", text: completionText }],
    details: goalDetails(completed),
  };
  const completionUi = renderGoalResult(completionResult, undefined, theme)
    .render(200)
    .join("\n");
  assert.doesNotMatch(completionText, /Time spent:|Tokens used: 25 tokens/);
  assert.match(completionUi, /Time spent: 1m01s/);
  assert.match(completionUi, /Tokens used: 25 tokens/);
  assert.equal(
    completionResult.content[0]!.text,
    completionText,
    "completion UI keeps usage out of model content",
  );

  const budgetless = { ...g, tokenBudget: undefined };
  const budgetlessCompleted = { ...budgetless, status: "complete" as const };
  for (const [record, text] of [
    [
      budgetless,
      buildGoalCreatedReport({
        objective: budgetless.objective,
        detailedSummary: goalModelDetailedSummary(budgetless),
      }),
    ],
    [
      budgetlessCompleted,
      buildCompletionReport({
        detailedSummary: goalModelDetailedSummary(budgetlessCompleted),
      }),
    ],
    [
      budgetlessCompleted,
      buildCompletionReport({
        detailedSummary: goalModelDetailedSummary(budgetlessCompleted),
        auditSkippedReason: "user bypassed the audit",
      }),
    ],
  ] as const) {
    const result = {
      content: [{ type: "text", text }],
      details: goalDetails(record),
    };
    const ui = renderGoalResult(result, undefined, theme)
      .render(200)
      .join("\n");
    assert.match(ui, /Time spent: 1m01s/);
    assert.match(ui, /Tokens used: 25 tokens/);
    assert.doesNotMatch(text, /Time spent:|Tokens used: 25 tokens/);
    assert.equal(result.content[0]!.text, text);
  }

  const ambiguousReport = `Goal audit approved.\n\nAuditor report:\nGoal: ${g.objective}\nStatus: ${statusLabel(g)}\nAuto-continue: on\nThis is report text, not a generated summary.`;
  const ambiguousUi = renderGoalResult(
    {
      content: [{ type: "text", text: ambiguousReport }],
      details: goalDetails(g),
    },
    undefined,
    theme,
  )
    .render(200)
    .join("\n");
  assert.doesNotMatch(
    ambiguousUi,
    /Time spent:|Tokens used: 25 tokens/,
    "ambiguous auditor prose does not receive reconstructed display rows",
  );
  assert.match(ambiguousUi, /This is report text, not a generated summary/);
});

test("post-compaction summaries retain execution state while excluding audit spend", () => {
  const g = goal({
    id: "compact-view",
    tokenBudget: 200,
    usage: { activeSeconds: 720, tokensUsed: 50 },
  });
  g.currentTaskId = "t1";
  g.taskList = {
    tasks: [
      {
        id: "t1",
        title: "Finish verification",
        status: "pending",
        verificationContract: "Run the package checks.",
      },
    ],
    blockCompletion: true,
    proposedAt: "2026-10-07T00:00:00.000Z",
  };
  g.pauseReason = "waiting on one fixture";
  const events: GoalLedgerEvent[] = [
    {
      type: "audit_usage",
      goalId: g.id,
      tokens: 50,
      inputTokens: 20,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.15,
      turns: 1,
      at: "2026-10-07T00:00:00.000Z",
    },
    {
      type: "audit_result",
      goalId: g.id,
      verdict: "disapproved",
      report: "The verification evidence is missing.",
      at: "2026-10-07T00:00:01.000Z",
    },
    {
      type: "task_started",
      goalId: g.id,
      taskId: "t1",
      at: "2026-10-07T00:00:02.000Z",
    },
  ];
  const compact = buildGoalCompactSummary(g, events);
  assert.match(compact, /Lifetime token budget:.*50\/200 used/);
  assert.match(compact, /The verification evidence is missing/);
  assert.doesNotMatch(
    compact,
    /Time:|Cumulative goal usage|audit cost|0\.1500|audit_usage/,
  );
  const delta = buildPostCompactionGoalDelta({
    goal: g,
    ledgerEvents: events,
    otherOpenCount: 2,
  });
  assert.match(delta, /Finish verification/);
  assert.match(delta, /Run the package checks/);
  assert.match(delta, /The verification evidence is missing/);
  assert.match(delta, /Other open goals: 2/);
  assert.doesNotMatch(delta, /audit_usage|0\.1500|tokensUsed|Context snapshot/);
});

test("audit rejection cost is removed only from the model-facing generated header", () => {
  const text = [
    "Goal audit rejected.",
    "",
    "Goal completion rejected by independent auditor.",
    "Auditor model: fixture/model",
    "Audit cost: $0.0100 · 25 tokens · 2 turns",
    "",
    "Audit cost: user-authored report text must remain.",
    "Missing tests.",
    "",
    "Operator note:",
    "Please add coverage.",
  ].join("\n");
  const projected = goalModelAuditRejectionText(text);
  assert.doesNotMatch(projected, /Audit cost: \$0\.0100/);
  assert.match(projected, /Audit cost: user-authored report text must remain/);
  assert.match(projected, /Missing tests/);
  assert.match(projected, /Please add coverage/);
  assert.match(
    text,
    /Audit cost: \$0\.0100/,
    "display-only source text remains untouched",
  );
});

test("audit display remains isolated from delegated child context", () => {
  const source = readFileSync(
    new URL("../extensions/goal.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(isDelegatedGoalSession\(\)\)[\s\S]*?filterGoalSessionContext\(event\.messages, true\)[\s\S]*?return;/,
  );
  assert.match(source, /registerGoalEvents\(core\)/);
  assert.equal(GOAL_AUDIT_ENTRY, "pi-goal-audit-event");
});

test("new persistent snapshots keep actual spending gates but never add free telemetry", () => {
  const g = goal({
    id: "new-snapshot",
    objective: "Keep [BUDGET LIMITED] as user text.",
    tokenBudget: 100,
    usage: { activeSeconds: 61, tokensUsed: 321 },
    status: "budget_limited",
  });
  const original = structuredClone(g);
  const limited = goalStateSnapshotPrompt(g);
  assert.match(
    limited,
    /Lifetime token budget: 321\/100 used, 0 remaining \(spending cap, not context capacity\)/,
  );
  assert.match(limited, /\[BUDGET LIMITED\]/);
  assert.match(limited, /do not start new substantive work/);
  assert.doesNotMatch(
    limited,
    /Time spent:|Context snapshot:|Tokens used: 321/,
  );
  assert.deepEqual(g, original);
  const active = { ...g, status: "active" as const };
  const reminder = goalStateSnapshotPrompt(active, undefined, {
    foldedNotes: [budgetReachedReminderNote(active)],
  });
  assert.match(reminder, /\[TOKEN BUDGET REACHED goalId=new-snapshot\]/);
  assert.match(reminder, /spending cap, not context capacity/);
  const noBudget = { ...active, tokenBudget: undefined };
  for (const generated of [
    goalStateSnapshotPrompt(noBudget),
    goalContextMessagePrompt(noBudget),
  ]) {
    assert.match(generated, /Keep \[BUDGET LIMITED\] as user text/);
    assert.doesNotMatch(
      generated,
      /321\/100|Time spent:|Tokens used:|Context snapshot:|unavailable/,
    );
  }
});

test("new completion output preserves an auditor-authored full-summary quotation", () => {
  const g = goal({
    id: "report-quote",
    objective: "Verify the evidence.",
    usage: { activeSeconds: 61, tokensUsed: 321 },
    status: "complete",
  });
  const original = structuredClone(g);
  const quote = `Auditor-authored quoted summary:\n${detailedSummary(g)}\nEnd of auditor quotation.`;
  const report = buildCompletionReport({
    detailedSummary: goalModelDetailedSummary(g),
    auditorReport: quote,
  });
  assert.ok(report.includes(`Auditor approval:\n${quote}\n\nGoal complete.`));
  assert.ok(report.endsWith(`\n${goalModelDetailedSummary(g)}`));
  assert.equal((report.match(/Time spent: 1m01s/g) ?? []).length, 1);
  assert.equal((report.match(/Tokens used: 321 tokens/g) ?? []).length, 1);
  const theme = createMockTheme() as unknown as Theme;
  const result = {
    content: [{ type: "text", text: report }],
    details: goalDetails(g),
  };
  const ui = renderGoalResult(result, undefined, theme).render(200).join("\n");
  assert.equal(
    (ui.match(/Time spent: 1m01s/g) ?? []).length,
    2,
    "UI keeps the auditor quotation plus its own authoritative usage row",
  );
  assert.equal((ui.match(/Tokens used: 321 tokens/g) ?? []).length, 2);
  assert.equal(
    result.content[0]!.text,
    report,
    "display restoration never mutates model content or the report",
  );
  assert.deepEqual(g, original);
});

test("tool UI restores usage when the objective itself contains a generated marker", () => {
  const theme = createMockTheme() as unknown as Theme;
  const created = goal({
    id: "marker-in-objective",
    objective: "Explain the Goal details:\nblock to the reviewer.",
    usage: { activeSeconds: 61, tokensUsed: 25 },
  });
  const createText = buildGoalCreatedReport({
    objective: created.objective,
    detailedSummary: goalModelDetailedSummary(created),
  });
  const createUi = renderGoalResult(
    {
      content: [{ type: "text", text: createText }],
      details: goalDetails(created),
    },
    undefined,
    theme,
  )
    .render(200)
    .join("\n");
  assert.doesNotMatch(createText, /Time spent:|Tokens used: 25 tokens/);
  assert.match(createUi, /Time spent: 1m01s/);
  assert.match(createUi, /Tokens used: 25 tokens/);

  const completed = goal({
    id: "marker-in-objective-complete",
    objective: "Summarize the Goal complete.\n\nmarker for the reviewer.",
    usage: { activeSeconds: 61, tokensUsed: 25 },
    status: "complete" as const,
  });
  const completionText = buildCompletionReport({
    detailedSummary: goalModelDetailedSummary(completed),
  });
  const completionUi = renderGoalResult(
    {
      content: [{ type: "text", text: completionText }],
      details: goalDetails(completed),
    },
    undefined,
    theme,
  )
    .render(200)
    .join("\n");
  assert.doesNotMatch(completionText, /Time spent:|Tokens used: 25 tokens/);
  assert.match(completionUi, /Time spent: 1m01s/);
  assert.match(completionUi, /Tokens used: 25 tokens/);
});

test("tool UI restores usage when a task title quotes a whole generated block", () => {
  const theme = createMockTheme() as unknown as Theme;
  const quoted =
    "Document this generated example:\n\nGoal: Verify artifacts\nStatus: complete\nAuto-continue: off\nTime spent: 0s\nTokens used: 0 tokens\nEnd of quoted example.";
  const g = goal({
    id: "title-quotes-block",
    objective: "Verify artifacts",
    autoContinue: false,
    status: "complete" as const,
    usage: { activeSeconds: 61, tokensUsed: 321 },
    taskList: {
      tasks: [{ id: "t1", title: quoted, status: "pending" as const }],
      blockCompletion: false,
      proposedAt: "2026-10-07T00:00:00.000Z",
    },
  });
  for (const text of [
    buildCompletionReport({ detailedSummary: goalModelDetailedSummary(g) }),
    buildCompletionReport({
      detailedSummary: goalModelDetailedSummary(g),
      auditSkippedReason: "user bypassed the audit",
    }),
    buildGoalCreatedReport({
      objective: g.objective,
      detailedSummary: goalModelDetailedSummary(g),
      tokenBudget: 100,
    }),
  ]) {
    const result = {
      content: [{ type: "text", text }],
      details: goalDetails(g),
    };
    // render(200) right-pads every line, so compare after trimming each line.
    const ui = renderGoalResult(result, undefined, theme)
      .render(200)
      .join("\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
    assert.ok(ui.includes(quoted), "the quoted task title survives verbatim");
    assert.ok(
      ui.includes(
        "Auto-continue: off\nTime spent: 1m01s\nTokens used: 321 tokens\nTasks: 0/1 tasks complete",
      ),
      "authoritative rows attach to the real generated header, not to the quotation",
    );
    assert.ok(
      ui.includes("Time spent: 0s"),
      "the quotation's own rows survive",
    );
    assert.doesNotMatch(text, /Time spent: 1m01s|Tokens used: 321 tokens/);
    assert.equal(
      result.content[0]!.text,
      text,
      "model content stays untouched",
    );
  }
});

test("tool UI keeps a multi-line objective intact when restoring usage", () => {
  const theme = createMockTheme() as unknown as Theme;
  const objective = "Line one\nLine two\nLine three\nLine four";
  const g = goal({
    id: "multiline-objective",
    objective,
    autoContinue: false,
    status: "complete" as const,
    usage: { activeSeconds: 61, tokensUsed: 321 },
  });
  const expected = `Goal: ${objective}\nStatus: complete\nAuto-continue: off\nTime spent: 1m01s\nTokens used: 321 tokens`;
  for (const text of [
    buildCompletionReport({ detailedSummary: goalModelDetailedSummary(g) }),
    buildCompletionReport({
      detailedSummary: goalModelDetailedSummary(g),
      auditSkippedReason: "user bypassed the audit",
    }),
    buildGoalCreatedReport({
      objective,
      detailedSummary: goalModelDetailedSummary(g),
      tokenBudget: 100,
    }),
  ]) {
    const result = {
      content: [{ type: "text", text }],
      details: goalDetails(g),
    };
    const ui = renderGoalResult(result, undefined, theme)
      .render(200)
      .join("\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
    assert.ok(
      ui.includes(expected),
      "rows attach after the real Auto-continue line with the objective intact",
    );
    assert.doesNotMatch(
      ui,
      /Line three\nTime spent:/,
      "the restored rows never split the objective",
    );
    assert.ok(
      ui.includes(objective),
      "the multi-line objective survives verbatim",
    );
    assert.doesNotMatch(text, /Time spent: 1m01s|Tokens used: 321 tokens/);
    assert.equal(
      result.content[0]!.text,
      text,
      "model content stays untouched",
    );
  }
});
