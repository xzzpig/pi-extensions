/**
 * A reply's fenced code blocks, drawn as a section: the two fence rows become rules
 * with the language and a `copy` chip on the opening one, and those rules join the
 * reply's frame (`├`/`┤`) so the block reads as part of it. The code rows are pi's
 * own, untouched, apart from a grammar for languages its highlighter cannot parse.
 *
 * Everything hangs on the Markdown component's private `renderToken`, which is what
 * makes the token's own language and text available; a pi that renames it leaves
 * replies exactly as they are and the caller says so once at load.
 */

import { highlightCode } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { visibleText } from "../draw/frame-draw.ts";
import { renderSplitDiff } from "../tools/split-diff.ts";
import type { ThemeLike } from "../theme-access.ts";

/**
 * The chip's label, and what it says once the text is on the clipboard. One cell of
 * Nerd Font reads faster than the word and costs a rule three cells less, so the
 * glyphs are the default; `icons: false` keeps the words, because a reader who turned
 * the glyphs off should not meet one here.
 */
export const COPY_CHIP = "\u{f0192}"; // md-content_copy
export const COPIED_CHIP = "\u{f00c}"; // fa-check
const COPY_WORD = "copy";
const COPIED_WORD = "copied";
/** How long the chip keeps saying `copied`. */
export const COPIED_MS = 1200;

/** The chip's two labels for this config. */
export function chipLabels(icons: boolean): { copy: string; copied: string } {
  return icons ? { copy: COPY_CHIP, copied: COPIED_CHIP } : { copy: COPY_WORD, copied: COPIED_WORD };
}

/** Every shape a chip is painted in, so a row read back from the screen can be recognised. */
export const CHIP_LABELS = [COPY_CHIP, COPIED_CHIP, COPY_WORD, COPIED_WORD] as const;
/** The glyph a fence row is drawn with once it becomes a rule. */
export const RULE_GLYPH = "─";

/**
 * Languages highlight.js has no grammar for, and the closest one it does. pi paints a
 * block it cannot parse with one flat colour, so an alias can only add: `fish` is a
 * shell (bash's grammar reads its keywords, strings and comments right), while `.env`
 * and TOML are the same `key = value` + `# comment` shape as INI.
 */
const HIGHLIGHT_ALIASES: Record<string, string> = {
  fish: "bash",
  toml: "ini",
  env: "ini",
  dotenv: "ini",
};

/** A fenced block found while the reply was rendered, in row order. */
export interface CodeBlock {
  /** The first word of the info string, or `code` for a bare fence. */
  lang: string;
  /** The token's text, tabs already expanded: exactly what the chip copies. */
  text: string;
  /** The opening rule's visible text, which is how a hit test finds it again. */
  open: string;
  /** The closing rule's visible text. */
  close: string;
  /** False when this pi cannot copy, and the rule carries no chip. */
  copyable: boolean;
  /** The label the chip is drawn with, "" when there is none. */
  chip: string;
  /** Inside a quote or a list item: its rules are indented, so they cannot join the frame. */
  nested?: boolean;
}

export interface CodeBlockOptions {
  theme: ThemeLike;
  /** `tidy.icons`: the chip is a glyph when on, a word when off. */
  icons: boolean;
  /** `tidy.codeBlocks`: off leaves every block exactly as pi drew it. */
  enabled: boolean;
  splitDiff: boolean;
  splitDiffMinWidth: number;
  canCopy: boolean;
}

/** A reply's blocks, plus the chip showing `copied` and the one under the pointer. */
export interface CodeBlocks {
  blocks: CodeBlock[];
  flash?: { index: number; until: number };
  /** The block whose chip the pointer is on, from the last move packet. */
  hover?: number;
}

/** One column range a click on a chip covers. */
export interface ChipSpan {
  row: number;
  /** Index into `CodeBlocks.blocks`. */
  index: number;
  x: number;
  end: number;
}

function infoWord(lang: string | undefined): string {
  return (lang ?? "").trim().split(/\s+/)[0] || "code";
}

