/**
 * Host adapter: original-rendering projection (change task 3.1).
 *
 * The adapter never re-implements rendering. It binds main-session
 * components (proven ours by the ownership contract of task 1.2) to model
 * members, then projects their existing render output through a plan the
 * view computes when the content is quiet:
 *
 * - no binding, or an active turn → the predecessor's lines come back
 *   untouched, the very array it returned;
 * - a hidden tool or special message renders as nothing;
 * - a folded group's carrier renders the summary lines in the member's
 *   place;
 * - a mixed assistant message hides only the selected thinking runs: the
 *   content children render at the same width, hidden runs (and their
 *   separator padding) drop out, and the remaining lines keep their exact
 *   bytes — including the OSC 133 zone markers, re-anchored to the visible
 *   extent exactly as the original renderer anchors them.
 *
 * Projection is installed through the recoverable patch registry with a
 * WeakMap membership guard, so components this package never bound — a
 * pi-btw/fleet panel reusing the same classes, or any other plugin's
 * components — always take the unmodified predecessor path. Nothing
 * mutates a renderer's returned or cached arrays: filtered output is a
 * fresh array, pass-through is the predecessor's own.
 */

import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import {
  installPrototypePatch,
  type PatchInstallResult,
} from "./patch-registry.ts";

/** The slice of a bound component the adapter reads. */
export type ProjectedComponent = {
  render(width: number): string[];
};

const asRenderable = (value: unknown): ProjectedComponent =>
  value as ProjectedComponent;

export type Projection =
  | { readonly kind: "hide" }
  | {
      /**
       * A folded group's carrier renders this line in the member's place.
       * The resolver receives the render width and may return undefined —
       * a terminal too narrow for the minimal summary keeps the original
       * display instead of overflowing.
       */
      readonly kind: "summary";
      /** Identifies the group for the group-wide width fallback. */
      readonly token: unknown;
      readonly lineFor: (width: number) => string | undefined;
    }
  | {
      /** Hide only the listed thinking runs; the rest renders as-is. */
      readonly kind: "hideThinkingRuns";
      readonly hiddenRuns: ReadonlySet<number>;
      /**
       * When a hidden run is its group's carrier, the summary line renders
       * in the run's place; undefined hides the run entirely.
       */
      readonly summaryForRun?: (
        run: number,
        width: number,
      ) => string | undefined;
      /** Title above an expanded run's own content (collapsible again). */
      readonly titleForRun?: (run: number, width: number) => string | undefined;
      /**
       * Geometry epoch: changes whenever the message content that feeds
       * row heights may have changed. Stable repaints reuse the cached
       * hidden-run heights instead of rendering hidden content again.
       */
      readonly geometryToken?: string;
    }
  | {
      /**
       * An expanded group's carrier: the group title line renders above
       * the member's own, unmodified output. Other members render normal.
       * Returning undefined from the resolver falls back to the plain
       * member output (title does not fit).
       */
      readonly kind: "titled";
      /** Identifies the group for the group-wide width fallback. */
      readonly token: unknown;
      readonly titleFor: (width: number) => string | undefined;
    };

export type ProjectionPlan = (
  component: object,
  width?: number,
) => Projection | undefined;

/**
 * Attempt a summary-row toggle for a component. Returning true means the
 * click was consumed (the group flipped); false falls through to the
 * component's own handler. `run` selects a specific thinking run when the
 * click landed on that run's managed row.
 */
export type SummaryClickHandler = (
  component: object,
  width: number,
  run?: number,
) => boolean;

/** Resolves the group target for click/press-release identity checks. */
export type TargetResolver = (
  component: object,
  width: number,
  run?: number,
) => unknown;

/** Reported when a summary cannot fit the current render width. */
export type UnfittableHandler = (component: object, width: number) => void;

type Binding = {
  /** Assistant bindings carry their content container for run filtering. */
  contentContainer?: { children: readonly unknown[] };
};

const bindings = new WeakMap<object, Binding>();
let activePlan: ProjectionPlan | undefined;

/** Bind a component this package owns to the projection pipeline. */
export function bindComponent(component: object): void {
  bindings.set(component, {});
}

