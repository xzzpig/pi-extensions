import type { TSNode } from "./parser";
import { resolvePlainVariableExpansion } from "./shell-variable-expansion";

/**
 * Node types whose text content is never a command argument, so no path
 * candidate is ever read from it.
 *
 * This governs the subtree's *text*, not whether it is visited at all: an
 * interpolating `heredoc_body` is also an execution host, so it is still
 * descended for the commands it runs while its prose stays out of the path
 * surface (#741). See `EXECUTION_HOST_TYPES` in `nested-execution.ts`.
 */
export const SKIP_SUBTREE_TYPES = new Set([
  "heredoc_body",
  "heredoc_end",
  "comment",
]);

/**
 * Node types that represent argument values in the AST
 * (word, concatenation, single-quoted string, double-quoted string).
 */
export const ARG_NODE_TYPES = new Set([
  "word",
  "concatenation",
  "string",
  "raw_string",
]);

/**
 * Whether an argument node's value is decided at run time: it contains a
 * command or process substitution, an arithmetic expansion, or a variable
 * expansion {@link resolvePlainVariableExpansion} cannot resolve.
 *
 * The complement of what {@link resolveNodeText} can spell exactly. A plain
 * `$HOME` / `$PWD` reference resolves, so `"$HOME/out"` is not computed; any
 * other expansion falls back to its own source text there, which names a file
 * that is not the one the shell will touch (ADR 0009's computed-path residual).
 * A single-quoted `'$x'` is a literal.
 */
export function hasComputedPart(node: TSNode): boolean {
  if (COMPUTED_NODE_TYPES.has(node.type)) return true;
  if (VARIABLE_EXPANSION_TYPES.has(node.type)) {
    return resolvePlainVariableExpansion(node) === null;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && hasComputedPart(child)) return true;
  }
  return false;
}

/** Node types whose value only running the command can produce. */
const COMPUTED_NODE_TYPES: ReadonlySet<string> = new Set([
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
]);

/** Variable references, computed unless they resolve as a plain reference. */
const VARIABLE_EXPANSION_TYPES: ReadonlySet<string> = new Set([
  "simple_expansion",
  "expansion",
]);

/**
 * Resolve the "shell value" of an argument node — the string the shell
 * would pass to the command after quote removal.
 *
 * - `word`          → `.text` (already unquoted)
 * - `raw_string`    → strip surrounding single quotes
 * - `string`        → strip surrounding double quotes, concatenate children text
 * - `concatenation` → concatenate resolved children
 * - expansions      → the resolved value of a plain `$HOME`/`$PWD` reference,
 *   else `.text` (see `shell-variable-expansion.ts`)
 * - other           → `.text` as fallback
 */
export function resolveNodeText(node: TSNode): string {
  switch (node.type) {
    case "word":
      return node.text;
    case "raw_string": {
      // Strip surrounding single quotes: 'content' → content
      const t = node.text;
      if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
        return t.slice(1, -1);
      }
      return t;
    }
    case "string": {
      // Double-quoted string: concatenate the resolved text of inner children,
      // skipping the quote-delimiter nodes (literal `"`).
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        // Skip the literal `"` delimiters
        if (child.type === '"') continue;
        result += resolveNodeText(child);
      }
      return result;
    }
    case "string_content":
      return node.text;
    case "simple_expansion":
    case "expansion":
      return resolvePlainVariableExpansion(node) ?? node.text;
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        result += resolveNodeText(child);
      }
      return result;
    }
    default:
      return node.text;
  }
}
