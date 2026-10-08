import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import {
  detailedSummary,
  GOAL_AUDIT_ENTRY,
  GOAL_CONTEXT_EVENT_ENTRY,
  GOAL_STATE_EVENT_ENTRY,
  goalDetails,
} from "../extensions/goal-format.ts";
import {
  buildCompletionReport,
  buildGoalCreatedReport,
} from "../extensions/goal-policy.ts";
import {
  goalContextMessagePrompt,
  goalStateSnapshotPrompt,
} from "../extensions/prompts/goal-prompts.ts";
import { filterGoalSessionContext } from "../extensions/goal-session-safety.ts";
import { compactGoalCheckpointContext } from "../extensions/goal-events.ts";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";
import { newGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import {
  goalModelAuditRejectionText,
  goalModelDetailedSummary,
  goalModelPromptParts,
  projectGoalModelLedgerEvents,
} from "../extensions/goal-model-view.ts";
import { goalDetailPage } from "../extensions/goal-detail.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

type SessionMessages = Parameters<typeof convertToLlm>[0];
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const active: GoalRecord = {
  ...createGoal({
    objective: "Run the required checks",
    autoContinue: true,
    sisyphus: false,
  }),
  id: "active-view",
  tokenBudget: 100,
  usage: { activeSeconds: 3600, tokensUsed: 25 },
  verificationContract: "Typecheck and all package tests pass.",
};
active.taskList = {
  tasks: [
    {
      id: "verify",
      title: "Run checks",
      status: "pending",
      verificationContract: "Report real exit codes.",
    },
  ],
  blockCompletion: true,
  proposedAt: "2026-10-07T00:00:00.000Z",
};
active.scheduler = {
  ...newGoalScheduler("sdk-fixture"),
  used: 2,
  phase: "waiting",
  decision: { kind: "wait" },
  wait: {
    id: "wait-1",
    token: "wait-token",
    reason: "waiting for upstream artifact",
    deadline: Date.UTC(2026, 9, 8, 12),
    remainingChecks: 3,
    nextCheckAt: Date.UTC(2026, 9, 8, 11, 30),
  },
};
const plain: GoalRecord = {
  ...createGoal({
    objective: "New goal objective\nTokens used: keep this user-authored text.",
    autoContinue: true,
    sisyphus: false,
  }),
  id: "plain-view",
  usage: { activeSeconds: 61, tokensUsed: 321 },
};
const completed = { ...plain, status: "complete" as const };
const quotedReport = `Auditor-authored quotation:\n${detailedSummary(completed)}\nEnd of auditor quotation.`;
const rejection = goalModelAuditRejectionText(
  "Goal audit rejected.\n\nGoal completion rejected by independent auditor.\nAuditor model: fixture/auditor\nAudit cost: $0.0100 · 25 tokens · 1 turn\n\nThe report says the test evidence is missing.\n\nOperator note:\nKeep the verification contract.",
);
const events: GoalLedgerEvent[] = [
  {
    type: "audit_usage",
    goalId: plain.id,
    tokens: 777777,
    inputTokens: 20,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.1234,
    turns: 1,
    at: "2026-10-07T00:00:00.000Z",
  },
  {
    type: "goal_budget_changed",
    goalId: plain.id,
    oldBudget: 100,
    newBudget: null,
    tokensUsed: 45,
    at: "2026-10-07T00:00:01.000Z",
  },
  {
    type: "task_complete",
    goalId: plain.id,
    taskId: "evidence",
    evidence: "Tokens used: preserve evidence.",
    at: "2026-10-07T00:00:02.000Z",
  },
];
const page = goalDetailPage(
  plain,
  { section: "history" },
  projectGoalModelLedgerEvents(events),
);
if (!page.ok) throw new Error("Expected a fresh execution-history page.");

function exchange(
  id: string,
  name: string,
  text: string,
  goal: GoalRecord,
): SessionMessages {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: {} }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      stopReason: "toolUse",
      usage,
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      details: JSON.parse(JSON.stringify(goalDetails(goal))),
      isError: false,
      timestamp: 2,
    },
  ];
}
const fresh: SessionMessages = [
  {
    role: "user",
    content: "Context snapshot: user-authored history remains untouched.",
    timestamp: 0,
  },
  {
    role: "custom",
    customType: GOAL_CONTEXT_EVENT_ENTRY,
    content: goalContextMessagePrompt(plain),
    display: false,
    details: { version: 1, kind: "context", goalId: plain.id, revision: 1 },
    timestamp: 0,
  },
  {
    role: "custom",
    customType: GOAL_STATE_EVENT_ENTRY,
    content: goalStateSnapshotPrompt(plain),
    display: false,
    details: { version: 3, kind: "state", goalId: plain.id, revision: 1 },
    timestamp: 0,
  },
  ...exchange(
    "create-new",
    "create_goal",
    buildGoalCreatedReport({
      objective: plain.objective,
      detailedSummary: goalModelDetailedSummary(plain),
    }),
    plain,
  ),
  ...exchange(
    "get-budget",
    "get_goal",
    goalModelDetailedSummary(active),
    active,
  ),
  ...exchange("get-history", "get_goal", page.text, plain),
  ...exchange(
    "draft-new",
    "propose_goal_draft",
    buildGoalCreatedReport({
      objective: plain.objective,
      confirmed: true,
      tokenBudget: undefined,
    }),
    plain,
  ),
  ...exchange(
    "complete-new",
    "update_goal",
    buildCompletionReport({
      detailedSummary: goalModelDetailedSummary(completed),
      auditorReport: quotedReport,
    }),
    completed,
  ),
  ...exchange("reject-new", "update_goal", rejection, plain),
  {
    role: "custom",
    customType: GOAL_AUDIT_ENTRY,
    content: "Audit card: $0.0100 · 25 tokens · 1 turn",
    display: true,
    details: { goalId: plain.id },
    timestamp: 3,
  },
  ...exchange(
    "read-evidence",
    "read",
    "Tokens used: this phrase is user-authored evidence.",
    plain,
  ),
  {
    role: "custom",
    customType: "third-party",
    content: "Context snapshot: this is not plugin telemetry.",
    display: false,
    timestamp: 3,
  },
];
const oldText =
  'Old recorded tool result: Context snapshot: 876543/1000000 tokens (88%).\n{"tokensUsed":765432,"pct":80}';
