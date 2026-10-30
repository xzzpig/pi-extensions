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
import {
  MouseRegion,
  Spacer,
  Text,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
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
      /** Group control after this run when it is the last member. */
      readonly footerForRun?: (
        run: number,
        width: number,
      ) => string | undefined;
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
      readonly footerFor?: (width: number) => string | undefined;
    }
  | {
      /** An expanded group's last member keeps its original output. */
      readonly kind: "footer";
      readonly footerFor: (width: number) => string | undefined;
    };

export type ShellRole = "header" | "footer";

export type GroupBoundaryEdges = {
  readonly start: boolean;
  readonly end: boolean;
  /** End run when the edge is inside an assistant message. */
  readonly endRun?: number;
};
export type GroupBoundaryGaps = {
  readonly before: boolean | undefined;
  readonly after: boolean;
};
export type GroupBoundaryResolver = (
  component: ProjectedComponent,
  width: number,
  edges: GroupBoundaryEdges,
) => GroupBoundaryGaps;

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
  role?: ShellRole,
) => boolean;

/** Resolves the group target for click/press-release identity checks. */
export type TargetResolver = (
  component: object,
  width: number,
  run?: number,
  role?: ShellRole,
) => unknown;

/** Reported when a summary cannot fit the current render width. */
export type UnfittableHandler = (component: object, width: number) => void;

type Binding = {
  /** Assistant bindings carry their content container for run filtering. */
  contentContainer?: { children: readonly unknown[] };
};

const bindings = new WeakMap<object, Binding>();
let activePlan: ProjectionPlan | undefined;
let activeProjectionOwner: symbol | undefined;
let activeBoundary: GroupBoundaryResolver | undefined;
let boundaryProbeDepth = 0;
const boundaryProbes: { component: unknown; startsWithGroup: boolean }[] = [];

/** Render an adjacent child without changing the screen's hit geometry. */
export function probeProjectedLines(
  component: unknown,
  width: number,
): { lines: string[]; startsWithGroup: boolean } | undefined {
  if (
    typeof component !== "object" ||
    component === null ||
    !("render" in component)
  )
    return undefined;
  const render = component.render;
  if (typeof render !== "function") return undefined;
  boundaryProbeDepth += 1;
  const probe = { component, startsWithGroup: false };
  boundaryProbes.push(probe);
  try {
    const result: unknown = Reflect.apply(render, component, [width]);
    return Array.isArray(result) &&
      result.every((line) => typeof line === "string")
      ? { lines: result, startsWithGroup: probe.startsWithGroup }
      : undefined;
  } catch {
    return undefined;
  } finally {
    boundaryProbes.pop();
    boundaryProbeDepth -= 1;
  }
}

function addGroupBoundaries(
  component: ProjectedComponent,
  width: number,
  lines: string[],
  edges: GroupBoundaryEdges,
  existingLeading = false,
): { lines: string[]; prefix: number } {
  if (
    !activeBoundary ||
    boundaryProbeDepth > 0 ||
    (!edges.start && !edges.end)
  ) {
    return { lines, prefix: 0 };
  }
  const gaps = activeBoundary(component, width, edges);
  const dropLeading = existingLeading && gaps.before === false;
  const addLeading = !existingLeading && gaps.before === true;
  const body = dropLeading ? lines.slice(1) : [...lines];
  // A removed carrier Spacer can own the assistant's OSC start marker.
  if (dropLeading && lines[0]?.includes(OSC_ZONE_START) && body.length > 0) {
    body[0] = OSC_ZONE_START + body[0];
  }
  return {
    lines: [...(addLeading ? [""] : []), ...body, ...(gaps.after ? [""] : [])],
    prefix: addLeading ? 1 : dropLeading ? -1 : 0,
  };
}

export type NotificationSpacerHost = {
  readonly chatContainer: { readonly children: readonly unknown[] };
};

type NotificationSpacerBinding = {
  readonly owner: WeakRef<ProjectedComponent>;
  readonly receiver: WeakRef<NotificationSpacerHost>;
  index: number;
};
let notificationSpacers = new WeakMap<object, NotificationSpacerBinding>();
let notificationOwnerSpacers = new WeakMap<
  ProjectedComponent,
  WeakRef<Spacer>
>();

