/**
 * The collapsed call row: only the first line of a command, plus a hint.
 *
 * Heredocs are why this exists — a 40-line `python3 - <<'PY'` body used to own
 * the whole box before the command even ran, so every following tool call was
 * pushed off screen. `ctrl+o` (pi's expand keybinding) still shows everything.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLAPSED_COMMAND_CHARS,
  collapseBashCommand,
  formatBashCallHighlighted,
} from "../src/tools/bash-highlight.ts";

// Minimal stand-in for pi's Theme: styling is identity, so assertions read as plain text.
const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as any;

test("single-line short command collapses to itself, with no hint", () => {
  const out = formatBashCallHighlighted({ command: "ls -la" }, theme, { expanded: false });
  assert.equal(out, "$ ls -la");
});

test("multi-line command keeps the first line and counts the rest", () => {
  const command = "cd ~ && python3 - <<'PY'\nimport pathlib\nprint('hi')\nPY";
  assert.deepEqual(collapseBashCommand(command), {
    head: "cd ~ && python3 - <<'PY'",
    hiddenLines: 3,
    truncatedChars: false,
  });
  const out = formatBashCallHighlighted({ command }, theme, { expanded: false, hint: "ctrl+o" });
  assert.equal(out, "$ cd ~ && python3 - <<'PY' (+3 more lines, ctrl+o)");
});

test("a long first line is cut at the char budget", () => {
  const command = `echo ${"x".repeat(COLLAPSED_COMMAND_CHARS * 2)}`;
  const { head, truncatedChars } = collapseBashCommand(command);
  assert.equal(truncatedChars, true);
  assert.equal(head.length, COLLAPSED_COMMAND_CHARS);
  assert.ok(head.endsWith("…"));

  const both = collapseBashCommand(`${command}\nsecond line`);
  assert.deepEqual([both.hiddenLines, both.truncatedChars], [1, true]);
});

test("expanded view is the whole command", () => {
  const command = "cd ~ && python3 - <<'PY'\nprint('hi')\nPY";
  assert.equal(
    formatBashCallHighlighted({ command }, theme, { expanded: true }),
    `$ ${command}`,
  );
  // No options = expanded, so existing callers keep the old behaviour.
  assert.equal(formatBashCallHighlighted({ command }, theme), `$ ${command}`);
});

test("timeout suffix survives both views", () => {
  const args = { command: "sleep 5\nsleep 6", timeout: 30 };
  assert.equal(
    formatBashCallHighlighted(args, theme, { expanded: false, hint: "ctrl+o" }),
    "$ sleep 5 (+1 more lines, ctrl+o) (timeout 30s)",
  );
  assert.equal(formatBashCallHighlighted(args, theme), "$ sleep 5\nsleep 6 (timeout 30s)");
});

test("empty command still renders a placeholder", () => {
  assert.equal(formatBashCallHighlighted({}, theme, { expanded: false }), "$ ...");
});
