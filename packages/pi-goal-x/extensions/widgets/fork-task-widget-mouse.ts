import {
  visibleWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { DashboardTaskNode } from "./goal-dashboard-model.ts";
import { TaskTreeMouse, type TaskMouseTarget } from "./fork-task-tree-mouse.ts";

export function handleTaskWidgetMouse(options: {
  event: TuiMouseEvent;
  mouse: TaskTreeMouse;
  enabled: boolean;
  width: number;
  signatureState: unknown;
  rows: Map<number, DashboardTaskNode>;
  controls: { line: number; hasCurrent: boolean } | undefined;
  taskArea: { first: number; last: number } | undefined;
  act: (target: TaskMouseTarget) => void;
  scroll: (delta: number) => void;
}): TuiMouseEventResult | undefined {
  const { event, mouse, width, rows, controls } = options;
  if (!options.enabled) {
    mouse.clear();
    return undefined;
  }
  const entries = [...rows.entries()];
  const target = (x: number, y: number): TaskMouseTarget | undefined => {
    if (x < 1 || x >= width - 1) return undefined;
    const node = rows.get(y);
    if (node?.totalSubtasks) return { kind: "task", id: node.id };
    if (controls?.line !== y) return undefined;
    // boxLine renders a left frame followed by one padding cell; content
    // begins at column 2 and has at most width - 3 visible cells.
    const start = 2;
    const contentWidth = Math.max(0, width - 3);
    if (
      contentWidth >= visibleWidth("[展开]") &&
      x >= start &&
      x < start + visibleWidth("[展开]")
    )
      return { kind: "toggle" };
    if (
      controls.hasCurrent &&
      contentWidth >= visibleWidth("[展开] [回到当前]") &&
      x >= start + visibleWidth("[展开] ") &&
      x < start + visibleWidth("[展开] [回到当前]")
    )
      return { kind: "follow" };
    return undefined;
  };
  const signature = JSON.stringify([
    options.signatureState,
    width,
    entries.map(([line, node]) => [line, node.id, node.totalSubtasks]),
    controls,
  ]);
  return mouse.handle(
    event,
    {
      signature,
      target,
      inTaskArea: (x, y) =>
        x >= 1 &&
        x < width - 1 &&
        !!options.taskArea &&
        y >= options.taskArea.first &&
        y <= options.taskArea.last,
    },
    options.act,
    options.scroll,
  );
}