/** Associate only a host-proven adjacent notification/spacer pair. */
export function bindNotificationSpacer(
  spacer: Spacer,
  owner: ProjectedComponent,
  receiver: NotificationSpacerHost,
  index: number,
): void {
  forgetNotificationSpacer(owner);
  notificationSpacers.set(spacer, {
    owner: new WeakRef(owner),
    receiver: new WeakRef(receiver),
    index,
  });
  notificationOwnerSpacers.set(owner, new WeakRef(spacer));
}

/** Discard the association when a notification loses its proven identity. */
export function forgetNotificationSpacer(owner: ProjectedComponent): void {
  const spacer = notificationOwnerSpacers.get(owner)?.deref();
  if (
    spacer !== undefined &&
    notificationSpacers.get(spacer)?.owner.deref() === owner
  ) {
    notificationSpacers.delete(spacer);
  }
  notificationOwnerSpacers.delete(owner);
}

/** Refresh a known pair in the existing linear host-child scan. */
export function refreshNotificationSpacer(
  spacer: unknown,
  next: unknown,
  receiver: NotificationSpacerHost,
  index: number,
): void {
  if (typeof spacer !== "object" || spacer === null) return;
  const binding = notificationSpacers.get(spacer);
  if (!binding) return;
  const owner = binding.owner.deref();
  if (
    owner === undefined ||
    binding.receiver.deref() !== receiver ||
    next !== owner
  ) {
    notificationSpacers.delete(spacer);
    if (
      owner !== undefined &&
      notificationOwnerSpacers.get(owner)?.deref() === spacer
    ) {
      notificationOwnerSpacers.delete(owner);
    }
    return;
  }
  binding.index = index;
}

/** A new view or an uninstalled adapter must not retain old associations. */
export function clearNotificationSpacers(): void {
  notificationSpacers = new WeakMap();
  notificationOwnerSpacers = new WeakMap();
}

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
  // SAFETY: only assistant components are bound here; the optional field is read, never written.
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
  footerForRun?: (run: number, width: number) => string | undefined,
): { lines: string[]; map: AssistantRowMaps } {
  const container = contentContainerOf(component);
  const lines: string[] = [];
  const rowMap = new Map<number, number>();
  const summaryRows = new Map<number, number>();
  const titleRows = new Map<number, number>();
  const footerRows = new Map<number, number>();
  if (container) {
    const children = [...container.children];
    // Pi puts a leading Spacer in an assistant message whose only visible
    // content is one thinking run. If that run is hidden and another
    // component owns its group summary, the Spacer belongs exclusively to
    // the hidden run and must not leave an orphan row in the transcript.
    // Restrict this to the proven two-child shape: mixed text, diagnostics,
    // and summary carriers keep their own layout and are handled separately.
    const suppressLeadingSpacer =
      children.length === 2 &&
      children[0] instanceof Spacer &&
      children[1] instanceof MouseRegion &&
      hiddenRuns.has(0) &&
      summaryForRun?.(0, width) === undefined;
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
    let separatorAfterSummary = false;
    const blank = (line: string) => stripTerminalSequences(line).trim() === "";
    const separateFromPrevious = () => {
      if (lines.length > 0 && !blank(lines[lines.length - 1])) lines.push("");
    };
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      let visibleRun: number | undefined;
      if (index === 0 && suppressLeadingSpacer) {
        const height =
          heights?.[index] ?? asRenderable(child).render(width).length;
        measured[index] = height;
        original += height;
        continue;
      }
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
            separateFromPrevious();
            summaryRows.set(lines.length, current);
            lines.push(summary);
            separatorAfterSummary = true;
          }
          continue;
        }
        visibleRun = current;
        // An expanded run of a managed group keeps a collapsible title.
        const title = titleForRun?.(current, width);
        if (title !== undefined) {
          separateFromPrevious();
          titleRows.set(lines.length, current);
          lines.push(title);
          separatorAfterSummary = false;
        }
      }
      const childLines = asRenderable(child).render(width);
      measured[index] = childLines.length;
      if (separatorAfterSummary && childLines.length > 0) {
        if (!blank(childLines[0])) separateFromPrevious();
        separatorAfterSummary = false;
      }
      for (let offset = 0; offset < childLines.length; offset++) {
        rowMap.set(lines.length + offset, original + offset);
      }
      lines.push(...childLines);
      original += childLines.length;
      if (visibleRun !== undefined) {
        const footer = footerForRun?.(visibleRun, width);
        if (footer !== undefined) {
          footerRows.set(lines.length, visibleRun);
          lines.push(footer);
        }
      }
    }
    assistantGeometry.set(component, { key, heights: measured });
  }
  if (lines.length === 0)
    return {
      lines,
      map: { width, rowMap, summaryRows, titleRows, footerRows },
    };
  // SAFETY: Pi's assistant component exposes this runtime field for OSC anchoring.
  const hasToolCalls = (component as unknown as { hasToolCalls?: boolean })
    .hasToolCalls;
  if (hasToolCalls) {
    return {
      lines,
      map: { width, rowMap, summaryRows, titleRows, footerRows },
    };
  }
  lines[0] = OSC_ZONE_START + lines[0];
  lines[lines.length - 1] =
    OSC_ZONE_END + OSC_ZONE_FINAL + lines[lines.length - 1];
  return { lines, map: { width, rowMap, summaryRows, titleRows, footerRows } };
}

