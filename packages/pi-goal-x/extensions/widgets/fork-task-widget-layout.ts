import {
  compactTaskViewportRows,
  expandedTaskViewportRows,
} from "./goal-dashboard-model.ts";
import { truncateToWidth } from "./text-cache.ts";

/** Render task content using the real stable-height cap, retaining the widget footer when possible. */
export function renderFittingTaskWidget(options: {
  width: number;
  terminalRows: number | undefined;
  reserve: number;
  regime: string;
  sticky: {
    stickyCap: number | undefined;
    stickyRegime: string | undefined;
    stickyTerminalRows: number | undefined;
    stickyReserve?: number;
  };
  expanded: boolean;
  render: (budget: number | undefined, hideIndicators: boolean) => string[];
  header: () => number | undefined;
  taskLines: () => Iterable<number>;
  controls: () => { line: number; hasCurrent: boolean } | undefined;
}): string[] {
  let natural = options.render(undefined, false);
  const header = options.header();
  const sameLatch =
    options.sticky.stickyRegime === options.regime &&
    options.sticky.stickyTerminalRows === options.terminalRows &&
    options.sticky.stickyReserve === options.reserve;
  const cap = sameLatch
    ? options.sticky.stickyCap
    : options.terminalRows
      ? Math.max(1, options.terminalRows - options.reserve)
      : undefined;
  if (cap === undefined || header === undefined) return natural;
  const maximum = options.expanded
    ? expandedTaskViewportRows(options.width)
    : compactTaskViewportRows(options.width);
  let budget = Math.max(0, Math.min(maximum, cap - header - 5));
  let hideIndicators = false;
  if (budget === 0 && cap >= header + 2) {
    budget = 1;
    hideIndicators = true;
  }
  natural = options.render(budget, hideIndicators);
  const renderedHeader = options.header();
  if (budget === 0 && renderedHeader !== undefined && renderedHeader + 1 >= cap)
    natural[cap - 1] = truncateToWidth("任务区空间不足", options.width, "…");
  if (natural.length > cap && cap > 0) {
    const lastTask = Math.max(renderedHeader ?? 0, ...options.taskLines());
    const start = Math.min(natural.length - 1, lastTask + 2);
    const controls = options.controls();
    const count = Math.min(
      natural.length - cap,
      natural.length - 1 - start - (controls ? 1 : 0),
    );
    if (count > 0) {
      natural.splice(start, count);
      if (controls && controls.line >= start) controls.line -= count;
    }
  }
  return natural;
}
