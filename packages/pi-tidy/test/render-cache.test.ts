/**
 * pi's fullscreen renderer draws the whole transcript on every frame — every
 * wheel tick, every streamed token, every hover change — so whatever a box
 * computes in `render` is paid once per box in the history, per frame. These
 * tests pin the caches that keep a long session scrollable, and check that
 * each one still lets go when its input changes.
 *
 * Runs in its own process, so the options set here stay here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditToolDefinition, initTheme, Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { colorToHex, Container } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups, thinkingRuns } from "../src/tools/tool-groups.ts";

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[Symbol.for("@earendil-works/pi-coding-agent:theme")];

// Building a split diff mixes its palette once, sampling each theme colour on
// an `x`; the context colour is sampled exactly once. pi paints its own
// unified diff with that colour too, but on the diff's text, so only the
// sample counts: one per build.
let builds = 0;
const fg = theme.fg;
theme.fg = function (this: unknown, color: string, text: string) {
  if (color === "toolDiffContext" && text === "x") builds++;
  return fg.call(this, color, text);
};

const ui = { requestRender: () => {} };
const cwd = process.cwd();
const editDef = createEditToolDefinition(cwd);
const W = 150;

patchToolBoxFrames({ icons: false, groupTools: true, splitDiff: true, splitDiffMinWidth: 72, diffLines: 8 });
resetGroups();

const DIFF = Array.from({ length: 24 }, (_, i) => (i < 12 ? `-${i + 1} old ${i + 1}` : `+${i - 11} new ${i - 11}`)).join("\n");

let nextId = 0;

function edit() {
  const c = new ToolExecutionComponent(
    "edit",
    `call-${++nextId}`,
    { path: `${cwd}/src/x${nextId}.ts`, edits: [{ oldText: "a", newText: "b" }] },
    {},
    editDef as any,
    ui as any,
    cwd,
  );
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult(
    {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      durationMs: 20,
      details: { diff: DIFF, firstChangedLine: 1 },
    } as any,
    false,
  );
  return c;
}

test("edit boxes keep their split diff between frames, however many share the transcript", () => {
  const boxes = [edit(), edit(), edit()];
  const host = new Container();
  for (const box of boxes) host.addChild(box);

  const first = host.render(W);
  assert.ok(first.some((line) => line.includes("↳ diff")), "the boxes are drawn as split diffs");
  assert.equal(builds, boxes.length, "the first frame builds each box's panes once");

  // A single module-level slot passed a test with one box and missed on every
  // frame of a real session: each box evicted the one before it.
  builds = 0;
  for (let frame = 0; frame < 3; frame++) assert.deepEqual(host.render(W), first);
  assert.equal(builds, 0, "later frames rebuild nothing");

  // The cache follows its inputs: expanding one box redraws that box only.
  boxes[1]!.setExpanded(true);
  builds = 0;
  host.render(W);
  assert.equal(builds, 1, "expanding a box rebuilds just that box");

  builds = 0;
  host.render(W - 10);
  assert.equal(builds, boxes.length, "a resize rebuilds every box");
});

const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
const themes = globalThis as unknown as Record<symbol, Theme>;
const colors = Object.fromEntries(
  Object.entries(theme.colors as Theme["colors"]).map(([name, color]) => [name, colorToHex(color)]),
) as ConstructorParameters<typeof Theme>[0] & ConstructorParameters<typeof Theme>[1];

function diffTheme(appearance: "light" | "dark", overrides: Record<string, string> = {}): Theme {
  const values = {
    ...colors,
    toolSuccessBg: appearance === "light" ? "#f0f0f0" : "#202228",
    toolDiffAdded: "#288c3c",
    toolDiffRemoved: "#c83246",
    ...overrides,
  };
  return new Theme(values, values, "truecolor", { appearance });
}

for (const appearance of ["light", "dark", undefined] as const) {
  test(`split diff row and word fills follow ${appearance ?? "legacy"} appearance`, () => {
    const current = diffTheme(appearance ?? "dark");
    if (!appearance) Object.defineProperty(current, "appearance", { value: undefined });
    themes[themeKey] = current;
    try {
      const row = edit().render(W).find((line) => line.includes("▌") && line.includes("old"));
      assert.ok(row, "the real edit box renders the changed row");
      const fills = new Set([...row.matchAll(/\x1b\[48;2;([0-9;]+)m/g)].map((match) => match[1]));
      // Pin the 16% row / 32% word strengths; intentional changes update these values.
      const { addedRow, removedRow, addedWord, removedWord } = appearance === "light"
        ? { addedRow: "208;224;211", removedRow: "234;210;213", addedWord: "176;208;182", removedWord: "227;179;186" }
        : { addedRow: "18;34;24", removedRow: "43;20;25", addedWord: "24;57;33", removedWord: "75;28;36" };
      assert.deepEqual(fills, new Set([addedRow, removedRow, addedWord, removedWord]));
    } finally {
      themes[themeKey] = theme;
    }
  });
}

for (const [name, next] of [
  ["appearance", diffTheme("dark", { toolSuccessBg: "#f0f0f0" })],
  ["background", diffTheme("light", { toolSuccessBg: "#ffffff" })],
] as const) {
  test(`split diff cache follows a theme's ${name} change even when added text is unchanged`, () => {
    const first = diffTheme("light");
    themes[themeKey] = first;
    try {
      const box = edit();
      const before = box.render(W);
      const cached = () => (box as any).__splitCache.value;
      const initial = cached();
      assert.ok(initial);
      assert.deepEqual(box.render(W), before);
      assert.equal(cached(), initial, "unchanged frames reuse the panes");

      assert.equal(first.fg("toolDiffAdded", "x"), next.fg("toolDiffAdded", "x"));
      themes[themeKey] = next;
      const after = box.render(W);
      const updated = cached();
      assert.notEqual(updated, initial, "the replacement theme rebuilds the panes");
      assert.notDeepEqual(after, before, "the background changes too");
      assert.deepEqual(box.render(W), after);
      assert.equal(cached(), updated, "subsequent frames reuse the new panes");

      themes[themeKey] = first;
      assert.deepEqual(box.render(W), before, "switching back restores the original colours");
    } finally {
      themes[themeKey] = theme;
    }
  });
}

test("thinking runs come back as the same array until the text grows", () => {
  const message = {
    content: [
      { type: "thinking", thinking: "Reading the " },
      { type: "toolCall", id: "t1" },
    ],
  };
  const runs = thinkingRuns(message);
  assert.deepEqual(runs, ["Reading the"]);
  assert.equal(thinkingRuns(message), runs, "unchanged text is not joined again");

  // Streaming appends to the open block in place, then adds blocks.
  (message.content[0] as { thinking: string }).thinking += "config first";
  const grown = thinkingRuns(message);
  assert.notEqual(grown, runs);
  assert.deepEqual(grown, ["Reading the config first"]);

  message.content.push({ type: "thinking", thinking: "Then the tests." });
  assert.deepEqual(thinkingRuns(message), ["Reading the config first", "Then the tests."]);
});
