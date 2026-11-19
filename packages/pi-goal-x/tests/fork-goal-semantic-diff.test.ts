import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { showTweakProposalDialog } from "../extensions/goal-tweak-confirmation.ts";
import { createMockExtensionContext } from "./tui-test-utils.ts";
import { convertFlatTasks } from "../extensions/goal-task-tools.ts";
import { projectTweakCandidate } from "../extensions/goal-tweak-projection.ts";
import test from "node:test";
import {
  pairDiffEntries,
  renderDiffEntries,
  type DiffTextLine,
  type DiffTextMeta,
} from "@xzzpig/pi-components/diff";
import {
  buildTweakComparison,
  buildTweakPresentation,
  type TweakPresentation,
  type TweakPresentationOptions,
} from "../extensions/goal-tweak-diff.ts";
import type { GoalRecord, GoalTask } from "../extensions/goal-record.ts";
import {
  TweakReview,
  withTweakReview,
} from "../extensions/goal-tweak-review.ts";

function goal(objective: string, tasks: GoalTask[] = []): GoalRecord {
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
    taskList: { tasks, blockCompletion: false, proposedAt: "now" },
  };
}
const task = (
  id: string,
  title: string,
  extra: Partial<GoalTask> = {},
): GoalTask => ({ id, title, status: "pending", ...extra });

test("real newlines and literal escape sequences remain distinct in contracts, tasks and full text", () => {
  const before = goal("same", [
    task("id", "task", { verificationContract: "甲\n\n乙" }),
  ]);
  before.verificationContract = "甲\n\n乙";
  const after = goal("same", [
    task("id", "task", { verificationContract: "甲\\n\\n乙" }),
  ]);
  after.verificationContract = "甲\\n\\n乙";
  const comparison = buildTweakComparison(before, after);
  assert.deepEqual(comparison.presentation.changedSections, [
    "Verification contract",
  ]);
  const pairs = pairDiffEntries<DiffTextLine, DiffTextMeta>(
    comparison.entries,
  ).filter((r) => r.left && r.right);
  assert.equal(pairs.length, 2);
  for (const pair of pairs)
    assert.notEqual(pair.left?.content, pair.right?.content);
  assert.notEqual(
    buildTweakComparison(before, before).fullUiText,
    comparison.fullUiText,
  );
  // Ordinary non-colliding legacy output remains byte-identical (fixture below).
  assert.equal(
    comparison.presentation.fullText,
    buildTweakPresentation(before, after).fullText,
  );
  const taskOnly = buildTweakComparison(before, {
    ...before,
    taskList: after.taskList,
  });
  assert.equal(taskOnly.presentation.hasChanges, false);
  assert.ok(
    taskOnly.entries.some((entry) =>
      entry.content.includes("verification contract"),
    ),
  );
});

test("ordinary objective paths and regular expressions remain literal in both views", () => {
  const before = goal("old");
  const objective = String.raw`Run \w+ from C:\tmp\new`;
  const candidate = projectTweakCandidate(
    before,
    { objective, auditorEnabled: true },
    {
      disableContracts: false,
      sessionId: "s",
      now: "now",
      schedulerGeneration: "g",
    },
  ).candidate;
  assert.equal(candidate.objective, objective);
  const c = buildTweakComparison(before, candidate);
  for (const width of [119, 120]) {
    const view = renderDiffEntries(c.entries, { width }).join("\n");
    assert.ok(view.includes(objective));
    assert.ok(!view.includes(String.raw`C:\\tmp`));
  }
  assert.ok(c.fullUiText.includes(objective));
  assert.ok(c.presentation.fullText.includes(objective));
});

test("actual tab and literal visible escape label have distinct effective UI projections", () => {
  const before = goal("a\tb");
  const candidate = projectTweakCandidate(
    before,
    { objective: "a⟦TAB⟧b", auditorEnabled: true },
    {
      disableContracts: false,
      sessionId: "s",
      now: "now",
      schedulerGeneration: "g",
    },
  ).candidate;
  const c = buildTweakComparison(before, candidate);
  for (const width of [119, 120]) {
    const view = renderDiffEntries(c.entries, { width }).join("\n");
    assert.ok(view.includes("a⟦TAB⟧b"));
    assert.ok(view.includes("a⟦⟦TAB⟧b"));
  }
  assert.notEqual(
    buildTweakComparison(before, before).fullUiText,
    c.fullUiText,
  );
  assert.ok(c.fullUiText.includes("a⟦⟦TAB⟧b"));
});

test("empty objective placeholder is distinct from literal text and legacy snapshot remains unchanged", () => {
  const before = goal("original");
  const project = (objective: string) =>
    projectTweakCandidate(
      before,
      { objective, auditorEnabled: true },
      {
        disableContracts: false,
        sessionId: "s",
        now: "now",
        schedulerGeneration: "g",
      },
    ).candidate;
  const empty = project("Verification contract: Run tests"),
    literal = project("(empty)\nVerification contract: Run tests");
  assert.equal(empty.objective, "");
  assert.equal(literal.objective, "(empty)");
  const a = buildTweakComparison(before, empty),
    b = buildTweakComparison(before, literal);
  assert.notEqual(a.fullUiText, b.fullUiText);
  assert.equal(a.presentation.fullText, b.presentation.fullText);
  assert.match(a.fullUiText, /⟦EMPTY OBJECTIVE⟧/);
  assert.match(b.fullUiText, /\(empty\)/);
  const literalMarker = project(
    "⟦EMPTY OBJECTIVE⟧\nVerification contract: Run tests",
  );
  assert.notEqual(
    a.fullUiText,
    buildTweakComparison(before, literalMarker).fullUiText,
  );
});

test("full UI distinguishes task title text from lightweight completion setting", () => {
  const before = goal("same", [
    task("parent", "Write docs (lightweight subtasks)", {
      subtasks: [task("child", "Child")],
    }),
  ]);
  const flat = convertFlatTasks(
    [
      { id: "parent", title: "Write docs", lightweight_subtasks: true },
      { id: "child", title: "Child", parent_id: "parent" },
    ],
    { maxSubtaskDepth: 2 },
  );
  if (!flat.ok) throw new Error(flat.message);
  const candidate = projectTweakCandidate(
    before,
    {
      objective: "same",
      taskList: {
        tasks: flat.tasks,
        blockCompletion: false,
        proposedAt: "now",
      },
      auditorEnabled: true,
    },
    {
      disableContracts: false,
      sessionId: "s",
      now: "now",
      schedulerGeneration: "g",
    },
  ).candidate;
  const first = buildTweakComparison(before, before),
    second = buildTweakComparison(before, candidate);
  assert.notEqual(first.fullUiText, second.fullUiText);
  assert.ok(
    first.presentation.fullText.includes("Write docs (lightweight subtasks)"),
  );
  assert.ok(
    second.presentation.fullText.includes("Write docs (lightweight subtasks)"),
  );
  for (const width of [119, 120]) {
    const render = (text: string) =>
      renderDiffEntries(
        text
          .split("\n")
          .map((content) => ({ kind: "meta" as const, content, hunkIndex: 1 })),
        { width, mode: "unified" },
      ).join("\n");
    assert.notEqual(render(first.fullUiText), render(second.fullUiText));
  }
});

