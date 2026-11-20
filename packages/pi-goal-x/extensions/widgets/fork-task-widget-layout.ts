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
  controls: () => { line: number; preserveThrough: number } | undefined;
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
  // Preserve the existing body budget: expanding the list by one would move
  // an already visible current-task summary out of frame on short terminals.
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
  const controls = options.controls();
  if (controls && controls.line >= cap) {
    // Prefer existing task content and its current-task summary over a new
    // footer. The cap can omit the footer, but cannot replace that summary.
    const firstDetail = Math.max(
      (renderedHeader ?? 0) + 2,
      controls.preserveThrough + 1,
      ...Array.from(options.taskLines(), (line) => line + 1),
    );
    const count = controls.line - cap + 1;
    if (controls.line - count >= firstDetail) {
      natural.splice(controls.line - count, count);
      controls.line -= count;
    }
  }
  return natural;
}