/** Drop a binding (component left the view or the epoch died). */
export function unbindComponent(component: object): void {
  bindings.delete(component);
}

export function isBound(component: object): boolean {
  return bindings.has(component);
}

/** The assistant content container, read through the runtime-public field. */
function contentContainerOf(component: object):
  | {
      children: readonly unknown[];
    }
  | undefined {
  const binding = bindings.get(component);
  if (binding?.contentContainer) return binding.contentContainer;
  const container = (
    component as unknown as {
      contentContainer?: { children: readonly unknown[] };
    }
  ).contentContainer;
  if (binding && container) {
    binding.contentContainer = container;
  }
  return container;
}

const OSC_ZONE_START = "\x1b]133;A\x07";
const OSC_ZONE_END = "\x1b]133;B\x07";
const OSC_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Render an assistant message with selected thinking runs managed, in a
 * single traversal that also builds the row map for mouse dispatch:
 *
 * - a folded run renders its group's summary line in the run's place
 *   (with its separator spacer);
 * - an expanded run of a managed group renders the group title **above**
 *   its own content, so the group can be collapsed from that row again;
 * - every child renders exactly once — hidden runs only for their height
 *   (their original rows still shift the coordinates below them).
 *
 * The OSC 133 markers land on the new first and last visible lines,
 * exactly as the component itself places them on its own output.
 */
function renderAssistantProjected(
  component: AssistantMessageComponent,
  width: number,
  hiddenRuns: ReadonlySet<number>,
  summaryForRun?: (run: number, width: number) => string | undefined,
  titleForRun?: (run: number, width: number) => string | undefined,
  geometryToken?: string,
): { lines: string[]; map: AssistantRowMaps } {
  const container = contentContainerOf(component);
  const lines: string[] = [];
  const rowMap = new Map<number, number>();
  const summaryRows = new Map<number, number>();
  const titleRows = new Map<number, number>();
  if (container) {
    const children = [...container.children];
    const hiddenKey = [...hiddenRuns].sort((a, b) => a - b).join(",");
    const key = `${width}|${hiddenKey}|${children.length}|${geometryToken ?? ""}`;
    const cached = assistantGeometry.get(component);
    // Stable frames reuse the measured heights: hidden content is not
    // rendered again just to learn its row count. The geometry epoch and
    // the invalidate() hook drop the cache whenever it could go stale.
    const heights =
      cached !== undefined &&
      cached.key === key &&
      cached.heights.length === children.length
        ? cached.heights
        : undefined;
    const measured: number[] = new Array<number>(children.length).fill(0);
    let original = 0;
    let runIndex = 0;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child instanceof MouseRegion) {
        const current = runIndex++;
        if (hiddenRuns.has(current)) {
          // The run is hidden but its rows still exist for coordinates.
          const height =
            heights?.[index] ?? asRenderable(child).render(width).length;
          measured[index] = height;
          original += height;
          // The separator spacer after a hidden run goes with it.
          if (
            index + 1 < children.length &&
            children[index + 1] instanceof Spacer
          ) {
            index += 1;
            const spacerHeight =
              heights?.[index] ??
              asRenderable(children[index]).render(width).length;
            measured[index] = spacerHeight;
            original += spacerHeight;
          }
          // A folded carrier run shows the group summary in its place.
          const summary = summaryForRun?.(current, width);
          if (summary !== undefined) {
            summaryRows.set(lines.length, current);
            lines.push(summary);
          }
          continue;
        }
        // An expanded run of a managed group keeps a collapsible title.
        const title = titleForRun?.(current, width);
        if (title !== undefined) {
          titleRows.set(lines.length, current);
          lines.push(title);
        }
      }
      const childLines = asRenderable(child).render(width);
      measured[index] = childLines.length;
      for (let offset = 0; offset < childLines.length; offset++) {
        rowMap.set(lines.length + offset, original + offset);
      }
      lines.push(...childLines);
      original += childLines.length;
    }
    assistantGeometry.set(component, { key, heights: measured });
  }
  if (lines.length === 0)
    return { lines, map: { rowMap, summaryRows, titleRows } };
  const hasToolCalls = (component as unknown as { hasToolCalls?: boolean })
    .hasToolCalls;
  if (hasToolCalls) {
    return { lines, map: { rowMap, summaryRows, titleRows } };
  }
  lines[0] = OSC_ZONE_START + lines[0];
  lines[lines.length - 1] =
    OSC_ZONE_END + OSC_ZONE_FINAL + lines[lines.length - 1];
  return { lines, map: { rowMap, summaryRows, titleRows } };
}

