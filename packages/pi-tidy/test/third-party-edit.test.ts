/**
 * An `edit` whose renderers come from another extension.
 *
 * aft's hashline mode (`edit_mode: "hashline"`) registers `edit` itself: the
 * call carries `{ patch }` rather than `{ path }`, and its renderers hand back a
 * single component instead of pi's container, so neither `args.path` nor the
 * `preview` pi's own edit renderer keeps state on exists. The box has to take
 * the file and the diff from the result, which is the same shape pi's edit
 * result uses. See https://github.com/Andy8647/pi-tidy/issues/72.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDiffString, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { chipLabels } from "../src/turns/code-blocks.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";

initTheme("dark");
const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "");
const W = 100;
const CHIP = chipLabels(true);
const CWD = process.cwd();
const PATH = `${CWD}/extension/lead-runtime.ts`;

patchToolBoxFrames({ icons: true, groupTools: false, splitDiff: true, splitDiffMinWidth: 72, diffLines: 10 });

const BEFORE = `export const label = "before";\nexport function greet(name: string) {\n  return \`hello \${name}\`;\n}\n`;
const AFTER = `export const label = "apres";\nexport function greet(name: string) {\n  added line\n  return \`hello \${name}\`;\n}\n`;
const { diff } = generateDiffString(BEFORE, AFTER);

/** aft's `edit`: renderers of its own, `{ patch }` for arguments. */
const hashlineEdit = {
  name: "edit",
  label: "edit",
  parameters: {},
  renderCall(args: any) {
    const patch = typeof args?.patch === "string" ? args.patch : "";
    return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", `${PATH}${patch.includes("MV") ? " and 1 more" : ""}`)}`, 0, 0);
  },
  renderResult() {
    return new Text(theme.fg("muted", `edited ${PATH} (+2/-2)`), 0, 0);
  },
};

function hashlineBox(details: unknown, args: unknown = { patch: `[${PATH}#1A2B]` }) {
  const box = new ToolExecutionComponent("edit", "call-hashline", args, {}, hashlineEdit as any, { requestRender() {} } as any, CWD);
  box.setArgsComplete();
  box.markExecutionStarted();
  box.updateResult({ content: [{ type: "text", text: "edited" }], isError: false, durationMs: 12, details } as any, false);
  return box;
}

test("the diff comes from the result when the call renderer has no preview", () => {
  const rows = hashlineBox({ diff, additions: 2, deletions: 1, files: [{ path: PATH, diff, additions: 2, deletions: 1 }] }).render(W);
  const text = rows.map(plain).join("\n");
  assert.match(text, /old\s+│\s+new/, `expected the two panes, got:\n${text}`);
  assert.match(text, /↳ diff \+2 -1/, "the panes keep their own summary row");
  assert.ok(!text.includes(`edited ${PATH}`), "the renderer's own summary row is replaced, not stacked under the panes");
});

test("the file the box names comes from the result when the call has no path", () => {
  const rows = hashlineBox({ diff, files: [{ path: PATH, diff }] }).render(W);
  const border = plain(rows[0] ?? "");
  assert.ok(border.includes("lead-runtime.ts"), `expected the path in the top border, got: ${border}`);
  assert.ok(border.includes(CHIP.copy), "a border that names a file carries the copy chip");
});

test("a path the result reports relative to the project is made absolute", () => {
  // aft names the patch's own path, which is relative to the checkout.
  const box = hashlineBox({ diff, files: [{ path: "extension/lead-runtime.ts", diff }] });
  box.render(W);
  const home = process.env.HOME!;
  const absolute = `${CWD}/extension/lead-runtime.ts`;
  const shown = absolute.startsWith(home) ? `~${absolute.slice(home.length)}` : absolute;
  assert.equal((box as any).__pathText, shown, "the chip copies the whole path, not the patch's relative one");
});

test("a moved file is named by its destination", () => {
  const box = hashlineBox({ diff, files: [{ path: `${CWD}/new.ts`, sourcePath: `${CWD}/old.ts`, diff }] });
  box.render(W);
  assert.match((box as any).__pathText ?? "", /new\.ts$/, "the chip copies where the content went");
});

test("no diff in the result keeps what the renderer drew", () => {
  const rows = hashlineBox({ additions: 0, deletions: 0, files: [] }).render(W);
  const text = rows.map(plain).join("\n");
  assert.match(text, /edited .*lead-runtime\.ts/, text);
});