test("hard newlines and nonbreaking spaces stay visible and distinguishable in objective UI", () => {
  for (const width of [119, 120]) {
    const p = "P".repeat(width - 2);
    const before = goal(`begin\n${p}  甲\nend`);
    const candidate = projectTweakCandidate(
      before,
      { objective: `begin\n${p}\n甲\nend`, auditorEnabled: true },
      {
        disableContracts: false,
        sessionId: "s",
        now: "now",
        schedulerGeneration: "g",
      },
    ).candidate;
    const full = (text: string) =>
      renderDiffEntries(
        text
          .split("\n")
          .map((content) => ({ kind: "meta" as const, content, hunkIndex: 1 })),
        { width, mode: "unified" },
      ).join("\n");
    assert.notEqual(
      full(buildTweakComparison(before, before).fullUiText),
      full(buildTweakComparison(before, candidate).fullUiText),
    );
    const p2 = "P".repeat(width === 119 ? 116 : 55);
    const old = goal(`begin\n${p2}甲\nend`);
    const next = projectTweakCandidate(
      old,
      { objective: `begin\n${p2}\u00a0甲\nend`, auditorEnabled: true },
      {
        disableContracts: false,
        sessionId: "s",
        now: "now",
        schedulerGeneration: "g",
      },
    ).candidate;
    const c = buildTweakComparison(old, next);
    const screen = renderDiffEntries(c.entries, { width }).join("\n");
    assert.match(screen, /⟦/);
    assert.match(screen, /00A0⟧/);
    assert.notEqual(
      full(buildTweakComparison(old, old).fullUiText),
      full(c.fullUiText),
    );
  }
});

test("visual wrap boundary spaces remain identifiable in effective diff and full frames", () => {
  for (const [width, n] of [
    [119, 116],
    [120, 55],
    [120, 117],
  ] as const) {
    const p = "P".repeat(n);
    const before = goal(`begin\n${p}甲\nend`);
    const candidate = projectTweakCandidate(
      before,
      { objective: `begin\n${p} 甲\nend`, auditorEnabled: true },
      {
        disableContracts: false,
        sessionId: "s",
        now: "now",
        schedulerGeneration: "g",
      },
    ).candidate;
    const c = buildTweakComparison(before, candidate);
    const view = renderDiffEntries(c.entries, { width }).join("\n");
    if (n !== 117)
      assert.match(view, /␠/, `inserted space visible at ${width}/${n}`);
    const full = (text: string) =>
      renderDiffEntries(
        text
          .split("\n")
          .map((content) => ({ kind: "meta" as const, content, hunkIndex: 1 })),
        { width },
      ).join("\n");
    assert.notEqual(
      full(buildTweakComparison(before, before).fullUiText),
      full(c.fullUiText),
    );
    assert.equal(candidate.objective, `begin\n${p} 甲\nend`);
  }
});

test("trailing spaces differ from padding in diff and full candidate UI", () => {
  const before = goal("begin\na \nend");
  const candidate = projectTweakCandidate(
    before,
    { objective: "begin\na\nend", auditorEnabled: true },
    {
      disableContracts: false,
      sessionId: "s",
      now: "now",
      schedulerGeneration: "g",
    },
  ).candidate;
  const c = buildTweakComparison(before, candidate);
  for (const width of [119, 120]) {
    const view = renderDiffEntries(c.entries, { width }).join("\n");
    assert.match(view, /a␠/);
  }
  const full = (text: string) =>
    renderDiffEntries(
      text
        .split("\n")
        .map((content) => ({ kind: "meta" as const, content, hunkIndex: 1 })),
      { width: 119 },
    ).join("\n");
  assert.notEqual(
    full(buildTweakComparison(before, before).fullUiText),
    full(c.fullUiText),
  );
  assert.match(
    full(buildTweakComparison(before, before).fullUiText),
    /a⟦SPACE⟧/,
  );
  const literal = goal("begin\na␠\nend");
  assert.match(
    full(buildTweakComparison(literal, literal).fullUiText),
    /a.*<U\+2420>/s,
  );
});

test("tab versus four spaces stays distinct in side-by-side semantic rows", () => {
  const before = goal("a\tb"),
    after = goal("a    b");
  const comparison = buildTweakComparison(before, after);
  const rows = renderDiffEntries(comparison.entries, { width: 120 });
  assert.ok(
    rows.some((row) => row.includes("a⟦TAB⟧b") && row.includes("a    b")),
  );
  assert.notEqual(
    buildTweakComparison(before, before).fullUiText,
    comparison.fullUiText,
  );
});