const oldMessages: SessionMessages = [
  {
    role: "custom",
    customType: GOAL_CONTEXT_EVENT_ENTRY,
    content:
      "[PI GOAL CONTEXT goalId=old]\nGoal snapshot: 999m · 765432 tokens\nContext snapshot: unavailable",
    details: { version: 1, kind: "context", goalId: "old", revision: 1 },
    display: false,
    timestamp: 1,
  },
  ...exchange("old-history", "get_goal", oldText, plain),
];

async function capture(
  api: "openai-responses" | "anthropic-messages",
  base: SessionMessages,
): Promise<Record<string, unknown>> {
  const cwd = mkdtempSync(path.join(tmpdir(), "goal-model-view-wire-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(cwd, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider("goal-view-fixture", {
      baseUrl: "http://127.0.0.1:1",
      api,
      apiKey: "fixture-only",
      models: [
        {
          id: "fixture",
          name: "fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 128,
        },
      ],
    });
    const model = runtime.getModel("goal-view-fixture", "fixture");
    assert.ok(model);
    const filtered = filterGoalSessionContext(base) ?? base;
    assert.equal(
      compactGoalCheckpointContext(filtered, active),
      null,
      "without checkpoints the existing normalizer leaves fixture history unchanged",
    );
    const retained = new LiveTailRetention().apply(
      "sdk-new-generation",
      filtered,
      goalModelPromptParts(active, { maxAutonomousRuns: 5 }),
    );
    let payload: Record<string, unknown> | undefined;
    await runtime
      .streamSimple(
        model,
        {
          systemPrompt: "Stable host policy.",
          messages: convertToLlm(retained.messages),
          tools: [
            {
              name: "get_goal",
              description: "Read goal state",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        },
        {
          cacheRetention: "short",
          sessionId: "goal-model-view-sdk",
          onPayload: (value) => {
            payload = value as Record<string, unknown>;
            throw new Error("Intentional capture before network dispatch");
          },
        },
      )
      .result();
    assert.ok(payload, "captured by the real SDK before HTTP dispatch");
    return payload;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const api of ["openai-responses", "anthropic-messages"] as const) {
  test(`real SDK ${api} sends minimized new content and leaves old messages untouched`, async () => {
    const original = structuredClone(fresh);
    const originalEvents = structuredClone(events);
    const payload = await capture(api, fresh);
    const wire = JSON.stringify(payload).replaceAll("\\n", "\n");
    assert.match(wire, /Lifetime token budget cap: 100 tokens/);
    assert.match(wire, /25\/100 used, 75 remaining/);
    assert.match(wire, /Maximum autonomous runs: 5/);
    assert.match(wire, /Autonomous runs: 2\/5/);
    assert.match(wire, /Waiting: waiting for upstream artifact/);
    assert.match(
      wire,
      /Verification contract:\n  Typecheck and all package tests pass/,
    );
    assert.match(wire, /The report says the test evidence is missing/);
    assert.match(wire, /Keep the verification contract/);
    assert.match(wire, /Tokens used: preserve evidence/);
    assert.match(wire, /Tokens used: this phrase is user-authored evidence/);
    assert.match(wire, /Tokens used: keep this user-authored text/);
    assert.match(
      wire,
      /Context snapshot: user-authored history remains untouched/,
    );
    assert.match(wire, /Context snapshot: this is not plugin telemetry/);
    assert.doesNotMatch(
      wire,
      /Goal snapshot:|Context snapshot: \d|Context snapshot: unavailable|audit_usage|tokensUsed|777777|costUsd|Audit cost:|Audit card:|No result provided/,
    );
    assert.equal(
      (wire.match(/Time spent: 1m01s/g) ?? []).length,
      1,
      "only auditor-authored quotation retains the usage row",
    );
    assert.equal(
      (wire.match(/Tokens used: 321 tokens/g) ?? []).length,
      1,
      "only auditor-authored quotation retains the token row",
    );
    assert.ok(
      wire.includes(`Auditor approval:\n${quotedReport}\n\nGoal complete.`),
    );
    assert.doesNotMatch(
      wire.slice(wire.lastIndexOf("Goal complete.\n\n")),
      /Time spent:|Tokens used: 321 tokens/,
    );
    assert.deepEqual(fresh, original);
    assert.deepEqual(events, originalEvents);
    const schema = JSON.stringify(payload.tools);
    assert.match(schema, /get_goal/);
    assert.doesNotMatch(schema, /outputSchema|structuredContent/);
    assert.match(
      wire,
      /read-evidence/,
      "ordinary tool call/result pairing remains present",
    );

    const oldOriginal = structuredClone(oldMessages);
    const withOld = await capture(api, [...oldMessages, ...fresh]);
    const oldWire = JSON.stringify(withOld).replaceAll("\\n", "\n");
    assert.match(oldWire, /Context snapshot: 876543\/1000000 tokens/);
    assert.match(oldWire, /tokensUsed.*765432/);
    assert.match(oldWire, /Goal snapshot: 999m/);
    assert.match(oldWire, /Context snapshot: unavailable/);
    assert.deepEqual(
      oldMessages,
      oldOriginal,
      "old persisted messages are neither erased nor request-projected",
    );
  });
}
