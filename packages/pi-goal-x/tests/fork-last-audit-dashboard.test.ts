import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoal } from "../extensions/goal-record.ts";
import { buildGoalStatusText } from "../extensions/goal-status.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import {
  GoalWidgetComponent,
  type AuditResultView,
  type AuditorWidgetProgress,
} from "../extensions/widgets/goal-widget.ts";
import type { GoalAuditFailure } from "../extensions/widgets/fork-goal-audit-failure.ts";
import { createMockTheme, createMockTUI } from "./tui-test-utils.ts";

const at = "2026-11-20T12:00:00Z";
const report = `Missing test evidence.\n复现实验缺少输出。\n${"补齐报告与日志。".repeat(80)}`;
function createDashboard(terminalRows = 42, taskCount = 1, activityCount = 0) {
  const goal = createGoal({
    objective: "Verify a completed task",
    sisyphus: false,
    autoContinue: false,
  });
  goal.taskList = {
    blockCompletion: true,
    proposedAt: at,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `t${index + 1}`,
      title: "Verified task",
      status: "complete" as const,
    })),
  };
  const state = {
    goal,
    result: { verdict: "disapproved", report, at } as AuditResultView | null,
    progress: null as AuditorWidgetProgress | null,
    failure: { verdict: "disapproved", report, at, historical: false } as
      | GoalAuditFailure
      | undefined,
    expanded: false,
  };
  const { tui } = createMockTUI({ terminalRows });
  const widget = new GoalWidgetComponent({
    tui,
    theme: createMockTheme(),
    getGoal: () => state.goal,
    getLedgerEvents: () =>
      Array.from({ length: activityCount }, (_, index) => ({
        type: "task_complete",
        goalId: goal.id,
        taskId: `t${index + 1}`,
        at,
      })),
    getAuditResult: () => state.result,
    getAuditorProgress: () => state.progress,
    getAuditFailure: (id) => (id === goal.id ? state.failure : undefined),
    getExpanded: () => state.expanded,
    onToggleExpanded: () => {
      state.expanded = !state.expanded;
    },
  });
  return { widget, state, tui };
}

test("normal dashboard retains the failed outcome after result-card expiry, without altering task geometry", () => {
  const { widget, state } = createDashboard();
  const width = 90;
  assert.match(widget.render(width).join("\n"), /CHANGES REQUIRED/);
  state.result = null;
  const compact = widget.render(width);
  const summary = compact.findIndex((line) =>
    line.includes("Last audit rejected: Missing test evidence."),
  );
  const tasks = compact.findIndex((line) => line.includes("Tasks ·"));
  assert.ok(summary > 0 && tasks > summary, compact.join("\n"));
  assert.match(compact.join("\n"), /✓.*Verified task/);
  assert.equal(
    compact.filter((line) => line.includes("Last audit rejected")).length,
    1,
  );
  assert.doesNotMatch(compact.join("\n"), /\/goal-status verbose/);
  const footer = compact.findIndex((line) => line.includes("[展开]"));
  assert.ok(footer > tasks);
  const x = visibleWidth(compact[footer]!.split("[展开]")[0]!) + 1;
  const gesture = {
    button: "left" as const,
    x,
    y: footer,
    screenX: x,
    screenY: footer,
    width,
    height: 42,
    shift: false,
    ctrl: false,
    alt: false,
    clickCount: 1,
  };
  assert.equal(widget.handleMouse({ ...gesture, type: "press" }), undefined);
  assert.deepEqual(widget.handleMouse({ ...gesture, type: "click" }), {
    handled: true,
  });
  const expanded = widget.render(width).join("\n");
  assert.match(expanded, /复现实验缺少输出。/);
  assert.match(expanded, /\/goal-status verbose/);
  assert.match(expanded, /\[收起\]/);
  assert.match(expanded, /✓.*Verified task/);
});

test("retry shows its own checklist; normal mode distinguishes errors and respects dock bounds", () => {
  const { widget, state } = createDashboard(14);
  state.result = null;
  state.expanded = true;
  state.failure = {
    verdict: "error",
    report: "Timeout.\x1b[31m 另一次错误。\x1b[0m\n" + report,
    at,
    historical: false,
  };
  const lines = widget.render(35);
  assert.ok(lines.length <= 14);
  assert.ok(lines.every((line) => visibleWidth(line) <= 35));
  assert.match(lines.join("\n"), /Last audit error: Timeout/);
  assert.ok(
    !lines.join("\n").includes("\x1b[31m"),
    "do not render report-supplied color controls",
  );
  state.progress = {
    phase: "running",
    recentOutput: [],
    elapsedMs: 0,
    auditorLabel: "Retry auditor",
  };
  const running = widget.render(65).join("\n");
  assert.match(running, /Retry auditor/);
  assert.doesNotMatch(running, /Last audit error|Timeout|Verified task/);
  state.progress = null;
  state.goal = createGoal({
    objective: "Other goal",
    sisyphus: false,
    autoContinue: false,
  });
  assert.doesNotMatch(widget.render(65).join("\n"), /Last audit error|Timeout/);
});

