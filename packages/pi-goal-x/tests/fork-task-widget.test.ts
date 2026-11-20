import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_GOAL_KEYBINDINGS } from "../extensions/goal-settings.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { createGoalCore } from "../extensions/goal-state.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoalWidgetComponent,
  renderGoalWidgetLines,
} from "../extensions/widgets/goal-widget.ts";
import { createMockTUI, createMockTheme } from "./tui-test-utils.ts";

function footerColumn(line: string, label: string): number {
  const index = line.indexOf(label);
  return index < 0 ? -1 : visibleWidth(line.slice(0, index));
}

test("紧凑与展开视图跟随末尾当前任务", () => {
  const goal = createGoal({
    objective: "任务树",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      status: "pending" as const,
    })),
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "t28";
  let expanded = false;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getExpanded: () => expanded,
  });
  let visible = widget.render(100).join("\n");
  assert.match(visible, /t28/);
  assert.match(visible, /Task 28/);
  expanded = true;
  visible = widget.render(100).join("\n");
  assert.match(visible, /Task 28/);
});

test("矮屏最终绘制仍包含任务行而不仅是 Current 摘要", () => {
  const goal = createGoal({
    objective: "任务树",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      status: "pending" as const,
    })),
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "t28";
  const { tui } = createMockTUI({ terminalRows: 18 });
  for (const expanded of [false, true]) {
    const widget = new GoalWidgetComponent({
      tui,
      theme: createMockTheme(),
      getGoal: () => goal,
      getExpanded: () => expanded,
    });
    const lines = widget.render(80);
    assert.ok(
      lines.some((line) => /▸ t28\s+Task 28/.test(line)),
      lines.join("\n"),
    );
    assert.ok(lines.length <= 12);
  }
});

test("父任务行完整单击切换，拖动和旧位置不切换", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
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
  const { tui } = createMockTUI();
  const widget = new GoalWidgetComponent({
    tui,
    theme: createMockTheme(),
    getGoal: () => goal,
  });
  const event = (type: "press" | "click" | "drag", y: number) => ({
    type,
    button: "left" as const,
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  });
  let lines = widget.render(80);
  const line = lines.findIndex(
    (s) => s.includes("父任务") && !s.includes("Current"),
  );
  assert.ok(line >= 0, lines.join("\n"));
  assert.ok(lines.some((s) => s.includes("子任务")));
  assert.equal(widget.handleMouse(event("press", line)), undefined);
  assert.deepEqual(widget.handleMouse(event("click", line)), { handled: true });
  lines = widget.render(80);
  assert.equal(
    lines.some((s) => s.includes("子任务")),
    false,
  );
  widget.handleMouse(event("press", line));
  widget.handleMouse(event("drag", line));
  assert.equal(widget.handleMouse(event("click", line)), undefined);
  assert.equal(
    widget.render(80).some((s) => s.includes("子任务")),
    false,
  );
});

test("滚轮只在任务行消费并保留手动浏览，焦点切换恢复", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      title: `任务 ${i}`,
      status: "pending" as const,
    })),
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "t15";
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
  });
  let lines = widget.render(80);
  const row = lines.findIndex((s) => /t15\s+任务 15/.test(s));
  const wheel = (y: number, delta: number) => ({
    type: "wheel" as const,
    button: "none" as const,
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: delta,
  });
  assert.ok(row >= 0, lines.join("\n"));
  assert.deepEqual(widget.handleMouse(wheel(row, -3)), { handled: true });
  lines = widget.render(80);
  assert.match(lines.join("\n"), /任务 12/);
  assert.equal(widget.handleMouse(wheel(0, 1)), undefined);
  goal.currentTaskId = "t19";
  lines = widget.render(80);
  assert.ok(
    lines.some((s) => /t19\s+任务 19/.test(s)),
    lines.join("\n"),
  );
});

