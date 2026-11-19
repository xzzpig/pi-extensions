import test from "node:test";
import assert from "node:assert/strict";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AuditorProgress } from "../extensions/goal-auditor.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { GoalWidgetComponent } from "../extensions/widgets/goal-widget.ts";
import { AuditDashboardViewport } from "../extensions/widgets/fork-audit-viewport.ts";
import { createMockTheme, createMockTUI } from "./tui-test-utils.ts";

function progress(attemptId: string | undefined = "a"): AuditorProgress {
  return {
    attemptId,
    phase: "running",
    elapsedMs: 1000,
    recentOutput: [],
    checks: Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      label: `检查项 ${i}`,
      source: "extra" as const,
      state: "pending" as const,
      detail: `依据 ${i} ` + "很长的中文依据".repeat(8),
    })),
  };
}
function event(
  type: TuiMouseEvent["type"],
  x: number,
  y: number,
  patch: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...patch,
  };
}

test("审计滚轮与键盘共用 offset，刷新保留，新 attempt、目标与生命周期隔离", () => {
  const view = new AuditDashboardViewport();
  view.maxRows = 9;
  let p = progress();
  const draw = () =>
    view
      .render(p, createMockTheme(), 80, {
        expanded: true,
        interactive: true,
        goalId: "g",
      })
      .join("\n");
  assert.match(draw(), /检查项 0/);
  assert.equal(
    view.scroll(8, () => {}),
    true,
  );
  assert.doesNotMatch(draw(), /检查项 0/);
  const held = draw();
  p = { ...p, elapsedMs: 9000 };
  assert.equal(draw(), held.replace("1s", "9s"));
  view.navigate("end", () => {});
  assert.match(draw(), /检查项 29/);
  p = progress("b");
  assert.match(draw(), /检查项 0/);
  view.scroll(8, () => {});
  view.leave();
  p = { ...progress(), attemptId: undefined };
  assert.match(draw(), /检查项 0/);
  view.scroll(8, () => {});
  assert.match(
    view
      .render(p, createMockTheme(), 80, {
        expanded: true,
        interactive: true,
        goalId: "other",
      })
      .join("\n"),
    /检查项 0/,
  );
});

test("真实组件点击审计控件、滚轮和键盘，保持 audit 数据不变", async () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  let p = progress();
  const before = structuredClone(p);
  let expanded = false;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI({ terminalRows: 20 }).tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    getExpanded: () => expanded,
    onToggleExpanded: () => {
      expanded = !expanded;
    },
  });
  let lines = widget.render(80);
  let y = lines.findIndex((s) => s.includes("[展开]"));
  assert.ok(y >= 0, lines.join("\n"));
  assert.equal(widget.handleMouse(event("press", 2, y)), undefined);
  assert.deepEqual(
    widget.handleMouse(event("click", 7, y, { clickCount: 1 })),
    undefined,
  );
  widget.handleMouse(event("press", 7, y));
  assert.deepEqual(
    widget.handleMouse(event("click", 7, y, { clickCount: 1 })),
    { handled: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(expanded, true);
  lines = widget.render(80);
  y = 2;
  assert.deepEqual(
    widget.handleMouse(event("wheel", 5, y, { button: "none", wheelDelta: 5 })),
    { handled: true },
  );
  lines = widget.render(80);
  assert.doesNotMatch(lines.join("\n"), /检查项 0/);
  assert.equal(
    widget.handleMouse(
      event("wheel", 5, 0, { button: "none", wheelDelta: -2 }),
    ),
    undefined,
  );
  widget.handleNavigationKey("home");
  assert.match(widget.render(80).join("\n"), /检查项 0/);
  p = { ...p, elapsedMs: 2000 };
  assert.equal(p.attemptId, before.attemptId);
  assert.deepEqual(p.checks, before.checks);
});