test("verbose audit status preserves the complete report and labels a previous attempt", () => {
  const {
    state: { goal },
  } = createDashboard();
  const full =
    "First finding\n" + "More evidence\n".repeat(45) + "Last finding: 完整。";
  const result: GoalLedgerEvent = {
    type: "audit_result",
    auditId: "a",
    goalId: goal.id,
    verdict: "disapproved",
    report: full,
    at,
  };
  const retry: GoalLedgerEvent = {
    type: "audit_started",
    auditId: "b",
    goalId: goal.id,
    at,
  };
  const options = { goal, focused: true, otherOpenGoals: 0 };
  const status = (events: GoalLedgerEvent[], verbose = true) =>
    buildGoalStatusText({ ...options, ledgerEvents: events, verbose });
  assert.ok(
    status([result]).includes(`Last audit (2026-11-20): disapproved\n${full}`),
  );
  assert.doesNotMatch(status([result], false), /Last finding/);
  const retryText = status([
    result,
    retry,
    { ...result, goalId: "another-goal", report: "unrelated report" },
    { ...result, report: "late result" },
  ]);
  assert.match(retryText, /Latest audit: no recorded result\./);
  assert.ok(
    retryText.includes(
      `Previous audit (historical) (2026-11-20): disapproved\n${full}`,
    ),
  );
  assert.doesNotMatch(retryText, /unrelated report|late result/);
  const approved = status([
    result,
    retry,
    {
      ...result,
      auditId: "b",
      verdict: "approved",
      report: "Approved.\nFull output. " + "long ".repeat(100) + "unshown tail",
    },
  ]);
  assert.match(
    approved,
    /Last audit \(2026-11-20\): approved\nApproved\. Full output\./,
  );
  assert.doesNotMatch(approved, /unshown tail|Last finding/);
});

test("80×24: with one spare row, expanded preview exposes more findings rather than just a command hint", () => {
  const { widget, state } = createDashboard(24, 5, 4);
  state.result = null;
  state.failure = {
    verdict: "disapproved",
    at,
    historical: false,
    report:
      "Finding one is short.\nFinding two begins here and continues toward an additional detail: MISSING-SDK-TRACE.\n" +
      "More lines in the report.\n".repeat(12),
  };
  const compact = widget.render(80).join("\n");
  assert.match(compact, /Finding two begins here/);
  assert.doesNotMatch(compact, /MISSING-SDK-TRACE/);
  state.expanded = true;
  const expanded = widget.render(80).join("\n");
  assert.match(expanded, /Finding two begins here/);
  assert.match(expanded, /MISSING-SDK-TRACE/);
  assert.match(expanded, /\[收起\]/);
});

test("80×12: adding the failure leaves the previously visible footer clickable", () => {
  const { widget, state } = createDashboard(12);
  state.result = null;
  const failure = state.failure;
  state.failure = undefined;
  const withoutFailure = widget.render(80);
  const footer = withoutFailure.findIndex((line) => line.includes("[展开]"));
  assert.ok(footer >= 0, withoutFailure.join("\n"));
  const x = visibleWidth(withoutFailure[footer]!.split("[展开]")[0]!) + 1;
  state.failure = failure;
  const withFailure = widget.render(80);
  assert.equal(withFailure.length, withoutFailure.length);
  assert.match(withFailure[footer]!, /\[展开\]/);
  assert.match(
    withFailure.join("\n"),
    /Last audit rejected: Missing test evidence/,
  );
  assert.match(withFailure.join("\n"), /✓.*Verified task/);
  const gesture = {
    button: "left" as const,
    x,
    y: footer,
    screenX: x,
    screenY: footer,
    width: 80,
    height: 12,
    shift: false,
    ctrl: false,
    alt: false,
    clickCount: 1,
  };
  assert.equal(widget.handleMouse({ ...gesture, type: "press" }), undefined);
  assert.deepEqual(widget.handleMouse({ ...gesture, type: "click" }), {
    handled: true,
  });
  assert.equal(state.expanded, true);
});

test("56×19: fullscreen root's measured dock leaves room for the footer", () => {
  const { widget, state, tui } = createDashboard(19, 1, 4);
  // Pi fullscreen gives the transcript one row and the editor/footer five.
  // The widget itself sits inside the above-editor container under a dock Stack.
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
  state.result = null;
  state.expanded = true;
  const lines = widget.render(56);
  assert.equal(lines.length, 12);
  assert.match(lines.join("\n"), /Last audit rejected: Missing test evidence/);
  assert.match(lines.join("\n"), /✓.*Verified task/);
  assert.match(lines.at(-1)!, /\[收起\]/);
});

test("80×24: blank paragraphs do not displace findings in a five-line preview", () => {
  const { widget, state } = createDashboard(24);
  state.result = null;
  state.failure = {
    verdict: "disapproved",
    at,
    historical: false,
    report:
      "First finding.\n\n\n\nSecond finding: missing SDK trace.\nThird finding: missing manifest.\n" +
      "More evidence required.\n".repeat(10),
  };
  const compact = widget.render(80).join("\n");
  assert.match(compact, /Second finding/);
  assert.doesNotMatch(compact, /Third finding/);
  state.expanded = true;
  const expanded = widget.render(80).join("\n");
  assert.match(expanded, /Second finding: missing SDK trace/);
  assert.match(expanded, /Third finding: missing manifest/);
});

