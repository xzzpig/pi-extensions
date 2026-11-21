import type { TUI } from "@earendil-works/pi-tui";
import {
  compactTaskViewportRows,
  expandedTaskViewportRows,
} from "./goal-dashboard-model.ts";
import type { AuditFailureMinimumLayout } from "./fork-goal-audit-failure.ts";
import { truncateToWidth } from "./text-cache.ts";

type DockChild = {
  children?: DockChild[];
  render?: (width: number) => string[];
};

/** Pi fullscreen mounts Transcript + Dock under one root VStack. */
export function dashboardDockChildren(
  host: TUI,
  unwrapRoot: boolean,
): DockChild[] | undefined {
  const children = (host as DockChild).children;
  return unwrapRoot && children?.length === 1
    ? children[0]?.children
    : children;
}

type FittingTaskWidgetOptions = {
  width: number;
  terminalRows: number | undefined;
  reserve: number;
  taskReserve?: number;
  regime: string;
  sticky: {
    stickyCap: number | undefined;
    stickyRegime: string | undefined;
    stickyTerminalRows: number | undefined;
    stickyReserve?: number;
  };
  expanded: boolean;
  auditFailure?: boolean;
  priorTaskWindow?: { budget: number; hideIndicators: boolean };
  blockerPreview?: (rows: number) => string[];
  blockerPreviewCap?: number;
  render: (
    budget: number | undefined,
    hideIndicators: boolean,
    auditPreviewRows?: number,
    shareStatusRow?: boolean,
    minimumLayout?: AuditFailureMinimumLayout,
    rowCap?: number,
  ) => string[];
  header: () => number | undefined;
  taskLines: () => Iterable<number>;
  controls: () => { line: number; preserveThrough: number } | undefined;
};

/** Render task content using the real stable-height cap, retaining the widget footer when possible. */
export function renderFittingTaskWidget(
  options: FittingTaskWidgetOptions,
): string[] {
  const cap = taskWidgetCap(options);
  const lines = fitTaskWidget(options, cap);
  const controls = options.controls();
  if (!options.blockerPreview || !controls) return lines;

  // Insert only after the protected task geometry. No task row or mouse
  // target moves; trim lower-priority details and update the final footer.
  const firstDetail = protectedTaskRows(options, controls.preserveThrough);
  const previewCap = Math.min(
    cap ?? Infinity,
    options.blockerPreviewCap ?? Infinity,
  );
  // A stricter preview cap accounts for the fullscreen spacer. If that cap
  // cannot even fit the existing protected rows and footer, keep the original
  // layout rather than charging the spacer to the ordinary task window.
  if (firstDetail > controls.line) return lines;
  if (firstDetail + 1 > previewCap) {
    // Keep the footer when a task expands into the space formerly occupied
    // by optional current-task detail. Never trim a task row to make room.
    return trimOptionalDetails(options, lines, previewCap, -1);
  }
  const preview = options.blockerPreview(previewCap - firstDetail - 1);
  lines.splice(firstDetail, 0, ...preview);
  controls.line += preview.length;
  return trimOptionalDetails(options, lines, previewCap);
}

function taskWidgetCap(options: FittingTaskWidgetOptions) {
  const sameLatch =
    options.sticky.stickyRegime === options.regime &&
    options.sticky.stickyTerminalRows === options.terminalRows &&
    options.sticky.stickyReserve === options.reserve;
  const dockCap = options.terminalRows
    ? Math.max(1, options.terminalRows - options.reserve)
    : undefined;
  return sameLatch ? options.sticky.stickyCap : dockCap;
}

