import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type {
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createMockExtensionContext,
  createMockTheme,
  createMockTUI,
} from "./tui-test-utils.ts";
import { showProposalDialog } from "../extensions/goal-questionnaire.ts";
import { showTweakProposalDialog } from "../extensions/goal-tweak-confirmation.ts";
import { buildDraftConfirmationText } from "../extensions/goal-draft.ts";
import { renderConfirmationTasks } from "../extensions/goal-task-confirmation.ts";
import { buildTweakComparison } from "../extensions/goal-tweak-diff.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

const DOWN = "\x1b[B",
  PAGE_DOWN = "\x1b[6~",
  PAGE_UP = "\x1b[5~",
  ENTER = "\r",
  ESC = "\x1b";
type Dialog = Component & { handleInput(data: string): void };

function harness(rows: number) {
  const ctx = createMockExtensionContext();
  let component: Dialog | undefined;
  let tui: TUI | undefined;
  (ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = ((
    factory: Parameters<ExtensionUIContext["custom"]>[0],
  ) =>
    new Promise<unknown>((resolve) => {
      tui = createMockTUI({ terminalRows: rows }).tui;
      component = factory(
        tui,
        createMockTheme(),
        {} as KeybindingsManager,
        resolve,
      ) as Dialog;
    })) as ExtensionUIContext["custom"];
  return {
    ctx,
    component: () => {
      assert.ok(component);
      return component;
    },
    tui: () => {
      assert.ok(tui);
      return tui;
    },
  };
}
function goal(objective: string): GoalRecord {
  return {
    id: "g",
    objective,
    status: "active",
    autoContinue: true,
    usage: { tokensUsed: 0, activeSeconds: 0 },
    sisyphus: false,
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
  };
}
function frame(dialog: Dialog, width: number, max: number): string[] {
  const lines = dialog.render(width);
  assert.ok(lines.length <= max, `height ${lines.length} exceeds ${max}`);
  for (const line of lines)
    assert.ok(
      visibleWidth(line) <= width,
      `width ${visibleWidth(line)} exceeds ${width}`,
    );
  return lines;
}

test("creation proposal keeps original blank lines, middle and nested tasks reachable with fixed actions", async () => {
  const h = harness(32);
  const objective = [
    "start",
    "",
    ...Array.from({ length: 30 }, (_, i) => `middle-${i}`),
    "end",
  ].join("\n");
  const draft = buildDraftConfirmationText({
    focus: "goal",
    originalTopic: "topic",
    objective,
    autoContinue: true,
  });
  assert.match(
    draft,
    /│   start\n│\n│   middle-0/,
    "the formatter must not erase logical blank lines",
  );
  const tasks = renderConfirmationTasks(
    [
      {
        id: "parent",
        title: "parent task",
        status: "pending",
        subtasks: [
          { id: "child", title: "nested child task", status: "pending" },
        ],
      },
    ],
    0,
  ).join("\n");
  const result = showProposalDialog(
    h.ctx,
    `${draft}\n\nTasks proposed for confirmation:\n${tasks}`,
    "goal",
    true,
  );
  const dialog = h.component();
  const seen = new Set<string>();
  for (let step = 0; step < 80; step++) {
    const lines = frame(dialog, 90, 28);
    const text = lines.join("\n");
    assert.match(
      text,
      /Confirm — create this goal now/,
      "decision remains fixed during body paging",
    );
    assert.match(text, /\[Confirm selection\]/);
    for (const line of lines) seen.add(line);
    dialog.handleInput(PAGE_DOWN);
  }
  const all = [...seen].join("\n");
  for (const text of [
    "start",
    "middle-0",
    "middle-15",
    "middle-29",
    "end",
    "parent task",
    "nested child task",
  ])
    assert.ok(all.includes(text), `${text} unreachable`);
  assert.ok(
    [...seen].some((line) => /^│ │\s*│$/.test(line)),
    "blank proposal line is drawn",
  );
  dialog.handleInput(ESC);
  assert.equal((await result).decision, "continue");
});

test("actual tweak content width switches at 119/120 and preserves semantic position on resize", async () => {
  const h = harness(35);
  const before = goal(
    Array.from({ length: 28 }, (_, i) => `旧目标-${i}`).join("\n"),
  );
  const after = goal(
    Array.from({ length: 28 }, (_, i) => `新目标-${i}`).join("\n"),
  );
  const compared = buildTweakComparison(before, after);
  const result = showTweakProposalDialog(h.ctx, {
    defaultAuditorEnabled: true,
    presentation: () => ({
      ...compared.presentation,
      diffEntries: compared.entries,
    }),
  });
  const dialog = h.component();
  let width = 123; // 2 frame columns + 1 left padding + 120 actual content columns
  let screen = frame(dialog, width, 31).join("\n");
  assert.match(screen, /旧值\s+│\s+新值/);
  assert.ok(
    screen
      .split("\n")
      .some((line) => line.includes("旧目标-0") && line.includes("新目标-0")),
  );
  for (let i = 0; i < 4; i++) {
    dialog.handleInput(PAGE_DOWN);
    screen = frame(dialog, width, 31).join("\n");
  }
  const visibleOld = screen.match(/旧目标-(\d+)/)?.[1];
  assert.ok(visibleOld);
  width = 122;
  screen = frame(dialog, width, 31).join("\n");
  assert.doesNotMatch(screen, /旧值\s+│\s+新值/);
  assert.ok(
    screen.includes(`旧目标-${visibleOld}`),
    "resize keeps the same semantic source row in view",
  );
  width = 123;
  screen = frame(dialog, width, 31).join("\n");
  assert.ok(screen.includes(`旧目标-${visibleOld}`));
  assert.match(screen, /\[Confirm selection\]/);
  dialog.handleInput(ESC);
  assert.equal((await result).decision, "continue");
});

test("wide semantic review exposes all fields, one-sided tasks, long Chinese wrapping and full view", async () => {
  const h = harness(30);
  const before = goal(`旧头${"旧".repeat(90)}旧尾\n\n上下文`);
  before.verificationContract = "旧验证";
  before.tokenBudget = 11;
  before.taskList = {
    proposedAt: "now",
    blockCompletion: false,
    tasks: [
      { id: "old-id", title: "删除任务", status: "pending" },
      { id: "same-id", title: "旧标题", status: "pending" },
    ],
  };
  const after = goal(`新头${"新".repeat(90)}新尾\n\n上下文`);
  after.verificationContract = "新验证";
  after.tokenBudget = 22;
  after.taskList = {
    proposedAt: "now",
    blockCompletion: true,
    tasks: [
      { id: "same-id", title: "新标题", status: "pending" },
      { id: "new-id", title: "新增任务", status: "pending" },
    ],
  };
  const comparison = buildTweakComparison(before, after);
  const result = showTweakProposalDialog(h.ctx, {
    defaultAuditorEnabled: true,
    presentation: () => ({
      ...comparison.presentation,
      diffEntries: comparison.entries,
    }),
  });
  const dialog = h.component();
  const seen: string[] = [];
  for (let i = 0; i < 100; i++) {
    const lines = frame(dialog, 123, 26);
    assert.ok(lines.some((row) => row.includes("[Confirm selection]")));
    seen.push(...lines);
    dialog.handleInput(PAGE_DOWN);
  }
  const all = seen.join("\n");
  for (const token of [
    "旧头",
    "旧尾",
    "新头",
    "新尾",
    "旧验证",
    "新验证",
    "old-id",
    "new-id",
    "旧标题",
    "新标题",
    "11 tokens",
    "22 tokens",
    "Task completion:",
  ])
    assert.ok(all.includes(token), `${token} missing from paged split view`);
  for (let i = 0; i < 3; i++) {
    dialog.handleInput(DOWN);
    frame(dialog, 123, 26);
  }
  dialog.handleInput(ENTER);
  const full: string[] = [];
  for (let i = 0; i < 100; i++) {
    full.push(...frame(dialog, 123, 26));
    dialog.handleInput(PAGE_DOWN);
  }
  for (const token of [
    "新头",
    "新尾",
    "新验证",
    "new-id",
    "新标题",
    "22 tokens",
  ])
    assert.ok(
      full.join("\n").includes(token),
      `${token} missing from full view`,
    );
  dialog.handleInput(ESC);
  assert.equal((await result).decision, "continue");
});

test("a one- or two-row terminal can reach the editor and keep its cursor visible", async () => {
  for (const rows of [1, 2]) {
    const h = harness(rows);
    const result = showProposalDialog(h.ctx, "body", "goal", true);
    const dialog = h.component() as Dialog & { focused: boolean };
    dialog.focused = true;
    dialog.handleInput(DOWN);
    frame(dialog, 50, rows);
    dialog.handleInput(ENTER);
    dialog.handleInput("feedback");
    const visible = frame(dialog, 50, rows).join("\n");
    assert.match(visible, /feedback/);
    assert.ok(
      visible.includes("\u001b_pi:c\u0007"),
      "focused IME cursor stays in the final cropped frame",
    );
    dialog.handleInput(ENTER);
    assert.equal((await result).feedback, "feedback");
  }
});

test("extremely short creation dialog can page the entire body and reach every action", async () => {
  const h = harness(12);
  const result = showProposalDialog(
    h.ctx,
    Array.from({ length: 20 }, (_, i) => `body-${i}`).join("\n"),
    "sisyphus",
    true,
  );
  const dialog = h.component();
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    for (const line of frame(dialog, 48, 8)) seen.add(line);
    dialog.handleInput(PAGE_DOWN);
  }
  const all = [...seen].join("\n");
  for (const expected of [
    "body-0",
    "body-10",
    "body-19",
    "Confirm — create",
    "Continue chatting",
    "Cancel — discard",
    "[Confirm selection]",
  ])
    assert.ok(all.includes(expected), `${expected} unreachable`);
  for (let i = 0; i < 100; i++) {
    dialog.handleInput(PAGE_UP);
    frame(dialog, 48, 8);
  }
  dialog.handleInput(DOWN);
  frame(dialog, 48, 8);
  dialog.handleInput(ENTER);
  frame(dialog, 48, 8);
  dialog.handleInput("feedback");
  dialog.handleInput(ENTER);
  const outcome = await result;
  assert.equal(outcome.decision, "continue");
  assert.equal(outcome.feedback, "feedback");
});
