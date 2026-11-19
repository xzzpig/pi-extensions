import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectTaskTree,
  TaskTreeView,
} from "../extensions/widgets/fork-task-tree-view.ts";
import type { DashboardTaskNode } from "../extensions/widgets/goal-dashboard-model.ts";

function node(
  id: string,
  depth: number,
  totalSubtasks = 0,
  status: DashboardTaskNode["status"] = "pending",
  completedAt?: string,
): DashboardTaskNode {
  return {
    id,
    title: id,
    depth,
    totalSubtasks,
    status,
    completedAt,
    isCurrent: false,
    completedSubtasks: 0,
  };
}
const tree = [
  node("a", 0, 1, "complete", "2026-01-01"),
  node("aa", 1),
  node("b", 0, 2),
  node("ba", 1, 1),
  node("baa", 2),
  node("bb", 1, 0, "skipped"),
  node("c", 0),
];
const ids = (nodes: DashboardTaskNode[]) => nodes.map((n) => n.id);

test("深层焦点投影保留祖先和同级，不改原树", () => {
  const before = structuredClone(tree);
  const projected = projectTaskTree(tree, "baa");
  assert.deepEqual(ids(projected.rows), ["a", "b", "ba", "baa", "bb", "c"]);
  assert.deepEqual([...projected.expanded], ["ba", "b"]);
  assert.equal(projected.parents.get("baa"), "ba");
  assert.deepEqual(tree, before);
});

test("当前父节点展开一层；无焦点时回到最近完成节点可见祖先", () => {
  assert.deepEqual(ids(projectTaskTree(tree, "b").rows), [
    "a",
    "b",
    "ba",
    "bb",
    "c",
  ]);
  assert.equal(projectTaskTree(tree, undefined).anchor, "a");
  assert.equal(projectTaskTree([], undefined).anchor, undefined);
  const nested = [
    node("a", 0, 1),
    node("aa", 1, 0, "complete", "2026-02-01"),
    node("b", 0),
  ];
  assert.equal(projectTaskTree(nested, undefined).anchor, "a");
});

test("手动浏览在刷新时保持，焦点变化和恢复跟随时重置", () => {
  const view = new TaskTreeView();
  view.update("goal", "baa", tree);
  assert.equal(view.offset("compact", 2), 2);
  assert.equal(view.scroll("compact", 2, -2), 0);
  assert.equal(view.toggle("a"), true);
  view.update(
    "goal",
    "baa",
    tree.map((n) =>
      n.id === "c"
        ? { ...n, status: "complete", completedAt: "2026-03-01" }
        : n,
    ),
  );
  assert.equal(view.offset("compact", 2), 0);
  assert.ok(view.update("goal", "baa", tree).expanded.has("a"));
  const after = view.update("goal", "c", tree);
  assert.deepEqual(ids(after.rows), ["a", "b", "c"]);
  assert.equal(view.offset("compact", 2), 1);
  view.toggle("a");
  view.resetFollow();
  assert.deepEqual(ids(view.update("goal", "c", tree).rows), ["a", "b", "c"]);
});

test("手动收起当前路径与删除、移动、切换目标安全", () => {
  const view = new TaskTreeView();
  view.update("one", "baa", tree);
  assert.equal(view.toggle("b"), true);
  assert.deepEqual(ids(view.update("one", "baa", tree).rows), ["a", "b", "c"]);
  assert.equal(view.toggle("c"), false);
  view.update(
    "one",
    "baa",
    tree.filter((n) => n.id !== "a" && n.id !== "aa"),
  );
  assert.deepEqual(ids(view.update("two", "baa", tree).rows), [
    "a",
    "b",
    "ba",
    "baa",
    "bb",
    "c",
  ]);
});

test("结构移动保留首行身份且移除已删除的展开覆盖", () => {
  const view = new TaskTreeView();
  const initial = [
    node("a", 0, 1),
    node("aa", 1),
    node("b", 0, 1),
    node("bb", 1),
    node("c", 0),
    node("d", 0),
  ];
  view.update("g", "bb", initial);
  view.offset("compact", 2);
  view.scroll("compact", 2, -1);
  view.toggle("a");
  view.update("g", "bb", initial);
  assert.ok(view.offset("compact", 2) >= 0);
  const reordered = [
    initial[4]!,
    initial[0]!,
    initial[1]!,
    initial[2]!,
    initial[3]!,
    initial[5]!,
  ];
  const previousRows = view.update("g", "bb", initial).rows;
  const firstId = previousRows[view.offset("compact", 2)]!.id;
  const moved = view.update("g", "bb", reordered);
  assert.equal(moved.rows[view.offset("compact", 2)]!.id, firstId);
  view.update(
    "g",
    "bb",
    reordered.filter((n) => n.id !== "a" && n.id !== "aa"),
  );
  const restored = view.update("g", "bb", reordered);
  assert.equal(restored.expanded.has("a"), false);
});

test("推断焦点变化与同一 ID 不同 goal 隔离", () => {
  const view = new TaskTreeView();
  view.update("one", "aa", tree);
  assert.equal(view.toggle("b"), true);
  assert.ok(view.update("one", "aa", tree).expanded.has("b"));
  assert.equal(view.update("one", "baa", tree).expanded.has("a"), false);
  view.toggle("a");
  assert.equal(view.update("two", "baa", tree).expanded.has("a"), false);
});