test("35×12: the shared row preserves goal status, both failure kinds and the footer", () => {
  const { widget, state } = createDashboard(12);
  state.result = null;
  for (const verdict of ["disapproved", "error"] as const) {
    state.failure = {
      verdict,
      at,
      historical: false,
      report: "SDK trace missing",
    };
    const lines = widget.render(35);
    assert.ok(lines.every((line) => visibleWidth(line) <= 35));
    const statusLine = lines.find((line) => line.includes("goal: active"));
    assert.ok(statusLine, lines.join("\n"));
    assert.match(
      statusLine,
      verdict === "error" ? /Audit error: S/ : /Rejected: SDK/,
    );
    assert.match(lines.join("\n"), /✓.*Verified task/);
    assert.match(lines.at(-1)!, /\[展开\]/);
  }
});

test("80×24: expanded audit gets report rows before long verification details", () => {
  const { widget, state } = createDashboard(24);
  state.result = null;
  state.goal.verificationContract = "Verify mandatory baseline. ".repeat(45);
  state.failure = {
    verdict: "disapproved",
    at,
    historical: false,
    report:
      "First finding: runtime evidence missing.\nSecond finding: separate audit proof needed.\nThird finding: final trace is missing.\nFourth finding: review again.",
  };
  const compact = widget.render(80).join("\n");
  assert.doesNotMatch(compact, /Third finding/);
  state.expanded = true;
  const expanded = widget.render(80).join("\n");
  assert.match(expanded, /Third finding: final trace is missing\./);
  assert.match(expanded, /✓.*Verified task/);
  assert.match(expanded, /\[收起\]/);
});

test("80×15: audit summary does not create a scrollable compact task window", () => {
  const { widget, state } = createDashboard(15, 2);
  state.result = null;
  const failure = state.failure;
  state.failure = undefined;
  const withoutFailure = widget.render(80).join("\n");
  assert.match(withoutFailure, /✓ t2/);
  assert.equal(widget.handleCompactScrollKey("up"), false);
  state.failure = failure;
  const withFailure = widget.render(80).join("\n");
  assert.match(withFailure, /✓ t1/);
  assert.match(withFailure, /✓ t2/);
  assert.match(withFailure, /Last audit rejected: Missing test evidence/);
  assert.match(withFailure, /\[展开\]/);
  assert.doesNotMatch(withFailure, /more task/);
  assert.equal(widget.handleCompactScrollKey("up"), false);
});

test("compact task visibility, scroll ownership and visible footer stay compatible across dock sizes", () => {
  for (const width of [35, 56, 80, 120]) {
    for (const height of [12, 15, 18, 24]) {
      for (const count of [1, 2, 5, 10]) {
        const { widget, state } = createDashboard(height, count, 4);
        state.result = null;
        state.goal.verificationContract =
          "Optionally verify more evidence. ".repeat(10);
        const failure = state.failure;
        state.failure = undefined;
        const baseline = widget.render(width);
        const baselineScroll = widget.handleCompactScrollKey("home");
        state.failure = failure;
        const actual = widget.render(width);
        const ids = (lines: string[]) =>
          lines.flatMap((line) => line.match(/✓ t\d+\b/g) ?? []);
        const label = `${width}×${height}, ${count} tasks`;
        assert.deepEqual(ids(actual), ids(baseline), label);
        assert.equal(
          widget.handleCompactScrollKey("home"),
          baselineScroll,
          label,
        );
        if (baseline.some((line) => line.includes("[展开]"))) {
          assert.ok(
            actual.some((line) => line.includes("[展开]")),
            label,
          );
        }
      }
    }
  }
});

test("80×17: identical paints preserve failed expanded task IDs and footer", () => {
  const { widget, state } = createDashboard(17, 6);
  state.result = null;
  state.expanded = true;
  state.failure = {
    verdict: "disapproved",
    report: "Missing SDK trace.",
    at,
    historical: false,
  };
  const baseline = createDashboard(17, 6);
  baseline.state.result = null;
  baseline.state.expanded = true;
  baseline.state.failure = undefined;
  baseline.widget.render(80);
  const ids = (lines: string[]) =>
    lines.flatMap((line) => line.match(/✓ t\d+\b/g) ?? []);
  const ordinaryTasks = ids(baseline.widget.render(80));
  assert.deepEqual(ordinaryTasks, ["✓ t1"]);
  const first = widget.render(80);
  assert.deepEqual(ids(first), ordinaryTasks);
  assert.match(first.at(-1)!, /\[收起\]/);
  for (let i = 0; i < 3; i++) assert.deepEqual(widget.render(80), first);
});

test("80×13: no-failure panel retains baseline 2a20a5c210 scroll ownership", () => {
  const { widget, state } = createDashboard(13, 2);
  state.result = null;
  state.failure = undefined;
  for (let i = 0; i < 3; i++) {
    const lines = widget.render(80).join("\n");
    assert.match(lines, /✓ t1/);
    assert.doesNotMatch(lines, /✓ t2/);
    assert.equal(widget.handleCompactScrollKey("up"), true);
  }
});