/** The indent pi puts in front of every body row, taken from its own first row. */
function bodyIndent(row: string | undefined): string {
  return /^ */.exec(row ?? "")![0];
}

/**
 * `─ fish copy ───────`: one colour, one row of the width asked for. The label and
 * the chip sit together right after the joint, and the rule runs on from there.
 */
function ruleRow(cells: number, theme: ThemeLike, lang = "", chip = ""): string {
  const head = lang ? ` ${lang} ` : "";
  const chipPart = chip ? `${chip} ` : "";
  const fill = cells - visibleWidth(head) - visibleWidth(chipPart);
  // A label longer than the row keeps the rule honest: the words go, not the line.
  if (cells < 4 || fill < 2) return theme.fg("muted", RULE_GLYPH.repeat(Math.max(0, cells)));
  // The chip keeps its own escapes, so the `copied` swap is a plain string replace.
  return theme.fg("muted", head) + (chip ? chipWord(theme, chip, false) + theme.fg("muted", " ") : "") + theme.fg("muted", RULE_GLYPH.repeat(fill));
}

/** The chip's painted word: muted at rest, lit while the pointer is on it. */
export function chipWord(theme: ThemeLike, text: string, hot: boolean): string {
  if (!hot) return theme.fg("muted", text);
  const lit = theme.bold(theme.fg("accent", text));
  return theme.bg ? theme.bg("selectedBg", lit) : lit;
}

/**
 * The body with one block's chip repainted: `copied` after a copy, lit under the
 * pointer, or both. The painted word is swapped whole; the rule around it is not
 * touched.
 */
export function repaintChip(body: readonly string[], span: ChipSpan, theme: ThemeLike, text: string, hot: boolean): string[] {
  const out = [...body];
  const row = out[span.row];
  if (row === undefined) return out;
  for (const was of CHIP_LABELS) {
    const painted = chipWord(theme, was, false);
    if (!row.includes(painted)) continue;
    out[span.row] = row.replace(painted, chipWord(theme, text, hot));
    break;
  }
  return out;
}

/**
 * A row that is a block's rule: `─ fish ─── copy ─`, or a bare `────`. Both are
 * returned with the frame's corners and rails taken off, so a caller can test the
 * shape without knowing how the row is hung.
 */
export function ruleCells(line: string): string {
  return line.replace(/^[╭├╰│]\s?/, "").replace(/\s?[┤│]$/, "").trim();
}

/** A block's opening rule: a language, the chip beside it, then rule to the end. */
export function isOpenRule(line: string): boolean {
  const chip = CHIP_LABELS.join("|");
  return new RegExp(`^─+ [^\\s─]+ (?:${chip}) ─*$`).test(ruleCells(line));
}

/** A row that is nothing but rule glyphs, which is how a block closes. */
export function isRuleOnly(line: string): boolean {
  return /^─+$/.test(ruleCells(line));
}

/**
 * pi's lines for one `code` token, with both fences drawn as rules. Undefined when
 * the shape is not what this expects, or the block is off, and then the caller keeps
 * pi's rows untouched.
 *
 * `lines` is the opening fence, one row per code line, the closing fence, and
 * sometimes a blank after it, so the body's extent is known without reading rows.
 */
export function ruleCodeToken(
  lines: readonly string[],
  token: { lang?: string; text: string },
  width: number,
  options: CodeBlockOptions,
): { lines: string[]; block: CodeBlock } | undefined {
  const count = token.text.split("\n").length;
  if (!options.enabled || lines.length < count + 2 || width < 4) return undefined;
  const lang = infoWord(token.lang);
  const indent = bodyIndent(lines[1]);
  // A replaced body can be a different number of rows (a diff's panes are), so the
  // block is rebuilt around it rather than patched in place.
  const replaced = bodyRows(token.text, lang, width, visibleWidth(indent), options);
  const rows = replaced ? replaced.map((row) => `${indent}${row.trimEnd()}`) : lines.slice(1, 1 + count);
  const chip = options.canCopy ? chipLabels(options.icons).copy : "";
  const open = ruleRow(width, options.theme, lang, chip);
  const close = ruleRow(width, options.theme);
  return {
    lines: [open, ...rows, close, ...lines.slice(2 + count)],
    block: { lang, text: token.text, open: visibleText(open), close: visibleText(close), copyable: options.canCopy, chip },
  };
}

