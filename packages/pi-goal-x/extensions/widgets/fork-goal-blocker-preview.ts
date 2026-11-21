import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  commandPaths,
  commandRoutes,
  matchCommandRoute,
  type GoalCommands,
} from "../goal-controls.ts";
import { truncateToWidth, wrapTextWithAnsi } from "./text-cache.ts";

const MAX_PREVIEW_ROWS = 4;
const MAX_PREVIEW_CHARS = 4096;

export function blockerSummary(reason: string, width: number): string {
  return truncateToWidth(
    cleanPreview(reason).replace(/\s+/g, " ").trim(),
    width,
    "…",
  );
}

/** Display-only text; the status command and transcript use the saved reason. */
function cleanPreview(reason: string): string {
  return stripVTControlCharacters(reason)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

export function blockerPreviewRows(
  reason: string,
  width: number,
  budget: number,
  commands?: GoalCommands,
): string[] {
  const maxRows = Math.min(budget, MAX_PREVIEW_ROWS);
  if (maxRows < 1 || width < 1) return [];

  const source = cleanPreview(reason);
  const heading = width > 9 ? "Blocker: " : "! ";
  const rows = wrapTextWithAnsi(
    `${heading}${source.slice(0, MAX_PREVIEW_CHARS).trim()}`,
    width,
  );
  if (rows.length <= maxRows && source.length <= MAX_PREVIEW_CHARS) return rows;

  const hint = maxRows >= 2 ? blockerStatusHint(commands, width) : undefined;
  const body = rows
    .filter((row) => row.trim())
    .slice(0, hint ? maxRows - 1 : maxRows);
  if (hint) return [...body, hint];
  const last = body.pop() ?? "";
  return [...body, `${truncateToWidth(last.trimEnd(), width - 1, "")}…`];
}

function blockerStatusHint(commands: GoalCommands | undefined, width: number) {
  const routes = commandRoutes(commands);
  for (const command of commandPaths(commands, "goal-status")) {
    const hint = `… /${command} verbose`;
    if (visibleWidth(hint) > width) continue;
    const [root, ...args] = `${command} verbose`.split(" ");
    if (!root) continue;
    const match = matchCommandRoute(routes, root, args.join(" "));
    // A longer alias can consume 'verbose' or dispatch to a mutating command.
    if (match?.id === "goal-status" && match.args === "verbose") return hint;
  }
}
