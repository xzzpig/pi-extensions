import {
  type BashCommand,
  collectCommands,
  type ParseProgram,
} from "./command-enumeration";
import type { TSNode } from "./parser";

/**
 * Parse a bash source string (an opaque wrapper payload) into command units,
 * sharing the caller's parser instance and recursing on nested payloads.
 *
 * The parser is stateless (`parse` is a pure function of its input), so
 * re-entrant use from inside the enumeration walk is safe: the walk is
 * synchronous and the inner parse fully completes before the walk continues.
 * An unparseable payload contributes no units (the wrapper is then flagged
 * `payloadUnresolved` by the enumerator; a payload with no commands at all is
 * marked inert instead).
 *
 * Returns `null` when the source cannot be parsed — a missing tree or one
 * containing ERROR nodes — so the caller can fail closed; a clean parse of a
 * command-less payload returns an empty array (provably inert, not unknown).
 */
function parseCommandUnits(
  source: string,
  parser: {
    parse(input: string): { rootNode: TSNode; delete(): void } | null;
  },
  parseProgram: ParseProgram,
): BashCommand[] | null {
  const tree = parser.parse(source);
  if (!tree || tree.rootNode.hasError) return null;
  try {
    return collectCommands(tree.rootNode, { parseProgram });
  } finally {
    tree.delete();
  }
}

/**
 * Build the wrapper-payload parse program for a parser instance.
 *
 * The returned `ParseProgram` re-parses an opaque wrapper payload with the
 * same parser and emits its inner commands as extra units, recursing on
 * nested payloads. The self-reference is what lets a nested payload itself
 * contain wrappers; `null` = unparseable (fail-closed), an empty array is a
 * clean parse of a command-less payload (provably inert).
 */
export function makeParseProgram(parser: {
  parse(input: string): { rootNode: TSNode; delete(): void } | null;
}): ParseProgram {
  const parseProgram: ParseProgram = (source) =>
    parseCommandUnits(source, parser, parseProgram);
  return parseProgram;
}
