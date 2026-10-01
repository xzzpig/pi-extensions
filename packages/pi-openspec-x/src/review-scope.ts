/**
 * Review-window scope for the final audit (design D10; openspec change
 * add-pi-openspec-x, task 6.5).
 *
 * The completion audit reviews the execution WINDOW's delta, not the whole
 * repository: a file that was already dirty before the window started was not
 * produced by this flow and must not be reported as a finding or rolled back.
 * The baseline and the delta belong to goal-x (`captureChangeBaseline` /
 * `computeChangeDelta`), so this module only reads them — dynamically, because
 * pi-goal-x is an optional peer — and renders the scope block injected into
 * the opsx-reviewer dispatch context.
 *
 * Non-git degradation: when there is no window delta (not a repository, or no
 * baseline was captured), the reviewer is told to read the code as needed and
 * to rely on the worker's `report_work` changed-file declarations instead.
 */
import type { GoalStorageContextLike } from "./goal-base.ts";

/** One changed path in the window, structurally goal-x's RepoChangeEntry. */
export interface ReviewScopeEntry {
  path: string;
  status: string;
  code: string;
  origPath?: string;
}

/** One repository's delta, structurally goal-x's RepoDelta. */
interface ReviewScopeRepo {
  root: string;
  entries: ReviewScopeEntry[];
  /**
   * Baseline reference the diff was taken against (the window's stash commit,
   * else HEAD). `null` for an unborn HEAD. Rollback restores from it.
   */
  base?: string | null;
  /** Which baseline the diff used; `status-only` has nothing to restore from. */
  baseKind?: "stash" | "head" | "status-only";
  error?: string;
}

/** The window delta, structurally goal-x's ChangeDelta. */
export interface ReviewWindowDelta {
  goalId: string;
  repos: ReviewScopeRepo[];
  empty: boolean;
  truncated: boolean;
  diagnostics: string[];
}

export interface ReviewScope {
  /** True when a git window delta was available. */
  fromWindow: boolean;
  /** Repo-relative changed paths, sorted and de-duplicated. */
  paths: string[];
  /** Present on the non-git degradation path. */
  degraded?: string;
}

const DEGRADED_NOTE =
  "the goal base has no git window delta (not a git repository, or no baseline was captured)";

/**
 * Build the review scope from a window delta. `undefined` is the explicit
 * non-git / no-baseline degradation; an empty window simply yields no paths.
 *
 * The scope block that once rendered here has no plugin-side injection point:
 * goal-x natively renders the change manifest into the opsx-reviewer's audit
 * context, and `OPSX_REVIEW_INSTRUCTIONS` points at that. What the plugin
 * needs the scope FOR is the tick gate's file reconciliation, which reads
 * `.paths` (deliberately uncapped).
 */
export function buildReviewScope(
  delta: ReviewWindowDelta | undefined,
): ReviewScope {
  if (!delta) {
    return { fromWindow: false, paths: [], degraded: DEGRADED_NOTE };
  }
  const paths = [
    ...new Set(
      delta.repos.flatMap((repo) =>
        repo.entries.map((entry) =>
          delta.repos.length > 1 ? `${repo.root}/${entry.path}` : entry.path,
        ),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return { fromWindow: true, paths };
}

/**
 * Opaque handle for goal-x's ChangeBaseline. This adapter only passes it from
 * `readChangeBaseline` to `computeChangeDelta`; it never inspects the shape.
 */
export interface GoalChangeBaselineHandle {
  readonly __goalChangeBaseline?: never;
}

/** The slice of goal-x's change-delta module this adapter needs. */
export interface GoalXWindowFacet {
  readChangeBaseline(
    ctx: GoalStorageContextLike,
    goalId: string,
  ): GoalChangeBaselineHandle | undefined;
  computeChangeDelta(
    baseline: GoalChangeBaselineHandle,
    options?: { timeoutMs?: number },
  ): Promise<ReviewWindowDelta>;
}

/** Injectable dynamic-import seam; tests supply a fake window facet. */
export type GoalXWindowLoader = () => Promise<GoalXWindowFacet>;

const GOAL_BASELINE_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-change-baseline.ts";
const GOAL_DELTA_MODULE: string =
  "@xzzpig/pi-goal-x/extensions/goal-change-delta.ts";

async function defaultGoalXWindowLoader(): Promise<GoalXWindowFacet> {
  const baselineModule = (await import(GOAL_BASELINE_MODULE)) as {
    readChangeBaseline: GoalXWindowFacet["readChangeBaseline"];
  };
  const deltaModule = (await import(GOAL_DELTA_MODULE)) as {
    computeChangeDelta: GoalXWindowFacet["computeChangeDelta"];
  };
  return {
    readChangeBaseline: baselineModule.readChangeBaseline,
    computeChangeDelta: deltaModule.computeChangeDelta,
  };
}

/**
 * Read the goal's window delta from goal-x. Returns `undefined` when goal-x is
 * missing, no baseline was captured, or the delta cannot be computed — the
 * caller then degrades to full read + report_work.
 */
export async function readGoalWindowDelta(
  ctx: GoalStorageContextLike,
  goalId: string,
  loader: GoalXWindowLoader = defaultGoalXWindowLoader,
): Promise<ReviewWindowDelta | undefined> {
  let facet: GoalXWindowFacet;
  try {
    facet = await loader();
  } catch {
    return undefined;
  }
  let baseline: GoalChangeBaselineHandle | undefined;
  try {
    baseline = facet.readChangeBaseline(ctx, goalId);
  } catch {
    return undefined;
  }
  if (!baseline) return undefined;
  try {
    return await facet.computeChangeDelta(baseline);
  } catch {
    return undefined;
  }
}

/**
 * Compute the review scope for one goal: the window delta when available, the
 * full-read degradation otherwise. Never throws.
 */
export async function computeReviewScope(
  ctx: GoalStorageContextLike,
  goalId: string,
  options: { loader?: GoalXWindowLoader } = {},
): Promise<ReviewScope> {
  const delta = await readGoalWindowDelta(ctx, goalId, options.loader);
  return buildReviewScope(delta);
}