test("one-sided added and removed IDs, titles, and missing current task remain distinguishable", () => {
  const before = goal("same", [
    task("a\nb", "title\nnext"),
    task("(none)", "last"),
  ]);
  before.currentTaskId = "(none)";
  const after = goal("same", [task("a\\nb", "title\\nnext")]);
  const comparison = buildTweakComparison(before, after);
  const values = comparison.entries.map((entry) => entry.content);
  assert.ok(values.some((text) => text.includes("a\\nb (removed)")));
  assert.ok(values.some((text) => text.includes("a\\\\nb (added)")));
  assert.ok(values.some((text) => text.includes("title\\\\nnext")));
  assert.ok(values.some((text) => text.includes("title\\\\\\\\nnext")));
  assert.ok(!comparison.presentation.changedSections.includes("Settings"));
  assert.ok(values.includes('"(none)"') && values.includes("(none)"));
});

test("literal absent marker in the effective root contract is quoted only in the UI full projection", () => {
  const before = goal("same objective");
  const after = projectTweakCandidate(
    before,
    {
      objective: "same objective\nVerification contract: (none)",
      auditorEnabled: true,
    },
    {
      disableContracts: false,
      sessionId: "test",
      now: "now",
      schedulerGeneration: "g",
    },
  ).candidate;
  assert.equal(after.verificationContract, "(none)");
  const baseline = buildTweakComparison(before, before);
  const comparison = buildTweakComparison(before, after);
  assert.ok(
    baseline.fullUiText.split("\n").includes("Verification contract: (none)"),
  );
  assert.ok(
    comparison.fullUiText
      .split("\n")
      .includes('Verification contract: "(none)"'),
  );
  assert.equal(
    comparison.presentation.fullText,
    baseline.presentation.fullText,
    "legacy snapshot format must not be rewritten",
  );
  assert.ok(comparison.presentation.diffText.includes('+ "(none)"'));
});

test("effective task movement into real (none) ID and deleted skip reason remain explicit", () => {
  const before = goal("same", [
    task("(none)", "parent"),
    task("child", "child"),
    task("skipped", "old", { status: "skipped", skipReason: "out of scope" }),
  ]);
  before.currentTaskId = "(none)";
  const converted = convertFlatTasks(
    [
      { id: "(none)", title: "parent" },
      { id: "child", title: "child", parent_id: "(none)" },
    ],
    { maxSubtaskDepth: 2 },
  );
  if (!converted.ok) throw new Error(converted.message);
  const candidate = projectTweakCandidate(
    before,
    {
      objective: "same",
      auditorEnabled: true,
      taskList: {
        tasks: converted.tasks,
        blockCompletion: false,
        proposedAt: "now",
      },
    },
    {
      disableContracts: false,
      sessionId: "s",
      now: "now",
      schedulerGeneration: "g",
    },
  ).candidate;
  const comparison = buildTweakComparison(before, candidate);
  assert.ok(!comparison.presentation.diffText.includes("~ child: parent:"));
  const wide = renderDiffEntries(comparison.entries, { width: 120 }).join("\n");
  const narrow = renderDiffEntries(comparison.entries, { width: 119 }).join(
    "\n",
  );
  for (const rendered of [wide, narrow]) {
    assert.ok(rendered.includes('"(none)"'));
    assert.ok(rendered.includes("out of scope"));
  }
  assert.ok(
    !comparison.presentation.diffText.includes("out of scope"),
    "legacy serialized diff must not gain UI-only rows",
  );
  assert.ok(
    buildTweakComparison(before, before).fullUiText.includes(
      'Current task: "(none)"',
    ),
  );
  assert.ok(
    buildTweakComparison(before, {
      ...before,
      currentTaskId: undefined,
    }).fullUiText.includes("Current task: (none)"),
  );
});

test("current-task ID values with real and literal escapes remain distinct", () => {
  const before = goal("same"),
    after = goal("same");
  before.currentTaskId = "a\nb";
  after.currentTaskId = "a\\nb";
  const comparison = buildTweakComparison(before, after);
  const pairs = pairDiffEntries<DiffTextLine, DiffTextMeta>(
    comparison.entries,
  ).filter((row) => row.left && row.right);
  assert.equal(pairs.length, 1);
  assert.notEqual(pairs[0]!.left!.content, pairs[0]!.right!.content);
  assert.ok(!comparison.presentation.diffText.includes("Current task:"));
});

