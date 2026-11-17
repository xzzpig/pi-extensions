import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AuditorProgress } from "../extensions/goal-auditor.ts";
import type { AuditItemProgress } from "../extensions/fork-audit-checklist.ts";
import {
  deriveAuditorDashboardModel,
  deriveAuditResultCard,
} from "../extensions/widgets/auditor-dashboard-model.ts";
import { renderAuditorDashboard } from "../extensions/widgets/goal-dashboard-renderer.ts";
import { auditDashboardBody } from "../extensions/widgets/fork-auditor-dashboard-renderer.ts";
import { AuditDashboardViewport } from "../extensions/widgets/fork-audit-viewport.ts";
import { GoalWidgetComponent } from "../extensions/widgets/goal-widget.ts";
import { createMockTheme, createMockTUI } from "./tui-test-utils.ts";

const theme = createMockTheme();
function item(
  index: number,
  state: AuditItemProgress["state"] = "pending",
): AuditItemProgress {
  return {
    id: `extra-${index}`,
    label: `检查项目 ${index}`,
    source: "extra",
    state,
    sequence: index,
  };
}
function progress(checks: AuditItemProgress[] = []): AuditorProgress {
  return {
    attemptId: "audit-1",
    checks,
    phase: "running",
    elapsedMs: 42000,
    recentOutput: [],
  };
}

test("model exposes actual ordered checks, never infers states from percentages or verdict", () => {
  const p = progress([
    item(1, "pending"),
    item(2, "running"),
    item(3, "failed"),
    item(4, "passed"),
  ]);
  for (const percentage of [0, 20, 40, 60, 80, 100]) {
    for (const verdict of ["approved", "disapproved", "error"] as const) {
      const model = deriveAuditorDashboardModel(
        { ...p, phase: "done", percentage },
        { verdict },
      );
      assert.deepEqual(
        model.checks.map((i) => [i.id, i.state]),
        p.checks?.map((i) => [i.id, i.state]),
      );
      assert.equal(model.active, false);
      assert.equal(model.verdict, verdict);
      model.checks[0]!.state = "passed";
      assert.equal(
        p.checks?.[0]?.state,
        "pending",
        "model is an observer-owned copy",
      );
    }
  }
  assert.deepEqual(
    deriveAuditorDashboardModel({ ...p, checks: undefined }).checks,
    [],
  );
});

test("compact summary uses reviewed counts and latest running item, expanded shows all details", () => {
  const model = deriveAuditorDashboardModel(
    progress([
      item(1, "passed"),
      item(2, "passed"),
      item(3, "failed"),
      item(4, "running"),
      item(5, "running"),
      item(6),
    ]),
    { auditorLabel: "provider/model" },
  );
  model.checks[2]!.detail = "需要额外证据";
  const compact = renderAuditorDashboard(model, theme, 100).join("\n");
  assert.match(compact, /已检查 3\/6 · 通过 2 · 不通过 1/);
  assert.match(compact, /◌ 检查项目 5/);
  assert.doesNotMatch(compact, /需要额外证据/);
  const expanded = renderAuditorDashboard(model, theme, 100, {
    showToolDetails: true,
    viewportRows: 10,
  }).join("\n");
  assert.match(expanded, /需要额外证据/);
  assert.match(expanded, /检查项目 6/);
});

test("empty lists and legacy estimates remain honest, finished running rows do not animate", () => {
  const empty = renderAuditorDashboard(
    deriveAuditorDashboardModel({ ...progress(), percentage: 100 }),
    theme,
    100,
  ).join("\n");
  assert.match(empty, /已检查 0\/0/);
  assert.match(empty, /没有配置检查项/);
  assert.match(empty, /审计员估计 100%/);
  assert.doesNotMatch(empty, /NaN|Objective and success criteria/);
  const done = renderAuditorDashboard(
    deriveAuditorDashboardModel({
      ...progress([item(1, "running"), item(2)]),
      phase: "done",
    }),
    theme,
    100,
    { showToolDetails: true },
  ).join("\n");
  assert.doesNotMatch(done, /◌|✓/);
  assert.match(done, /审计已结束/);
});

