import { statusLabel } from "./goal-core.ts";
import { goalModelDetailedSummary } from "./goal-model-view.ts";
import type { GoalRecord } from "./goal-record.ts";

/**
 * Reconstruct UI-only usage from authoritative details, never mutate tool content.
 *
 * The anchor is the exact summary this fork generated for the record
 * (`goalModelDetailedSummary(goal)`), not a text shape: the report builders embed
 * that string verbatim as their final block. A task title, objective, or auditor
 * quotation can contain any header-like lines without displacing the real block,
 * because only the real block reproduces the whole generated summary.
 *
 * The insertion offset is the length of the generated header, rebuilt from the
 * record rather than counted in physical lines: the objective may be multi-line,
 * so line counting would split the user's own objective text. Legacy results
 * already carry their own usage rows and simply find no match here; when nothing
 * matches, the text is returned verbatim (fail-closed).
 *
 * SAFETY: this module and goal-model-view.ts import each other (the summary
 * generator lives there and imports goal-format.ts, which calls this function).
 * Both sides are hoisted function declarations used only inside function bodies,
 * so the ESM cycle is safe and never reads an uninitialized binding.
 */
export function restoreDisplayUsage(
  text: string,
  goal: GoalRecord,
  usage: string,
): string {
  const createdResult = text.startsWith("Goal confirmed and created.");
  const completionResult =
    text.startsWith("Goal audit approved.") ||
    text.startsWith("Goal audit skipped.") ||
    text.startsWith("Goal complete.");
  if (!createdResult && !completionResult) return text;
  const summary = goalModelDetailedSummary(goal);
  const header = `Goal: ${goal.objective}\nStatus: ${statusLabel(goal)}\nAuto-continue: ${goal.autoContinue ? "on" : "off"}`;
  if (!summary.startsWith(header)) return text;
  const matchAt = text.lastIndexOf(summary);
  if (matchAt < 0) return text;
  const insertAt = matchAt + header.length;
  const tail = text.slice(insertAt);
  if (tail !== "" && !tail.startsWith("\n")) return text;
  if (tail === `\n${usage}` || tail.startsWith(`\n${usage}\n`)) return text;
  return `${text.slice(0, insertAt)}\n${usage}${tail}`;
}
