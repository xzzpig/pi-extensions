/**
 * pi's non-tool error rows: a retry storm must leave one framed row, not three
 * identical ones with the provider's body. See error-lines.ts.
 *
 * The theme uses real escape sequences: the hook decides by the colour a row is
 * painted in, which a tag-based fake theme would not survive.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const theme = {
  fg: (color: string, text: string) =>
    color === "error" ? `\x1b[31m${text}\x1b[39m` : color === "warning" ? `\x1b[33m${text}\x1b[39m` : `\x1b[36m${text}\x1b[39m`,
  bg: (_color: string, text: string) => `\x1b[48;5;60m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};
(globalThis as any)[THEME_KEY] = theme;

const { installErrorLines, patchErrorLines } = await import("../src/frame.ts");
const { Spacer, Text, visibleWidth } = await import("@earendil-works/pi-tui");

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "");
const BODY = 'Error: 429: {"message":"rate limit exceeded","type":"rate_limit_error"}';

/** The shape pi builds: a plain Text painted with the error colour, padded. */
const errorRow = (text = BODY) => new Text(theme.fg("error", text), 1, 1);

function chat() {
  const container: any = {
    children: [] as unknown[],
    addChild(child: unknown) {
      container.children.push(child);
    },
  };
  installErrorLines(container);
  return container;
}

test("three identical attempts leave one framed row carrying ×3", () => {
  patchErrorLines({ enabled: true });
  const container = chat();
  for (let attempt = 0; attempt < 3; attempt++) container.addChild(errorRow());

  assert.equal(container.children.length, 1, "one row, not one per attempt");
  // Wide enough that the body is one row: this is about the fold, not wrapping.
  const rows = (container.children[0] as any).render(80).map(plain);
  assert.equal(rows.length, 3, "border, one body row, border");
  assert.match(rows[0]!, /^╭─ .*error ×3 ─+╮$/, "label counts the attempts");
  assert.match(rows[1]!, /^│ Error: 429/, "the body keeps pi's text");
  assert.ok(visibleWidth(rows[1]!) === 80, "the frame owns the width");
});

test("a different error starts its own row", () => {
  patchErrorLines({ enabled: true });
  const container = chat();
  container.addChild(errorRow("Error: 500: upstream exploded"));
  container.addChild(errorRow("Error: 404: no such model"));
  assert.equal(container.children.length, 2);
});

test("a blank separator does not break the fold", () => {
  patchErrorLines({ enabled: true });
  const container = chat();
  container.addChild(errorRow());
  container.addChild(new Spacer(1));
  container.addChild(errorRow());

  assert.equal(container.children.length, 2, "the spacer stays, the repeat does not");
  const rows = (container.children[0] as any).render(60).map(plain);
  assert.match(rows[0]!, /error ×2/, "the count still reached the survivor");
});

test("any other child ends the streak", () => {
  patchErrorLines({ enabled: true });
  const container = chat();
  container.addChild(errorRow());
  container.addChild(new Text(theme.fg("text", "something else"), 1, 0));
  container.addChild(errorRow());
  assert.equal(container.children.length, 3);
});

test("warning rows are left exactly as pi drew them", () => {
  patchErrorLines({ enabled: true });
  const container = chat();
  const warning = new Text(theme.fg("warning", "Warning: Anthropic dropped 2 blocks"), 1, 1);
  container.addChild(warning);

  assert.equal(container.children[0], warning, "same object");
  assert.ok(!(warning as any).render(60).some((line: string) => line.includes("╭")), "no frame");
});

test("dedupeErrors: false leaves every row alone", () => {
  patchErrorLines({ enabled: false });
  const container = chat();
  container.addChild(errorRow());
  container.addChild(errorRow());

  assert.equal(container.children.length, 2);
  for (const child of container.children as any[]) {
    assert.ok(!child.render(60).some((line: string) => line.includes("╭")), "no frame");
  }
  patchErrorLines({ enabled: true });
});

test("a single failure is still framed, without a count", () => {
  patchErrorLines({ enabled: true });
  const container = chat();
  container.addChild(errorRow());
  const rows = (container.children[0] as any).render(40).map(plain);
  assert.match(rows[0]!, /^╭─ .*error ─+╮$/, "plain `error` label");
  assert.ok(rows.every((line: string) => visibleWidth(line) === 40));
});

test("installing twice on the same container does not double-wrap", () => {
  patchErrorLines({ enabled: true });
  const container = chat();
  installErrorLines(container);
  container.addChild(errorRow());
  const rows = (container.children[0] as any).render(50).map(plain);
  assert.equal(rows.filter((line: string) => line.startsWith("╭")).length, 1, "one top border");
});
