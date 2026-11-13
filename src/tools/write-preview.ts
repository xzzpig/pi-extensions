/**
 * The write box's call row: `write ~/path` plus the file's first lines.
 *
 * pi's own renderer hard-codes 10 lines and has no setting, so index.ts
 * registers a call renderer with a configurable budget (`writeLines`) without
 * replacing the tool's execution. Everything below the path mirrors pi: the whole content
 * highlighted once (so multi-line constructs colour correctly), tabs expanded,
 * trailing blank lines dropped, and a `... (N more lines, M total, ctrl+o to
 * expand)` footer while collapsed.
 */

import { getLanguageFromPath, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import type { ThemeLike } from "../theme-access.ts";

export interface WriteCallOptions {
  expanded: boolean;
  /** Visual lines shown while collapsed; `0` hides the preview entirely. */
  lines: number;
}

/** Digits pi uses when it expands a tab in a tool preview. */
const TAB = "   ";

function shorten(path: string): string {
  const home = homedir();
  if (!home || !path.startsWith(home)) return path;
  return `~${path.slice(home.length)}`;
}

const cache = new Map<string, string[]>();

function highlightedLines(content: string, language: string | undefined): string[] {
  const key = `${language ?? ""}\u0000${content}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let lines: string[];
  if (language && content.trim()) {
    try {
      lines = highlightCode(content, language);
    } catch {
      lines = content.split("\n");
    }
  } else {
    lines = content.split("\n");
  }
  // Streaming rewrites this string on every delta; keep only the last few.
  if (cache.size > 8) cache.clear();
  cache.set(key, lines);
  return lines;
}

function trimTrailingEmpty(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

export function formatWriteCallText(
  args: { path?: unknown; file_path?: unknown; content?: unknown } | undefined,
  theme: ThemeLike,
  options: WriteCallOptions,
): string {
  const rawPath =
    typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
  const header = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("syntaxVariable", shorten(rawPath))}`;
  if (typeof args?.content !== "string" || args.content === "") return header;

  const language = rawPath ? getLanguageFromPath(rawPath) : undefined;
  const lines = trimTrailingEmpty(highlightedLines(args.content.replace(/\t/g, TAB), language));
  const budget = options.expanded ? lines.length : Math.max(0, options.lines);
  const shown = lines.slice(0, budget);
  const remaining = lines.length - shown.length;
  const body = shown.map((line) => (language ? line : theme.fg("toolOutput", line))).join("\n");
  let text = shown.length > 0 ? `${header}\n\n${body}` : header;
  if (remaining > 0) {
    const hint = keyHint("app.tools.expand", "to expand");
    text += `${theme.fg("toolOutput", `\n... (${remaining} more lines, ${lines.length} total,`)} ${hint}${theme.fg("toolOutput", ")")}`;
  }
  return text;
}