test("no-failure dock with above-editor spacer retains baseline task rows and footer", () => {
  for (const height of [12, 15]) {
    const { widget, state, tui } = createDashboard(
      height,
      height === 15 ? 2 : 1,
    );
    Object.assign(tui, {
      children: [
        {},
        { children: [{ render: () => ["spacer"] }, widget] },
        { render: () => Array(5).fill("host chrome") },
      ],
    });
    state.result = null;
    state.failure = undefined;
    for (let frame = 0; frame < 3; frame++) {
      const text = widget.render(80).join("\n");
      assert.match(text, /✓ t1/);
      assert.match(text, /\[展开\]/);
      // The legacy height latch already narrows the 15-row window on
      // later frames. Match that behavior, not just the initial viewport.
      const showsBoth = height === 15 && frame === 0;
      assert.equal(/✓ t2/.test(text), showsBoth);
      assert.equal(
        widget.handleCompactScrollKey("up"),
        height === 15 && frame > 0,
      );
    }
  }
});

test("a failure with measured host spacer preserves the baseline task window and footer hit", () => {
  for (const height of [12, 15]) {
    const { widget, state, tui } = createDashboard(
      height,
      height === 15 ? 2 : 1,
    );
    Object.assign(tui, {
      children: [
        {},
        { children: [{ render: () => ["spacer"] }, widget] },
        { render: () => Array(5).fill("host chrome") },
      ],
    });
    state.result = null;
    const failure = state.failure;
    state.failure = undefined;
    const baseline = widget.render(80).join("\n");
    assert.equal(/✓ t2/.test(baseline), height === 15);
    assert.equal(widget.handleCompactScrollKey("up"), false);
    assert.match(baseline, /\[展开\]/);
    state.failure = failure;
    for (let frame = 0; frame < 3; frame++) {
      const lines = widget.render(80);
      const text = lines.join("\n");
      assert.match(text, /Last audit rejected: Missing test evidence/);
      assert.match(text, /✓ t1/);
      assert.equal(/✓ t2/.test(text), height === 15);
      assert.equal(widget.handleCompactScrollKey("up"), false);
      assert.doesNotMatch(text, /more task/);
      assert.match(lines.at(-1)!, /\[展开\]/);
    }
    const lines = widget.render(80);
    const y = lines.length - 1;
    const x = visibleWidth(lines[y]!.split("[展开]")[0]!) + 1;
    const event = {
      button: "left" as const,
      x,
      y,
      screenX: x,
      screenY: y,
      width: 80,
      height,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    };
    assert.equal(widget.handleMouse({ ...event, type: "press" }), undefined);
    assert.deepEqual(widget.handleMouse({ ...event, type: "click" }), {
      handled: true,
    });
    assert.equal(state.expanded, true);
  }
});

test("equal-height resize relatches the failure layout and keeps the footer clickable", () => {
  const height = 18;
  const { widget, state, tui } = createDashboard(height, 10);
  state.result = null;
  const terminal = { rows: height, columns: 35 };
  Object.assign(tui, {
    terminal,
    children: [
      {},
      { children: [{ render: () => ["spacer"] }, widget] },
      { render: () => Array(5).fill("chrome") },
    ],
  });
  for (const width of [35, 120, 35, 120]) {
    terminal.columns = width;
    const first = widget.render(width);
    assert.ok(first.length <= 11);
    assert.match(first.join("\n"), /Last audit rejected|Rejected/);
    assert.match(first.join("\n"), /✓ t1/);
    const y = first.findIndex((line) => line.includes("[展开]"));
    assert.ok(y >= 0, `${width}: ${first.join("\n")}`);
    assert.deepEqual(widget.render(width), first);
    assert.deepEqual(widget.render(width), first);
    const x = visibleWidth(first[y]!.split("[展开]")[0]!) + 1;
    const event = {
      button: "left" as const,
      x,
      y,
      screenX: x,
      screenY: y,
      width,
      height,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    };
    assert.equal(widget.handleMouse({ ...event, type: "press" }), undefined);
    assert.deepEqual(widget.handleMouse({ ...event, type: "click" }), {
      handled: true,
    });
    assert.equal(state.expanded, true);
    state.expanded = false;
  }
});

