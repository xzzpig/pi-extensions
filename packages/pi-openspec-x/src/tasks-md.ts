/**
 * Parser for openspec's `tasks.md` tracking format (design D10; openspec
 * change add-pi-openspec-x, task 6.2).
 *
 * openspec's apply phase tracks progress by parsing checkbox lines, and its
 * instruction is explicit about the rule: a box whose content trims to `x`
 * (any case, any spacing) is done; every other box marker (`- [~]`, `- [-]`,
 * an empty `- []`, ...) reads as unfinished; a line with no checkbox is not
 * tracked at all. This parser implements exactly that rule, so the plugin's
 * mirror of the task list can never disagree with `openspec apply` about what
 * is done.
 *
 * The authoritative source is `tasks.md`: this module only reads it. Nothing
 * here writes, and no goal-x type leaks in — the goal task tree is built by
 * ./objective.ts from the parsed tasks.
 */

/** One tracked task parsed out of tasks.md. */
export interface OpsxTask {
  /** The `X.Y` identifier openspec puts in front of the description. */
  id: string;
  /** Task description with the id and any explicit verification suffix removed. */
  title: string;
  /** True when the checkbox content trims to `x` (openspec's done rule). */
  done: boolean;
  /** Nearest `## ...` group heading, when the task sits under one. */
  section?: string;
  /**
   * The verification requirement, when the description carries an explicit
   * `验证：` / `Verification:` marker. openspec asks authors to state the
   * verification inside the description; when it is marked off, the goal task
   * carries it as its verification contract so the completion gate can demand
   * evidence.
   */
  verificationContract?: string;
}

/**
 * A checkbox list item. The `(?:\s+(.*))?` tail is deliberate: a markdown
 * link (`- [text](url)`) has no whitespace after `]`, so it never parses as a
 * task.
 */
const CHECKBOX_RE = /^(\s*)[-*]\s+\[([^\]]*)\](?:\s+(.*))?\s*$/;

/** A group heading: `## 1. Setup`, `### 2.3 ...` (any depth). */
const GROUP_HEADING_RE = /^#{1,6}\s+(.*\S)\s*$/;

/** The `X.Y` id prefix openspec writes: `1.1`, `2.3.4`. */
const ID_PREFIX_RE = /^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/;

/** Explicit verification marker (Chinese or English, colon required). */
const VERIFICATION_MARKER_RE = /(?:验证|Verification|Verify)\s*[:：]/i;

function splitVerification(text: string): {
  title: string;
  verificationContract?: string;
} {
  const match = VERIFICATION_MARKER_RE.exec(text);
  if (!match || match.index === 0) return { title: text.trim() };
  const title = text
    .slice(0, match.index)
    .replace(/[；;]\s*$/, "")
    .trim();
  const contract = text.slice(match.index + match[0].length).trim();
  if (!title || !contract) return { title: text.trim() };
  return { title, verificationContract: contract };
}

function parseTaskDescription(
  description: string,
  index: number,
): { id: string; title: string; verificationContract?: string } {
  // The id prefix is extracted first: the verification marker may follow it
  // directly (`1.1 验证：...`), which would otherwise hide the id.
  const idMatch = ID_PREFIX_RE.exec(description);
  const id = idMatch ? idMatch[1]! : `task-${index + 1}`;
  const rest = (idMatch ? idMatch[2]! : description).trim();
  const { title, verificationContract } = splitVerification(rest);
  return { id, title, verificationContract };
}

/**
 * Parse tasks.md into the ordered tracked task list. Lines that are not
 * checkboxes (prose, headings, blank lines) are ignored, matching openspec's
 * "a line with no checkbox is not tracked at all" rule. Checkboxes with an
 * empty description are skipped too: they track nothing a goal task could
 * mirror.
 */
export function parseTasksMarkdown(markdown: string): OpsxTask[] {
  const tasks: OpsxTask[] = [];
  let section: string | undefined;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = GROUP_HEADING_RE.exec(raw);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }
    const checkbox = CHECKBOX_RE.exec(raw);
    if (!checkbox) continue;
    const description = (checkbox[3] ?? "").trim();
    if (!description) continue;
    const parsed = parseTaskDescription(description, tasks.length);
    tasks.push({
      id: parsed.id,
      title: parsed.title,
      done: checkbox[2]!.trim().toLowerCase() === "x",
      ...(section ? { section } : {}),
      ...(parsed.verificationContract
        ? { verificationContract: parsed.verificationContract }
        : {}),
    });
  }
  return tasks;
}

/**
 * openspec's done rule as a goal task status: the mirror uses the binary
 * pending/complete mapping only (design D10; no `start`/`skipped` middle
 * states ever cross the boundary).
 */
export function goalStatusForTask(
  task: Pick<OpsxTask, "done">,
): "pending" | "complete" {
  return task.done ? "complete" : "pending";
}

/** Ids of every parsed task, in order; used for duplicate detection. */
export function duplicateTaskIds(tasks: readonly OpsxTask[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) duplicates.add(task.id);
    else seen.add(task.id);
  }
  return [...duplicates];
}
