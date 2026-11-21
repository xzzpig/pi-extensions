import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendGoalEvent,
  goalActivityEvents,
  goalLedgerPath,
  goalRuntimeAuditFailure,
  invalidateGoalLedgerCache,
  LEDGER_CHECKPOINT_FILE,
  LEDGER_CHECKPOINT_VERSION,
  loadLedgerState,
  readGoalLedger,
} from "../extensions/goal-ledger.ts";
import {
  goalAuditFailure,
  goalAuditHistory,
  type GoalAuditEvent,
} from "../extensions/fork-goal-audit-history.ts";
import { buildLedgerIndex } from "../extensions/goal-ledger-index.ts";

const at = "2026-11-20T12:00:00Z";
const start = (auditId: string, goalId = "g"): GoalAuditEvent => ({
  type: "audit_started",
  auditId,
  goalId,
  at,
});
const result = (
  auditId: string,
  verdict: "approved" | "disapproved" | "error",
  report = verdict as string,
  goalId = "g",
): GoalAuditEvent => ({
  type: "audit_result",
  auditId,
  goalId,
  verdict,
  report,
  at,
});

test("failure projection uses accepted attempt history, not the last result or event timestamp", () => {
  const first = result("a", "disapproved");
  const busy = [
    start("a"),
    first,
    start("b"),
    result("a", "error", "late"),
    result("x", "error", "other goal", "other"),
  ];
  const index = buildLedgerIndex(busy);
  const expected = {
    verdict: "disapproved",
    report: "disapproved",
    at,
    historical: true,
  };
  assert.deepEqual(goalAuditFailure(goalAuditHistory(busy, "g")), expected);
  assert.deepEqual(goalAuditFailure(index.get("g")), expected);
  assert.equal(goalAuditFailure(index.get("other"))?.report, "other goal");
  assert.equal(goalAuditFailure(index.get("missing")), undefined);
  // Existing auditor warm context still uses the original settled pin.
  assert.deepEqual(index.get("g")?.settledAudit, busy[3]);
  assert.deepEqual(
    goalAuditFailure(goalAuditHistory([...busy, result("b", "error")], "g")),
    { verdict: "error", report: "error", at, historical: false },
  );
});

test("approval and explicit skips supersede failures, even after a new start", () => {
  const failed = [start("a"), result("a", "disapproved"), start("b")];
  const terminalEvents: GoalAuditEvent[] = [
    result("b", "approved"),
    {
      type: "audit_skipped",
      goalId: "g",
      auditId: "b",
      reason: "user_aborted",
      at,
    },
    {
      type: "audit_skipped",
      goalId: "g",
      auditId: "disabled",
      reason: "disabled",
      at,
    },
  ];
  for (const terminal of terminalEvents) {
    const events = [
      ...failed,
      terminal,
      start("c"),
      result("b", "disapproved", "late"),
    ];
    assert.equal(goalAuditFailure(goalAuditHistory(events, "g")), undefined);
    assert.equal(
      goalAuditFailure(buildLedgerIndex(events).get("g")),
      undefined,
    );
  }
});

test("bounded runtime audit history survives old checkpoints, cold replay and in-process append", (t) => {
  const cwd = fs.mkdtempSync(join(tmpdir(), "goal-audit-checkpoint-"));
  t.after(() => {
    invalidateGoalLedgerCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const ctx = { cwd };
  for (const event of [
    start("a"),
    result("a", "disapproved", "old report"),
    start("b"),
    result("a", "error", "late"),
  ]) {
    assert.ok(appendGoalEvent(ctx, event));
  }
  for (let i = 0; i < 70; i++) {
    assert.ok(
      appendGoalEvent(ctx, {
        type: "task_started",
        goalId: "g",
        taskId: `task-${i}`,
        at: new Date(Date.parse(at) + (i + 1) * 1000).toISOString(),
      }),
    );
  }
  const ledger = goalLedgerPath(ctx);
  const checkpoint = join(dirname(ledger), LEDGER_CHECKPOINT_FILE);
  const original = fs.readFileSync(ledger, "utf8");
  const replay = () =>
    goalAuditFailure(goalAuditHistory(readGoalLedger(ctx).events, "g"));
  invalidateGoalLedgerCache();
  assert.equal(loadLedgerState(ctx).source, "full");
  const expected = replay();
  assert.deepEqual(expected, {
    verdict: "disapproved",
    report: "old report",
    at,
    historical: true,
  });
  assert.deepEqual(goalRuntimeAuditFailure(ctx, "g"), expected);
  assert.equal(
    goalActivityEvents(ctx, "g").some((event) => event.type === "audit_result"),
    false,
  );

  const stale = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
  stale.version = LEDGER_CHECKPOINT_VERSION - 1;
  for (const [, entry] of stale.runtimeIndex)
    delete entry.acceptedAuditTerminal;
  fs.writeFileSync(checkpoint, JSON.stringify(stale));
  invalidateGoalLedgerCache();
  assert.equal(loadLedgerState(ctx).source, "full");
  assert.deepEqual(goalRuntimeAuditFailure(ctx, "g"), expected);
  assert.equal(fs.readFileSync(ledger, "utf8"), original);

  invalidateGoalLedgerCache();
  assert.equal(loadLedgerState(ctx).source, "checkpoint");
  assert.deepEqual(goalRuntimeAuditFailure(ctx, "g"), expected);
  assert.ok(appendGoalEvent(ctx, result("b", "error", "current error")));
  assert.deepEqual(goalRuntimeAuditFailure(ctx, "g"), replay());
  assert.equal(goalRuntimeAuditFailure(ctx, "g")?.report, "current error");

  // External append forces the cold positioned tail path (not just warm mutation).
  fs.appendFileSync(
    ledger,
    `${JSON.stringify(start("c"))}\n${JSON.stringify(result("c", "approved"))}\n`,
  );
  invalidateGoalLedgerCache();
  assert.equal(loadLedgerState(ctx).source, "tail");
  assert.equal(goalRuntimeAuditFailure(ctx, "g"), undefined);
  assert.deepEqual(goalRuntimeAuditFailure(ctx, "g"), replay());
});
