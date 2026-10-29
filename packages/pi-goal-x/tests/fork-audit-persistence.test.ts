import test from "node:test";
import assert from "node:assert/strict";
import { stabilizationHarness } from "./stabilization-utils.ts";
import { saveGoalSettingsFileConfig } from "../extensions/goal-settings.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

const approved = { approved: true, output: "Evidence checked. <approved/>", model: "fixture" };

for (const failedType of ["audit_started", "audit_result", "audit_skipped"] as const) {
 test(`failed ${failedType} persistence keeps the goal open`, async () => {
  let auditorCalls = 0;
  const h = stabilizationHarness(async () => { auditorCalls++; return approved; });
  try {
   if (failedType === "audit_skipped") saveGoalSettingsFileConfig(h.cwd, { auditor: { disabled: true } });
   await h.start();
   const append = h.core.goalService.appendEvents.bind(h.core.goalService);
   h.core.goalService.appendEvents = (ctx, events, options) =>
    events.some(event => event.type === failedType) ? false : append(ctx, events, options);
   const result = await h.call("update_goal", { status: "complete" });
   assert.equal(result.isError, true);
   assert.match(result.content[0].text, /could not be persisted/);
   assert.equal(h.core.state.goal?.status, "active");
   assert.equal(h.core.activeAudit, null);
   assert.equal(auditorCalls, failedType === "audit_result" ? 1 : 0);
   assert.ok(!h.sent.some(message => JSON.stringify(message).includes("Goal completed —")), "no completion notice may precede a failed audit outcome");
  } finally { await h.cleanup(); }
 });
}

test("a missing completion_requested record does not block a durable approved audit", async () => {
 const h = stabilizationHarness(async () => approved);
 try {
  await h.start();
  const append = h.core.goalService.appendEvents.bind(h.core.goalService);
  h.core.goalService.appendEvents = (ctx, events: GoalLedgerEvent[], options) =>
   events.some(event => event.type === "completion_requested") ? false : append(ctx, events, options);
  const result = await h.call("update_goal", { status: "complete" });
  assert.notEqual(result.isError, true);
  assert.equal(h.core.state.goal?.status, "complete");
  assert.ok(h.ledger().some(event => event.type === "audit_started"));
  assert.ok(h.ledger().some(event => event.type === "audit_result" && event.verdict === "approved"));
 } finally { await h.cleanup(); }
});
