/**
 * A color swatch in front of a color a message names: `#7f849c`,
 * `rgb(127, 132, 156)`, `hsla(240, 10%, 15%, .8)`. The value keeps its text and
 * gains a `●` painted in that color.
 *
 * Display only — `pi.registerMarkdownTransformer` never touches the session or
 * the model context. The swatch is a foreground glyph, not a background fill:
 * a user message's rows go through `stripBackgroundFills` (the rail and frame
 * styles repaint the fill themselves), and a fill would be painted out there.
 *
 * Fenced code blocks and inline code are left alone. A swatch inside a snippet
 * is noise, and a shell comment that happens to look like a color (`#abc`) is
 * not one. Named CSS colors are left alone as well: `red` and `tomato` are
 * ordinary words in prose.
 */

import { paint } from "../draw/paint.ts";
import type { ThemeLike } from "../theme-access.ts";

/**
 * A dot, not a block: one cell wide, present in every monospace font, and it
 * reads as a color chip beside the value instead of a hole punched in the line.
 * Nerd Font private-use glyphs are the alternative, but their real width varies
 * by font (pi-tui measures them as one cell, some draw two).
 */
export const SWATCH_GLYPH = "●";

/** Longest first, so `#7f849cff` does not match as `#7f84` plus a broken tail. */
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/;
const HEX_AT = new RegExp(HEX_RE.source, "g");

/**
 * `rgb()` / `rgba()` / `hsl()` / `hsla()`, spaces or commas between the parts.
 * No nested parentheses, and a length cap, so a `calc()` inside is not attempted
 * and a runaway match cannot swallow a paragraph.
 */
const FUNC_RE = /\b(?:rgba?|hsla?)\([^()\n]{1,48}?\)/gi;
const FUNC_AT = new RegExp(FUNC_RE.source, "gi");

/** Up to three spaces of indent, then a run of three or more of one char. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Fence {
  char: string;
  length: number;
}

function toHex(channels: [number, number, number]): string {
  return `#${channels
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as `#rrggbb`; alpha has nothing to blend against. */
function hexColor(hex: string): string | undefined {
  let body = hex.slice(1);
  if (body.length === 4) body = body.slice(0, 3);
  else if (body.length === 8) body = body.slice(0, 6);
  if (body.length === 3) body = [...body].map((cell) => cell + cell).join("");
  return body.length === 6 ? `#${body.toLowerCase()}` : undefined;
}

function rgbColor(parts: readonly string[]): string | undefined {
  const channels = parts.map((part) => {
    const value = Number.parseFloat(part);
    if (!Number.isFinite(value)) return Number.NaN;
    // `rgb(50%, 0%, 0%)` is the same as `rgb(127.5, 0, 0)`.
    return part.endsWith("%") ? (value * 255) / 100 : value;
  });
  if (channels.some(Number.isNaN)) return undefined;
  return toHex(channels as [number, number, number]);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const floor = l - chroma / 2;
  const [r, g, b] =
    h < 60 ? [chroma, second, 0] : h < 120 ? [second, chroma, 0] : h < 180 ? [0, chroma, second] : h < 240 ? [0, second, chroma] : h < 300 ? [second, 0, chroma] : [chroma, 0, second];
  return [(r + floor) * 255, (g + floor) * 255, (b + floor) * 255];
}

function hslColor(parts: readonly string[]): string | undefined {
  const numbers = parts.map((part) => Number.parseFloat(part));
  if (numbers.some((value) => !Number.isFinite(value))) return undefined;
  return toHex(hslToRgb(numbers[0]!, numbers[1]!, numbers[2]!));
}

function functionColor(value: string): string | undefined {
  const open = value.indexOf("(");
  if (open < 0) return undefined;
  const name = value.slice(0, open).trim().toLowerCase();
  const parts = value
    .slice(open + 1)
    .replace(/\)\s*$/, "")
    .split(/[\s,/]+/)
    .filter((part) => part.length > 0);
  // Alpha is the fourth part and is ignored, like the hex forms.
  if (parts.length < 3) return undefined;
  return name.startsWith("rgb") ? rgbColor(parts.slice(0, 3)) : hslColor(parts.slice(0, 3));
}

/** `#rrggbb` for any color value this transformer draws, or `undefined`. */
export function swatchColor(value: string): string | undefined {
  return value.startsWith("#") ? hexColor(value) : functionColor(value);
}

