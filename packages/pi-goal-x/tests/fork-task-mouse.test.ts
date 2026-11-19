import test from "node:test";
import assert from "node:assert/strict";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  TaskTreeMouse,
  type TaskMouseLayout,
  type TaskMouseTarget,
} from "../extensions/widgets/fork-task-tree-mouse.ts";

const event = (
  type: TuiMouseEvent["type"],
  patch: Partial<TuiMouseEvent> = {},
): TuiMouseEvent => ({
  type,
  button: "left",
  x: 4,
  y: 3,
  screenX: 4,
  screenY: 3,
  width: 80,
  height: 24,
  alt: false,
  ctrl: false,
  shift: false,
  ...patch,
});
const layout: TaskMouseLayout = {
  signature: "one",
  target: (x, y) =>
    x === 4 && y === 3 ? { kind: "task", id: "p" } : undefined,
  inTaskArea: (x, y) => x > 0 && y >= 2 && y <= 5,
};

test("滚轮按原 delta 消费、边界零值不穿透，区域外不消费", () => {
  const mouse = new TaskTreeMouse();
  const deltas: number[] = [];
  const run = (e: TuiMouseEvent) =>
    mouse.handle(
      e,
      layout,
      () => assert.fail(),
      (n) => deltas.push(n),
    );
  assert.deepEqual(run(event("wheel", { button: "none", wheelDelta: -6 })), {
    handled: true,
  });
  assert.deepEqual(run(event("wheel", { button: "none", wheelDelta: 0 })), {
    handled: true,
  });
  assert.equal(
    run(event("wheel", { button: "none", y: 1, wheelDelta: 2 })),
    undefined,
  );
  assert.deepEqual(deltas, [-6]);
});

test("按下透传，拖动、坐标变化、右键、双击及布局失效均不触发动作", () => {
  const mouse = new TaskTreeMouse();
  const actions: TaskMouseTarget[] = [];
  const run = (e: TuiMouseEvent, l = layout) =>
    mouse.handle(
      e,
      l,
      (a) => actions.push(a),
      () => {},
    );
  assert.equal(run(event("press")), undefined);
  run(event("drag", { x: 5 }));
  assert.equal(run(event("click")), undefined);
  run(event("press"));
  assert.equal(run(event("click", { x: 5 })), undefined);
  run(event("press", { button: "right" }));
  assert.equal(run(event("click", { button: "right" })), undefined);
  run(event("press"));
  assert.equal(run(event("click", { clickCount: 2 })), undefined);
  run(event("press"));
  assert.equal(
    run(event("click"), { ...layout, signature: "changed" }),
    undefined,
  );
  assert.deepEqual(actions, []);
  run(event("press"));
  assert.deepEqual(run(event("click", { clickCount: 1 })), { handled: true });
  assert.deepEqual(actions, [{ kind: "task", id: "p" }]);
});