test("scrolling a constrained failure panel preserves task rows and both footer hit targets", () => {
  const width = 120;
  const height = 18;
  const setup = () => {
    const { widget, state, tui } = createDashboard(height, 10);
    state.result = null;
    state.goal.taskList!.blockCompletion = false;
    state.goal.taskList!.tasks[0]!.status = "pending";
    state.goal.currentTaskId = "t1";
    Object.assign(tui, {
      children: [
        {},
        { children: [{ render: () => ["spacer"] }, widget] },
        { render: () => Array(5).fill("chrome") },
      ],
    });
    return { widget, state };
  };
  const taskIds = (lines: string[]) =>
    lines.flatMap((line) =>
      line.includes("Verified task") ? (line.match(/[✓▸] +t\d+\b/g) ?? []) : [],
    );
  const baseline = setup();
  baseline.state.failure = undefined;
  baseline.widget.render(width);
  const taskCount = taskIds(baseline.widget.render(width)).length;
  assert.equal(taskCount, 4);
  for (const action of ["展开", "回到当前"]) {
    const { widget, state } = setup();
    const footer = /\[展开\].*\[回到当前\]/;
    assert.match(widget.render(width).join("\n"), footer);
    for (const key of ["down", "down", "end", "up", "home", "down"] as const) {
      assert.equal(widget.handleCompactScrollKey(key), true);
      const lines = widget.render(width);
      assert.ok(lines.length <= 11);
      assert.match(lines.join("\n"), /Last audit rejected/);
      assert.equal(taskIds(lines).length, taskCount);
      assert.ok(
        lines.some((line) => footer.test(line)),
        lines.join("\n"),
      );
      assert.deepEqual(widget.render(width), lines);
      assert.deepEqual(widget.render(width), lines);
    }
    const lines = widget.render(width);
    const y = lines.findIndex((line) => footer.test(line));
    const x = visibleWidth(lines[y]!.split(`[${action}]`)[0]!) + 1;
    const gesture = {
      button: "left" as const,
      x,
      y,
      screenX: x,
      screenY: y,
      width,
      height,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    };
    assert.equal(widget.handleMouse({ ...gesture, type: "press" }), undefined);
    assert.deepEqual(widget.handleMouse({ ...gesture, type: "click" }), {
      handled: true,
    });
    if (action === "展开") assert.equal(state.expanded, true);
    else assert.match(widget.render(width).join("\n"), /▸ t1\b/);
  }
});

test("sibling dock content does not turn a visible footer into clipped task rows", () => {
  const { widget, state, tui } = createDashboard(15, 2);
  state.result = null;
  state.goal.taskList!.tasks[0]!.status = "pending";
  state.goal.currentTaskId = "t1";
  Object.assign(tui, {
    children: [
      {},
      {
        children: [
          { render: () => ["spacer"] },
          { render: () => ["sibling 1", "sibling 2"] },
          widget,
        ],
      },
      { render: () => Array(5).fill("chrome") },
    ],
  });
  const failure = state.failure;
  state.failure = undefined;
  widget.render(80);
  const baseline = widget.render(80);
  assert.match(baseline.join("\n"), /▸ t1/);
  assert.doesNotMatch(baseline.join("\n"), /✓ t2/);
  assert.equal(widget.handleCompactScrollKey("up"), true);
  for (const next of [undefined, failure]) {
    state.failure = next;
    const lines = widget.render(80);
    const y = lines.findIndex((line) => /\[展开\].*\[回到当前\]/.test(line));
    assert.ok(y >= 0, lines.join("\n"));
    if (next) {
      assert.ok(lines.length <= 6);
      assert.match(
        lines.join("\n"),
        /Last audit rejected: Missing test evidence/,
      );
      assert.match(lines.join("\n"), /▸ t1/);
      assert.doesNotMatch(lines.join("\n"), /✓ t2/);
    }
    assert.deepEqual(widget.render(80), lines);
    assert.deepEqual(widget.render(80), lines);
    assert.equal(widget.handleCompactScrollKey("down"), true);
    const scrolled = widget.render(80);
    if (next) assert.match(scrolled.join("\n"), /✓ t2/);
    const footerY = scrolled.findIndex((line) =>
      /\[展开\].*\[回到当前\]/.test(line),
    );
    assert.ok(footerY >= 0, scrolled.join("\n"));
    const x = visibleWidth(scrolled[footerY]!.split("[展开]")[0]!) + 1;
    const event = {
      button: "left" as const,
      x,
      y: footerY,
      screenX: x,
      screenY: footerY,
      width: 80,
      height: 15,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    };
    assert.equal(widget.handleMouse({ ...event, type: "press" }), undefined);
    assert.deepEqual(widget.handleMouse({ ...event, type: "click" }), {
      handled: true,
    });
    assert.equal(state.expanded, true);
    state.expanded = false;
    assert.equal(widget.handleCompactScrollKey("home"), true);
  }
});

test("result-card expiry carries forward the stable ordinary viewport and scroll ownership", () => {
  for (const [siblingRows, pending] of [
    [2, false],
    [1, true],
  ] as const) {
    const { widget, state, tui } = createDashboard(15, 2);
    const failure = state.failure;
    const result = state.result;
    state.result = null;
    state.failure = undefined;
    if (pending) {
      state.goal.taskList!.tasks[0]!.status = "pending";
      state.goal.currentTaskId = "t1";
    }
    Object.assign(tui, {
      children: [
        {},
        {
          children: [
            { render: () => ["spacer"] },
            { render: () => Array(siblingRows).fill("sibling component") },
            widget,
          ],
        },
        { render: () => Array(5).fill("chrome") },
      ],
    });
    widget.render(80);
    const before = widget.render(80).join("\n");
    assert.match(before, /[✓▸] t1/);
    assert.doesNotMatch(before, /✓ t2/);
    assert.equal(widget.handleCompactScrollKey("up"), true);
    state.result = result;
    state.failure = failure;
    assert.match(widget.render(80).join("\n"), /CHANGES REQUIRED/);
    state.result = null;
    for (let frame = 0; frame < 3; frame++) {
      const after = widget.render(80).join("\n");
      assert.match(after, /Last audit rejected/);
      assert.match(after, /[✓▸] t1/);
      assert.doesNotMatch(after, /✓ t2/);
      assert.match(after, /\[展开\]/);
      assert.equal(widget.handleCompactScrollKey("up"), true);
    }
    assert.equal(widget.handleCompactScrollKey("down"), true);
    assert.match(widget.render(80).join("\n"), /✓ t2/);
  }
});