/** Rendering and hit-testing share the same inserted boundary geometry. */
function renderManagedAssistant(
  component: AssistantMessageComponent,
  width: number,
  hiddenRuns: ReadonlySet<number>,
  summaryForRun?: (run: number, width: number) => string | undefined,
  titleForRun?: (run: number, width: number) => string | undefined,
  geometryToken?: string,
  footerForRun?: (run: number, width: number) => string | undefined,
): { lines: string[]; map: AssistantRowMaps } {
  const rendered = renderAssistantProjected(
    component,
    width,
    hiddenRuns,
    summaryForRun,
    titleForRun,
    geometryToken,
    footerForRun,
  );
  const { map } = rendered;
  const last = rendered.lines.length - 1;
  const leadingBoundary =
    contentContainerOf(component)?.children[0] instanceof Spacer &&
    rendered.lines[0] !== undefined &&
    stripTerminalSequences(rendered.lines[0]).trim() === "" &&
    (map.summaryRows.has(1) || map.titleRows.has(1));
  const result = addGroupBoundaries(
    component,
    width,
    rendered.lines,
    {
      start: leadingBoundary || map.summaryRows.has(0) || map.titleRows.has(0),
      end: map.summaryRows.has(last) || map.footerRows.has(last),
      endRun: map.summaryRows.get(last) ?? map.footerRows.get(last),
    },
    leadingBoundary,
  );
  if (result.prefix === 0) return { lines: result.lines, map };
  const shifted = (rows: Map<number, number>) =>
    new Map(
      [...rows]
        .filter(([row]) => row + result.prefix >= 0)
        .map(([row, value]) => [row + result.prefix, value]),
    );
  return {
    lines: result.lines,
    map: {
      width,
      rowMap: shifted(map.rowMap),
      summaryRows: shifted(map.summaryRows),
      titleRows: shifted(map.titleRows),
      footerRows: shifted(map.footerRows),
    },
  };
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
    /** Only proven main-transcript neighbors participate in spacing. */
    groupBoundary?: GroupBoundaryResolver;
    /** Only the current main-session receiver may own projected spacers. */
    isNotificationReceiver?: (receiver: NotificationSpacerHost) => boolean;
    /** Tell the session when this optional host seam is unavailable. */
    onNotificationSpacerUnavailable?: () => void;
  },
): PatchInstallResult {
  const owner = Symbol("host-adapter-projection");
  activeProjectionOwner = owner;
  activePlan = plan;
  activeUnfittable = options?.onUnfittable;
  activeBoundary = options?.groupBoundary;
  // SAFETY: each caller supplies a real class prototype, whose methods the registry probes.
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
          const { lines, map } = renderManagedAssistant(
            receiver as AssistantMessageComponent,
            width,
            projection.hiddenRuns,
            projection.summaryForRun,
            projection.titleForRun,
            projection.geometryToken,
            projection.footerForRun,
          );
          rememberAssistantRows(receiver as object, map);
          return lines;
        }
        if (boundaryProbeDepth === 0)
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
    // Only explicitly proven notification spacers can be projected. All
    // other Spacer instances, including other extensions' UI, pass through.
    installPrototypePatch(
      target(Spacer.prototype),
      "render",
      "host-adapter-notification-spacer",
      ({ predecessor, receiver, args }) => {
        if (typeof receiver !== "object" || receiver === null) {
          return predecessor.apply(receiver, args);
        }
        const binding = notificationSpacers.get(receiver);
        const owner = binding?.owner.deref();
        const host = binding?.receiver.deref();
        if (
          !binding ||
          !owner ||
          !host ||
          !options?.isNotificationReceiver?.(host)
        ) {
          return predecessor.apply(receiver, args);
        }
        const children = host.chatContainer.children;
        if (
          children?.[binding.index] !== receiver ||
          children[binding.index + 1] !== owner
        ) {
          return predecessor.apply(receiver, args);
        }
        const projection = projectionFor(owner, (args[0] as number) ?? 0);
        return projection?.kind === "hide"
          ? []
          : predecessor.apply(receiver, args);
      },
    ),
  ];
  const spacerProjection = results.at(-1);
  if (spacerProjection && !spacerProjection.available) {
    options?.onNotificationSpacerUnavailable?.();
  }

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
      // A later installation replaced this behavior slot. Its live plan
      // and weak spacer associations must survive an out-of-order cleanup.
      if (activeProjectionOwner === owner) {
        activeProjectionOwner = undefined;
        activePlan = undefined;
        activeBoundary = undefined;
        activeClickContext = undefined;
        activeUnfittable = undefined;
        clearNotificationSpacers();
      }
    },
  };
}

