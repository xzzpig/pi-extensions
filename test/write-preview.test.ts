/**
 * The write box's preview budget (`writeLines`) and the format pi uses around
 * it. pi hard-codes ten lines; this checks ours matches pi's shape and honours
 * the setting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatWriteCallText } from "../src/tools/write-preview.ts";

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[
  Symbol.for("@earendil-works/pi-coding-agent:theme")
];

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "");

const content = Array.from({ length: 30 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
const args = { path: "/tmp/preview.ts", content };

function render(lines: number, expanded = false): string[] {
  const text = formatWriteCallText(args, theme, { expanded, lines });
  return new Text(text, 0, 0).render(80).map(plain);
}

const body = (rows: string[]) => rows.filter((row) => row.includes("const line"));

test("collapsed shows the configured number of lines plus a footer", () => {
  const rows = render(10);
  assert.equal(body(rows).length, 10);
  assert.match(rows.join("\n"), /\.\.\. \(20 more lines, 30 total, .*expand\)/);
});

test("writeLines: 0 keeps only the header until the box is expanded", () => {
  const rows = render(0);
  assert.equal(body(rows).length, 0);
  assert.match(rows[0] ?? "", /write .*preview\.ts/);
  assert.match(rows.join("\n"), /30 more lines, 30 total/);
});

test("a bigger budget shows more lines", () => {
  assert.equal(body(render(25)).length, 25);
  assert.equal(body(render(30)).length, 30);
  assert.doesNotMatch(render(30).join("\n"), /more lines/);
  assert.equal(body(render(10, true)).length, 30, "expanded ignores the budget");
});

test("every rendered row fits the width", () => {
  for (const row of render(10)) {
    assert.ok(visibleWidth(row) <= 80, `${visibleWidth(row)} > 80: ${row}`);
  }
});

test("tabs are expanded, trailing blank lines dropped", () => {
  const rows = render(5).map(plain);
  const tabbed = formatWriteCallText(
    { path: "/tmp/a.txt", content: "a\tb\n\n\n" },
    theme,
    { expanded: true, lines: 5 },
  );
  assert.ok(!tabbed.includes("\t"));
  assert.doesNotMatch(tabbed, /\n\n$/);
  assert.ok(rows.length >= 2);
});
