/**
 * The user's own `!` / `!!` bash runs: tidy's rounded frame, marked as the
 * user's (user icon, the typed `!`, the rail color) so it never passes for the
 * agent's bash box. Everything under the command row is pi's.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
// Colors as zero-width 256-color codes: tags like `<fg:x>` would count as
// visible text, and the frame pads and cuts by visible width.
const CODES: Record<string, number> = { railCol: 201, dim: 202, bashMode: 203 };
const sgr = (color: string) => `\x1b[38;5;${CODES[color] ?? 250}m`;
(globalThis as any)[THEME_KEY] = {
  fg: (color: string, text: string) => {
    if (color.startsWith("#")) throw new Error(`Unknown theme color: ${color}`);
    return `${sgr(color)}${text}\x1b[39m`;
  },
  bg: (_color: string, text: string) => `\x1b[48;5;60m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  getColorMode: () => "truecolor",
};

const { patchBashExecutions } = await import("../src/frame.ts");
const { tidyEnabled } = await import("../src/live.ts");
const { BashExecutionComponent } = await import("@earendil-works/pi-coding-agent");

const USER_ICON = "\u{f007}";
const W = 60;
const ui = { requestRender() {} };

function plain(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function finished(command: string, output: string, exitCode = 0, excluded = false) {
  const component = new (BashExecutionComponent as any)(command, ui, excluded);
  component.appendOutput(output);
  component.setComplete(exitCode, false);
  return component;
}

test("a finished `!` run: rounded frame in the rail color, user icon, `!` prompt, pi's output", () => {
  patchBashExecutions({ enabled: true, icons: true, color: "railCol" });
  const lines: string[] = finished("ls -la", "a.txt\nb.txt").render(W);

  assert.equal(lines[0], "", "blank spacer, as pi draws one");
  assert.ok(lines[1].startsWith(`${sgr("railCol")}╭─`) && plain(lines[1]).endsWith("╮"));
  assert.ok(lines.at(-1)!.startsWith(`${sgr("railCol")}╰─`));
  const body = lines.slice(2, -1).map(plain);
  assert.ok(body[0].includes(`${USER_ICON} ! ls -la`), body[0]);
  assert.ok(!body[0].includes("$"), "not the agent's `$` prompt");
  assert.ok(body.some((row) => row.includes("a.txt")) && body.some((row) => row.includes("b.txt")));
  assert.ok(!lines.join("\n").includes(sgr("bashMode")), "pi's bashMode rules are gone");
});

test("a failed run keeps the rail color; pi's `(exit N)` row says it failed", () => {
  patchBashExecutions({ enabled: true, icons: true, color: "railCol" });
  const lines: string[] = finished("false", "", 1).render(W);
  assert.ok(lines[1].startsWith(`${sgr("railCol")}╭`));
  assert.ok(lines.map(plain).some((row) => row.includes("(exit 1)")));
});

test("`!!` stays dim and shows the `!!` that was typed", () => {
  patchBashExecutions({ enabled: true, icons: false, color: "railCol" });
  const lines: string[] = finished("pwd", "/tmp", 0, true).render(W);
  assert.ok(lines[1].startsWith(`${sgr("dim")}╭`));
  assert.ok(plain(lines[2]).startsWith("│ !! pwd"), plain(lines[2]));
});

test("a running command shows pi's spinner row inside the frame", () => {
  patchBashExecutions({ enabled: true, icons: true, color: "railCol" });
  const component = new (BashExecutionComponent as any)("sleep 5", ui, false);
  try {
    const lines: string[] = component.render(W);
    assert.ok(lines[1].startsWith(`${sgr("railCol")}╭`));
    assert.ok(lines.map(plain).some((row) => row.includes("Running...")));
  } finally {
    component.setComplete(0, true);
  }
});

test("a hex rail color paints the frame directly", () => {
  patchBashExecutions({ enabled: true, icons: true, color: "#cba6f7" });
  const lines: string[] = finished("ls", "x").render(W);
  assert.ok(lines[1].startsWith("\x1b[38;2;203;166;247m╭"), JSON.stringify(lines[1]));
});

test("frameMessages off or tidy disabled: pi's own rules", () => {
  patchBashExecutions({ enabled: false, icons: true, color: "railCol" });
  assert.ok(finished("ls", "x").render(W).some((line: string) => line.includes(`${sgr("bashMode")}─`)));

  patchBashExecutions({ enabled: true, icons: true, color: "railCol" });
  tidyEnabled.set(false);
  try {
    assert.ok(finished("ls", "x").render(W).some((line: string) => line.includes(`${sgr("bashMode")}─`)));
  } finally {
    tidyEnabled.set(true);
  }
});
