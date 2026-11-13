/**
 * `userMessageMaxWidth`: a framed user message wraps earlier and the frame hugs
 * the narrower column, so `userMessageAlign: "right"` keeps the bubble shape for
 * long prompts. Rendered through pi's own `UserMessageComponent`, at the width
 * the transcript gives it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { visibleText } from "../src/draw/frame-draw.ts";
import { patchContainerBoxes } from "../src/messages/message-frame.ts";

initTheme("dark");
const colors = { user: "toolTitle", custom: "warning" };
const options = { includeUser: true, icons: true };

/** The frame's own width, without the indent right alignment puts in front of it. */
function frameWidth(lines: string[]): number {
  return Math.max(...lines.map((line) => visibleWidth(line.trimStart())));
}

test("a fraction of the width wraps the text earlier and the frame hugs it", () => {
  const long = "word ".repeat(40).trim();
  patchContainerBoxes(colors, { ...options, userAlign: "right" });
  const full = new UserMessageComponent(long).render(100).map(visibleText);

  patchContainerBoxes(colors, { ...options, userAlign: "right", userMaxWidth: 0.5 });
  const capped = new UserMessageComponent(long).render(100).map(visibleText);

  assert.ok(frameWidth(full) > 90, `by default a long message fills the width: ${frameWidth(full)}`);
  assert.ok(frameWidth(capped) <= 53, `0.5 of 100 leaves 50 columns of text plus the border: ${frameWidth(capped)}`);
  assert.ok(capped.length > full.length, "the text wrapped into more rows");
  assert.ok(visibleWidth(capped[0]!.trimStart()) === frameWidth(capped), "the top border is the widest row");
  assert.match(capped[0]!, /^ +╭─+ \u{f007} ─╮$/u);
  // Right alignment still ends every row at the terminal's edge.
  assert.ok(capped.every((line) => visibleWidth(line) === 100));
});

test("a column cap keeps CJK text whole", () => {
  const text = "检查中文内容和边界。".repeat(6);
  patchContainerBoxes(colors, { ...options, icons: false, userMaxWidth: 30 });
  const plain = new UserMessageComponent(text).render(100).map(visibleText);

  assert.ok(frameWidth(plain) <= 33, `30 columns of text plus the border: ${frameWidth(plain)}`);
  for (const line of plain) assert.ok(visibleWidth(line) <= 100, "no row overflows the terminal");
  // Every character survived: a split double-width cell loses or garbles one.
  assert.equal(plain.join("").replace(/[│╭╮╰╯─\s]/gu, ""), text);
});

test("a cap wider than the terminal changes nothing", () => {
  const message = new UserMessageComponent("word ".repeat(30).trim());
  patchContainerBoxes(colors, options);
  const auto = message.render(60);
  for (const userMaxWidth of [100, 1]) {
    patchContainerBoxes(colors, { ...options, userMaxWidth });
    assert.deepEqual(message.render(60), auto, `userMessageMaxWidth: ${userMaxWidth}`);
  }
});

test("changing the max width invalidates an existing message's cache", () => {
  const message = new UserMessageComponent("word ".repeat(30).trim());
  patchContainerBoxes(colors, { ...options, userAlign: "right" });
  const auto = message.render(80);
  assert.deepEqual(message.render(80), auto, "unchanged frames reuse the rows");

  patchContainerBoxes(colors, { ...options, userAlign: "right", userMaxWidth: 40 });
  const capped = message.render(80);
  assert.notDeepEqual(capped, auto, "the cap reaches an already drawn message");
  assert.ok(frameWidth(capped.map(visibleText)) <= 43);
  assert.deepEqual(message.render(80), capped, "the new rows are cached in turn");

  patchContainerBoxes(colors, { ...options, userAlign: "right" });
  assert.deepEqual(message.render(80), auto, "and back to the whole width");
});
