import assert from "node:assert/strict";
import test from "node:test";
import { appendGoalEvent } from "../extensions/goal-ledger.ts";
import { buildBlockerFingerprint } from "../extensions/goal-oracle.ts";
import { saveGoalSettingsFileConfig } from "../extensions/goal-settings.ts";
import { stabilizationHarness } from "./stabilization-utils.ts";
import { createMockTheme } from "./tui-test-utils.ts";

const reason = `需要外部确认。\n\n第二段保留空行。\n${"补充阻塞细节。".repeat(35)}\nBLOCKER-ORIGINAL-END`;

test("the verbose status command prints the saved reason in its original line order", async (t) => {
  const h = stabilizationHarness();
  t.after(() => h.cleanup());
  await h.start();
  const result = await h.call("update_goal", { status: "blocked", reason });
  assert.equal(result.terminate, true);
  const status = h.commands.get("goal-status");
  await status.handler("", h.ctx);
  assert.doesNotMatch(h.notices.at(-1)!, /BLOCKER-ORIGINAL-END/);
  await status.handler("verbose", h.ctx);
  assert.ok(h.notices.at(-1)!.includes(`Pause/blocker: ${reason}\n`));
});

test("successful blocking persists a result-scoped reason for the expanded transcript only", async (t) => {
  const h = stabilizationHarness();
  t.after(() => h.cleanup());
  await h.start();
  const result = await h.call("update_goal", {
    status: "blocked",
    reason: `  ${reason}  `,
  });
  assert.equal(result.terminate, true);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "Goal blocked. Continuation stopped; the goal is waiting for the user to resume, revise, or clear it. Stop now; do not start another tool call.",
    },
  ]);
  assert.equal(result.details.resultDetail, `Blocker: ${reason}`);
  assert.equal(h.core.state.goal?.pauseReason, reason);
  await h.commands.get("goal-resume").handler("", h.ctx);
  assert.equal(h.core.state.goal?.status, "active");
  const laterReason = "A different blocker, not the original.";
  assert.equal(
    (await h.call("update_goal", { status: "blocked", reason: laterReason }))
      .terminate,
    true,
  );

  const saved = JSON.parse(JSON.stringify(result));
  const render = (expanded: boolean) =>
    h.tools
      .get("update_goal")
      .renderResult(saved, { expanded }, createMockTheme());
  assert.doesNotMatch(
    render(false).render(80).join("\n"),
    /BLOCKER-ORIGINAL-END/,
  );
  const full: string = render(true)
    .render(80)
    .map((line: string) => line.trimEnd())
    .join("\n");
  assert.match(full, /Blocker: 需要外部确认。\n\n第二段保留空行。/);
  assert.match(full, /BLOCKER-ORIGINAL-END/);
  assert.ok(!full.includes(laterReason));
  delete saved.details.resultDetail;
  assert.doesNotMatch(
    render(true).render(80).join("\n"),
    /BLOCKER-ORIGINAL-END/,
  );
});

test("validation and write failures do not attach successful block details", async (t) => {
  const h = stabilizationHarness();
  t.after(() => h.cleanup());
  await h.start();
  const invalid = await h.call("update_goal", {
    status: "blocked",
    reason: " ",
  });
  assert.notEqual(invalid.terminate, true);
  assert.equal(invalid.details.resultDetail, undefined);
  t.mock.method(h.core.goalService, "apply", () => ({
    ok: false,
    message: "conflict",
  }));
  const failed = await h.call("update_goal", { status: "blocked", reason });
  assert.match(failed.content[0].text, /NOT marked blocked/);
  assert.notEqual(failed.terminate, true);
  assert.equal(failed.details.resultDetail, undefined);
  assert.equal(h.core.state.goal?.status, "active");
  assert.ok(!h.ledger().some((event) => event.type === "goal_blocked"));
});

test("actionable Oracle advice is not rendered as a successful block", async (t) => {
  const h = stabilizationHarness();
  t.after(() => h.cleanup());
  saveGoalSettingsFileConfig(h.cwd, {
    oracle: {
      enabled: true,
      projectResources: false,
      maxFailedAttemptsPerBlocker: 2,
    },
  });
  await h.start();
  const goal = h.core.state.goal!;
  appendGoalEvent(h.ctx, {
    type: "oracle_result",
    goalId: goal.id,
    fingerprint: buildBlockerFingerprint(goal, reason),
    adviceId: "advice-1",
    disposition: "actionable",
    summary: "Try the alternative.",
    at: new Date().toISOString(),
  });
  const result = await h.call("update_goal", { status: "blocked", reason });
  assert.match(result.content[0].text, /NOT marked blocked/);
  assert.equal(result.terminate, false);
  assert.equal(result.details.resultDetail, undefined);
  assert.equal(h.core.state.goal?.status, "active");
  assert.ok(!h.ledger().some((event) => event.type === "goal_blocked"));
});
