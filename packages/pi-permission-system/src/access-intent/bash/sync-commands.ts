import {
  type BashCommand,
  collectCommands,
  type ParseProgram,
} from "#src/access-intent/bash/command-enumeration";
import { getWarmBashParser } from "#src/access-intent/bash/parser";

/**
 * Synchronously enumerate the command-pattern units of a bash command using the
 * warmed tree-sitter parser.
 *
 * Returns `null` when the parser has not been warmed yet (the pre-warm window),
 * so the caller can fall back to whole-string matching rather than block. Once
 * warm it mirrors the enumeration the gate performs (`BashProgram.commands()`):
 * chains split, nested substitutions/subshells descend, and wrapper payloads
 * are re-parsed with their inner commands emitted as extra units
 * (#306). Only the command-pattern surface is produced — no path slices, so no
 * `PathNormalizer` is needed.
 *
 * An unparseable command yields an empty array (the caller's decompose path
 * fails it closed via `resolveBashCommandCheck`, #452).
 */
export function parseBashCommandsSync(command: string): BashCommand[] | null {
  const parser = getWarmBashParser();
  if (!parser) return null;
  const tree = parser.parse(command);
  if (!tree) return [];
  try {
    const parseProgram: ParseProgram = (source) => {
      const payloadTree = parser.parse(source);
      if (!payloadTree) return [];
      try {
        return collectCommands(payloadTree.rootNode, { parseProgram });
      } finally {
        payloadTree.delete();
      }
    };
    return collectCommands(tree.rootNode, { parseProgram });
  } finally {
    tree.delete();
  }
}