function fitTaskWidget(
  options: FittingTaskWidgetOptions,
  cap: number | undefined,
) {
  const initial = options.render(undefined, false);
  if (cap === undefined) {
    return options.auditFailure && options.expanded
      ? options.render(undefined, false, 4)
      : initial;
  }

  // Compute the same viewport as the original task panel. The first render
  // adds exactly one summary row before the task header; don't charge that
  // row to task navigation. Every subsequent draw uses this same budget.
  const header = options.header();
  // Fit the smallest failure panel directly from the available rows, not
  // from the legacy task budget (which can be zero even with room for a task).
  if (options.auditFailure && cap <= 3) {
    const taskRows = cap === 3 && header !== undefined ? 1 : 0;
    return trimOptionalDetails(
      options,
      options.render(taskRows, true, 0, true, "status-header"),
      cap,
    );
  }
  const summaryRows = options.auditFailure ? 1 : 0;
  const baselineHeader =
    header === undefined ? undefined : header - summaryRows;
  // Keep the legacy rule without a failure. In the failure panel, the
  // committed height bounds optional content, not the task window itself:
  // feeding that smaller height back into the viewport would shrink it on
  // the next paint even though the physical dock has not changed.
  const viewportCap =
    options.auditFailure && options.terminalRows
      ? Math.max(
          1,
          options.terminalRows - (options.taskReserve ?? options.reserve),
        )
      : cap;
  const { budget, hideIndicators } =
    options.priorTaskWindow ?? taskWindow(options, baselineHeader, viewportCap);
  if (header === undefined && !options.auditFailure) return initial;
  let natural =
    budget === undefined ? initial : options.render(budget, hideIndicators);

  const required = requiredTaskRows(options);
  if (options.auditFailure && options.controls() && required > cap) {
    natural = fitFailureTaskBody(options, budget, hideIndicators, cap);
  } else if (options.auditFailure && options.expanded) {
    const render = (rows: number) =>
      options.render(budget, hideIndicators, rows);
    natural =
      renderFailurePreview(options, render, cap) ??
      tryPreviewWithoutProgress(options, budget, hideIndicators, false, cap) ??
      render(0);
  }

  const renderedHeader = options.header();
  if (
    !options.auditFailure &&
    budget === 0 &&
    renderedHeader !== undefined &&
    renderedHeader + 1 >= cap
  )
    natural[cap - 1] = truncateToWidth("任务区空间不足", options.width, "…");
  return trimOptionalDetails(options, natural, cap);
}

/** Repaint each candidate so the final task and footer hit targets match its rows. */
function fitFailureTaskBody(
  options: FittingTaskWidgetOptions,
  budget: number | undefined,
  hideIndicators: boolean,
  cap: number,
): string[] {
  const merged = (rows: number) =>
    options.render(budget, hideIndicators, rows, true);
  let natural = merged(0);
  if (requiredTaskRows(options) > cap && !hideIndicators) {
    // A middle scroll position can introduce a second overflow indicator.
    hideIndicators = true;
    natural = merged(0);
  }
  if (requiredTaskRows(options) <= cap) {
    const preview = renderFailurePreview(options, merged, cap);
    if (preview || !options.expanded) return preview ?? natural;
    // Progress duplicates the checked rows. Reclaim its space if the
    // merged summary was all that fit and the report has more to show.
    return (
      tryPreviewWithoutProgress(options, budget, hideIndicators, true, cap) ??
      merged(0)
    );
  }
  if (budget === undefined || options.header() === undefined) return natural;

  // First fit the complete ordinary task window. Progress duplicates the
  // checked rows; current-task details are more useful, so retain those
  // until even the simplified progress layout cannot fit.
  const desiredRows = Math.max(1, budget);
  const layouts: AuditFailureMinimumLayout[] = options.expanded
    ? [
        "hide-progress",
        "status-header-with-details",
        "status-header-without-task-divider",
        "status-header-bounded-details",
      ]
    : [];
  layouts.push("hide-details", "hide-task-header", "status-header");
  for (const layout of layouts) {
    const render = (rows: number) =>
      options.render(desiredRows, true, rows, true, layout, cap);
    natural = render(0);
    if (requiredTaskRows(options) <= cap) {
      const preview = renderFailurePreview(options, render, cap);
      if (preview || layout !== "hide-progress") return preview ?? natural;
      // Try the shorter header too: it preserves the same task details and
      // may expose a continuation when removing Progress alone cannot.
      const header = (rows: number) =>
        options.render(
          desiredRows,
          true,
          rows,
          true,
          "status-header-with-details",
        );
      header(0);
      return renderFailurePreview(options, header, cap) ?? render(0);
    }
  }
  const visibleTasks = Array.from(options.taskLines()).length;
  const excess = requiredTaskRows(options) - cap;
  if (excess > 0 && visibleTasks > 0) {
    return options.render(
      Math.max(1, visibleTasks - excess),
      true,
      0,
      true,
      "status-header",
    );
  }
  return natural;
}

