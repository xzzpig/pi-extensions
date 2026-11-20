import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  isKittyProtocolActive,
  setKittyProtocolActive,
} from "@earendil-works/pi-tui/dist/keys.js";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
} from "@earendil-works/pi-tui/dist/keybindings.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GOAL_KEYBINDINGS,
  loadGoalSettings,
} from "../extensions/goal-settings.ts";
import type { AuditorProgress } from "../extensions/goal-auditor.ts";
import { syncTerminalInputPause } from "../extensions/goal-widget.ts";
import { createGoalCore } from "../extensions/goal-state.ts";
import { createGoal } from "../extensions/goal-record.ts";
import {
  GoalWidgetComponent,
  renderAuditorWidgetLines,
} from "../extensions/widgets/goal-widget.ts";
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
function auditFooter(lines: string[]): number {
  const line = lines.findIndex((text) => text.startsWith("╰"));
  assert.ok(line >= 0, lines.join("\n"));
  return line;
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
  let y = auditFooter(lines);
  assert.ok(y >= 0, lines.join("\n"));
  assert.equal(widget.handleMouse(event("press", 4, y)), undefined);
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
  for (const width of [10, 11, 14, 15, 80])
    for (const expanded of [false, true]) {
      const create = (onToggleExpanded: () => void) =>
        new GoalWidgetComponent({
          tui: createMockTUI().tui,
          theme: createMockTheme(),
          getGoal: () => goal,
          getAuditorProgress: () => p,
          getExpanded: () => expanded,
          onToggleExpanded,
        });
      const lines = create(() => {}).render(width);
      const y = auditFooter(lines);
      const footer = lines[y]!;
      const match = footer.match(/\[(?:收起|展开)(?:清单)?\]/);
      const start = match ? visibleWidth(footer.slice(0, match.index)) : -1;
      const end = match ? start + visibleWidth(match[0]) : -1;
      const action = expanded ? "收起" : "展开";
      assert.equal(
        match?.[0],
        width >= 15
          ? `[${action}清单]`
          : width >= 11
            ? `[${action}]`
            : undefined,
      );
      for (const x of [0, 1, start - 1, start, end - 1, end, width - 1].filter(
        (col) => col >= 0,
      )) {
        let toggles = 0;
        const widget = create(() => toggles++);
        widget.render(width);
        widget.handleMouse(event("press", x, y, { width }));
        const result = widget.handleMouse(
          event("click", x, y, { width, clickCount: 1 }),
        );
        const hits = x >= start && x < end;
        assert.equal(result?.handled === true, hits, `width=${width}, x=${x}`);
        checks.push(() => assert.equal(toggles, hits ? 1 : 0));
      }
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
    const footer = lines[auditFooter(lines)]!;
    assert.match(footer, /\[收起清单\]/);
    if (width >= 40) assert.match(footer, /Esc: stop audit/);
    assert.deepEqual(view.geometry.body, { first: 2, last: 5 });
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
  let control = auditFooter(lines);
  assert.ok(control >= 0);
  widget.handleMouse(event("press", 4, control));
  (tui as unknown as { terminal: { rows: number } }).terminal.rows = 14;
  lines = widget.render(40);
  assert.ok(lines.length <= 8);
  assert.equal(
    widget.handleMouse(event("click", 4, control, { clickCount: 1 })),
    undefined,
  );
  assert.equal(expanded, true);
  assert.equal(
    widget.handleMouse(
      event("wheel", 5, lines.length, { button: "none", wheelDelta: 1 }),
    ),
    undefined,
  );
  control = auditFooter(lines);
  assert.ok(control >= 0, lines.join("\n"));
  widget.handleMouse(event("press", 4, control, { width: 40, height: 14 }));
  assert.deepEqual(
    widget.handleMouse(
      event("click", 4, control, { width: 40, height: 14, clickCount: 1 }),
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
  const control = auditFooter(lines);
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
  let y = auditFooter(lines);
  widget.handleMouse(event("press", 4, y));
  p = { ...p!, attemptId: "b" };
  widget.render(80);
  assert.equal(
    widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
    undefined,
  );
  assert.equal(toggles, 0);
  widget.handleMouse(event("press", 4, y));
  p = null;
  widget.update();
  lines = widget.render(80);
  assert.equal(
    widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
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
  const y = auditFooter(widget.render(80));
  widget.handleMouse(event("press", 4, y));
  widget.handleMouse(event("drag", 5, y));
  assert.equal(
    widget.handleMouse(event("click", 4, y, { clickCount: 1 })),
    undefined,
  );
  widget.handleMouse(event("press", 4, y, { button: "right" }));
  assert.equal(
    widget.handleMouse(
      event("click", 4, y, { button: "right", clickCount: 1 }),
    ),
    undefined,
  );
  widget.handleMouse(event("press", 4, y));
  assert.equal(
    widget.handleMouse(event("click", 4, y, { clickCount: 2 })),
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
  const y = auditFooter(widget.render(80));
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
  const y = auditFooter(widget.render(80));
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
  const y = auditFooter(widget.render(80));
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
      const y = auditFooter(widget.render(80));
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
  const y = auditFooter(widget.render(80));
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
      const y = auditFooter(widget.render(80));
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

test("清单切换只出现于底边框，中断与生效的收起键明确分开", () => {
  let expanded = false;
  const options = {
    ...DEFAULT_GOAL_KEYBINDINGS,
    dashboard: { ...DEFAULT_GOAL_KEYBINDINGS.dashboard },
  };
  let keybindings = options;
  let p = progress();
  const theme = createMockTheme();
  const widget = new GoalWidgetComponent({
    tui: createMockTUI({ terminalRows: 24 }).tui,
    theme,
    getGoal: () => null,
    getAuditorProgress: () => p,
    getExpanded: () => expanded,
    getSettings: () => ({ keybindings }),
  });
  const compact = widget.render(96);
  assert.match(compact[2]!, /等待逐项上报/);
  assert.doesNotMatch(compact.join("\n"), /展开查看清单/);
  assert.equal(compact.filter((line) => line.includes("[展开清单]")).length, 1);
  assert.match(
    compact[auditFooter(compact)]!,
    /^╰─ \[展开清单\] Ctrl\+Shift\+T · Esc: stop audit/,
  );
  p = {
    ...p,
    checks: p.checks!.map((item, index) =>
      index === 0 ? { ...item, state: "running" } : item,
    ),
  };
  assert.match(widget.render(96)[2]!, /◌ 检查项 0/);
  expanded = true;
  const drawFooter = () => {
    const lines = widget.render(96);
    return lines[auditFooter(lines)]!;
  };
  assert.match(
    drawFooter(),
    /^╰─ \[收起清单\] Ctrl\+Shift\+T · Esc: stop audit/,
  );
  keybindings = {
    ...options,
    interruptAudit: "f7",
    dashboard: {
      ...options.dashboard,
      collapse: "f7",
      toggleExpand: ["f7", "f8"],
    },
  };
  assert.match(drawFooter(), /^╰─ \[收起清单\] F8 · F7: stop audit/);
  keybindings = {
    ...options,
    interruptAudit: [],
    dashboard: { ...options.dashboard, collapse: [], toggleExpand: [] },
  };
  assert.doesNotMatch(drawFooter(), /F7|F8|Unbound|stop audit|Ctrl\+Shift\+T/);
  assert.match(
    renderAuditorWidgetLines(progress(), theme, 96).join("\n"),
    /等待逐项上报 · 展开查看清单/,
  );
});

function keyboardFooterHarness(
  t: import("node:test").TestContext,
  settings = {},
  autoContinue = false,
) {
  const cwd = mkdtempSync(join(tmpdir(), "goal-footer-keys-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "pi-goal-x-settings.json"),
    JSON.stringify(settings),
  );
  let input: ((data: string) => unknown) | undefined;
  let expanded = false;
  const calls: string[] = [];
  const goal = createGoal({ objective: "目标", sisyphus: false, autoContinue });
  const toggle = () => {
    expanded = !expanded;
    calls.push("toggle");
  };
  const core = {
    state: { goal },
    goalModalDepth: 0,
    uiPromptDepth: 0,
    auditProgress: progress() as AuditorProgress | null,
    isDashboardExpanded: () => expanded,
    toggleDashboardExpanded: toggle,
    abortAudit: () => {
      calls.push("audit-stop");
    },
    interruption: {
      pause: () => calls.push("pause"),
      interruptTurn: () => calls.push("host-stop"),
    },
    goalWidgetComponentRef: { current: null as GoalWidgetComponent | null },
  };
  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    ui: {
      onTerminalInput: (fn: typeof input) => {
        input = fn;
        return () => {
          input = undefined;
        };
      },
    },
  };
  const widget = new GoalWidgetComponent({
    tui: createMockTUI({ terminalRows: 24 }).tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getSettings: () => loadGoalSettings(cwd),
    getExpanded: core.isDashboardExpanded,
    getAuditorProgress: () => core.auditProgress,
    onToggleExpanded: toggle,
    isIdle: ctx.isIdle,
  });
  core.goalWidgetComponentRef.current = widget;
  syncTerminalInputPause(core as never, ctx as never);
  const footer = () => {
    const lines = widget.render(96);
    return lines[auditFooter(lines)]!;
  };
  const click = (label: string) => {
    const lines = widget.render(96);
    const y = auditFooter(lines);
    const index = lines[y]!.indexOf(label);
    assert.ok(index >= 0, lines[y]);
    const x = visibleWidth(lines[y]!.slice(0, index));
    widget.handleMouse(event("press", x, y, { width: 96 }));
    assert.deepEqual(
      widget.handleMouse(event("click", x, y, { width: 96, clickCount: 1 })),
      { handled: true },
    );
  };
  return { core, footer, click, calls, fire: (data: string) => input?.(data) };
}

const ctrlShiftT = "\x1b[116;6u";

test("真实输入分派与两个底边框一致：Pi 中断先于普通切换键，但不禁用鼠标", (t) => {
  const previous = getKeybindings();
  setKeybindings(
    new KeybindingsManager({
      "app.interrupt": {
        defaultKeys: "ctrl+shift+t",
        description: "interrupt",
      },
    }),
  );
  t.after(() => setKeybindings(previous));
  const { core, footer, calls, fire, click } = keyboardFooterHarness(
    t,
    {},
    true,
  );
  assert.match(footer(), /\[展开清单\]/);
  assert.doesNotMatch(footer(), /Ctrl\+Shift\+T/);
  assert.deepEqual(fire(ctrlShiftT), { consume: true });
  assert.deepEqual(calls, ["host-stop"]);
  core.auditProgress = null;
  assert.match(footer(), /\[展开\]/);
  assert.doesNotMatch(footer(), /Ctrl\+Shift\+T/);
  assert.deepEqual(fire(ctrlShiftT), { consume: true });
  assert.deepEqual(calls, ["host-stop", "host-stop"]);
  click("[展开]");
  assert.match(footer(), /\[收起\] Esc/);
  assert.deepEqual(fire("\x1b"), { consume: true });
  assert.match(footer(), /\[展开\]/);
});

test("审计鼠标和实际终端快捷键交替切换同一状态；中断优先且滚动只提示可用键", async (t) => {
  const { footer, calls, fire, click } = keyboardFooterHarness(t, {
    keybindings: { interruptAudit: "up" },
  });
  assert.match(footer(), /\[展开清单\]/);
  assert.deepEqual(fire(ctrlShiftT), { consume: true });
  assert.match(footer(), /\[收起清单\]/);
  assert.match(footer(), /↑: stop audit · ↓ 1–\d+\//);
  assert.doesNotMatch(footer(), /↑\/↓/);
  assert.deepEqual(fire("\x1b[A"), { consume: true });
  assert.deepEqual(calls, ["toggle", "audit-stop"]);
  click("[收起清单]");
  await new Promise((resolve) => setTimeout(resolve, 575));
  assert.match(footer(), /\[展开清单\]/);
  click("[展开清单]");
  await new Promise((resolve) => setTimeout(resolve, 575));
  assert.match(footer(), /\[收起清单\]/);
  assert.deepEqual(fire(ctrlShiftT), { consume: true });
  assert.match(footer(), /\[展开清单\]/);
  assert.deepEqual(calls, [
    "toggle",
    "audit-stop",
    "toggle",
    "toggle",
    "toggle",
  ]);
  const unbound = keyboardFooterHarness(t, {
    keybindings: { dashboard: { up: [], down: [] } },
  });
  unbound.fire(ctrlShiftT);
  assert.match(unbound.footer(), / · 1–\d+\//);
  assert.doesNotMatch(unbound.footer(), /[↑↓]/);
});

test("传统 ESC+字母与方向键重叠：提示遵循 Pi 解码，Kitty 可区分时恢复按键", (t) => {
  const prior = isKittyProtocolActive();
  t.after(() => setKittyProtocolActive(prior));
  setKittyProtocolActive(false);
  for (const [direction, letter] of [
    ["up", "p"],
    ["down", "n"],
    ["left", "b"],
    ["right", "f"],
  ] as const) {
    const { footer, calls, fire } = keyboardFooterHarness(t, {
      keybindings: {
        interruptAudit: `alt+${direction}`,
        dashboard: { toggleExpand: [`alt+${letter}`, "f8"] },
      },
    });
    assert.match(footer(), /^╰─ \[展开清单\] F8 · Alt\+.+: stop audit/);
    assert.deepEqual(fire(`\x1b${letter}`), { consume: true });
    assert.deepEqual(calls, ["audit-stop"]);
    assert.match(footer(), /\[展开清单\]/);
    assert.deepEqual(fire("\x1b[19~"), { consume: true });
    assert.match(footer(), /\[收起清单\]/);
  }
  const { footer, calls, fire } = keyboardFooterHarness(t, {
    keybindings: {
      interruptAudit: "alt+up",
      dashboard: { toggleExpand: "alt+p" },
    },
  });
  assert.doesNotMatch(footer(), /Alt\+P/);
  setKittyProtocolActive(true);
  assert.match(footer(), /^╰─ \[展开清单\] Alt\+P · Alt\+↑: stop audit/);
  assert.deepEqual(fire("\x1b[112;3u"), { consume: true });
  assert.deepEqual(calls, ["toggle"]);
  assert.match(footer(), /\[收起清单\]/);
});

test("Kitty 根据事件中报告的布局识别冲突，不假设 Shift 总产生美式符号", (t) => {
  const prior = isKittyProtocolActive();
  t.after(() => setKittyProtocolActive(prior));
  setKittyProtocolActive(true);
  for (const [stop, view, raw, stopLabel] of [
    ["ctrl+shift+1", "ctrl+!", "\x1b[49:33;6u", "Ctrl+Shift+1"],
    ["shift+7", "/", "\x1b[55:47;2u", "Shift+7"],
    ["shift+6", "&", "\x1b[54:38;2u", "Shift+6"],
    ["ctrl+1", "ctrl+2", "\x1b[49::50;5u", "Ctrl+1"],
  ] as const) {
    const { footer, calls, fire } = keyboardFooterHarness(t, {
      keybindings: {
        interruptAudit: stop,
        dashboard: { toggleExpand: [view, "f8"] },
      },
    });
    assert.ok(
      footer().startsWith(`╰─ [展开清单] F8 · ${stopLabel}: stop audit`),
      footer(),
    );
    assert.deepEqual(fire(raw), { consume: true });
    assert.deepEqual(calls, ["audit-stop"]);
    assert.match(footer(), /\[展开清单\]/);
    assert.deepEqual(fire("\x1b[19~"), { consume: true });
    assert.deepEqual(calls, ["audit-stop", "toggle"]);
    assert.match(footer(), /\[收起清单\]/);
  }
});

test("不提示配置语法接受但 Pi 解码不支持的键，同时保留可用备选", (t) => {
  const prior = isKittyProtocolActive();
  t.after(() => setKittyProtocolActive(prior));
  setKittyProtocolActive(true);
  const { footer, calls, fire } = keyboardFooterHarness(t, {
    keybindings: {
      interruptAudit: ["shift+escape", "f7"],
      dashboard: { toggleExpand: ["ctrl+f8", "ctrl+pageUp", "f8"] },
    },
  });
  assert.match(footer(), /^╰─ \[展开清单\] Ctrl\+PageUp\/F8 · F7: stop audit/);
  assert.doesNotMatch(footer(), /Shift\+Esc|Ctrl\+F8/);
  assert.equal(fire("\x1b[27;2u"), undefined);
  assert.equal(fire("\x1b[19;5~"), undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(fire("\x1b[18~"), { consume: true });
  assert.deepEqual(fire("\x1b[5;5~"), { consume: true });
  assert.deepEqual(calls, ["audit-stop", "toggle"]);
  const unsupportedOnly = keyboardFooterHarness(t, {
    keybindings: { interruptAudit: "shift+escape" },
  });
  assert.doesNotMatch(unsupportedOnly.footer(), /stop audit|Shift\+Esc/);
  assert.equal(unsupportedOnly.fire("\x1b[27;2u"), undefined);
});

for (const mode of [
  "task press",
  "audit press",
  "audit pending",
  "audit attempt",
  "audit result",
  "audit ordinary progress",
  "audit detached",
] as const) {
  test(`同帧变更只作废已失效的底边框手势：${mode}`, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "goal-footer-coalesced-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const core = createGoalCore({
      getActiveTools: () => [],
      setActiveTools: () => {},
      appendEntry: () => {},
    } as never);
    core.state.goal = createGoal({
      objective: "底边框",
      autoContinue: false,
      sisyphus: false,
    });
    if (mode !== "task press") core.auditProgress = progress();
    let input: ((data: string) => unknown) | undefined;
    const ctx = {
      cwd,
      hasUI: true,
      isIdle: () => true,
      ui: {
        setStatus() {},
        setWidget() {},
        onTerminalInput: (fn: typeof input) => {
          input = fn;
          return () => {
            input = undefined;
          };
        },
      },
    };
    const widget = new GoalWidgetComponent({
      tui: createMockTUI().tui,
      theme: createMockTheme(),
      getGoal: () => core.state.goal,
      getAuditorProgress: () => core.auditProgress,
      getAuditResult: () => core.auditResult,
      getExpanded: () => core.isDashboardExpanded(),
      onToggleExpanded: () => core.toggleDashboardExpanded(),
    });
    core.goalWidgetComponentRef.current = widget;
    syncTerminalInputPause(core, ctx as never);
    const before = widget.render(80);
    const y = auditFooter(before);
    const label = mode === "task press" ? "[展开]" : "[展开清单]";
    const index = before[y]!.indexOf(label);
    assert.ok(index >= 0, before[y]);
    const x = visibleWidth(before[y]!.slice(0, index));
    const press = event("press", x, y);
    const click = event("click", x, y, { clickCount: 1 });
    assert.equal(widget.handleMouse(press), undefined);
    const pending = mode !== "task press" && mode !== "audit press";
    if (pending) assert.deepEqual(widget.handleMouse(click), { handled: true });
    if (mode === "audit detached") {
      core.clearGoalWidget(ctx as never);
      assert.equal(core.goalWidgetComponentRef.current, null);
      await new Promise((resolve) => setTimeout(resolve, 575));
      assert.equal(
        core.isDashboardExpanded(),
        false,
        "卸载的组件不能再切换面板",
      );
      return;
    }

    // None of these transitions draws until after the source has returned.
    if (mode === "audit ordinary progress") {
      core.auditProgress = { ...core.auditProgress!, elapsedMs: 2000 };
      widget.render(80);
      await new Promise((resolve) => setTimeout(resolve, 575));
      assert.equal(
        core.isDashboardExpanded(),
        true,
        "普通审计刷新保留同一目标的有效单击",
      );
      return;
    } else if (mode === "audit attempt") {
      core.auditProgress = progress("b");
      core.auditProgress = progress("a");
    } else if (mode === "audit result") {
      core.setAuditResult("approved", "temporary result");
      core.clearAuditResult();
    } else {
      assert.deepEqual(input?.(ctrlShiftT), { consume: true });
      assert.equal(core.isDashboardExpanded(), true);
      assert.deepEqual(input?.(ctrlShiftT), { consume: true });
      assert.equal(core.isDashboardExpanded(), false);
    }
    assert.deepEqual(widget.render(80), before);
    if (!pending) assert.equal(widget.handleMouse(click), undefined);
    await new Promise((resolve) => setTimeout(resolve, 575));
    assert.equal(core.isDashboardExpanded(), false, "旧按下或延迟操作不会复活");
    assert.equal(widget.handleMouse(press), undefined);
    assert.deepEqual(widget.handleMouse(click), { handled: true });
    if (mode !== "task press")
      await new Promise((resolve) => setTimeout(resolve, 575));
    assert.equal(core.isDashboardExpanded(), true, "同一位置的新手势仍然可用");
  });
}
