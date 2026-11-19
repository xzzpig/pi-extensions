import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import { VStack } from "@earendil-works/pi-tui/dist/components/v-stack.js";
import { visibleWidth } from "@earendil-works/pi-tui/dist/utils.js";
import type { Component } from "@earendil-works/pi-tui";
import type {
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { showProposalDialog } from "../extensions/goal-questionnaire.ts";
import {
  createMockExtensionContext,
  createMockTheme,
} from "./tui-test-utils.ts";

async function setup(footerStart: number) {
  let input = (_data: string) => {};
  const terminal = {
    columns: 130,
    rows: 45,
    kittyProtocolActive: true,
    start(fn: typeof input) {
      input = fn;
    },
    stop() {},
    write() {},
    hideCursor() {},
    showCursor() {},
    moveBy() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
  };
  const tui = new TuiAltScreen(terminal as never, false, undefined, {
    mouse: true,
  });
  const host = tui as unknown as {
    doRender(): void;
    currentLayout: { root: unknown };
  };
  const ctx = createMockExtensionContext();
  let done = false;
  let component: (Component & { dispose?(): void }) | undefined;
  (ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = ((
    factory: Parameters<ExtensionUIContext["custom"]>[0],
  ) =>
    new Promise<unknown>((resolve) => {
      component = factory(
        tui,
        createMockTheme(),
        {} as KeybindingsManager,
        (value: unknown) => {
          done = true;
          resolve(value);
        },
      ) as Component & { dispose?(): void };
    })) as ExtensionUIContext["custom"];
  void showProposalDialog(
    ctx,
    Array.from({ length: 12 }, (_, i) => `proposal ${i}`).join("\n"),
    "goal",
    true,
  );
  assert.ok(component);
  let footerHeight = footerStart;
  const spacer = { render: () => ["spacer"], invalidate() {} };
  const footer = {
    render: () => Array.from({ length: footerHeight }, () => "footer"),
    invalidate() {},
  };
  const root = new VStack([
    { component: spacer, grow: 1, shrink: 0 },
    { component, shrink: 1 },
    { component: footer, shrink: 0 },
  ]);
  tui.setLayoutRoot(root);
  tui.start();
  const draw = async () => {
    host.doRender();
    await Promise.resolve();
    host.doRender();
    await Promise.resolve();
  };
  await draw();
  await draw();
  const point = () => {
    const lines = tui.getScreenLines();
    const y = lines.findIndex((line) => line.includes("[Confirm selection]"));
    assert.ok(y >= 0, "confirm control visible in host viewport");
    const line = lines[y]!;
    const x = visibleWidth(line.slice(0, line.indexOf("[Confirm selection]")));
    return { x, y };
  };
  const send = (code: number, p: { x: number; y: number }, suffix: "M" | "m") =>
    input(`\x1b[<${code};${p.x + 1};${p.y + 1}${suffix}`);
  return {
    tui,
    component,
    draw,
    point,
    send,
    done: () => done,
    setFooter: async (height: number) => {
      footerHeight = height;
      await draw();
    },
  };
}

test("actual fullscreen host fits dialog above ten footer rows", async () => {
  const h = await setup(10);
  try {
    assert.ok(h.point().y < 35);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("actual fullscreen SGR click confirms after an unchanged host redraw", async () => {
  const h = await setup(3);
  try {
    const point = h.point();
    h.send(0, point, "M");
    h.send(0, point, "m");
    await h.draw();
    await new Promise((resolve) => setTimeout(resolve, 560));
    assert.equal(
      h.done(),
      true,
      "fixture must dispatch a valid click and keep it on identical redraw",
    );
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const phase of ["pressed", "pending"] as const)
  test(`fullscreen position round trip invalidates ${phase} gesture`, async () => {
    const h = await setup(3);
    try {
      const p = h.point();
      h.send(0, p, "M");
      if (phase === "pending") h.send(0, p, "m");
      await h.setFooter(4);
      const moved = h.point();
      assert.notEqual(
        moved.y,
        p.y,
        "fixture must actually move the screen origin",
      );
      await h.setFooter(3);
      assert.equal(h.point().y, p.y);
      if (phase === "pressed") h.send(0, p, "m");
      await new Promise((resolve) => setTimeout(resolve, 560));
      assert.equal(
        h.done(),
        false,
        "old click must never execute after geometry returns",
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });
