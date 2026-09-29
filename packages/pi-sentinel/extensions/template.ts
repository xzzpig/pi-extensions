import Handlebars from "handlebars";

/**
 * Handlebars adapter for rule prompts.
 *
 * Fixed engine configuration:
 * - `noEscape: true`, so command text keeps `&&`/`<` instead of becoming HTML entities;
 * - non-strict, so a missing path renders as an empty string (recorded as a
 *   diagnostic instead of failing the audit);
 * - a closed helper set (`json`, `truncate`, `now`) with no custom registration.
 */

/** Marker separating the rendered prompt from the audit scope block. */
export const SCOPE_SEPARATOR = "--- 审计范围 ---";

/** String fields longer than this are truncated before reaching a prompt. */
export const MAX_FIELD_CHARS = 8000;

/** Built-in helper names; a path with params is a helper call, not a variable. */
export const BUILT_IN_HELPERS = new Set([
  "json",
  "truncate",
  "now",
  // Handlebars built-ins that take params and must not be reported as variables.
  "if",
  "unless",
  "each",
  "with",
  "lookup",
  "log",
  "helperMissing",
  "blockHelperMissing",
]);

const environment = Handlebars.create();

/** Truncate text with an explicit marker, shared by helpers and event data. */
export function truncateText(
  text: string,
  limit: number = MAX_FIELD_CHARS,
): string {
  if (text.length <= limit) return text;
  const removed = text.length - limit;
  return `${text.slice(0, limit)}...[截断 ${removed} 字符]`;
}

function stringify(value: unknown): string {
  if (value === undefined) return "null";
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

environment.registerHelper("json", (value: unknown) => stringify(value));
environment.registerHelper("truncate", (value: unknown, limit: unknown) => {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : stringify(value);
  const parsed =
    typeof limit === "number" && Number.isFinite(limit)
      ? limit
      : MAX_FIELD_CHARS;
  return truncateText(text, parsed);
});
environment.registerHelper("now", () => {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
});

interface TemplateAstNode {
  type: string;
  path?: { original?: string; depth?: number; data?: boolean };
  original?: string;
  depth?: number;
  data?: boolean;
  params?: TemplateAstNode[];
  hash?: { pairs?: TemplateAstNode[] };
  program?: TemplateAstNode;
  inverse?: TemplateAstNode;
  body?: TemplateAstNode[];
  value?: unknown;
}

interface CollectedPath {
  path: string;
  /** False inside `each`/`with`, where identifiers resolve against the item. */
  rootContext: boolean;
}

/**
 * Data references (`@root`, `@index`, …) and `this`-relative paths are resolved
 * by Handlebars itself and never come from event data, so reporting them as
 * unresolved template variables would be a false positive.
 */
function isNonEventPath(path: string, isData: boolean): boolean {
  return (
    isData ||
    path.startsWith("@") ||
    path === "this" ||
    path.startsWith("this.")
  );
}

function collectPaths(
  node: unknown,
  rootContext: boolean,
  out: CollectedPath[],
): void {
  if (!node || typeof node !== "object") return;
  const ast = node as TemplateAstNode;

  switch (ast.type) {
    case "Program": {
      for (const child of ast.body ?? []) collectPaths(child, rootContext, out);
      return;
    }
    case "ContentStatement":
    case "CommentStatement":
    case "PartialStatement":
    case "PartialBlockStatement":
      return;
    case "MustacheStatement":
    case "SubExpression": {
      const original = ast.path?.original;
      const depth = ast.path?.depth ?? 0;
      const isData = ast.path?.data === true;
      const params = ast.params ?? [];
      const isHelperCall =
        params.length > 0 ||
        (original !== undefined && BUILT_IN_HELPERS.has(original));
      if (
        !isHelperCall &&
        original !== undefined &&
        !isNonEventPath(original, isData)
      ) {
        out.push({ path: original, rootContext: rootContext && depth === 0 });
      }
      for (const param of params) collectPaths(param, rootContext, out);
      for (const pair of ast.hash?.pairs ?? [])
        collectPaths(pair, rootContext, out);
      return;
    }
    case "BlockStatement": {
      const name = ast.path?.original;
      const params = ast.params ?? [];
      for (const param of params) collectPaths(param, rootContext, out);
      for (const pair of ast.hash?.pairs ?? [])
        collectPaths(pair, rootContext, out);
      // `each`/`with` re-root the context for their bodies; `if`/`unless` do not.
      const bodyRoot = name === "each" || name === "with" ? false : rootContext;
      collectPaths(ast.program, bodyRoot, out);
      collectPaths(ast.inverse, bodyRoot, out);
      return;
    }
    case "PathExpression": {
      const original = ast.original ?? ast.path?.original;
      const depth = ast.depth ?? ast.path?.depth ?? 0;
      const isData = ast.data === true || ast.path?.data === true;
      if (
        original !== undefined &&
        depth === 0 &&
        !isNonEventPath(original, isData)
      ) {
        out.push({ path: original, rootContext });
      }
      return;
    }
    case "Hash":
    case "HashPair": {
      if (ast.value) collectPaths(ast.value, rootContext, out);
      return;
    }
    default:
      return;
  }
}

/** Arbitrary event data object used as the template variable root. */
export type TemplateEventData = object;

/** Collect every template variable path referenced by a prompt. */
export function collectTemplatePaths(prompt: string): string[] {
  let ast: unknown;
  try {
    ast = environment.parse(prompt);
  } catch {
    return [];
  }
  const out: CollectedPath[] = [];
  collectPaths(ast, true, out);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of out) {
    if (!entry.rootContext) continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    paths.push(entry.path);
  }
  return paths;
}

function pathResolves(data: TemplateEventData, path: string): boolean {
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized
    .split(".")
    .filter((segment) => segment.length > 0);
  let current: unknown = data as Record<string, unknown>;
  for (const segment of segments) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

/** Variable paths that do not resolve against the event data. */
export function unresolvedPaths(
  prompt: string,
  eventData: TemplateEventData,
): string[] {
  return collectTemplatePaths(prompt).filter(
    (path) => !pathResolves(eventData, path),
  );
}

/** Render a prompt with the fixed engine configuration. */
export function renderTemplate(
  prompt: string,
  eventData: TemplateEventData,
): string {
  const template = environment.compile(prompt, {
    noEscape: true,
    strict: false,
  });
  return template(eventData);
}

export interface RenderedAuditMessage {
  /** Two-part user message: rendered prompt + scope block. */
  text: string;
  /** Prompt variable paths that did not resolve against the event data. */
  unresolved: string[];
}

/**
 * Build the two-part audit message: the rendered prompt followed by the fixed
 * scope block. The scope block is always appended and never templated.
 */
export function renderAuditMessage(options: {
  prompt: string;
  eventData: TemplateEventData;
  scopeText: string;
  /** Pre-rendered prompt (avoids rendering twice and keeps the cache key exact). */
  renderedPrompt?: string;
}): RenderedAuditMessage {
  const rendered =
    options.renderedPrompt ?? renderTemplate(options.prompt, options.eventData);
  const unresolved = unresolvedPaths(options.prompt, options.eventData);
  const text = `${rendered}\n\n${SCOPE_SEPARATOR}\n${options.scopeText}`;
  return { text, unresolved };
}