test("basic host displays escaped semantic diff rather than ambiguous legacy tabs", async () => {
  const ctx = createMockExtensionContext();
  delete (ctx.ui as unknown as { custom?: unknown }).custom;
  let prompt = "";
  (ctx.ui as unknown as { select: ExtensionUIContext["select"] }).select =
    async (text) => {
      prompt = text;
      return undefined;
    };
  const comparison = buildTweakComparison(goal("a\tb"), goal("a    b"));
  await showTweakProposalDialog(ctx, {
    defaultAuditorEnabled: true,
    presentation: () => ({
      ...comparison.presentation,
      diffEntries: comparison.entries,
      fullUiText: comparison.fullUiText,
    }),
  });
  assert.ok(prompt.includes("a⟦TAB⟧b"));
  assert.ok(prompt.includes("a    b"));
});

test("semantic rows and stable snapshot originate from the same ID-based comparison", () => {
  const before = goal("旧目标\n\n不变", [
    task("keep", "旧 -> 标题"),
    task("removed", "删除"),
  ]);
  before.verificationContract = "旧契约";
  before.tokenBudget = 10;
  const after = goal("新目标\n\n不变", [
    task("keep", "新 -> 标题"),
    task("added", "新增"),
  ]);
  after.verificationContract = "新契约";
  after.tokenBudget = 20;
  after.skipAuditor = true;
  after.taskList!.blockCompletion = true;
  const comparison = buildTweakComparison(before, after);
  assert.deepEqual(
    comparison.presentation,
    buildTweakPresentation(before, after),
  );
  assert.deepEqual(Object.keys(comparison.presentation).sort(), [
    "changedSections",
    "diffText",
    "fullText",
    "hasChanges",
    "summary",
  ]);
  const paired = pairDiffEntries<DiffTextLine, DiffTextMeta>(
    comparison.entries,
  );
  const isPair = (oldText: string, newText: string) =>
    paired.some(
      (row) => row.left?.content === oldText && row.right?.content === newText,
    );
  assert.ok(isPair("旧目标", "新目标"));
  assert.ok(isPair('"旧契约"', '"新契约"'));
  assert.ok(isPair('"旧 -> 标题"', '"新 -> 标题"'));
  assert.ok(isPair("10 tokens", "20 tokens"));
  assert.ok(isPair("enabled", "disabled"));
  assert.ok(
    !paired.some(
      (row) =>
        row.left?.content.includes("removed:") &&
        row.right?.content.includes("added:"),
    ),
    "different task IDs do not imply a rename",
  );
  assert.ok(
    comparison.entries.some(
      (row) =>
        row.kind === "line" && row.lineKind === "context" && row.content === "",
    ),
    "logical blank line survives",
  );
  for (const width of [119, 120]) {
    const lines = renderDiffEntries(comparison.entries, { width });
    if (width === 119)
      assert.ok(
        !lines.some(
          (line) => line.includes("旧目标") && line.includes("新目标"),
        ),
      );
    else
      assert.ok(
        lines.some(
          (line) => line.includes("旧目标") && line.includes("新目标"),
        ),
      );
  }
});

test("moving and reordering a retained task changes fields rather than inventing deletion and addition", () => {
  const before = goal("same", [
    task("parent", "parent"),
    task("second", "second", { subtasks: [task("child", "child")] }),
  ]);
  const after = goal("same", [
    task("second", "second"),
    task("parent", "parent", {
      subtasks: [
        task("child", "child", { status: "complete", evidence: "checked" }),
      ],
    }),
  ]);
  const comparison = buildTweakComparison(before, after);
  const pairs = pairDiffEntries<DiffTextLine, DiffTextMeta>(comparison.entries);
  const pair = (oldText: string, newText: string) =>
    pairs.some(
      (row) => row.left?.content === oldText && row.right?.content === newText,
    );
  assert.ok(
    pair('"second"', '"parent"'),
    "parent IDs are compared directly and escaped for display",
  );
  assert.ok(pair("pending", "complete"));
  assert.ok(pair("(none)", '"checked"'));
  assert.ok(
    !comparison.entries.some(
      (entry) =>
        entry.kind === "meta" && /\((removed|added)\)/.test(entry.content),
    ),
  );
  assert.ok(comparison.presentation.diffText.includes("order"));
});