test("面板与回到当前控件在实际绘制行响应", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      title: `任务 ${i}`,
      status: "pending" as const,
    })),
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "t15";
  let expanded = false;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI({ terminalRows: 34 }).tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getExpanded: () => expanded,
    onToggleExpanded: () => {
      expanded = !expanded;
    },
  });
  const click = (x: number, y: number) => {
    const base = {
      button: "left" as const,
      x,
      y,
      screenX: x,
      screenY: y,
      width: 80,
      height: 34,
      shift: false,
      alt: false,
      ctrl: false,
    };
    widget.handleMouse({ ...base, type: "press" });
    return widget.handleMouse({ ...base, type: "click", clickCount: 1 });
  };
  let lines = widget.render(80);
  const clickFooter = (label: string) => {
    const y = lines.findIndex(
      (line) => line.startsWith("╰") && line.includes(label),
    );
    assert.ok(y >= 0, lines.join("\n"));
    return click(footerColumn(lines[y]!, label), y);
  };
  assert.deepEqual(clickFooter("[展开]"), { handled: true });
  assert.equal(expanded, true);
  lines = widget.render(80);
  assert.deepEqual(clickFooter("[收起]"), { handled: true });
  assert.equal(expanded, false);
  widget.render(80);
  widget.handleCompactScrollKey("home");
  lines = widget.render(80);
  assert.deepEqual(clickFooter("[回到当前]"), { handled: true });
  assert.ok(widget.render(80).some((s) => /t15\s+任务 15/.test(s)));
});

test("按下后任务被替换、双击和非左键不切换", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
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
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
  });
  const line = widget
    .render(80)
    .findIndex((s) => s.includes("父任务") && !s.includes("Current"));
  const base = {
    button: "left" as const,
    x: 4,
    y: line,
    screenX: 4,
    screenY: line,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
  widget.handleMouse({ ...base, type: "press" });
  goal.taskList.tasks[0]!.title = "新父任务";
  widget.render(80);
  assert.equal(
    widget.handleMouse({ ...base, type: "click", clickCount: 1 }),
    undefined,
  );
  widget.handleMouse({ ...base, type: "press" });
  assert.equal(
    widget.handleMouse({ ...base, type: "click", clickCount: 2 }),
    undefined,
  );
  widget.handleMouse({ ...base, type: "press", button: "right" });
  assert.equal(
    widget.handleMouse({
      ...base,
      type: "click",
      button: "right",
      clickCount: 1,
    }),
    undefined,
  );
  assert.ok(widget.render(80).some((s) => s.includes("子任务")));
});

test("可容纳一行时优先当前行，无法容纳时明确提示", () => {
  const goal = createGoal({
    objective: "任务树",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      title: `任务 ${i}`,
      status: "pending" as const,
    })),
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "t28";
  for (const [rows, expanded, hasRow] of [
    [10, false, true],
    [10, true, false],
    [12, true, true],
  ] as const) {
    const widget = new GoalWidgetComponent({
      tui: createMockTUI({ terminalRows: rows }).tui,
      theme: createMockTheme(),
      getGoal: () => goal,
      getExpanded: () => expanded,
    });
    const visible = widget.render(80).join("\n");
    if (hasRow) assert.match(visible, /▸ t28\s+任务 28/);
    else assert.match(visible, /任务区空间不足/);
  }
});

test("缩放后旧手势无效，绘制外区域无命中", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: [
      {
        id: "p",
        title: "长父任务标题中文文字",
        status: "pending",
        subtasks: [{ id: "child", title: "子任务", status: "pending" }],
      },
    ],
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "p";
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
  });
  const line = widget
    .render(80)
    .findIndex((s) => s.includes("长父任务") && !s.includes("Current"));
  const base = {
    button: "left" as const,
    x: 3,
    y: line,
    screenX: 3,
    screenY: line,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
  widget.handleMouse({ ...base, type: "press" });
  widget.render(40);
  assert.equal(
    widget.handleMouse({ ...base, type: "click", clickCount: 1 }),
    undefined,
  );
  assert.equal(
    widget.handleMouse({ ...base, type: "press", y: 100 }),
    undefined,
  );
  assert.equal(
    widget.handleMouse({ ...base, type: "click", y: 100, clickCount: 1 }),
    undefined,
  );
  assert.ok(widget.render(40).some((s) => s.includes("子任务")));
});

test("不同宽度、长中文与深层任务保持可见且高度稳定", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: [
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `t${i}`,
        title: `之前任务 ${i}`,
        status: "pending" as const,
      })),
      {
        id: "p",
        title: "父任务",
        status: "pending",
        subtasks: [
          {
            id: "q",
            title: "中层任务",
            status: "pending",
            subtasks: [
              {
                id: "deep",
                title: "当前深层中文任务标题很长很长很长",
                status: "pending",
              },
            ],
          },
        ],
      },
    ],
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "deep";
  for (const width of [40, 70, 110])
    for (const expanded of [false, true]) {
      const widget = new GoalWidgetComponent({
        tui: createMockTUI({ terminalRows: 20 }).tui,
        theme: createMockTheme(),
        getGoal: () => goal,
        getExpanded: () => expanded,
      });
      const first = widget.render(width);
      assert.ok(
        first.some((line) => /deep\s+当前/.test(line)),
        first.join("\n"),
      );
      assert.equal(widget.render(width).length, first.length);
    }
});