/**
 * The escape sequence that puts a user message's text color back.
 *
 * pi draws a user message's Markdown with a `defaultTextStyle` that wraps each
 * text token in `userMessageText`, so an SGR reset inside the token drops the
 * color for the rest of it. Assistant text has no default style, so nothing is
 * lost there and this returns "". Built the way pi-tui builds its own
 * `stylePrefix`: style a sentinel, keep what came before it.
 */
export function restoreColor(theme: ThemeLike, messageType: string): string {
  if (messageType !== "user") return "";
  const sentinel = "\u0000";
  let styled: string;
  try {
    styled = theme.fg("userMessageText", sentinel);
  } catch {
    return "";
  }
  const at = styled.indexOf(sentinel);
  return at > 0 ? styled.slice(0, at) : "";
}

function swatch(value: string, restore: string, theme: ThemeLike): string {
  const color = swatchColor(value);
  if (!color) return value;
  // The dot, then the enclosing style back, then the value itself unpainted:
  // it reads as the sentence it belongs to, not as the label of a chip.
  return `${paint(theme, color, SWATCH_GLYPH)}${restore} ${value}`;
}

/** The index just past a closing run of exactly `length` backticks, or -1. */
function closingTicks(line: string, from: number, length: number): number {
  let at = line.indexOf("`".repeat(length), from);
  while (at !== -1) {
    // A longer run is that run, not the end of this one.
    if (line[at + length] !== "`") return at + length;
    at = line.indexOf("`".repeat(length), at + length + 1);
  }
  return -1;
}

function swatchesInLine(line: string, restore: string, theme: ThemeLike): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const char = line[i]!;
    if (char === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const end = closingTicks(line, i + run, run);
      if (end === -1) return out + line.slice(i);
      out += line.slice(i, end);
      i = end;
      continue;
    }
    const match = colorAt(line, i);
    if (match) {
      out += swatch(match, restore, theme);
      i += match.length;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** The color value that starts exactly at `index`, or undefined. */
function colorAt(line: string, index: number): string | undefined {
  const char = line[index];
  if (char === "#") {
    HEX_AT.lastIndex = index;
    const match = HEX_AT.exec(line);
    if (match && match.index === index) return match[0];
    return undefined;
  }
  if (char !== "r" && char !== "R" && char !== "h" && char !== "H") return undefined;
  // `myrgb(…)` is not a color, and the regex's `\b` starts one cell later.
  const before = line[index - 1];
  if (before !== undefined && /[0-9A-Za-z_]/.test(before)) return undefined;
  FUNC_AT.lastIndex = index;
  const match = FUNC_AT.exec(line);
  return match && match.index === index ? match[0] : undefined;
}

function mayHaveColor(markdown: string): boolean {
  return markdown.includes("#") || /rgba?\(|hsla?\(/i.test(markdown);
}

/**
 * The markdown with a swatch in front of every color outside code. `restore`
 * is what `restoreColor` returned for this message.
 */
export function withHexSwatches(markdown: string, restore: string, theme: ThemeLike): string {
  if (!mayHaveColor(markdown)) return markdown;
  const lines = markdown.split("\n");
  let fence: Fence | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opened = FENCE_RE.exec(line);
    if (fence) {
      // The closing fence is the same character, at least as long, and nothing
      // but whitespace after it.
      if (opened && opened[1]![0] === fence.char && opened[1]!.length >= fence.length && line.slice(opened[0].length).trim() === "") {
        fence = undefined;
      }
      continue;
    }
    if (opened) {
      fence = { char: opened[1]![0]!, length: opened[1]!.length };
      continue;
    }
    if (mayHaveColor(line)) lines[i] = swatchesInLine(line, restore, theme);
  }
  return lines.join("\n");
}

/**
 * Streaming re-renders the same markdown several times a second, and a settled
 * reply re-renders on every width change. The swatches of one message do not
 * change until its text does, so the last few results are kept.
 */
const CACHE_LIMIT = 256;
const cache = new Map<string, string>();

export function withHexSwatchesCached(markdown: string, restore: string, theme: ThemeLike): string {
  if (!mayHaveColor(markdown)) return markdown;
  const key = `${theme.getColorMode?.() ?? "truecolor"}\u0000${restore}\u0000${markdown}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = withHexSwatches(markdown, restore, theme);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}