/**
 * Rows to put in place of pi's body, or undefined to keep pi's. A `diff` block goes
 * side by side when it fits, with the same renderer and switch as an edit's diff;
 * a language pi has no grammar for gets the closest one.
 */
function bodyRows(text: string, lang: string, width: number, indent: number, options: CodeBlockOptions): string[] | undefined {
  if (lang === "diff" && options.splitDiff && options.splitDiffMinWidth <= width) {
    const panes = renderSplitDiff({ diff: text, width: Math.max(1, width - indent), theme: options.theme, numbered: false });
    if (panes) return panes.lines;
  }
  const alias = HIGHLIGHT_ALIASES[lang];
  return alias ? highlightCode(text, alias) : undefined;
}

/**
 * A row's visible text with a quote's border or a list item's marker taken off, and
 * whether it had one. What is left is the rule's own glyphs and its label.
 */
function ruleText(row: string): { bare: string; prefixed: boolean } {
  const text = visibleText(row).trim();
  const prefix = /^(?:[│>]\s*|\d+[.)]\s+)/.exec(text);
  return prefix ? { bare: text.slice(prefix[0].length).trim(), prefixed: true } : { bare: text, prefixed: false };
}

/** Whether a row is this block's opening rule: the label, then rule to the end. */
function isOpening(bare: string, block: CodeBlock): boolean {
  // A row too narrow for the label drew a plain rule, and so did this pi when it cannot copy.
  if (!block.chip || !block.open.includes(block.chip)) return /^─+$/.test(bare);
  const label = `${block.lang} ${block.chip}`;
  return bare.startsWith(label) && /^─*$/.test(bare.slice(label.length).trim());
}

/**
 * The rows of a body that are a block's rules, with the chip's columns on the opening
 * one. A rule is recognised by its shape, not by the cells it was drawn with: a block
 * inside a quote or a list is drawn narrower, and a wrapped body is more rows than its
 * token, so the number of `─` in a rule says nothing about which rule it is.
 */
export function ruleRows(body: readonly string[], blocks: readonly CodeBlock[]): { rules: number[]; spans: ChipSpan[]; opens: Map<number, number> } {
  const rules: number[] = [];
  const spans: ChipSpan[] = [];
  const opens = new Map<number, number>();
  let next = 0;
  /** The block at `next` has not had its opening rule yet. */
  let pending = true;
  for (let row = 0; row < body.length && next < blocks.length; row++) {
    const block = blocks[next]!;
    const { bare, prefixed } = ruleText(body[row]!);
    // A closing rule is a bare run of them, so it matches every block's: only look
    // for one once its own block's opening row has been seen.
    if (!pending) {
      if (!/^─+$/.test(bare)) continue;
      // Only a rule with nothing in front can take the frame's corner. A quote or a
      // list marker pushes it right, and so does a nested block's tab, so both stay
      // a plain row: a joint in the middle of a frame is not a joint.
      if (!prefixed && !block.nested) rules.push(row);
      next++;
      pending = true;
      continue;
    }
    if (!isOpening(bare, block)) continue;
    if (!prefixed && !block.nested) rules.push(row);
    opens.set(row, next);
    // A row too narrow for its label drew a plain rule: there is no chip to hit.
    if (block.chip && block.open.includes(block.chip)) {
      const drawn = visibleText(body[row]!);
      const x = visibleWidth(drawn.slice(0, drawn.lastIndexOf(block.chip)));
      spans.push({ row, index: next, x, end: x + visibleWidth(block.chip) });
    }
    pending = false;
  }
  return { rules, spans, opens };
}


