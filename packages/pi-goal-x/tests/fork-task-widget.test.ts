import test from "node:test";
import assert from "node:assert/strict";
import { createGoal } from "../extensions/goal-record.ts";
import { GoalWidgetComponent } from "../extensions/widgets/goal-widget.ts";
import { createMockTUI, createMockTheme } from "./tui-test-utils.ts";

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
    tui: createMockTUI({ terminalRows: 20 }).tui,
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
      height: 20,
      shift: false,
      alt: false,
      ctrl: false,
    };
    widget.handleMouse({ ...base, type: "press" });
    return widget.handleMouse({ ...base, type: "click", clickCount: 1 });
  };
  let lines = widget.render(80);
  let controls = lines.findIndex((s) => /\[(展开|收起)\]/.test(s));
  assert.ok(controls >= 0, lines.join("\n"));
  assert.deepEqual(click(2, controls), { handled: true });
  assert.equal(expanded, true);
  lines = widget.render(80);
  controls = lines.findIndex((s) => /\[(展开|收起)\]/.test(s));
  assert.ok(controls >= 0, lines.join("\n"));
  assert.deepEqual(click(2, controls), { handled: true });
  assert.equal(expanded, false);
  lines = widget.render(80);
  widget.handleCompactScrollKey("home");
  lines = widget.render(80);
  controls = lines.findIndex((s) => /\[(展开|收起)\]/.test(s));
  assert.deepEqual(click(10, controls), { handled: true });
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
  for (const width of [10, 19, 20, 80])
    for (const expanded of [false, true]) {
      for (const x of [0, 1, 2, 7, 8, 9, 18, 19]) {
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
        const y = lines.findIndex((s) =>
          s.includes(expanded ? "[收起]" : "[展开]"),
        );
        assert.ok(y >= 0, `width=${width} ${lines.join("\n")}`);
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
        const toggle = x >= 2 && x <= 7 && width >= 9;
        const follow = x >= 9 && x <= 18 && width >= 20;
        assert.equal(
          !!result?.handled,
          toggle || follow,
          `width=${width}, expanded=${expanded}, x=${x}, line=${lines[y]}`,
        );
        assert.equal(toggles, toggle ? 1 : 0, `width=${width}, x=${x}`);
      }
    }
});
