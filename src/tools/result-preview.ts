/**
 * Shrink the collapsed result preview of a tool box.
 *
 * pi's bash renderer caps the collapsed output at a hard-coded
 * `BASH_PREVIEW_LINES = 5` and exposes no setting for it, so a one-line command
 * still costs five output rows. The result component is built by pi, not by us,
 * hence the structural walk: any node carrying a numeric `maxVisualLines` option
 * is a `VisualLinePreview`, and all we need to do is lower that budget.
 *
 * Duck-typed instead of `instanceof VisualLinePreview` so this keeps working if
 * pi moves the class: we simply stop finding nodes and the built-in view stays.
 */

interface PreviewLike {
  options?: { maxVisualLines?: unknown };
  children?: unknown[];
  invalidate?: () => void;
}

/**
 * Lower the collapsed-output line budget of every preview nested in `root`.
 * Returns the number of previews it changed (0 means pi's layout moved and the
 * caller is looking at the built-in behaviour).
 */
export function shrinkResultPreview(root: unknown, maxLines: number): number {
  if (!Number.isFinite(maxLines) || maxLines < 0) return 0;
  let changed = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as PreviewLike | null | undefined;
    if (node === null || node === undefined || typeof node !== "object") continue;

    const budget = node.options?.maxVisualLines;
    if (typeof budget === "number") {
      if (budget > maxLines) {
        node.options!.maxVisualLines = maxLines;
        node.invalidate?.();
        changed++;
      }
      continue; // preview children (if any) are rendered lines, not components
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return changed;
}

/**
 * Budget to apply to a collapsed result, or `undefined` to leave pi's own alone.
 *
 * Errors are exempt: pi's read renderer already shows the full output on error
 * (`!options.expanded && !isError` bails out early), and a one-line traceback is
 * worse than no collapsing at all. Bash keeps pi's own 5-line cap here.
 */
export function collapsedResultBudget(configured: number, isError: boolean): number | undefined {
  return isError ? undefined : configured;
}