test("控件首尾与空白按最终绘制命中，矮屏不泄漏隐藏区域", async () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  const p = progress();
  const checks: Array<() => void> = [];
  for (const width of [10, 19, 20, 80])
    for (const expanded of [false, true])
      for (const x of [0, 1, 2, 7, 8]) {
        let toggles = 0;
        const widget = new GoalWidgetComponent({
          tui: createMockTUI().tui,
          theme: createMockTheme(),
          getGoal: () => goal,
          getAuditorProgress: () => p,
          getExpanded: () => expanded,
          onToggleExpanded: () => toggles++,
        });
        const lines = widget.render(width);
        const y = lines.findIndex((s) =>
          s.includes(expanded ? "[收起]" : "[展开]"),
        );
        assert.ok(y >= 0, lines.join("\n"));
        widget.handleMouse(event("press", x, y, { width }));
        const result = widget.handleMouse(
          event("click", x, y, { width, clickCount: 1 }),
        );
        assert.equal(
          result?.handled === true,
          x >= 2 && x <= 7,
          `width=${width}, x=${x}`,
        );
        checks.push(() => assert.equal(toggles, x >= 2 && x <= 7 ? 1 : 0));
      }
  await new Promise((resolve) => setTimeout(resolve, 550));
  checks.forEach((check) => check());
  const tiny = new GoalWidgetComponent({
    tui: createMockTUI({ terminalRows: 8 }).tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    getExpanded: () => true,
  });
  const lines = tiny.render(80);
  assert.ok(lines.length <= 2);
  assert.equal(
    tiny.handleMouse(event("wheel", 5, 2, { button: "none", wheelDelta: 1 })),
    undefined,
  );
});

test("短窗口保留页眉、汇总、可见控件和停止提示，长中文依据可遍历", () => {
  const p = progress();
  p.checks![29]!.detail = "尾部唯一标记";
  for (const width of [20, 40, 80, 110]) {
    const view = new AuditDashboardViewport();
    view.maxRows = 7;
    const draw = () =>
      view.render(p, createMockTheme(), width, {
        expanded: true,
        interactive: true,
        goalId: "g",
      });
    let lines = draw();
    assert.equal(lines.length, 7);
    assert.match(lines[0]!, /^╭/);
    assert.match(lines[1]!, /已检查/);
    assert.ok(
      lines.some((s) => s.includes("[收起]")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((s) => s.includes("Esc")),
      lines.join("\n"),
    );
    assert.deepEqual(view.geometry.body, { first: 2, last: 4 });
    view.scroll(10000, () => {});
    lines = draw();
    assert.match(lines.join("\n"), /尾部唯一标记/);
    view.scroll(-10000, () => {});
    lines = draw();
    assert.match(lines.join("\n"), /检查项 0/);
  }
});

test("缺 attempt ID 的新审计与切换目标重新定位，普通刷新不重置", () => {
  const view = new AuditDashboardViewport();
  view.maxRows = 8;
  let p = { ...progress(), attemptId: undefined };
  const draw = (goalId = "g") =>
    view
      .render(p, createMockTheme(), 80, {
        expanded: true,
        interactive: true,
        goalId,
      })
      .join("\n");
  draw();
  view.scroll(12, () => {});
  const before = draw();
  assert.doesNotMatch(before, /检查项 0/);
  p = { ...p, elapsedMs: 2300 };
  assert.doesNotMatch(draw(), /检查项 0/);
  view.leave();
  assert.match(draw(), /检查项 0/);
  view.scroll(12, () => {});
  assert.match(draw("other"), /检查项 0/);
});

test("展开切换与同一次 attempt 挂起模拟不会丢失滚动；短清单被约束", () => {
  const view = new AuditDashboardViewport();
  view.maxRows = 8;
  let p = progress();
  const draw = (expanded: boolean) =>
    view
      .render(p, createMockTheme(), 80, {
        expanded,
        interactive: true,
        goalId: "g",
      })
      .join("\n");
  draw(true);
  view.scroll(12, () => {});
  assert.doesNotMatch(draw(true), /检查项 0/);
  draw(false);
  p = { ...p, elapsedMs: 10000 };
  assert.doesNotMatch(draw(true), /检查项 0/);
  p = { ...p, checks: p.checks!.slice(0, 1) };
  const short = draw(true);
  assert.match(short, /检查项 0/);
  assert.equal(
    view.scroll(-999, () => {}),
    true,
  );
  assert.match(draw(true), /检查项 0/);
});

test("组件缩放后正文与控件命中仅覆盖最终行，旧手势失效", () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  const p = progress();
  let expanded = true;
  const { tui } = createMockTUI({ terminalRows: 24 });
  const widget = new GoalWidgetComponent({
    tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    getExpanded: () => expanded,
    onToggleExpanded: () => {
      expanded = !expanded;
    },
  });
  let lines = widget.render(80);
  let control = lines.findIndex((s) => s.includes("[收起]"));
  assert.ok(control >= 0);
  widget.handleMouse(event("press", 2, control));
  (tui as unknown as { terminal: { rows: number } }).terminal.rows = 14;
  lines = widget.render(40);
  assert.ok(lines.length <= 8);
  assert.equal(
    widget.handleMouse(event("click", 2, control, { clickCount: 1 })),
    undefined,
  );
  assert.equal(expanded, true);
  assert.equal(
    widget.handleMouse(
      event("wheel", 5, lines.length, { button: "none", wheelDelta: 1 }),
    ),
    undefined,
  );
  control = lines.findIndex((s) => s.includes("[收起]"));
  assert.ok(control >= 0, lines.join("\n"));
  widget.handleMouse(event("press", 2, control, { width: 40, height: 14 }));
  assert.deepEqual(
    widget.handleMouse(
      event("click", 2, control, { width: 40, height: 14, clickCount: 1 }),
    ),
    { handled: true },
  );
});

