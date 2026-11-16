import assert from "node:assert/strict";
import { test } from "node:test";
import { withHexSwatches } from "../../src/messages/hex-swatches.ts";

const theme = {
  fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/<[^>]+>/g, "");

test("sticky color recognition keeps valid formats and excludes inline/fenced code", () => {
  const markdown = [
    "Use #f00, #abcdef, rgb(1, 2, 3), and hsl(120 100% 50%).",
    "Inline `#fff` and `rgb(0,0,0)` stay untouched.",
    "```css",
    "color: #fff; background: rgb(0, 0, 0);",
    "```",
    "Invalid #12 and #1234567 remain unchanged.",
  ].join("\n");
  const rendered = plain(withHexSwatches(markdown, "", theme as any));
  assert.equal(rendered, [
    "Use ● #f00, ● #abcdef, ● rgb(1, 2, 3), and ● hsl(120 100% 50%).",
    "Inline `#fff` and `rgb(0,0,0)` stay untouched.",
    "```css",
    "color: #fff; background: rgb(0, 0, 0);",
    "```",
    "Invalid #12 and #1234567 remain unchanged.",
  ].join("\n"));
});

test("dense invalid hash candidates remain unchanged at transcript-sized input", () => {
  const markdown = "See #not-a-color in this issue. ".repeat(2_000);
  assert.equal(withHexSwatches(markdown, "", theme as any), markdown);
});