test("审计和结果卡置换视图使旧任务手势失效，浏览不修改目标", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
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
  const before = structuredClone(goal);
  let audit:
    | import("../extensions/widgets/goal-widget.ts").AuditorWidgetProgress
    | null = null;
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getAuditorProgress: () => audit,
  });
  let lines = widget.render(80);
  const y = lines.findIndex(
    (s) => s.includes("父任务") && !s.includes("Current"),
  );
  const base = {
    button: "left" as const,
    x: 3,
    y,
    screenX: 3,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
  widget.handleMouse({ ...base, type: "press" });
  audit = { phase: "running", elapsedMs: 0, recentOutput: [] };
  widget.render(80);
  assert.equal(
    widget.handleMouse({ ...base, type: "click", clickCount: 1 }),
    undefined,
  );
  audit = null;
  lines = widget.render(80);
  assert.ok(lines.some((s) => s.includes("子任务")));
  widget.handleMouse({ ...base, type: "press" });
  widget.handleMouse({ ...base, type: "click", clickCount: 1 });
  widget.render(80);
  assert.deepEqual(goal, before);
});

test("叶子和没有焦点的恢复控件不会响应，禁用任务不生成隐藏命中", () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: [
      {
        id: "leaf",
        title: "叶子",
        status: "complete",
        completedAt: "2026-01-01T00:00:00Z",
      },
    ],
    blockCompletion: false,
    proposedAt: "2026-01-01T00:00:00Z",
  };
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
  });
  let lines = widget.render(80);
  assert.doesNotMatch(lines.join("\n"), /回到当前/);
  const y = lines.findIndex(
    (line) => line.includes("叶子") && !line.includes("Current"),
  );
  const base = {
    button: "left" as const,
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(widget.handleMouse({ ...base, type: "press" }), undefined);
  assert.equal(
    widget.handleMouse({ ...base, type: "click", clickCount: 1 }),
    undefined,
  );
  const disabled = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    getSettings: () => ({ disableTasks: true }),
  });
  lines = disabled.render(80);
  assert.equal(
    lines.some((line) => line.includes("叶子")),
    false,
  );
  assert.equal(
    disabled.handleMouse({
      ...base,
      type: "wheel",
      button: "none",
      wheelDelta: 1,
    }),
    undefined,
  );
});

test("控件可见首尾列命中，边框、填充和间隔不命中，裁切时禁用不完整控件", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
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
  for (const width of [10, 11, 23, 24, 80])
    for (const expanded of [false, true]) {
      let toggles = 0;
      const widget = new GoalWidgetComponent({
        tui: createMockTUI().tui,
        theme: createMockTheme(),
        getGoal: () => goal,
        getExpanded: () => expanded,
        onToggleExpanded: () => {
          toggles++;
        },
      });
      const lines = widget.render(width);
      const y = lines.findIndex((s) => s.startsWith("╰"));
      assert.ok(y >= 0, `width=${width} ${lines.join("\n")}`);
      const label = expanded ? "[收起]" : "[展开]";
      const followLabel = "[回到当前]";
      const toggleStart = footerColumn(lines[y]!, label);
      const followStart = footerColumn(lines[y]!, followLabel);
      assert.equal(toggleStart >= 0, width >= 11);
      assert.equal(followStart >= 0, width >= 24);
      for (let x = 0; x < width; x++) {
        const previous = toggles;
        const base = {
          button: "left" as const,
          x,
          y,
          screenX: x,
          screenY: y,
          width,
          height: 24,
          shift: false,
          alt: false,
          ctrl: false,
        };
        assert.equal(widget.handleMouse({ ...base, type: "press" }), undefined);
        const result = widget.handleMouse({
          ...base,
          type: "click",
          clickCount: 1,
        });
        const toggle =
          toggleStart >= 0 &&
          x >= toggleStart &&
          x < toggleStart + visibleWidth(label);
        const follow =
          followStart >= 0 &&
          x >= followStart &&
          x < followStart + visibleWidth(followLabel);
        assert.equal(
          !!result?.handled,
          toggle || follow,
          `width=${width}, expanded=${expanded}, x=${x}, line=${lines[y]}`,
        );
        assert.equal(
          toggles - previous,
          toggle ? 1 : 0,
          `width=${width}, x=${x}`,
        );
      }
    }
});