test("legacy text and full snapshots match the pre-change implementation byte-for-byte", () => {
  // Generated from HEAD's unchanged pre-implementation goal-tweak-diff.ts;
  // the fixture includes task moves, additions/deletions, settings and coarse fallback.
  const cases = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/fork-tweak-legacy-presentations.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Array<{
    name: string;
    before: GoalRecord;
    after: GoalRecord;
    options?: TweakPresentationOptions;
    expected: TweakPresentation;
  }>;
  for (const item of cases)
    assert.deepEqual(
      buildTweakComparison(item.before, item.after, item.options).presentation,
      item.expected,
      item.name,
    );
});

test("deleted skipped-task UI detail does not leak into tool output or review snapshot", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "goal-skipped-legacy-"));
  try {
    const cases = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/fork-tweak-legacy-presentations.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const baseline = cases.find(
      (entry: { name: string }) => entry.name === "deleted-skipped-task",
    );
    assert.ok(baseline);
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "test" },
    } as unknown as ExtensionContext;
    const result = await withTweakReview(async () => {
      const review = new TweakReview(
        ctx,
        baseline.before,
        "same",
        baseline.after.taskList,
        undefined,
        true,
      );
      const candidate = review.mutate(baseline.before, true).candidate;
      const comparison = buildTweakComparison(baseline.before, candidate);
      assert.equal(
        comparison.presentation.diffText,
        baseline.expected.diffText,
      );
      for (const width of [119, 120])
        assert.match(
          renderDiffEntries(comparison.entries, { width }).join("\n"),
          /out of scope/,
        );
      assert.equal(
        review.record({
          decision: "confirm",
          auditorEnabled: true,
          unavailable: false,
        }),
        baseline.expected.diffText,
      );
      return {
        content: [{ type: "text", text: "result" }],
        details: {},
        terminate: true,
      };
    });
    const snapshot = (result.details as { tweakReview: TweakPresentation })
      .tweakReview;
    assert.deepEqual(snapshot.diffText, baseline.expected.diffText);
    assert.deepEqual(snapshot.fullText, baseline.expected.fullText);
    assert.ok(
      result.content.some((item) => item.text === baseline.expected.diffText),
    );
    assert.doesNotMatch(JSON.stringify(result), /out of scope/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("effective collision cases retain HEAD baseline through tool result while UI disambiguates", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "goal-collision-baseline-"));
  try {
    const cases = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/fork-tweak-legacy-presentations.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s" },
    } as unknown as ExtensionContext;
    for (const name of [
      "parent-id-collision",
      "current-id-collision",
      "contract-newline-collision",
    ]) {
      const item = cases.find((entry: { name: string }) => entry.name === name);
      assert.ok(item);
      const objective =
        name === "contract-newline-collision"
          ? "same\nVerification contract: alpha\\nbeta"
          : "same";
      const list =
        name === "contract-newline-collision" ? undefined : item.after.taskList;
      const result = await withTweakReview(async () => {
        const review = new TweakReview(
          ctx,
          item.before,
          objective,
          list,
          undefined,
          true,
        );
        const candidate = review.mutate(item.before, true).candidate;
        const comparison = buildTweakComparison(item.before, candidate);
        assert.deepEqual(comparison.presentation, item.expected, name);
        for (const width of [119, 120]) {
          const view = renderDiffEntries(comparison.entries, { width }).join(
            "\n",
          );
          if (
            name === "parent-id-collision" ||
            name === "current-id-collision"
          ) {
            assert.match(
              view,
              name === "parent-id-collision"
                ? /child: parent:/
                : /Current task:/,
            );
            const pair = pairDiffEntries<DiffTextLine, DiffTextMeta>(
              comparison.entries,
            ).find(
              (row) =>
                (row.left?.content === "(none)" &&
                  row.right?.content === '"(none)"') ||
                (row.left?.content === '"(none)"' &&
                  row.right?.content === "(none)"),
            );
            assert.ok(pair, "UI differentiates missing from literal ID");
          } else {
            const pair = pairDiffEntries<DiffTextLine, DiffTextMeta>(
              comparison.entries,
            ).find((row) => row.left && row.right);
            assert.ok(pair);
            assert.notEqual(pair.left?.content, pair.right?.content);
          }
        }
        assert.equal(
          review.record({
            decision: "confirm",
            auditorEnabled: true,
            unavailable: false,
          }),
          item.expected.diffText,
        );
        return {
          content: [{ type: "text", text: "result" }],
          details: {},
          terminate: true,
        };
      });
      const snapshot = (result.details as { tweakReview: TweakPresentation })
        .tweakReview;
      assert.equal(snapshot.diffText, item.expected.diffText, name);
      assert.equal(snapshot.fullText, item.expected.fullText, name);
      assert.ok(
        result.content.some((entry) => entry.text === item.expected.diffText),
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("UI-only rows never enter persisted review snapshots for either auditor choice or outcome", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "goal-semantic-snapshot-"));
  try {
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "test" },
    } as unknown as ExtensionContext;
    for (const auditorEnabled of [true, false])
      for (const decision of ["confirm", "continue", "cancel"] as const) {
        const original = goal("原目标", [task("same", "任务")]);
        const result = await withTweakReview(async () => {
          const review = new TweakReview(
            ctx,
            original,
            "新目标",
            undefined,
            undefined,
            auditorEnabled,
          );
          const expected = review.presentation(auditorEnabled);
          assert.equal(
            review.mutate(original, auditorEnabled).candidate.objective,
            "新目标",
          );
          review.record({ decision, auditorEnabled, unavailable: false });
          return {
            content: [{ type: "text", text: "result" }],
            details: { expected },
            terminate: decision === "confirm",
          };
        });
        const details = result.details as unknown as {
          expected: TweakPresentation;
          tweakReview: TweakPresentation & {
            version: number;
            goalId: string;
            revision: number;
            outcome: string;
          };
        };
        const snapshot = details.tweakReview;
        assert.deepEqual(Object.keys(snapshot).sort(), [
          "changedSections",
          "diffText",
          "fullText",
          "goalId",
          "hasChanges",
          "outcome",
          "revision",
          "summary",
          "version",
        ]);
        assert.deepEqual(
          {
            hasChanges: snapshot.hasChanges,
            summary: snapshot.summary,
            changedSections: snapshot.changedSections,
            diffText: snapshot.diffText,
            fullText: snapshot.fullText,
          },
          details.expected,
        );
        assert.equal(snapshot.revision, original.revision);
        assert.equal(
          snapshot.outcome,
          decision === "confirm" ? "applied" : decision,
        );
        assert.doesNotMatch(JSON.stringify(result), /diffEntries|entryIndexes/);
        assert.equal(original.objective, "原目标", "review is read-only");
      }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("empty comparison and bounded coarse body never fabricate or lose changes", () => {
  const before = goal("相同\n\n内容");
  const unchanged = buildTweakComparison(before, structuredClone(before));
  assert.equal(unchanged.presentation.hasChanges, false);
  assert.equal(unchanged.entries.length, 1);
  assert.equal(unchanged.entries[0]?.kind, "meta");
  const after = { ...before, objective: "全新\n目标" };
  const coarse = buildTweakComparison(before, after, { maxDiffCells: 1 });
  const values = coarse.entries.filter(
    (row): row is DiffTextLine => row.kind === "line",
  );
  assert.deepEqual(
    values.filter((row) => row.lineKind === "remove").map((row) => row.content),
    ["相同", "", "内容"],
  );
  assert.deepEqual(
    values.filter((row) => row.lineKind === "add").map((row) => row.content),
    ["全新", "目标"],
  );
});