/**
 * Install the render projection on the host component classes. The plan is
 * consulted per render; components without a binding or without a plan
 * pass through untouched.
 *
 * `onSummaryClick` additionally installs the native summary-click path for
 * hosts without a click consumer (Starline absent or its click feature
 * off): a plain single click on a summary/title row toggles the group
 * exactly once; every other event is translated back into the original
 * render's row space and handed to the component's own handler.
 */
export function installRenderProjection(
  plan: ProjectionPlan,
  options?: {
    onSummaryClick?: SummaryClickHandler;
    /** Resolves the group target for click/press-release identity checks. */
    resolveSummaryTarget?: TargetResolver;
    /** A summary cannot fit the width: the whole group falls back. */
    onUnfittable?: UnfittableHandler;
  },
): PatchInstallResult {
  activePlan = plan;
  activeUnfittable = options?.onUnfittable;
  const target = (value: object) =>
    value as unknown as Record<PropertyKey, unknown>;

  const results = [
    installPrototypePatch(
      target(ToolExecutionComponent.prototype),
      "render",
      "host-adapter-render",
      ({ predecessor, receiver, args }) => project(predecessor, receiver, args),
    ),
    installPrototypePatch(
      target(CustomMessageComponent.prototype),
      "render",
      "host-adapter-render",
      ({ predecessor, receiver, args }) => project(predecessor, receiver, args),
    ),
    installPrototypePatch(
      target(AssistantMessageComponent.prototype),
      "render",
      "host-adapter-render",
      ({ predecessor, receiver, args }) => {
        const width = (args[0] as number) ?? 0;
        const projection = projectionFor(receiver, width);
        if (projection?.kind === "hideThinkingRuns") {
          // One traversal: the visible output and the row→run maps for
          // mouse dispatch. Every child renders at most once per frame —
          // the visible body is not rendered twice for coordinates, and
          // cached geometry skips hidden content entirely.
          const { lines, map } = renderAssistantProjected(
            receiver as AssistantMessageComponent,
            width,
            projection.hiddenRuns,
            projection.summaryForRun,
            projection.titleForRun,
            projection.geometryToken,
          );
          lastAssistantRowMaps.set(receiver as object, map);
          return lines;
        }
        lastAssistantRowMaps.delete(receiver as object);
        return project(predecessor, receiver, args);
      },
    ),
    // Any component invalidation (theme, thinking visibility, content
    // reset) drops the cached geometry before the next render measures it.
    installPrototypePatch(
      target(AssistantMessageComponent.prototype),
      "invalidate",
      "host-adapter-render",
      ({ predecessor, receiver, args }) => {
        assistantGeometry.delete(receiver as object);
        return predecessor.apply(receiver, args);
      },
    ),
    // Notification carriers are ThemedText (Text subclass): the render
    // projection must cover them too. The binding guard keeps every other
    // Text in the process on the untouched predecessor path.
    installPrototypePatch(
      target(Text.prototype),
      "render",
      "host-adapter-render",
      ({ predecessor, receiver, args }) => project(predecessor, receiver, args),
    ),
  ];

  // Native summary clicks (fallback when no click consumer is installed).
  if (options?.onSummaryClick) {
    activeClickContext = {
      onClick: options.onSummaryClick,
      resolveTarget: options.resolveSummaryTarget ?? (() => undefined),
    };
    for (const prototype of [
      ToolExecutionComponent.prototype,
      CustomMessageComponent.prototype,
      AssistantMessageComponent.prototype,
    ]) {
      results.push(
        installPrototypePatch(
          target(prototype),
          "handleMouse",
          "host-adapter-summary-click",
          ({ predecessor, receiver, args }) =>
            dispatchSummaryMouse(predecessor, receiver, args),
        ),
      );
    }
    results.push(installNotificationCarrierClicks());
  }

  const available = results.every((result) => result.available);
  const cleanups = results.map((result) => result.cleanup);
  return {
    available,
    cleanup: () => {
      for (const cleanup of cleanups) cleanup();
      activePlan = undefined;
      activeClickContext = undefined;
      activeUnfittable = undefined;
    },
  };
}