test("minimum compact failure layout keeps its last task and does not swallow scroll", () => {
  for (const [height, siblings, pending] of [
    [15, 3, true],
    [13, 2, false],
  ] as const) {
    const { widget, state, tui } = createDashboard(height);
    const failure = state.failure;
    const result = state.result;
    state.failure = undefined;
    state.result = null;
    if (pending) {
      state.goal.taskList!.tasks[0]!.status = "pending";
      state.goal.taskList!.blockCompletion = false;
      state.goal.currentTaskId = "t1";
    }
    Object.assign(tui, {
      children: [
        {},
        {
          children: [
            { render: () => ["spacer"] },
            { render: () => Array(siblings).fill("sibling") },
            widget,
          ],
        },
        { render: () => Array(5).fill("chrome") },
      ],
    });
    widget.render(80);
    assert.match(widget.render(80).join("\n"), /[✓▸] t1/);
    assert.equal(widget.handleCompactScrollKey("down"), false);
    state.failure = failure;
    state.result = result;
    widget.render(80);
    state.result = null;
    for (let frame = 0; frame < 3; frame++) {
      const text = widget.render(80).join("\n");
      assert.match(text, /[✓▸] t1/);
      assert.match(text, /Last audit rejected/);
      assert.match(text, /\[展开\]/);
      assert.doesNotMatch(text, /任务区空间不足/);
      assert.equal(widget.handleCompactScrollKey("down"), false);
    }
  }
});

test("minimum expanded failure layout keeps the completed task and clickable collapse", () => {
  for (const [height, siblings] of [
    [13, 0],
    [15, 2],
  ] as const) {
    const width = 80;
    const { widget, state, tui } = createDashboard(height);
    state.expanded = true;
    Object.assign(tui, {
      children: [
        {},
        {
          children: [
            { render: () => ["spacer"] },
            { render: () => Array(siblings).fill("sibling") },
            widget,
          ],
        },
        { render: () => Array(5).fill("chrome") },
      ],
    });
    const failure = state.failure;
    for (const showFailure of [false, true]) {
      state.expanded = true;
      state.result = { verdict: "disapproved", report };
      state.failure = showFailure ? failure : undefined;
      assert.match(widget.render(width).join("\n"), /CHANGES REQUIRED/);
      state.result = null;
      const first = widget.render(width);
      for (let frame = 0; frame < 3; frame++) {
        const lines = widget.render(width);
        assert.match(lines.join("\n"), /✓ t1/);
        assert.match(lines.join("\n"), /\[收起\]/);
        assert.doesNotMatch(lines.join("\n"), /任务区空间不足/);
        if (showFailure) {
          assert.deepEqual(lines, first);
          assert.match(lines.join("\n"), /Last audit rejected/);
          assert.ok(lines.length <= 6);
        }
      }
      const lines = widget.render(width);
      const y = lines.findIndex((line) => line.includes("[收起]"));
      const x = visibleWidth(lines[y]!.split("[收起]")[0]!) + 1;
      const event = {
        button: "left" as const,
        x,
        y,
        screenX: x,
        screenY: y,
        width,
        height,
        shift: false,
        alt: false,
        ctrl: false,
        clickCount: 1,
      };
      assert.equal(widget.handleMouse({ ...event, type: "press" }), undefined);
      assert.deepEqual(widget.handleMouse({ ...event, type: "click" }), {
        handled: true,
      });
      assert.equal(state.expanded, false);
    }
  }
});