test("空清单和滚动两端消费事件，标题、控件和边框不消费", () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  let p = progress();
  let expanded = true;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI({ terminalRows: 18 }).tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    getExpanded: () => expanded,
  });
  let lines = widget.render(80);
  let y = 2;
  for (const delta of [-999, -999, 9999, 9999]) {
    assert.deepEqual(
      widget.handleMouse(
        event("wheel", 4, y, { button: "none", wheelDelta: delta }),
      ),
      { handled: true },
    );
    lines = widget.render(80);
  }
  const control = lines.findIndex((s) => s.includes("[收起]"));
  for (const [x, row] of [
    [4, 0],
    [4, 1],
    [4, control],
    [0, 2],
  ] as const)
    assert.equal(
      widget.handleMouse(
        event("wheel", x, row, { button: "none", wheelDelta: 1 }),
      ),
      undefined,
    );
  p = { ...p, checks: [] };
  lines = widget.render(80);
  assert.deepEqual(
    widget.handleMouse(event("wheel", 4, 2, { button: "none", wheelDelta: 1 })),
    { handled: true },
  );
  assert.match(lines.join("\n"), /没有配置检查项/);
  expanded = false;
  widget.render(80);
  assert.equal(
    widget.handleMouse(event("wheel", 4, 2, { button: "none", wheelDelta: 1 })),
    undefined,
  );
});

test("审计变更和可见分支切换清除旧手势且不会执行隐藏任务动作", () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: [
      {
        id: "p",
        title: "父任务",
        status: "pending",
        subtasks: [{ id: "child", title: "子任务", status: "pending" }],
      },
    ],
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "p";
  const snapshot = structuredClone(goal);
  let p: AuditorProgress | null = progress();
  let expanded = false;
  let toggles = 0;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    getExpanded: () => expanded,
    onToggleExpanded: () => toggles++,
  });
  let lines = widget.render(80);
  let y = lines.findIndex((s) => s.includes("[展开]"));
  widget.handleMouse(event("press", 2, y));
  p = { ...p!, attemptId: "b" };
  widget.render(80);
  assert.equal(
    widget.handleMouse(event("click", 2, y, { clickCount: 1 })),
    undefined,
  );
  assert.equal(toggles, 0);
  widget.handleMouse(event("press", 2, y));
  p = null;
  widget.update();
  lines = widget.render(80);
  assert.equal(
    widget.handleMouse(event("click", 2, y, { clickCount: 1 })),
    undefined,
  );
  assert.equal(toggles, 0);
  y = lines.findIndex((s) => s.includes("父任务") && !s.includes("Current"));
  widget.handleMouse(event("press", 4, y));
  p = progress();
  widget.render(80);
  p = null;
  widget.update();
  widget.render(80);
  assert.equal(
    widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
    undefined,
  );
  assert.ok(widget.render(80).some((s) => s.includes("子任务")));
  assert.deepEqual(goal, snapshot);
});