/** pi-tui's event slice the dispatch reads; coordinates are component-local. */
type TuiEvent = {
  type: string;
  x: number;
  y: number;
  width: number;
  button: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  clickCount?: number;
};

function isTuiEvent(value: unknown): value is TuiEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TuiEvent>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.width === "number"
  );
}

/** The press a plain-click release must match, per component. */
type PressRecord = {
  x: number;
  y: number;
  /** Thinking run the pressed row belongs to (assistant summaries). */
  run?: number;
  /** The group target resolved at press; the release must land on it again. */
  target: unknown;
};
const pressCells = new WeakMap<object, PressRecord>();

/**
 * Test/probe counter: how many bound-member body renders the hide
 * projection skipped (incremented instead of calling the predecessor).
 */
export const debugSkippedBodyRenders = { value: 0 };

/**
 * Latest row→run maps per assistant component, written by the render
 * path whenever the managed-runs projection is active. Consumers (the
 * published expand-target resolver) query these instead of re-walking.
 */
type AssistantRowMaps = {
  rowMap: Map<number, number>;
  summaryRows: Map<number, number>;
  titleRows: Map<number, number>;
};
const lastAssistantRowMaps = new WeakMap<object, AssistantRowMaps>();

/**
 * Cached per-child row heights for the managed assistant projection. The
 * geometry epoch (model revision) and the component's invalidate() hook
 * both drop the entry, so a cache hit can never outlive a layout change.
 */
const assistantGeometry = new WeakMap<
  object,
  { key: string; heights: number[] }
>();

/**
 * The managed thinking run whose shell (summary/title) renders at
 * `localRow` of this assistant component, or undefined. Answers from the
 * projection's own row maps — no layout guessing, no text matching.
 */
export function managedRunAtRow(
  component: object,
  localRow: number,
): number | undefined {
  const maps = lastAssistantRowMaps.get(component);
  if (!maps) return undefined;
  return maps.summaryRows.get(localRow) ?? maps.titleRows.get(localRow);
}

/** Installed alongside the projection when native clicks are wanted. */
type ClickContext = {
  onClick: SummaryClickHandler;
  resolveTarget: TargetResolver;
};
let activeClickContext: ClickContext | undefined;
let activeUnfittable: UnfittableHandler | undefined;
/** Cleanup-only registry: which receivers reported an unfittable width. */
const unfittableReported = new WeakSet<object>();

function dispatchSummaryMouse(
  predecessor: (this: unknown, ...args: unknown[]) => unknown,
  receiver: unknown,
  args: unknown[],
): unknown {
  const event = args[0];
  if (!isTuiEvent(event) || typeof receiver !== "object" || receiver === null) {
    return predecessor.apply(receiver, args);
  }
  const projection = projectionFor(receiver);
  if (projection === undefined) {
    return predecessor.apply(receiver, args);
  }

  if (projection.kind === "summary") {
    // The folded carrier renders one summary row; only row 0 can arrive.
    return shellRow(predecessor, receiver, args, event);
  }
  if (projection.kind === "titled") {
    if (event.y === 0) {
      return shellRow(predecessor, receiver, args, event);
    }
    // Below the title: hand the event back in the original row space.
    return predecessor.apply(receiver, [
      { ...event, y: event.y - 1 },
      ...args.slice(1),
    ]);
  }
  if (projection.kind === "hideThinkingRuns") {
    const { rowMap, summaryRows, titleRows } = assistantRowMap(
      receiver as AssistantMessageComponent,
      event.width,
      projection.hiddenRuns,
      projection.summaryForRun,
      projection.titleForRun,
    );
    const run = summaryRows.get(event.y) ?? titleRows.get(event.y) ?? undefined;
    if (run !== undefined) {
      // An in-place group summary or title row: the plain-click protocol
      // applies, resolved to that row's own thinking run.
      return shellRow(predecessor, receiver, args, event, run);
    }
    const originalY = rowMap.get(event.y);
    if (originalY === undefined) {
      return predecessor.apply(receiver, args);
    }
    return predecessor.apply(receiver, [
      { ...event, y: originalY },
      ...args.slice(1),
    ]);
  }
  return predecessor.apply(receiver, args);
}

