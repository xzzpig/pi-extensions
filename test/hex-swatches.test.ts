/**
 * The hex swatch: a color named in a message gets a block painted with it.
 *
 * The markdown is rendered through pi's own `Markdown` component, not checked as
 * a string: the interesting part is what pi does with the escape sequence
 * afterwards — a user message's text is wrapped in `userMessageText`, and an SGR
 * reset inside that wrapper would drop the color for the rest of the line.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
/** A user message's own color; the swatch must reopen it after its reset. */
const TEXT = "\x1b[38;5;250m";
const fakeTheme = {
  fg: (color: string, text: string) => {
    if (color.startsWith("#")) throw new Error(`Unknown theme color: ${color}`);
    return `${color === "userMessageText" ? TEXT : "\x1b[38;5;200m"}${text}\x1b[39m`;
  },
  bg: (_color: string, text: string) => `\x1b[48;5;60m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
  getColorMode: () => "truecolor",
};
(globalThis as any)[THEME_KEY] = fakeTheme;

const { getMarkdownTheme } = await import("@earendil-works/pi-coding-agent");
const { Markdown } = await import("@earendil-works/pi-tui");
const { restoreColor, swatchColor, withHexSwatches } = await import("../src/messages/hex-swatches.ts");

type Theme = Parameters<typeof restoreColor>[0];

function render(text: string, messageType: "user" | "assistant", width = 70): string[] {
  const restore = restoreColor(fakeTheme as unknown as Theme, messageType);
  const markdown = new Markdown(
    text,
    0,
    0,
    getMarkdownTheme(),
    messageType === "user" ? { color: (line: string) => fakeTheme.fg("userMessageText", line) } : undefined,
    { transform: (source: string) => withHexSwatches(source, restore, fakeTheme as unknown as Theme) },
  );
  return markdown.render(width);
}

function plain(line: string): string {
  return line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

const RED = "\x1b[38;2;255;0;0m";

test("swatchColor: every CSS hex length, alpha dropped", () => {
  assert.equal(swatchColor("#f00"), "#ff0000");
  assert.equal(swatchColor("#7f849c"), "#7f849c");
  assert.equal(swatchColor("#F008"), "#ff0000");
  assert.equal(swatchColor("#7F849C80"), "#7f849c");
  assert.equal(swatchColor("#7f849"), undefined);
});

test("swatchColor: rgb(), rgba(), hsl() and hsla(), whichever way they are written", () => {
  assert.equal(swatchColor("rgb(30,30,46)"), "#1e1e2e");
  assert.equal(swatchColor("rgb(127, 132, 156)"), "#7f849c");
  assert.equal(swatchColor("rgba(127, 132, 156, 0.5)"), "#7f849c");
  assert.equal(swatchColor("rgb(50%, 0%, 0%)"), "#800000");
  assert.equal(swatchColor("HSL(240, 100%, 50%)"), "#0000ff");
  assert.equal(swatchColor("hsl(120deg 100% 50%)"), "#00ff00");
  assert.equal(swatchColor("hsla(0, 100%, 50%, .8)"), "#ff0000");
  assert.equal(swatchColor("rgb(1,2)"), undefined);
  assert.equal(swatchColor("rgb(a, b, c)"), undefined);
});

test("color functions in prose get the swatch", () => {
  const line = render("overlay is rgb(127, 132, 156) and hsl(240, 100%, 50%)", "assistant")[0]!;
  assert.equal(plain(line).trimEnd(), "overlay is ● rgb(127, 132, 156) and ● hsl(240, 100%, 50%)");
  assert.match(line, /\x1b\[38;2;127;132;156m●/);
});

test("a word that ends in rgb is not a color function", () => {
  const line = render("myrgb(1,2,3) and rgbx(1,2,3) stay as they are", "assistant")[0]!;
  assert.equal(plain(line).includes("●"), false);
});

test("color functions inside fences and inline code are left alone", () => {
  const fenced = render(["```css", "a { color: rgb(255, 0, 0); }", "```"].join("\n"), "assistant").join("\n");
  assert.equal(fenced.includes("●"), false);
  const inline = render("`hsl(0, 100%, 50%)` is red", "assistant")[0]!;
  assert.equal(plain(inline).includes("●"), false);
});

test("a hex in an assistant reply gains the block, the value stays", () => {
  const [line] = render("The border is #7f849c, a muted grey.", "assistant");
  assert.match(line!, /\x1b\[38;2;127;132;156m●\x1b\[39m/);
  assert.equal(plain(line!).trimEnd(), "The border is ● #7f849c, a muted grey.");
});

test("a user message keeps its own text color after the swatch", () => {
  const [line] = render("Pick #ff0000 for errors", "user");
  assert.equal(plain(line!).trimEnd(), "Pick ● #ff0000 for errors");
  // pi closed the swatch with a reset; without the reopened color, "for errors"
  // would fall back to the terminal's default foreground.
  assert.match(line!, /\x1b\[38;2;255;0;0m●\x1b\[39m\x1b\[38;5;250m #ff0000 for errors/);
});

test("assistant text has no wrapper to restore", () => {
  assert.equal(restoreColor(fakeTheme as unknown as Theme, "assistant"), "");
  assert.equal(restoreColor(fakeTheme as unknown as Theme, "assistant-thinking"), "");
  assert.equal(restoreColor(fakeTheme as unknown as Theme, "user"), TEXT);
});

test("fenced code is left alone, whatever the fence character", () => {
  const fenced = render(["```css", "a { color: #ff0000; }", "```"].join("\n"), "assistant").join("\n");
  assert.equal(fenced.includes("●"), false);
  const tildes = render(["~~~", "#ff0000", "~~~"].join("\n"), "assistant").join("\n");
  assert.equal(tildes.includes("●"), false);
});

test("inline code is left alone, and the prose around it still gets swatches", () => {
  const line = render("`#ff0000` is the hex for #00ff00", "assistant")[0]!;
  assert.match(line, /\x1b\[38;2;0;255;0m●/);
  // pi's Markdown draws a codespan by its text, without the backticks.
  assert.equal(plain(line).trimEnd(), "#ff0000 is the hex for ● #00ff00");
});

test("a longer run of digits is not a color", () => {
  const line = render("issue #1234567 and #abcdefg", "assistant")[0]!;
  assert.equal(plain(line).includes("●"), false);
});

test("the dot, its space and the hash cost three cells", () => {
  const before = plain(render("color 7f849c", "assistant")[0]!).trimEnd();
  const after = plain(render("color #7f849c", "assistant")[0]!).trimEnd();
  assert.equal(after.length - before.length, 3);
});
