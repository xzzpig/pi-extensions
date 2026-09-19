// ============================================================================
// Suspension Pattern-Set Filter (local fork addition)
//
// Applies per-category suspension as a one-shot filter over the PatternSet at
// the single redactMessageContent entry point (the "context" event handler),
// so the redaction engine itself (redactText / redactDeep /
// redactMessageContent) stays byte-identical to upstream. Filtering rules out
// by category is exactly equivalent to the engine skipping them: a suspended
// rule produces no matches either way, and the exclude set applies to matched
// text only (never to rules), so it is passed through untouched.
// ============================================================================

/** Structural view of the engine's PatternSet (avoids importing index.ts). */
export interface FilterablePatternSet {
  keywords: Array<{ value: string; category: string }>;
  regex: Array<{ pattern: string; flags: string; category: string }>;
  exclude: Set<string>;
}

/**
 * Drop every keyword/regex rule whose category is currently suspended.
 * Categories are compared as stored: rule categories are sanitized at
 * buildPatternSet time and SuspensionState stores sanitized names, so plain
 * set membership replicates the engine's former per-rule skip predicate.
 */
export function filterPatternSet(
  patterns: FilterablePatternSet,
  suspendedCategories: ReadonlySet<string>,
): FilterablePatternSet {
  if (suspendedCategories.size === 0) return patterns;
  return {
    keywords: patterns.keywords.filter((r) => !suspendedCategories.has(r.category)),
    regex: patterns.regex.filter((r) => !suspendedCategories.has(r.category)),
    exclude: patterns.exclude,
  };
}