test("expanded body preserves long Chinese and all evidence, control text cannot drive the terminal", () => {
  const p = progress([
    {
      ...item(1, "failed"),
      label: "中文标题".repeat(60),
      detail: "验证依据".repeat(100) + "末尾唯一标识",
    },
  ]);
  p.currentTool = "read";
  p.currentToolArgs = "src/a.ts";
  p.recentOutput = ["evidence\u001b[2J\u0007tail"];
  const model = deriveAuditorDashboardModel(p);
  for (const width of [10, 24, 40, 80, 100]) {
    const rows = auditDashboardBody(model, width);
    assert.ok(rows.join("").includes("末尾唯一标识"));
    assert.ok(rows.join("").includes("read"));
    const rendered = renderAuditorDashboard(model, theme, width, {
      showToolDetails: true,
      viewportRows: 5,
    });
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    // SDK wrapping may append safe SGR resets; no other terminal escapes are permitted.
    assert.ok(
      !rendered
        .join("")
        .replace(/\u001b\[[0-9;]*m/g, "")
        .includes("\u001b"),
    );
    assert.ok(!rendered.join("").includes("\u0007"));
  }
});

test("viewport scroll is bounded, retained for one attempt and reset for a new one", () => {
  const view = new AuditDashboardViewport();
  view.maxRows = 8;
  const p = progress(Array.from({ length: 40 }, (_, i) => item(i + 1)));
  let renders = 0;
  const render = () => view.render(p, theme, 80, { expanded: true }).join("\n");
  assert.match(render(), /检查项目 1 /);
  assert.equal(
    view.navigate("end", () => renders++),
    true,
  );
  assert.match(render(), /检查项目 40/);
  p.elapsedMs += 1000;
  assert.match(render(), /检查项目 40/);
  view.maxRows = 6;
  assert.match(render(), /已检查 0\/40/);
  view.navigate("end", () => renders++);
  assert.match(render(), /检查项目 40/);
  p.attemptId = "audit-2";
  assert.match(render(), /检查项目 1 /);
  assert.doesNotMatch(render(), /检查项目 40/);
  view.navigate("pageDown", () => renders++);
  view.navigate("pageUp", () => renders++);
  view.navigate("home", () => renders++);
  assert.match(render(), /检查项目 1 /);
  assert.ok(renders >= 5);
});

test("actual widget navigation reaches the last item in a short terminal and survives resize", () => {
  const { tui, state } = createMockTUI({ terminalRows: 18 });
  let expanded = true;
  const p = progress(Array.from({ length: 40 }, (_, i) => item(i + 1)));
  const widget = new GoalWidgetComponent({
    tui,
    theme,
    getGoal: () => null,
    getAuditorProgress: () => p,
    getExpanded: () => expanded,
  });
  const first = widget.render(72);
  assert.ok(first.length <= 12);
  assert.equal(widget.handleNavigationKey("end"), true);
  assert.match(widget.render(72).join("\n"), /检查项目 40/);
  assert.match(widget.render(72).join("\n"), /已检查 0\/40/);
  Reflect.set(Reflect.get(tui, "terminal"), "rows", 12);
  const resized = widget.render(40);
  assert.ok(resized.length <= 6);
  assert.ok(resized.every((line) => visibleWidth(line) <= 40));
  widget.handleNavigationKey("end");
  assert.match(widget.render(40).join("\n"), /检查项目 40/);
  p.attemptId = "audit-2";
  assert.match(widget.render(72).join("\n"), /检查项目 1 /);
  expanded = false;
  widget.render(72);
  assert.equal(widget.handleNavigationKey("down"), false);
  assert.equal(widget.handleCompactScrollKey("down"), false);
  assert.ok(state.requestRenderCalls > 0);
});

test("approval card reports actual verdict/report without fabricating checklist acceptance", () => {
  const card = deriveAuditResultCard(
    "approved",
    "Auditor approved after review.",
  );
  assert.equal(card.verdict, "approved");
  assert.deepEqual(card.lines, ["Auditor approved after review."]);
  assert.doesNotMatch(
    card.lines.join("\n"),
    /Required tasks and evidence accepted|Verification requirements satisfied/,
  );
});