test("审计控件拖动、右键和双击不触发额外切换", () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  const p = progress();
  let toggles = 0;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    onToggleExpanded: () => toggles++,
  });
  const y = widget.render(80).findIndex((s) => s.includes("[展开]"));
  widget.handleMouse(event("press", 2, y));
  widget.handleMouse(event("drag", 3, y));
  assert.equal(
    widget.handleMouse(event("click", 2, y, { clickCount: 1 })),
    undefined,
  );
  widget.handleMouse(event("press", 2, y, { button: "right" }));
  assert.equal(
    widget.handleMouse(
      event("click", 2, y, { button: "right", clickCount: 1 }),
    ),
    undefined,
  );
  widget.handleMouse(event("press", 2, y));
  assert.equal(
    widget.handleMouse(event("click", 2, y, { clickCount: 2 })),
    undefined,
  );
  assert.equal(toggles, 0);
});

test("Escape 实际视图切换：同一 lifecycle 暂无进度再恢复，空快照不丢位置，新生命周期重置", () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  const lifecycle1 = {};
  let lifecycle: object | null = lifecycle1;
  const original = { ...progress(), attemptId: undefined };
  let p: AuditorProgress | null = original;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI({ terminalRows: 18 }).tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    getAuditLifecycle: () => lifecycle,
    getExpanded: () => true,
  });
  widget.render(80);
  widget.handleMouse(event("wheel", 5, 2, { button: "none", wheelDelta: 12 }));
  let lines = widget.render(80);
  assert.doesNotMatch(lines.join("\n"), /检查项 0/);
  p = null;
  widget.update();
  widget.render(80);
  p = { phase: "running", elapsedMs: 0, recentOutput: [] };
  widget.update();
  widget.render(80);
  p = { ...original, elapsedMs: 10 };
  widget.update();
  lines = widget.render(80);
  assert.doesNotMatch(lines.join("\n"), /检查项 0/);
  p = null;
  lifecycle = null;
  widget.update();
  widget.render(80);
  lifecycle = {};
  p = original;
  widget.update();
  assert.match(widget.render(80).join("\n"), /检查项 0/);
});

test("双击首击不会提前切换，选择第二击取消待执行动作，延迟期间失效的目标不切换", async () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  let p: AuditorProgress | null = progress();
  let count = 0;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    onToggleExpanded: () => count++,
  });
  const y = widget.render(80).findIndex((s) => s.includes("[展开]"));
  widget.handleMouse(event("press", 4, y));
  widget.handleMouse(event("click", 4, y, { clickCount: 1 }));
  widget.handleMouse(event("press", 4, y));
  widget.handleMouse(event("click", 4, y, { clickCount: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(count, 0);
  widget.handleMouse(event("press", 4, y));
  widget.handleMouse(event("click", 4, y, { clickCount: 1 }));
  p = { ...p!, attemptId: "replacement" };
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(count, 0);
});

test("单击待确认期间打开浮层不会触发底层切换", async () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  const p = progress();
  let overlay = false;
  let toggles = 0;
  const { tui } = createMockTUI();
  Object.assign(tui, { hasOverlay: () => overlay });
  const widget = new GoalWidgetComponent({
    tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    onToggleExpanded: () => toggles++,
  });
  const y = widget.render(80).findIndex((s) => s.includes("[展开]"));
  widget.handleMouse(event("press", 4, y));
  widget.handleMouse(event("click", 4, y, { clickCount: 1 }));
  overlay = true;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(toggles, 0);
});

test("宿主优先消费链接时不产生组件 click，无延迟切换", async () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  let count = 0;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => progress(),
    onToggleExpanded: () => count++,
  });
  const y = widget.render(80).findIndex((s) => s.includes("[展开]"));
  widget.handleMouse(event("press", 4, y));
  widget.handleMouse(event("release", 4, y));
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(count, 0);
});