/** pi-tui's event slice the dispatch reads; coordinates are component-local. */
type TuiEvent = {
  type: string;
  x: number;
  y: number;
  width: number;
  screenX?: number;
  screenY?: number;
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
  width: number;
  screenX?: number;
  screenY?: number;
  /** Thinking run the pressed row belongs to (assistant summaries). */
  run?: number;
  role: ShellRole;
  /** The group target resolved at press; the release must land on it again. */
  target: unknown;
  at: number;
  expandedAtPress: boolean | undefined;
  expandedAfterToggle?: boolean;
  suppressToggle: boolean;
};
const pressCells = new WeakMap<object, PressRecord>();
const recentToggles = new WeakMap<object, PressRecord>();
const suppressedClicks = new WeakMap<object, PressRecord>();
// Match Pi/Starline's double-click window. Press is still passed through to
// native selection; only a second same-cell group toggle is prevented.
const DOUBLE_CLICK_MS = 500;

function targetExpansion(target: unknown): boolean | undefined {
  try {
    if (
      typeof target !== "object" ||
      target === null ||
      !("expanded" in target)
    )
      return undefined;
    return typeof target.expanded === "boolean" ? target.expanded : undefined;
  } catch {
    return undefined;
  }
}

function sameClickCell(
  previous: PressRecord,
  event: TuiEvent,
  target: unknown,
  run: number | undefined,
  role: ShellRole,
  now: number,
): boolean {
  return (
    now >= previous.at &&
    now - previous.at <= DOUBLE_CLICK_MS &&
    previous.target !== undefined &&
    previous.target === target &&
    previous.x === event.x &&
    previous.y === event.y &&
    previous.width === event.width &&
    previous.screenX === event.screenX &&
    previous.screenY === event.screenY &&
    previous.run === run &&
    previous.role === role
  );
}

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
  width: number;
  rowMap: Map<number, number>;
  summaryRows: Map<number, number>;
  titleRows: Map<number, number>;
  footerRows: Map<number, number>;
};
const lastAssistantRowMaps = new WeakMap<object, AssistantRowMaps>();
const lastHeaderRows = new WeakMap<object, { width: number; row: number }>();
const lastFooterRows = new WeakMap<object, { width: number; row: number }>();

/** The rendered local header row, if this component currently owns one. */
export function headerRowAtWidth(
  component: unknown,
  width: number,
): number | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const regular = lastHeaderRows.get(component);
  return regular?.width === width ? regular.row : undefined;
}

function rememberAssistantRows(
  component: unknown,
  map: AssistantRowMaps,
): void {
  if (typeof component !== "object" || component === null) return;
  if (boundaryProbeDepth > 0) {
    const probe = boundaryProbes.at(-1);
    if (probe?.component === component)
      probe.startsWithGroup = map.summaryRows.has(0) || map.titleRows.has(0);
    return;
  }
  lastAssistantRowMaps.set(component, map);
}

function rememberHeaderRow(
  component: unknown,
  width: number,
  row: number,
): void {
  if (typeof component !== "object" || component === null) return;
  if (boundaryProbeDepth > 0) {
    const probe = boundaryProbes.at(-1);
    if (probe?.component === component) probe.startsWithGroup = row === 0;
    return;
  }
  lastHeaderRows.set(component, { width, row });
}

