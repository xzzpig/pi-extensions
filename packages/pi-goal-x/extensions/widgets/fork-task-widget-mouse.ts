import type {
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { TaskFooterControls } from "./fork-task-dashboard-footer.ts";
import type { GoalWidgetRecord } from "./goal-widget.ts";
import type { DashboardTaskNode } from "./goal-dashboard-model.ts";
import { TaskTreeMouse, type TaskMouseTarget } from "./fork-task-tree-mouse.ts";

type TaskMouseGeometry = {
  width: number;
  rows: Map<number, DashboardTaskNode>;
  controls: TaskFooterControls | undefined;
  taskArea: { first: number; last: number } | undefined;
};

export function taskWidgetSourceSignature(
  goal: GoalWidgetRecord | null,
  expanded: boolean,
): string {
  return JSON.stringify([goal?.currentTaskId, goal?.taskList, expanded]);
}

export function taskWidgetMouseSignature(
  geometry: TaskMouseGeometry,
  state: unknown,
): string {
  return JSON.stringify([
    state,
    geometry.width,
    [...geometry.rows].map(([line, node]) => [
      line,
      node.id,
      node.totalSubtasks,
    ]),
    geometry.controls,
    geometry.taskArea,
  ]);
}

export function handleTaskWidgetMouse(
  options: TaskMouseGeometry & {
    event: TuiMouseEvent;
    mouse: TaskTreeMouse;
    enabled: boolean;
    signature: string;
    act: (target: TaskMouseTarget) => void;
    scroll: (delta: number) => void;
  },
): TuiMouseEventResult | undefined {
  const { event, mouse, width, rows, controls } = options;
  if (!options.enabled) {
    mouse.clear();
    return undefined;
  }
  const target = (x: number, y: number): TaskMouseTarget | undefined => {
    if (x < 1 || x >= width - 1) return undefined;
    if (controls?.line === y) {
      const hit = controls.actions.find(
        ({ start, end }) => x >= start && x < end,
      );
      return hit ? { kind: hit.action } : undefined;
    }
    const node = rows.get(y);
    return node?.totalSubtasks ? { kind: "task", id: node.id } : undefined;
  };
  return mouse.handle(
    event,
    {
      signature: options.signature,
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
