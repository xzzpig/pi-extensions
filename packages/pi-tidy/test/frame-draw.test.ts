import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth, drawFrame, labeledTopBorder } from "../src/draw/frame-draw.ts";

// pi-tui's truncateToWidth segments the whole string even when nothing is cut,
// which is why clipToWidth measures first. These pin the equivalence: a fitting
// row keeps its exact bytes, a wide one is clipped to the same cells.
test("a row that fits comes back byte for byte", () => {
  const rows = [
    "plain ascii row",
    "\x1b[38;2;120;180;255m✓ read\x1b[39m \x1b[2m48 lines\x1b[22m",
    "\x1b[1m󰈔 path/to/file.ts\x1b[22m — 检查边界情况",
    "\x1b]8;;https://example.com\x07link\x1b]8;;\x07 done",
    "trailing spaces   ",
  ];
  for (const row of rows) assert.equal(clipToWidth(row, visibleWidth(row) + 4), row);
  assert.equal(clipToWidth("", 0), "");
});

test("a row that is too wide is still clipped to the width", () => {
  const wide = `\x1b[38;5;245m${"检查边界情况width ".repeat(12)}\x1b[39m`;
  for (const width of [10, 40, 119]) {
    const out = clipToWidth(wide, width);
    assert.ok(visibleWidth(out) <= width, `${visibleWidth(out)} > ${width}`);
    // The theme's closing sequence stays after the ellipsis, so it is not the last char.
    assert.ok(out.includes("…"), out);
  }
  // Clipping appends a reset, so compare cells and prefix rather than bytes.
  const clipped = clipToWidth("abcdefghij", 4, "");
  assert.ok(clipped.startsWith("abcd"));
  assert.equal(visibleWidth(clipped), 4);
  assert.equal(clipToWidth("abcdefghij", 0), "");
});

test("a frame takes #rrggbb, which theme.fg itself would throw on", () => {
  const strict = {
    fg(color: string, text: string) {
      if (color.startsWith("#")) throw new Error(`Unknown theme color: ${color}`);
      return text;
    },
    bold: (text: string) => text,
  };
  const red = "\x1b[38;2;255;0;0m";
  assert.ok(drawFrame(["x"], 10, strict as any, "#ff0000")[0]!.includes(red));
  assert.ok(labeledTopBorder(20, strict as any, "#ff0000", "label").includes(red));
});
