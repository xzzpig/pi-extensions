import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoal } from "../extensions/goal-record.ts";
import type { GoalAuditFailure } from "../extensions/widgets/fork-goal-audit-failure.ts";
import {
  GoalWidgetComponent,
  renderGoalWidgetLines,
} from "../extensions/widgets/goal-widget.ts";
import { createMockTheme, createMockTUI } from "./tui-test-utils.ts";

const longReason = `等外部确认。\n第二条说明。\n${"很长的中文段落".repeat(90)}\nTAIL-OF-BLOCKER`;
const theme = createMockTheme();

function blockedGoal(reason?: string) {
  const goal = createGoal({
    objective: "Check blocker visibility",
    autoContinue: false,
    sisyphus: false,
  });
  goal.status = "blocked";
  goal.pauseReason = reason;
  return goal;
}

test("compact normalizes newlines; expanded wraps Chinese and indicates a bounded preview", () => {
  const goal = blockedGoal("外部确认。\n第二条说明。");
  const compact = renderGoalWidgetLines(goal, theme, 56);
  assert.match(
    compact.find((line) => line.includes("Blocker"))!,
    /外部确认。 第二条说明。/,
  );
  assert.ok(compact.every((line) => !line.includes("\n")));
  const short = renderGoalWidgetLines(goal, theme, 56, { expanded: true }).join(
    "\n",
  );
  assert.match(short, /Blocker: 外部确认。/);
  assert.match(short, /第二条说明。/);
  assert.doesNotMatch(short, /\/goal-status verbose/);

  goal.pauseReason = longReason;
  for (const routes of [undefined, ["work state"], []]) {
    const lines = renderGoalWidgetLines(goal, theme, 40, {
      expanded: true,
      commands: routes ? { "goal-status": routes } : undefined,
    });
    const output = lines.join("\n");
    assert.ok(lines.every((line) => visibleWidth(line) <= 40));
    assert.match(output, /第二条说明。/);
    assert.match(output, /…/);
    assert.doesNotMatch(output, /TAIL-OF-BLOCKER/);
    const hints = output.match(/\/[\w -]+ verbose/g) ?? [];
    assert.deepEqual(
      hints,
      routes
        ? routes.map((route) => `/${route} verbose`)
        : ["/goal-status verbose"],
    );
  }
});

test("the preview selects a fitting alias that actually dispatches verbose status", () => {
  const view = (status: string[], pause: string[]) =>
    renderGoalWidgetLines(blockedGoal(longReason), theme, 40, {
      expanded: true,
      commands: { "goal-status": status, "goal-pause": pause },
    }).join("\n");
  assert.match(
    view(["an-alias-that-is-too-long-for-the-terminal", "gs"], []),
    /\/gs verbose/,
  );
  assert.match(view(["work", "gs"], ["work verbose"]), /\/gs verbose/);
  assert.doesNotMatch(view(["work"], ["work verbose"]), /\/work verbose/);
  assert.doesNotMatch(
    view(["work", "work verbose"], ["work verbose verbose"]),
    /\/work verbose/,
  );
});

