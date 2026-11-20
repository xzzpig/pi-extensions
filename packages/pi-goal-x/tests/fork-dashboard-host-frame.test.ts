import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import { TuiMainScreen } from "@earendil-works/pi-tui/dist/tui-main-screen.js";
import type { TUI } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui/dist/tui.js";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui/dist/keybindings.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalCore } from "../extensions/goal-state.ts";
import { syncTerminalInputPause } from "../extensions/goal-widget.ts";
import { loadGoalSettings } from "../extensions/goal-settings.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { GoalWidgetComponent } from "../extensions/widgets/goal-widget.ts";
import { createMockTheme } from "./tui-test-utils.ts";

// Use Pi's own dynamic reference, as passed to extension widget factories.
const { createInteractiveTuiReference } = (await import(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js",
    import.meta.url,
  ).href
)) as { createInteractiveTuiReference(getTui: () => TUI): TUI };

function createFullscreenHost() {
  let input = (_data: string) => {};
  let notifyResize = () => {};
  const terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: true,
    start(onInput: typeof input, onResize: () => void) {
      input = onInput;
      notifyResize = onResize;
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
    copyOnSelect: false,
  });
  const draw = () => (tui as unknown as { doRender(): void }).doRender();
  return {
    terminal,
    tui,
    draw,
    input: (data: string) => input(data),
    resize: (columns: number, rows: number) => {
      terminal.columns = columns;
      terminal.rows = rows;
      notifyResize();
    },
  };
}

for (const kind of [
  "height",
  "width",
  "round-trip",
  "audit pending",
  "task painted overlay",
  "audit overlay press",
  "audit overlay pending",
  "audit remounted overlay pending",
] as const) {
  test(`真实 Pi 全屏缩放或浮层变化不命中旧底边框：${kind}`, async () => {
    const { terminal, tui, input, resize, draw } = createFullscreenHost();
    const originalRender = tui.requestRender;
    const regular = new TuiMainScreen(terminal as never, false);
    const remounted = kind.includes("remounted");
    let renderer: TUI = remounted ? regular : tui;
    const host = remounted
      ? createInteractiveTuiReference(() => renderer)
      : tui;
    const goal = createGoal({
      objective: "缩放夹具",
      autoContinue: false,
      sisyphus: false,
    });
    goal.taskList = {
      tasks: [{ id: "current", title: "当前任务", status: "pending" }],
      proposedAt: goal.createdAt,
      blockCompletion: false,
    };
    goal.currentTaskId = "current";
    const audit = kind.startsWith("audit");
    const pending = kind.endsWith("pending");
    let toggles = 0;
    const widget = new GoalWidgetComponent({
      tui: host,
      theme: createMockTheme(),
      getGoal: () => goal,
      getAuditorProgress: () =>
        audit
          ? { phase: "running", elapsedMs: 0, attemptId: "a", recentOutput: [] }
          : null,
      getExpanded: () => toggles % 2 === 1,
      onToggleExpanded: () => {
        toggles++;
      },
    });
    let acceptedClicks = 0;
    const handleMouse = widget.handleMouse.bind(widget);
    widget.handleMouse = (event) => {
      const result = handleMouse(event);
      if (event.type === "click" && result?.handled) acceptedClicks++;
      return result;
    };
    const label = audit ? "[展开清单]" : "[展开]";
    const point = () => {
      const frame = tui.getScreenLines();
      const y = frame.findIndex((line) => line.includes(label));
      assert.ok(y >= 0, frame.join("\n"));
      return {
        x: visibleWidth(frame[y]!.slice(0, frame[y]!.indexOf(label))),
        y,
      };
    };
    const send = (pos: { x: number; y: number }, suffix: "M" | "m") =>
      input(`\x1b[<0;${pos.x + 1};${pos.y + 1}${suffix}`);
    try {
      if (remounted) {
        regular.addChild(widget);
        widget.render(80);
        // Pi reuses its extension widget container when it swaps renderers.
        regular.clear();
        renderer = tui;
      }
      tui.setLayoutRoot(widget);
      tui.start();
      draw();
      draw();
      const old = point();
      send(old, "M");
      if (pending) {
        send(old, "m");
        assert.equal(
          acceptedClicks,
          1,
          "the native Pi click was accepted and is waiting to act",
        );
      }
      if (kind.includes("overlay")) {
        const overlay = tui.showOverlay(
          {
            render: (width) =>
              Array.from({ length: 4 }, () =>
                "OCCLUDING OVERLAY".padEnd(width),
              ),
            invalidate() {},
          },
          { row: old.y, col: 0, width: 40 },
        );
        if (kind === "task painted overlay") {
          draw();
          assert.match(tui.getScreenLines()[old.y]!, /OCCLUDING OVERLAY/);
          assert.ok(!tui.getScreenLines()[old.y]!.includes(label));
        }
        overlay.hide();
        if (kind === "task painted overlay") draw();
      } else {
        if (kind === "width") resize(8, 24);
        else resize(80, 10);
        if (kind === "round-trip" || kind === "audit pending") resize(80, 24);
      }
      if (!pending) send(old, "m");
      assert.equal(
        toggles,
        0,
        "release before the first repaint must ignore the stale target",
      );
      draw();
      if (kind === "height" || kind === "width") {
        assert.doesNotMatch(tui.getScreenLines().join("\n"), /\[展开\]/);
        resize(80, 24);
        draw();
      }
      await new Promise((resolve) => setTimeout(resolve, 570));
      assert.equal(
        toggles,
        0,
        "a changed host frame must cancel a pending audit click and not revive a press after a round trip",
      );
      draw();
      const fresh = point();
      send(fresh, "M");
      send(fresh, "m");
      if (audit) await new Promise((resolve) => setTimeout(resolve, 570));
      assert.equal(toggles, 1, "a new click after layout remains usable");
      if (remounted) {
        renderer = regular;
        widget.render(80);
        assert.equal(
          tui.requestRender,
          originalRender,
          "retired renderer is unhooked",
        );
      }
    } finally {
      widget.dispose();
      assert.equal(tui.requestRender, originalRender);
      tui.stop();
    }
  });
}