test("底边框快捷键取自当前绑定，静态渲染保留原输出", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
    sisyphus: false,
  });
  let expanded = false;
  let dashboard = {
    ...DEFAULT_GOAL_KEYBINDINGS.dashboard,
    toggleExpand: [
      "f7",
      "f8",
    ] as typeof DEFAULT_GOAL_KEYBINDINGS.dashboard.toggleExpand,
  };
  const theme = createMockTheme();
  const widget = new GoalWidgetComponent({
    tui: createMockTUI().tui,
    theme,
    getGoal: () => goal,
    getExpanded: () => expanded,
    getSettings: () => ({
      keybindings: { ...DEFAULT_GOAL_KEYBINDINGS, dashboard },
    }),
  });
  assert.match(widget.render(100).at(-1)!, /^╰─ \[展开\] F7\/F8/);
  dashboard = { ...dashboard, toggleExpand: [], collapse: "f9" };
  assert.doesNotMatch(widget.render(100).at(-1)!, /F7|F8|Unbound|expand/i);
  expanded = true;
  assert.match(widget.render(100).at(-1)!, /^╰─ \[收起\] F9/);
  assert.doesNotMatch(
    widget.render(100).join("\n"),
    /回到当前|F7|F8|Unbound|: collapse/,
  );
  assert.match(
    renderGoalWidgetLines(goal, theme, 100).at(-1)!,
    /Ctrl\+Shift\+T: expand tasks/,
  );
  assert.match(
    renderGoalWidgetLines(goal, theme, 100, { expanded: true }).at(-1)!,
    /Esc\/Ctrl\+Shift\+T: collapse/,
  );
});

test("底边框在矮屏裁切或填充后没有过期命中，也不取得正文滚轮", () => {
  const goal = createGoal({
    objective: "任务",
    autoContinue: true,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      title: `任务 ${i}`,
      status: "pending",
    })),
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  let toggles = 0;
  const { tui } = createMockTUI({ terminalRows: 16 });
  const widget = new GoalWidgetComponent({
    tui,
    theme: createMockTheme(),
    getGoal: () => goal,
    onToggleExpanded: () => {
      toggles++;
    },
  });
  const initial = widget.render(80);
  const y = initial.findIndex(
    (line) => line.startsWith("╰") && line.includes("[展开]"),
  );
  assert.ok(y >= 0, initial.join("\n"));
  const x = footerColumn(initial[y]!, "[展开]");
  const base = {
    button: "left" as const,
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 16,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(
    widget.handleMouse({
      ...base,
      type: "wheel",
      button: "none",
      wheelDelta: 1,
    }),
    undefined,
  );
  assert.equal(widget.handleMouse({ ...base, type: "press" }), undefined);
  (tui as unknown as { terminal: { rows: number } }).terminal.rows = 8;
  assert.doesNotMatch(widget.render(80).join("\n"), /\[展开\]/);
  (tui as unknown as { terminal: { rows: number } }).terminal.rows = 16;
  assert.deepEqual(widget.render(80), initial);
  assert.equal(
    widget.handleMouse({ ...base, type: "click", clickCount: 1 }),
    undefined,
  );
  assert.equal(toggles, 0);
  widget.handleMouse({ ...base, type: "press" });
  widget.handleMouse({ ...base, type: "drag" });
  assert.equal(
    widget.handleMouse({ ...base, type: "click", clickCount: 1 }),
    undefined,
  );
  widget.handleMouse({ ...base, type: "press" });
  assert.deepEqual(
    widget.handleMouse({ ...base, type: "click", clickCount: 1 }),
    { handled: true },
  );
  assert.equal(toggles, 1);
  goal.taskList.tasks.splice(1);
  const shortened = widget.render(80);
  const afterFooter = shortened.findIndex((line) => line.startsWith("╰")) + 1;
  assert.ok(
    afterFooter > 0 && afterFooter < shortened.length,
    shortened.join("\n"),
  );
  assert.equal(shortened[afterFooter], "");
  widget.handleMouse({ ...base, y: afterFooter, type: "press" });
  assert.equal(
    widget.handleMouse({
      ...base,
      y: afterFooter,
      type: "click",
      clickCount: 1,
    }),
    undefined,
  );
});