/**
 * The summary/title row's plain-click protocol. Hosts differ in what the
 * component sees: pi-tui's fullscreen scroll view runs selection on
 * press/release and delivers a synthesized **"click"** event to the
 * component (what native thinking-block handlers consume), while direct
 * callers may deliver press+release. Both shapes are honored:
 *
 * - "click": a plain single click (no modifiers, clickCount 1) toggles
 *   once, provided the target still resolves at this cell;
 * - press/release: the release must land on the same cell and resolve to
 *   the same target the press anchored on (layout changes forward instead
 *   of toggling).
 *
 * Modified or multi-click events and every other event type stay with the
 * original handler — selection and word-click keep their meaning.
 */
function shellRow(
  predecessor: (this: unknown, ...args: unknown[]) => unknown,
  receiver: object,
  args: unknown[],
  event: TuiEvent,
  run?: number,
): unknown {
  const clickContext = activeClickContext;
  if (!clickContext) return predecessor.apply(receiver, args);
  const cell = { x: event.x, y: event.y };
  if (event.type === "click") {
    const plain =
      !event.shift &&
      !event.alt &&
      !event.ctrl &&
      (event.clickCount ?? 1) === 1 &&
      clickContext.resolveTarget?.(receiver, event.width, run) !== undefined;
    if (plain && clickContext.onClick(receiver, event.width, run)) {
      return { handled: true, render: true };
    }
    return predecessor.apply(receiver, args);
  }
  if (event.type === "press") {
    pressCells.set(receiver, {
      ...cell,
      run,
      target: clickContext.resolveTarget?.(receiver, event.width, run),
    });
    return predecessor.apply(receiver, args);
  }
  if (event.type === "move" || event.type === "drag") {
    const pressed = pressCells.get(receiver);
    if (pressed && (pressed.x !== cell.x || pressed.y !== cell.y)) {
      pressCells.delete(receiver);
    }
    return predecessor.apply(receiver, args);
  }
  if (event.type === "release") {
    const pressed = pressCells.get(receiver);
    pressCells.delete(receiver);
    // Identity across the press/release gap: the release must land on the
    // same cell and resolve to the very target the press anchored on. A
    // layout change that moved, removed, or replaced the group therefore
    // forwards the event instead of toggling.
    const releasedTarget = clickContext.resolveTarget?.(
      receiver,
      event.width,
      run,
    );
    const plain =
      pressed !== undefined &&
      pressed.x === cell.x &&
      pressed.y === cell.y &&
      pressed.run === run &&
      pressed.target !== undefined &&
      pressed.target === releasedTarget &&
      !event.shift &&
      !event.alt &&
      !event.ctrl &&
      (event.clickCount ?? 1) === 1;
    if (plain && clickContext.onClick(receiver, event.width, run)) {
      // Consumed without capture or focus: overlays keep their routing and
      // no drag channel is opened.
      return { handled: true, render: true };
    }
    return predecessor.apply(receiver, args);
  }
  return predecessor.apply(receiver, args);
}

/**
 * Notification carriers are plain `Text` subclasses the render projection
 * does not patch; `Text` has no `handleMouse` to wrap, so the click path is
 * added additively and removed on cleanup. The binding guard keeps every
 * other Text in the process untouched.
 */
