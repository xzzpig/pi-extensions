import assert from "node:assert/strict";
import test from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui/dist/tui-main-screen.js";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type {
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { showProposalDialog } from "../extensions/goal-questionnaire.ts";
import { showTweakProposalDialog } from "../extensions/goal-tweak-confirmation.ts";
import {
  createMockExtensionContext,
  createMockTheme,
} from "./tui-test-utils.ts";

for (const chatLines of [7, 43, 80])
  for (const kind of ["create", "tweak"] as const)
    test(`main-screen stable redraw with ${chatLines} chat lines and ${kind}`, async () => {
      const terminal = {
        columns: 130,
        rows: 45,
        kittyProtocolActive: true,
        start() {},
        stop() {},
        write() {},
        hideCursor() {},
        showCursor() {},
        moveBy() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
      };
      const tui = new TuiMainScreen(terminal as never);
      const host = tui as unknown as {
        doRender(): void;
        previousLines: string[];
      };
      tui.addChild({
        render: () => Array.from({ length: chatLines }, (_, i) => `chat ${i}`),
        invalidate() {},
      });
      host.doRender();
      const ctx = createMockExtensionContext();
      let component: (Component & { dispose?(): void }) | undefined;
      (ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom =
        ((factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
          new Promise<unknown>((resolve) => {
            component = factory(
              tui,
              createMockTheme(),
              {} as KeybindingsManager,
              resolve,
            ) as Component & { dispose?(): void };
          })) as ExtensionUIContext["custom"];
      const text = Array.from({ length: 35 }, (_, i) => `proposal ${i}`).join(
        "\n",
      );
      if (kind === "create") void showProposalDialog(ctx, text, "goal", true);
      else
        void showTweakProposalDialog(ctx, {
          defaultAuditorEnabled: true,
          presentation: () => ({ diffText: text, fullText: text }),
        });
      assert.ok(component);
      tui.addChild(component);
      const heights: number[] = [];
      for (let i = 0; i < 8; i++) {
        host.doRender();
        heights.push(host.previousLines.length);
        assert.ok(
          host.previousLines
            .slice(-45)
            .some((row) => row.includes("[Confirm selection]")),
          `action lost in redraw ${i}`,
        );
      }
      assert.equal(new Set(heights).size, 1, `unstable host frames ${heights}`);
      if (chatLines === 7) assert.ok(heights[0]! <= 45);
      component.dispose?.();
      tui.stop();
    });

test("growing from two to three or four columns never destroys double-cell proposal characters", () => {
  const ctx = createMockExtensionContext();
  let component: (Component & { dispose?(): void }) | undefined;
  (ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = ((
    factory: Parameters<ExtensionUIContext["custom"]>[0],
  ) =>
    new Promise<unknown>((resolve) => {
      const tui = {
        getShowHardwareCursor: () => false,
        setShowHardwareCursor() {},
        requestRender() {},
      } as unknown as TUI;
      component = factory(
        tui,
        createMockTheme(),
        {} as KeybindingsManager,
        resolve,
      ) as Component & { dispose?(): void };
    })) as ExtensionUIContext["custom"];
  void showTweakProposalDialog(ctx, {
    defaultAuditorEnabled: true,
    presentation: () => ({ diffText: "甲乙中文", fullText: "甲乙中文" }),
  });
  assert.ok(component);
  for (const width of [2, 3, 4]) {
    const rendered = component.render(width).join("\n");
    for (const char of "甲乙中文")
      assert.ok(rendered.includes(char), `${char} missing at width ${width}`);
  }
  component.dispose?.();
});