for (const entry of [
  "cold recovery",
  "resize under result card",
  "resize after expiry",
] as const) {
  test(`${entry} uses the settled ordinary task window and input routing`, () => {
    for (const showFailure of [false, true]) {
      const cold = entry === "cold recovery";
      const { widget, state, tui } = createDashboard(cold ? 15 : 42, 2);
      const terminal = { rows: cold ? 15 : 42, columns: cold ? 80 : 130 };
      const failure = state.failure;
      state.failure = cold && showFailure ? failure : undefined;
      state.result = null;
      Object.assign(tui, {
        terminal,
        children: [
          {},
          { children: [{ render: () => ["spacer"] }, widget] },
          { render: () => Array(5).fill("chrome") },
        ],
      });
      if (!cold) {
        widget.render(130);
        widget.render(130);
        state.result = { verdict: "disapproved", report };
        assert.match(widget.render(130).join("\n"), /CHANGES REQUIRED/);
        if (entry === "resize under result card") {
          Object.assign(terminal, { rows: 15, columns: 80 });
          assert.match(widget.render(80).join("\n"), /CHANGES REQUIRED/);
        }
        state.result = null;
        state.failure = showFailure ? failure : undefined;
        if (entry === "resize after expiry") {
          widget.render(130);
          widget.render(130);
          Object.assign(terminal, { rows: 15, columns: 80 });
        }
      }
      widget.render(80);
      for (let frame = 0; frame < 3; frame++) {
        const text = widget.render(80).join("\n");
        assert.match(text, /✓ t1/);
        assert.doesNotMatch(text, /✓ t2/);
        assert.match(text, /\[展开\]/);
        assert.equal(widget.handleCompactScrollKey("up"), true);
      }
      assert.equal(widget.handleCompactScrollKey("down"), true);
      if (showFailure) assert.match(widget.render(80).join("\n"), /✓ t2/);
    }
  });
}

test("narrow status header preserves the audit kind and some reason text", () => {
  for (const width of [30, 35, 40]) {
    for (const expanded of [false, true]) {
      for (const verdict of ["error", "disapproved"] as const) {
        const { widget, state, tui } = createDashboard(13, 2);
        state.result = null;
        state.expanded = expanded;
        state.failure = {
          verdict,
          report: "SDK trace absent.",
          at,
          historical: false,
        };
        Object.assign(tui, {
          children: [
            {},
            { children: [{ render: () => ["spacer"] }, widget] },
            { render: () => Array(8).fill("chrome") },
          ],
        });
        const lines = widget.render(width);
        assert.equal(lines.length, 3);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.match(lines[0]!, width >= 35 ? /goal: active/ : /goal: act/);
        assert.match(
          lines[0]!,
          verdict === "error"
            ? /(?:Audit error|Error): SD/
            : /(?:Rejected|Reject): SD/,
        );
        assert.match(lines[1]!, /✓ t1/);
        assert.ok(lines[2]!.includes(expanded ? "[收起]" : "[展开]"));
      }
    }
  }
});

for (const [chromeRows, siblingRows] of [
  [5, 3],
  [8, 0],
] as const) {
  test(`tiny failure dock with ${chromeRows} chrome and ${siblingRows} sibling rows preserves usable controls`, () => {
    const width = 80;
    for (const rows of [2, 3]) {
      const height = 10 + rows;
      for (const expanded of [false, true]) {
        const { widget, state, tui } = createDashboard(height, 2);
        state.result = null;
        state.expanded = expanded;
        Object.assign(tui, {
          children: [
            {},
            {
              children: [
                { render: () => ["spacer"] },
                { render: () => Array(siblingRows).fill("sibling") },
                widget,
              ],
            },
            { render: () => Array(chromeRows).fill("chrome") },
          ],
        });
        const lines = widget.render(width);
        assert.equal(lines.length, rows);
        assert.match(lines[0]!, /goal: active · Last audit rejected/);
        if (rows === 3) assert.match(lines[1]!, /✓ t1/);
        else assert.doesNotMatch(lines.join("\n"), /✓ t1|任务区空间不足/);
        const button = expanded ? "[收起]" : "[展开]";
        const y = rows - 1;
        assert.ok(lines[y]!.includes(button));
        assert.deepEqual(widget.render(width), lines);
        assert.deepEqual(widget.render(width), lines);
        if (rows === 2) {
          const navigate = expanded
            ? widget.handleNavigationKey.bind(widget)
            : widget.handleCompactScrollKey.bind(widget);
          for (const key of [
            "up",
            "pageUp",
            "home",
            "pageDown",
            "end",
            "down",
          ] as const)
            assert.equal(
              navigate(key),
              false,
              `${expanded ? "expanded" : "compact"}: ${key}`,
            );
          const terminal = tui.terminal as { rows: number };
          terminal.rows = height + 1;
          const restored = widget.render(width).join("\n");
          assert.match(restored, /✓ t1/);
          assert.doesNotMatch(restored, /✓ t2/);
          terminal.rows = height;
          assert.deepEqual(widget.render(width), lines);
        }
        const x = visibleWidth(lines[y]!.split(button)[0]!) + 1;
        const event = {
          button: "left" as const,
          x,
          y,
          screenX: x,
          screenY: y,
          width,
          height,
          shift: false,
          alt: false,
          ctrl: false,
          clickCount: 1,
        };
        assert.equal(
          widget.handleMouse({ ...event, type: "press" }),
          undefined,
        );
        assert.deepEqual(widget.handleMouse({ ...event, type: "click" }), {
          handled: true,
        });
        assert.equal(state.expanded, !expanded);
      }
    }
  });
}