/** Identify a footer only from geometry produced by the current render. */
export function footerAtRow(
  component: unknown,
  localRow: number,
  width: number,
): { run?: number } | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const assistant = lastAssistantRowMaps.get(component);
  if (assistant?.width === width && assistant.footerRows.has(localRow)) {
    return { run: assistant.footerRows.get(localRow) };
  }
  const footer = lastFooterRows.get(component);
  return footer?.width === width && footer.row === localRow ? {} : undefined;
}

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
  if (event.type === "move" || event.type === "drag") {
    const pressed = pressCells.get(receiver);
    if (
      pressed &&
      (pressed.x !== event.x ||
        pressed.y !== event.y ||
        pressed.width !== event.width ||
        pressed.screenX !== event.screenX ||
        pressed.screenY !== event.screenY)
    ) {
      pressCells.delete(receiver);
    }
  }
  const projection = projectionFor(receiver);
  if (projection === undefined) {
    return predecessor.apply(receiver, args);
  }

  const footer = lastFooterRows.get(receiver);
  if (footer?.width === event.width && footer.row === event.y) {
    return shellRow(
      () => undefined,
      receiver,
      args,
      event,
      undefined,
      "footer",
    );
  }
  const header = lastHeaderRows.get(receiver);
  // Direct component clients can dispatch before the first render. In a
  // displayed frame the measured row always wins, including boundary gaps.
  const headerRow = header?.width === event.width ? header.row : 0;
  if (projection.kind === "summary") {
    if (headerRow === event.y) {
      return shellRow(predecessor, receiver, args, event);
    }
    return undefined;
  }
  if (projection.kind === "titled") {
    if (event.y === headerRow) {
      return shellRow(predecessor, receiver, args, event);
    }
    // Synthetic padding has no original row; body rows translate past the title.
    if (
      event.y < headerRow ||
      (footer?.width === event.width && event.y > footer.row)
    )
      return undefined;
    return predecessor.apply(receiver, [
      { ...event, y: event.y - headerRow - 1 },
      ...args.slice(1),
    ]);
  }
  if (
    projection.kind === "footer" &&
    footer?.width === event.width &&
    event.y > footer.row
  ) {
    return undefined;
  }
  if (projection.kind === "hideThinkingRuns") {
    // Use the exact same traversal as rendering: synthetic separator rows
    // and original child coordinates must never drift apart on a click.
    const { map } = renderManagedAssistant(
      receiver as AssistantMessageComponent,
      event.width,
      projection.hiddenRuns,
      projection.summaryForRun,
      projection.titleForRun,
      projection.geometryToken,
      projection.footerForRun,
    );
    rememberAssistantRows(receiver, map);
    const { rowMap, summaryRows, titleRows, footerRows } = map;
    const footerRun = footerRows.get(event.y);
    if (footerRun !== undefined) {
      return shellRow(
        () => undefined,
        receiver,
        args,
        event,
        footerRun,
        "footer",
      );
    }
    const run = summaryRows.get(event.y) ?? titleRows.get(event.y) ?? undefined;
    if (run !== undefined) {
      // An in-place group summary or title row: the plain-click protocol
      // applies, resolved to that row's own thinking run.
      return shellRow(predecessor, receiver, args, event, run);
    }
    const originalY = rowMap.get(event.y);
    if (originalY === undefined) {
      // A group-owned separator has no original component row. Passing its
      // projected y to the native handler can toggle an unrelated run.
      return undefined;
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
  role: ShellRole = "header",
): unknown {
  const clickContext = activeClickContext;
  if (!clickContext) return predecessor.apply(receiver, args);
  const cell = { x: event.x, y: event.y };
  if (event.type === "click") {
    const target = clickContext.resolveTarget?.(
      receiver,
      event.width,
      run,
      role,
    );
    const suppressed = suppressedClicks.get(receiver);
    suppressedClicks.delete(receiver);
    const now = Date.now();
    if (
      (suppressed &&
        sameClickCell(suppressed, event, target, run, role, now)) ||
      (event.clickCount ?? 1) > 1
    ) {
      // The group shell has no original member row. Leave this click to Pi's
      // selection machinery rather than routing it into a member's handler.
      return undefined;
    }
    const plain =
      !event.shift && !event.alt && !event.ctrl && target !== undefined;
    if (plain && clickContext.onClick(receiver, event.width, run, role)) {
      recentToggles.set(receiver, {
        ...cell,
        width: event.width,
        screenX: event.screenX,
        screenY: event.screenY,
        run,
        role,
        target,
        at: now,
        expandedAtPress: undefined,
        expandedAfterToggle: targetExpansion(target),
        suppressToggle: false,
      });
      return { handled: true, render: true };
    }
    return predecessor.apply(receiver, args);
  }
  if (event.type === "press") {
    const target = clickContext.resolveTarget?.(
      receiver,
      event.width,
      run,
      role,
    );
    const now = Date.now();
    const previous = pressCells.get(receiver);
    const recent = recentToggles.get(receiver);
    const expandedAtPress = targetExpansion(target);
    // Starline consumes the first release after Pi saw its press. Detect
    // its external toggle from the stable target's changed expansion state;
    // the second release then belongs to selection, not another toggle.
    const externalToggle =
      previous !== undefined &&
      sameClickCell(previous, event, target, run, role, now) &&
      previous.expandedAtPress !== undefined &&
      expandedAtPress !== undefined &&
      previous.expandedAtPress !== expandedAtPress;
    const recentToggle =
      recent !== undefined &&
      sameClickCell(recent, event, target, run, role, now) &&
      recent.expandedAfterToggle !== undefined &&
      recent.expandedAfterToggle === expandedAtPress;
    suppressedClicks.delete(receiver);
    pressCells.set(receiver, {
      ...cell,
      width: event.width,
      screenX: event.screenX,
      screenY: event.screenY,
      run,
      role,
      target,
      at: now,
      expandedAtPress,
      suppressToggle: externalToggle || recentToggle,
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
    if (pressed?.suppressToggle) {
      suppressedClicks.set(receiver, pressed);
      return predecessor.apply(receiver, args);
    }
    // Identity across the press/release gap: the release must land on the
    // same cell and resolve to the very target the press anchored on. A
    // layout change that moved, removed, or replaced the group therefore
    // forwards the event instead of toggling.
    const releasedTarget = clickContext.resolveTarget?.(
      receiver,
      event.width,
      run,
      role,
    );
    const plain =
      pressed !== undefined &&
      pressed.x === cell.x &&
      pressed.y === cell.y &&
      pressed.width === event.width &&
      pressed.screenX === event.screenX &&
      pressed.screenY === event.screenY &&
      pressed.run === run &&
      pressed.role === role &&
      pressed.target !== undefined &&
      pressed.target === releasedTarget &&
      !event.shift &&
      !event.alt &&
      !event.ctrl &&
      (event.clickCount ?? 1) === 1;
    if (plain && clickContext.onClick(receiver, event.width, run, role)) {
      recentToggles.set(receiver, {
        ...pressed,
        at: Date.now(),
        expandedAfterToggle: targetExpansion(pressed.target),
      });
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
  // SAFETY: this is the host Text prototype; the registry probes the method before wrapping it.
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
  if (
    boundaryProbeDepth === 0 &&
    typeof receiver === "object" &&
    receiver !== null
  ) {
    lastHeaderRows.delete(receiver);
    lastFooterRows.delete(receiver);
  }
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
    if (typeof receiver !== "object" || receiver === null) return [line];
    const result = addGroupBoundaries(asRenderable(receiver), width, [line], {
      start: true,
      end: true,
    });
    rememberHeaderRow(receiver, width, result.prefix);
    return result.lines;
  }
  if (projection.kind === "titled") {
    const title = projection.titleFor(width);
    if (title === undefined) return predecessor.apply(receiver, args);
    // The title line above the member's own output, at the same width,
    // with no member list, indentation, or re-wrapping below it.
    const own = predecessor.apply(receiver, args) as string[];
    const rows = [title, ...own];
    const footer = projection.footerFor?.(width);
    const footerRow = footer === undefined ? undefined : rows.length;
    if (footer !== undefined) rows.push(footer);
    if (typeof receiver !== "object" || receiver === null) return rows;
    const result = addGroupBoundaries(asRenderable(receiver), width, rows, {
      start: true,
      end: footer !== undefined,
    });
    rememberHeaderRow(receiver, width, result.prefix);
    if (boundaryProbeDepth === 0 && footerRow !== undefined)
      lastFooterRows.set(receiver, { width, row: footerRow + result.prefix });
    return result.lines;
  }
  if (projection.kind === "footer") {
    const own = predecessor.apply(receiver, args);
    const footer = projection.footerFor(width);
    if (
      !Array.isArray(own) ||
      footer === undefined ||
      typeof receiver !== "object" ||
      receiver === null
    ) {
      return own;
    }
    const result = addGroupBoundaries(
      asRenderable(receiver),
      width,
      [...own, footer],
      { start: false, end: true },
    );
    if (boundaryProbeDepth === 0)
      lastFooterRows.set(receiver, { width, row: own.length + result.prefix });
    return result.lines;
  }
  return predecessor.apply(receiver, args);
}