function tryPreviewWithoutProgress(
  options: FittingTaskWidgetOptions,
  budget: number | undefined,
  hideIndicators: boolean,
  shareStatusRow: boolean,
  cap: number,
): string[] | undefined {
  const render = (rows: number) =>
    options.render(
      budget,
      hideIndicators,
      rows,
      shareStatusRow,
      "hide-progress",
    );
  render(0);
  return renderFailurePreview(options, render, cap);
}

/** Give remaining protected rows to the report before optional goal details. */
function renderFailurePreview(
  options: FittingTaskWidgetOptions,
  render: (rows: number) => string[],
  cap: number,
): string[] | undefined {
  const required = requiredTaskRows(options);
  const previewRows = Math.min(4, cap - required);
  if (!options.expanded || previewRows <= 0) return undefined;
  const preview = render(previewRows);
  const withPreview = requiredTaskRows(options);
  if (withPreview > required && withPreview <= cap) return preview;
  // No additional line fit. Restore the base hit geometry as well.
  render(0);
  return undefined;
}

/** Predict the legacy viewport once its normal height latch has settled.
 * Use this when no matching ordinary paint exists, including cold recovery
 * and changes to the host geometry while the failure panel is on screen.
 */
export function measureOrdinaryTaskWindow(
  options: Pick<
    FittingTaskWidgetOptions,
    "expanded" | "width" | "header" | "render"
  > & { cap: number },
) {
  options.render(undefined, false);
  const header = options.header();
  const initial = taskWindow(options, header, options.cap);
  if (initial.budget === undefined) return initial;
  const natural = options.render(initial.budget, initial.hideIndicators);
  return taskWindow(options, header, Math.min(options.cap, natural.length));
}

function taskWindow(
  options: Pick<FittingTaskWidgetOptions, "expanded" | "width">,
  header: number | undefined,
  cap: number,
) {
  if (header === undefined) return { budget: undefined, hideIndicators: false };
  const maximum = options.expanded
    ? expandedTaskViewportRows(options.width)
    : compactTaskViewportRows(options.width);
  // Preserve the existing body budget so a visible current-task summary
  // isn't displaced on short terminals.
  const budget = Math.max(0, Math.min(maximum, cap - header - 5));
  return budget === 0 && cap >= header + 2
    ? { budget: 1, hideIndicators: true }
    : { budget, hideIndicators: false };
}

function protectedTaskRows(
  options: FittingTaskWidgetOptions,
  preserveThrough: number,
): number {
  const header = options.header();
  return Math.max(
    header === undefined ? 0 : header + 2,
    preserveThrough + 1,
    ...Array.from(options.taskLines(), (line) => line + 1),
  );
}

function requiredTaskRows(options: FittingTaskWidgetOptions): number {
  const controls = options.controls();
  return controls
    ? protectedTaskRows(options, controls.preserveThrough) + 1
    : 3;
}

function trimOptionalDetails(
  options: FittingTaskWidgetOptions,
  lines: string[],
  cap: number,
  preserveThrough?: number,
): string[] {
  const controls = options.controls();
  if (!controls || controls.line < cap) return lines;
  const firstDetail = protectedTaskRows(
    options,
    preserveThrough ?? controls.preserveThrough,
  );
  const count = controls.line - cap + 1;
  if (controls.line - count >= firstDetail) {
    lines.splice(controls.line - count, count);
    controls.line -= count;
  }
  return lines;
}