test("往返布局、attempt、目标及模式的每次实际绘制不可逆地取消手势和延迟动作", async () => {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 560));
  for (const mode of ["press", "pending"] as const)
    for (const change of [
      "width",
      "attempt",
      "goal",
      "expanded",
      "height",
      "lifecycle",
    ] as const) {
      const originalGoal = createGoal({
        objective: "目标",
        autoContinue: false,
        sisyphus: false,
      });
      let goal = originalGoal;
      let p = progress("a");
      let expanded = false;
      const lifecycle1 = {};
      let lifecycle: object = lifecycle1;
      let toggles = 0;
      const { tui } = createMockTUI({ terminalRows: 24 });
      const widget = new GoalWidgetComponent({
        tui,
        theme: createMockTheme(),
        getGoal: () => goal,
        getAuditorProgress: () => p,
        getExpanded: () => expanded,
        getAuditLifecycle: () => lifecycle,
        onToggleExpanded: () => toggles++,
      });
      const y = widget.render(80).findIndex((s) => s.includes("[展开]"));
      assert.ok(y >= 0);
      widget.handleMouse(event("press", 4, y));
      if (mode === "pending")
        assert.deepEqual(
          widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
          { handled: true },
        );
      if (change === "width") {
        widget.render(40);
        widget.render(80);
      }
      if (change === "attempt") {
        p = progress("b");
        widget.render(80);
        p = progress("a");
        widget.render(80);
      }
      if (change === "goal") {
        goal = createGoal({
          objective: "其他",
          autoContinue: false,
          sisyphus: false,
        });
        widget.render(80);
        goal = originalGoal;
        widget.render(80);
      }
      if (change === "expanded") {
        expanded = true;
        widget.render(80);
        expanded = false;
        widget.render(80);
      }
      if (change === "height") {
        const terminal = (tui as unknown as { terminal: { rows: number } })
          .terminal;
        terminal.rows = 18;
        widget.render(80);
        terminal.rows = 24;
        widget.render(80);
      }
      if (change === "lifecycle") {
        lifecycle = {};
        widget.render(80);
        lifecycle = lifecycle1;
        widget.render(80);
      }
      if (mode === "press")
        assert.equal(
          widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
          undefined,
          `${mode} ${change}`,
        );
      await wait();
      assert.equal(toggles, 0, `${mode} ${change}`);
    }
});

test("状态更新的 attempt 往返即使尚未重绘也使旧手势失效；相同布局的普通刷新保留单击", async () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  let p = progress("a");
  let count = 0;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => p,
    onToggleExpanded: () => count++,
  });
  const y = widget.render(80).findIndex((s) => s.includes("[展开]"));
  widget.handleMouse(event("press", 4, y));
  p = progress("b");
  widget.update();
  p = progress("a");
  widget.update();
  widget.render(80);
  assert.equal(
    widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
    undefined,
  );
  widget.handleMouse(event("press", 4, y));
  widget.handleMouse(event("click", 4, y, { clickCount: 1 }));
  p = { ...p, elapsedMs: 5000 };
  widget.update();
  widget.render(80);
  await new Promise((resolve) => setTimeout(resolve, 560));
  assert.equal(count, 1);
});

test("浮层出现后消失不可复活旧按下或延迟单击", async () => {
  for (const kind of ["press", "pending"] as const)
    for (const observation of ["update", "render"] as const) {
      const goal = createGoal({
        objective: "目标",
        autoContinue: false,
        sisyphus: false,
      });
      let overlay = false;
      let toggles = 0;
      const { tui } = createMockTUI();
      Object.assign(tui, { hasOverlay: () => overlay });
      const widget = new GoalWidgetComponent({
        tui,
        theme: createMockTheme(),
        getGoal: () => goal,
        getAuditorProgress: () => progress(),
        onToggleExpanded: () => toggles++,
      });
      const y = widget.render(80).findIndex((s) => s.includes("[展开]"));
      widget.handleMouse(event("press", 4, y));
      if (kind === "pending")
        assert.deepEqual(
          widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
          { handled: true },
        );
      overlay = true;
      if (observation === "update") widget.update();
      else widget.render(80);
      overlay = false;
      if (observation === "update") widget.update();
      else widget.render(80);
      if (kind === "press")
        assert.equal(
          widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
          undefined,
          `${kind}/${observation}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 560));
      assert.equal(toggles, 0, `${kind}/${observation}`);
    }
});