function dashboard(reason?: string, taskCount = 40) {
  let goal = blockedGoal(reason);
  goal.taskList = {
    blockCompletion: true,
    proposedAt: goal.createdAt,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index + 1}`,
      title: `Evidence task ${index + 1}`,
      status: "pending" as const,
    })),
  };
  const { tui } = createMockTUI({ terminalRows: 34 });
  const terminal = tui.terminal as { rows: number };
  const originalId = goal.id;
  let expanded = true;
  let failure: GoalAuditFailure | undefined;
  const widget = new GoalWidgetComponent({
    tui,
    theme,
    getGoal: () => goal,
    getExpanded: () => expanded,
    onToggleExpanded: () => {
      expanded = !expanded;
    },
    getAuditFailure: (id) => (id === originalId ? failure : undefined),
  });
  return {
    widget,
    terminal,
    tui,
    goal,
    setGoal: (next: typeof goal) => {
      goal = next;
    },
    setFailure: (next: GoalAuditFailure) => {
      failure = next;
    },
  };
}

function input(x: number, y: number, width: number, height: number) {
  return {
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    ctrl: false,
    alt: false,
  };
}

const tasksIn = (lines: string[]) =>
  lines.filter((line) => /task-\d+ +Evidence task \d/.test(line));

test("live preview preserves the plain task window, wheel and footer across redraw and resize", () => {
  const { widget, terminal } = dashboard(longReason);
  const baseline = dashboard();
  for (const [width, height] of [
    [80, 34],
    [56, 17],
    [56, 14],
    [80, 34],
  ] as const) {
    terminal.rows = baseline.terminal.rows = height;
    const plain = baseline.widget.render(width);
    const first = widget.render(width);
    assert.deepEqual(tasksIn(first), tasksIn(plain));
    assert.ok(first.length <= height - 6);
    assert.deepEqual(widget.render(width), first);
    const footer = first.findIndex((line) => line.includes("[收起]"));
    if (plain.some((line) => line.includes("[收起]"))) assert.ok(footer >= 0);
    if (height === 34)
      assert.match(first.join("\n"), /Blocker:.*\n.*\/goal-status verbose/);
  }
  const width = 80;
  const first = widget.render(width);
  const task = first.findIndex((line) => /Evidence task 1\b/.test(line));
  assert.ok(task >= 0);
  assert.deepEqual(
    widget.handleMouse({
      ...input(5, task, width, terminal.rows),
      type: "wheel",
      button: "none",
      wheelDelta: 1,
    }),
    { handled: true },
  );
  const scrolled = widget.render(width);
  assert.notDeepEqual(tasksIn(scrolled), tasksIn(first));
  const footer = scrolled.findIndex((line) => line.includes("[收起]"));
  assert.ok(footer >= 0);
  const x = visibleWidth(scrolled[footer]!.split("[收起]")[0]!) + 1;
  const button = {
    ...input(x, footer, width, terminal.rows),
    button: "left" as const,
    clickCount: 1,
  };
  assert.equal(widget.handleMouse({ ...button, type: "press" }), undefined);
  assert.deepEqual(widget.handleMouse({ ...button, type: "click" }), {
    handled: true,
  });
  assert.match(widget.render(width).join("\n"), /\[展开\]/);
});

function mountFullscreenDock({ tui, widget }: ReturnType<typeof dashboard>) {
  Object.assign(tui, {
    children: [
      {
        children: [
          {},
          {
            children: [
              { children: [{ render: () => ["widget spacer"] }, widget] },
              { render: () => Array.from({ length: 5 }, () => "chrome") },
            ],
          },
        ],
      },
    ],
  });
}

test("the fullscreen dock spacer is reserved before a short blocker preview can displace the footer", () => {
  const live = dashboard(longReason, 2);
  const { widget, terminal } = live;
  mountFullscreenDock(live);
  assert.match(widget.render(60).join("\n"), /Blocker:/);
  terminal.rows = 18;
  const short = widget.render(60);
  assert.ok(short.length <= 11);
  assert.equal(tasksIn(short).length, 2);
  assert.match(short.at(-1)!, /\[收起\]/);
  assert.doesNotMatch(short.join("\n"), /Blocker:/);
  const baseline = dashboard(undefined, 2);
  mountFullscreenDock(baseline);
  baseline.widget.render(60);
  terminal.rows = baseline.terminal.rows = 12;
  for (let redraw = 0; redraw < 3; redraw++) {
    const ordinary = tasksIn(baseline.widget.render(60));
    assert.equal(ordinary.length, 1);
    assert.deepEqual(tasksIn(widget.render(60)), ordinary);
  }
});

test("clicking a branch in a short fullscreen dock keeps its child and the collapse footer", () => {
  const live = dashboard(longReason, 2);
  const { widget, terminal, goal } = live;
  mountFullscreenDock(live);
  goal.taskList!.tasks[1]!.subtasks = [
    { id: "child", title: "SHORT-DOCK-CHILD", status: "pending" },
  ];
  terminal.rows = 19;
  const lines = widget.render(60);
  const y = lines.findIndex((line) => /task-2 +Evidence task 2/.test(line));
  assert.ok(y >= 0);
  const gesture = {
    ...input(3, y, 60, 19),
    button: "left" as const,
    clickCount: 1,
  };
  assert.equal(widget.handleMouse({ ...gesture, type: "press" }), undefined);
  assert.deepEqual(widget.handleMouse({ ...gesture, type: "click" }), {
    handled: true,
  });
  const expanded = widget.render(60);
  assert.match(expanded.join("\n"), /▾.*Evidence task 2/);
  assert.match(expanded.join("\n"), /\[收起\]/);
  assert.ok(widget.handleNavigationKey("down"));
  const scrolled = widget.render(60);
  assert.match(scrolled.join("\n"), /SHORT-DOCK-CHILD/);
  assert.match(scrolled.join("\n"), /\[收起\]/);
  assert.deepEqual(widget.render(60), scrolled);
});

test("audit failure remains independent when a blocked goal is resumed or focus changes", () => {
  const { widget, goal, setGoal, setFailure } = dashboard(longReason);
  setFailure({
    verdict: "disapproved",
    report: "AUDIT-REASON",
    at: goal.createdAt,
    historical: false,
  });
  let output = widget.render(80).join("\n");
  assert.match(output, /AUDIT-REASON/);
  assert.match(output, /Blocker:/);
  goal.status = "active";
  // Protect against stale display data even if a caller retains the old field.
  output = widget.render(80).join("\n");
  assert.match(output, /AUDIT-REASON/);
  assert.doesNotMatch(output, /外部确认|Blocker:/);
  setGoal(blockedGoal("OTHER-BLOCKER"));
  output = widget.render(80).join("\n");
  assert.match(output, /OTHER-BLOCKER/);
  assert.doesNotMatch(output, /外部确认|AUDIT-REASON/);
});