for (const [height, report] of [
  [17, "SDK trace absent."],
  [
    18,
    "SDK trace absent.\nFinding 2: Preserve this additional evidence.\nFinding 3: Review the full report.",
  ],
] as const) {
  test(`expanded failure after card expiry keeps tasks and shows report in the ${height}-row terminal`, () => {
    const { widget, state, tui } = createDashboard(height, 2);
    state.result = null;
    state.expanded = true;
    state.goal.taskList!.tasks[0]!.status = "pending";
    state.failure = undefined;
    Object.assign(tui, {
      children: [
        {},
        { children: [{ render: () => ["spacer"] }, widget] },
        { render: () => Array(5).fill("chrome") },
      ],
    });
    const assertFrame = () => {
      const text = widget.render(80).join("\n");
      assert.match(text, /▸ t1/);
      assert.match(text, /✓ t2/);
      assert.match(text, /Current task/);
      assert.match(text, /\[收起\]/);
    };
    for (let i = 0; i < 3; i++) assertFrame();
    state.result = { verdict: "error", report };
    assert.match(widget.render(80).join("\n"), /ERROR|Error|error/);
    state.failure = { verdict: "error", report, at, historical: false };
    state.result = null;
    for (let i = 0; i < 3; i++) {
      assertFrame();
      assert.equal(widget.handleNavigationKey("down"), true);
    }
    assertFrame();
    const expanded = widget.render(80);
    assert.match(expanded.join("\n"), /Last audit error: SDK trace absent/);
    if (height === 18) {
      assert.ok(expanded.length <= 11);
      const finding = expanded.findIndex((line) =>
        line.includes("Finding 2: Preserve this additional evidence."),
      );
      const summary = expanded.findIndex((line) =>
        line.includes("Last audit error"),
      );
      assert.ok(finding > summary && summary >= 0, expanded.join("\n"));
      assert.match(expanded.join("\n"), /Inferred from the first pending task/);
      assert.deepEqual(widget.render(80), expanded);
    }
  });
}

for (const [
  label,
  height,
  siblings,
  contract,
  inferred,
  evidence,
  evidenceFits,
] of [
  [
    "single-line",
    17,
    2,
    "Attach the integration trace.",
    false,
    undefined,
    false,
  ],
  [
    "wrapped",
    18,
    3,
    "Attach the integration trace and verify the signed build output. Include SDK-TRACE-END.",
    false,
    undefined,
    false,
  ],
  [
    "wrapped with inferred focus",
    18,
    3,
    "Attach the integration trace and verify the signed build output. Include SDK-TRACE-END.",
    true,
    undefined,
    false,
  ],
  [
    "wrapped with inferred focus and evidence",
    18,
    3,
    "Attach the integration trace and verify the signed build output. Include SDK-TRACE-END.",
    true,
    "SDK job 145 passed.",
    true,
  ],
  [
    "wrapped with inferred focus and overflowing evidence",
    18,
    3,
    "Attach the integration trace and verify the signed build output. Include SDK-TRACE-END.",
    true,
    "SDK job 145 passed. " + "Additional evidence. ".repeat(16),
    false,
  ],
] as const) {
  test(`expanded failure preserves the ${label} current-task contract before allocating preview rows`, () => {
    const width = 80;
    const { widget, state, tui } = createDashboard(height, 2);
    state.result = null;
    state.expanded = true;
    state.failure = undefined;
    if (!inferred) state.goal.currentTaskId = "t1";
    Object.assign(state.goal.taskList!.tasks[0]!, {
      status: "pending",
      verificationContract: contract,
      evidence,
    });
    Object.assign(tui, {
      children: [
        {},
        {
          children: [
            { render: () => ["spacer"] },
            { render: () => Array(siblings).fill("sibling") },
            widget,
          ],
        },
        { render: () => Array(5).fill("chrome") },
      ],
    });
    for (let i = 0; i < 3; i++) widget.render(width);
    const report =
      "SDK trace absent.\nFinding 2: Preserve this additional evidence.\nFinding 3: Review the full report.";
    state.result = { verdict: "error", report };
    assert.match(widget.render(width).join("\n"), /Audit result/);
    state.failure = { verdict: "error", report, at, historical: false };
    state.result = null;
    for (let i = 0; i < 3; i++) {
      const lines = widget.render(width);
      const frame = lines.join("\n");
      assert.equal(lines.length, 8);
      if (label === "single-line") assert.match(frame, /├─ Tasks/);
      else assert.doesNotMatch(frame, /├─ Tasks/);
      assert.match(frame, /▸ t1/);
      assert.match(frame, /✓ t2/);
      assert.match(frame, /Current task/);
      const contractLine = lines.findIndex((line) =>
        line.includes("Contract: Attach the integration trace"),
      );
      assert.ok(contractLine >= 0, frame);
      if (label !== "single-line")
        assert.match(lines[contractLine + 1]!, /Include SDK-TRACE-END\./);
      if (inferred)
        assert.match(
          lines[contractLine - 1]!,
          /t1 · .*Inferred from the first pending task/,
        );
      if (evidence) assert.match(frame, /Evidence: SDK job 145 passed\./);
      if (evidence && !evidenceFits) assert.match(lines.at(-2)!, /…/);
      assert.match(frame, /Last audit error: SDK trace absent/);
      assert.match(frame, /\[收起\]/);
      assert.doesNotMatch(frame, /^│ Finding 2:/m);
      assert.equal(widget.handleNavigationKey("down"), true);
    }
  });
}