test("真实全屏宿主先处理搜索和视口键，两个底边框只提示到达 Goal-X 的绑定", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-footer-viewport-keys-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "pi-goal-x-settings.json"),
    JSON.stringify({
      keybindings: {
        dashboard: { toggleExpand: ["ctrl+shift+f", "f8"] },
        interruptAudit: ["ctrl+home", "f7"],
      },
    }),
  );
  const previousKeys = getKeybindings();
  const hostKeys = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(hostKeys);
  t.after(() => setKeybindings(previousKeys));
  const { tui, input, draw } = createFullscreenHost();
  const core = createGoalCore({
    getActiveTools: () => [],
    setActiveTools: () => {},
    appendEntry: () => {},
  } as never);
  core.state.goal = createGoal({
    objective: "宿主输入",
    autoContinue: false,
    sisyphus: false,
  });
  let auditStops = 0;
  core.abortAudit = () => {
    auditStops++;
  };
  const seen: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    ui: {
      onTerminalInput(fn: Parameters<typeof tui.addInputListener>[0]) {
        return tui.addInputListener((data) => {
          seen.push(data);
          return fn(data);
        });
      },
    },
  };
  const widget = new GoalWidgetComponent({
    tui,
    theme: createMockTheme(),
    getGoal: () => core.state.goal,
    getAuditorProgress: () => core.auditProgress,
    getExpanded: () => core.isDashboardExpanded(),
    onToggleExpanded: () => core.toggleDashboardExpanded(),
    getSettings: () => loadGoalSettings(cwd),
    isKeyboardBlocked: () => core.uiPromptDepth > 0,
  });
  core.goalWidgetComponentRef.current = widget;
  const footer = () => {
    draw();
    return tui.getScreenLines().find((line) => line.startsWith("╰"))!;
  };
  const search = "\x1b[102;6u";
  const top = "\x1b[1;5H";
  const f8 = "\x1b[19~";
  try {
    const editor = {
      render: () => [""],
      invalidate() {},
      handleInput() {},
      onSubmit() {},
      actionHandlers: new Map([["app.clear", () => {}]]),
    };
    const root = new Container();
    root.addChild(widget);
    root.addChild(editor);
    tui.setLayoutRoot(root);
    tui.setFocus(editor);
    tui.start();
    syncTerminalInputPause(core, ctx as never);
    assert.match(footer(), /\[展开\] F8/);
    assert.doesNotMatch(footer(), /Ctrl\+Shift\+F/);
    input(search);
    assert.equal(tui.hasOverlay(), true, "原生搜索仍打开");
    assert.deepEqual(seen, []);
    assert.match(footer(), /\[展开\]/);
    assert.doesNotMatch(
      footer(),
      /F8/,
      "hide shortcuts while transcript search owns focus",
    );
    input(f8);
    assert.equal(core.isDashboardExpanded(), false);
    assert.deepEqual(seen.splice(0), [f8]);
    input(search);
    assert.equal(tui.hasOverlay(), false);
    assert.equal(core.isDashboardExpanded(), false);
    input(f8);
    assert.equal(core.isDashboardExpanded(), true);
    input(f8);
    core.auditProgress = {
      phase: "running",
      attemptId: "a",
      elapsedMs: 0,
      recentOutput: [],
    };
    assert.match(footer(), /\[展开清单\] F8 · F7: stop audit/);
    assert.doesNotMatch(footer(), /Ctrl\+Home|Ctrl\+Shift\+F/);
    input(top);
    assert.equal(auditStops, 0);
    assert.deepEqual(seen, [f8, f8], "顶部跳转和搜索都不分派给扩展监听器");
    input(search);
    assert.match(footer(), /\[展开清单\]/);
    assert.doesNotMatch(footer(), /F[78]|stop audit/);
    input(f8);
    input("\x1b[18~");
    assert.equal(core.isDashboardExpanded(), false);
    assert.equal(auditStops, 0);
    input(search);
    assert.match(footer(), /\[展开清单\] F8 · F7: stop audit/);
    core.uiPromptDepth++;
    assert.doesNotMatch(footer(), /F[78]|stop audit/);
    input(f8);
    assert.equal(core.isDashboardExpanded(), false);
    core.uiPromptDepth--;
    input(f8);
    assert.match(footer(), /\[收起清单\] Esc\/F8/);
    input(f8);
    // Use Pi's resolved keys, not a baked-in list of default chords.
    hostKeys.setUserBindings({
      "tui.altScreen.search": [],
      "tui.altScreen.top": "f6",
    });
    assert.match(
      footer(),
      /\[展开清单\] Ctrl\+Shift\+F\/F8 · Ctrl\+Home\/F7: stop audit/,
    );
    input(top);
    assert.equal(auditStops, 1);
    input(search);
    assert.equal(core.isDashboardExpanded(), true);
    assert.equal(tui.hasOverlay(), false);
  } finally {
    core.terminalInputUnsubscribe?.();
    widget.dispose();
    tui.stop();
  }
});