function installNotificationCarrierClicks(): PatchInstallResult {
  const prototype = Text.prototype as unknown as Record<PropertyKey, unknown>;
  const existing = prototype.handleMouse;
  if (typeof existing === "function") {
    return installPrototypePatch(
      prototype,
      "handleMouse",
      "host-adapter-summary-click",
      ({ predecessor, receiver, args }) =>
        dispatchSummaryMouse(predecessor, receiver, args),
    );
  }
  const handler = function (this: object, event: unknown): unknown {
    return dispatchSummaryMouse(() => undefined, this, [event]);
  };
  prototype.handleMouse = handler;
  return {
    available: true,
    cleanup: () => {
      if (prototype.handleMouse === handler) {
        delete prototype.handleMouse;
      }
    },
  };
}

/**
 * Projected-row → original-row index map for an assistant message with
 * managed thinking runs: the walk `renderAssistantWithoutRuns` performs,
 * recording where each visible line came from, plus the projected rows
 * that carry a managed shell (folded summary or expanded title), each
 * mapped to its own thinking run for click resolution.
 */
function assistantRowMap(
  component: AssistantMessageComponent,
  width: number,
  hiddenRuns: ReadonlySet<number>,
  summaryForRun?: (run: number, width: number) => string | undefined,
  titleForRun?: (run: number, width: number) => string | undefined,
): {
  rowMap: Map<number, number>;
  summaryRows: Map<number, number>;
  titleRows: Map<number, number>;
} {
  const rowMap = new Map<number, number>();
  const summaryRows = new Map<number, number>();
  const titleRows = new Map<number, number>();
  const container = contentContainerOf(component);
  if (!container) return { rowMap, summaryRows, titleRows };
  const children = [...container.children];
  let projected = 0;
  let original = 0;
  let runIndex = 0;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child instanceof MouseRegion) {
      const current = runIndex++;
      if (hiddenRuns.has(current)) {
        if (
          index + 1 < children.length &&
          children[index + 1] instanceof Spacer
        ) {
          index += 1;
          original += asRenderable(children[index]).render(width).length;
        }
        original += asRenderable(child).render(width).length;
        const summary = summaryForRun?.(current, width);
        if (summary !== undefined) {
          summaryRows.set(projected, current);
          projected += 1;
        }
        continue;
      }
      // An expanded managed run: its title row maps to the run.
      const title = titleForRun?.(current, width);
      if (title !== undefined) {
        titleRows.set(projected, current);
        projected += 1;
      }
    }
    const height = asRenderable(child).render(width).length;
    for (let offset = 0; offset < height; offset++) {
      rowMap.set(projected + offset, original + offset);
    }
    projected += height;
    original += height;
  }
  return { rowMap, summaryRows, titleRows };
}

function projectionFor(
  receiver: unknown,
  width?: number,
): Projection | undefined {
  if (!activePlan) return undefined;
  if (typeof receiver !== "object" || receiver === null) return undefined;
  if (!bindings.has(receiver)) return undefined;
  return activePlan(receiver, width);
}

function project(
  predecessor: (this: unknown, ...args: unknown[]) => unknown,
  receiver: unknown,
  args: unknown[],
): unknown {
  const width = (args[0] as number) ?? 0;
  const projection = projectionFor(receiver, width);
  if (projection === undefined) {
    // Pass-through: the predecessor's own array, unmodified.
    return predecessor.apply(receiver, args);
  }
  if (projection.kind === "hide") {
    // The member's body is skipped entirely — the predecessor render for
    // this bound component never runs. Counted for the scale regression.
    debugSkippedBodyRenders.value += 1;
    return [];
  }
  if (projection.kind === "summary") {
    const line = projection.lineFor(width);
    if (line === undefined) {
      // No fitting summary: the whole group falls back to its original
      // display, not just this member. The plan hears about the shortfall
      // so every other member renders transparent at this width too.
      if (activeUnfittable && !unfittableReported.has(receiver as object)) {
        unfittableReported.add(receiver as object);
        activeUnfittable(receiver as object, width);
      }
      return predecessor.apply(receiver, args);
    }
    return [line];
  }
  if (projection.kind === "titled") {
    const title = projection.titleFor(width);
    if (title === undefined) return predecessor.apply(receiver, args);
    // The title line above the member's own output, at the same width,
    // with no member list, indentation, or re-wrapping below it.
    const own = predecessor.apply(receiver, args) as string[];
    return [title, ...own];
  }
  return predecessor.apply(receiver, args);
}