test("五行待办保留既有 Current 摘要而不让底边框抢占末行", () => {
  const goal = createGoal({
    objective: "目标",
    autoContinue: false,
    sisyphus: false,
  });
  goal.taskList = {
    tasks: [{ id: "m", title: "唯一当前任务", status: "pending" }],
    blockCompletion: false,
    proposedAt: new Date().toISOString(),
  };
  goal.currentTaskId = "m";
  const { tui } = createMockTUI({ terminalRows: 11 });
  const widget = new GoalWidgetComponent({
    tui,
    theme: createMockTheme(),
    getGoal: () => goal,
  });
  const short = widget.render(80);
  assert.equal(short.length, 5);
  assert.match(short[3]!, /▸ m +唯一当前任务/);
  assert.match(short[4]!, /Current  m · 唯一当前任务/);
  assert.ok(short.every((line) => !line.includes("[展开]")));
  const event = {
    button: "left" as const,
    x: 4,
    y: 4,
    screenX: 4,
    screenY: 4,
    width: 80,
    height: 11,
    alt: false,
    shift: false,
    ctrl: false,
  };
  assert.equal(widget.handleMouse({ ...event, type: "press" }), undefined);
  assert.equal(
    widget.handleMouse({ ...event, type: "click", clickCount: 1 }),
    undefined,
  );
  (tui as unknown as { terminal: { rows: number } }).terminal.rows = 12;
  const taller = widget.render(80);
  assert.deepEqual(taller.slice(0, 5), short);
  assert.match(taller[5]!, /^╰─ \[展开\]/);
});

for (const change of ["goal", "current", "inferred", "usage"] as const) {
  test(`已注册待办组件在下一帧前观察目标源变化：${change}`, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "goal-footer-task-source-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, ".pi", "goals"), { recursive: true });
    const core = createGoalCore({
      getActiveTools: () => [],
      setActiveTools: () => {},
      appendEntry: () => {},
    } as never);
    const { tui } = createMockTUI({ terminalRows: 26 });
    const ctx = {
      cwd,
      hasUI: true,
      isIdle: () => true,
      ui: {
        setStatus() {},
        setWidget(_key: string, factory: unknown) {
          if (typeof factory === "function") factory(tui, createMockTheme());
        },
      },
      sessionManager: {
        getSessionId: () => "coalesced-task-source",
        getBranch: () => [],
      },
    } as never;
    const goal = createGoal({
      objective: "任务",
      autoContinue: false,
      sisyphus: false,
    });
    goal.taskList = {
      tasks: [
        { id: "a", title: "甲", status: "pending" },
        { id: "b", title: "乙", status: "pending" },
      ],
      blockCompletion: false,
      proposedAt: goal.createdAt,
    };
    if (change !== "inferred") goal.currentTaskId = "a";
    const setGoal = (next: typeof goal) => core.setGoal(next, ctx, false);
    setGoal(goal);
    await Promise.resolve();
    const widget = core.goalWidgetComponentRef.current;
    assert.ok(widget);
    widget.render(80); // Establish the stable-height cap before recording the frame.
    const first = widget.render(80);
    const y = first.findIndex(
      (line) => line.startsWith("╰") && line.includes("[展开]"),
    );
    assert.ok(y >= 0);
    const x = footerColumn(first[y]!, "[展开]");
    const base = {
      button: "left" as const,
      x,
      y,
      screenX: x,
      screenY: y,
      width: 80,
      height: 26,
      alt: false,
      shift: false,
      ctrl: false,
    };
    const press = () => widget.handleMouse({ ...base, type: "press" });
    const click = () =>
      widget.handleMouse({ ...base, type: "click", clickCount: 1 });
    assert.equal(press(), undefined);
    const revision = core.focusRevision;
    // Neither publication draws a frame. A UI host may batch both redraws.
    if (change === "goal") setGoal({ ...goal, id: `${goal.id}-other` });
    if (change === "current") setGoal({ ...goal, currentTaskId: "b" });
    if (change === "inferred")
      setGoal({
        ...goal,
        taskList: {
          ...goal.taskList,
          tasks: [...goal.taskList.tasks].reverse(),
        },
      });
    if (change === "usage")
      setGoal({ ...goal, usage: { ...goal.usage, tokensUsed: 1 } });
    if (change !== "usage") setGoal(goal);
    if (change === "goal") assert.equal(core.focusRevision, revision + 2);
    else assert.equal(core.focusRevision, revision);
    await Promise.resolve();
    assert.equal(core.goalWidgetComponentRef.current, widget);
    const frame = widget.render(80);
    assert.equal(frame[y], first[y], "切换往返后仍是同一位置和内容的底边框");
    if (change !== "usage") {
      assert.equal(click(), undefined);
      assert.equal(core.isDashboardExpanded(), false);
      press();
    }
    assert.deepEqual(click(), { handled: true });
    assert.equal(core.isDashboardExpanded(), true);
  });
}
