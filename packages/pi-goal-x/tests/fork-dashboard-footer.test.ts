import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layoutDashboardFooter } from "../extensions/widgets/fork-dashboard-footer.ts";

const frame = (text: string) => `\x1b[90m${text}\x1b[39m`;
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("边框、ANSI 样式、中文宽度与可见动作范围一致", () => {
  const { text, actions } = layoutDashboardFooter(64, frame, [
    { text: "\x1b[1m[展开]\x1b[22m", action: "toggle" },
    { text: "[回到当前]", action: "follow" },
    { text: "Ctrl+Shift+T", after: "toggle" },
    { text: "Esc: stop audit", right: true },
    { text: "●", right: true },
  ]);
  const line = plain(text);
  assert.match(
    line,
    /^╰─ \[展开\] Ctrl\+Shift\+T · \[回到当前\]─+ Esc: stop audit · ● ─╯$/,
  );
  assert.equal(visibleWidth(text), 64);
  for (const [label, action] of [
    ["[展开]", "toggle"],
    ["[回到当前]", "follow"],
  ] as const) {
    const start = visibleWidth(line.slice(0, line.indexOf(label)));
    assert.deepEqual(
      actions.find((hit) => hit.action === action),
      { action, start, end: start + visibleWidth(label) },
    );
  }
  const hit = (col: number) =>
    actions.find((range) => col >= range.start && col < range.end)?.action;
  for (const { action, start, end } of actions) {
    assert.equal(hit(start), action);
    assert.equal(hit(end - 1), action);
    assert.equal(hit(start - 1), undefined);
    assert.equal(hit(end), undefined);
  }
  assert.equal(
    hit(visibleWidth(line.slice(0, line.indexOf("Esc")))),
    undefined,
  );
});

test("短标签只整体替换，提示不会挤掉动作，极窄时没有透明命中", () => {
  const render = (width: number) =>
    layoutDashboardFooter(width, frame, [
      { text: "[展开清单]", shortText: "[展开]", action: "toggle" },
      { text: "Tab", after: "toggle" },
    ]);
  for (let width = 0; width <= 30; width++)
    assert.equal(visibleWidth(render(width).text), width);
  assert.deepEqual(render(10).actions, []);
  assert.equal(plain(render(10).text), "╰────────╯");
  assert.deepEqual(render(11).actions, [
    { action: "toggle", start: 3, end: 9 },
  ]);
  assert.equal(plain(render(11).text), "╰─ [展开]─╯");
  assert.equal(plain(render(15).text), "╰─ [展开清单]─╯");
});

test("先选择主要动作与回到当前，再分配辅助内容", () => {
  const render = (width: number) =>
    layoutDashboardFooter(width, frame, [
      { text: "[展开]", action: "toggle" },
      { text: "[回到当前]", action: "follow" },
      { text: "F10", after: "toggle" },
      { text: "●", right: true },
    ]);
  assert.equal(plain(render(24).text), "╰─ [展开] · [回到当前]─╯");
  assert.deepEqual(
    render(23).actions.map((hit) => hit.action),
    ["toggle"],
  );
  assert.match(plain(render(35).text), /\[展开\] F10 · \[回到当前\]─+ ● ─╯$/);
});
