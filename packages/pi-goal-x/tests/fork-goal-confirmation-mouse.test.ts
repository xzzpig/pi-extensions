import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type {
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createMockExtensionContext,
  createMockTheme,
  createMockTUI,
} from "./tui-test-utils.ts";
import { showProposalDialog } from "../extensions/goal-questionnaire.ts";
import {
  showTweakProposalDialog,
  type TweakProposalDialogResult,
} from "../extensions/goal-tweak-confirmation.ts";

const ENTER = "\r",
  DOWN = "\x1b[B",
  UP = "\x1b[A",
  ESC = "\x1b";
type Dialog = Component & {
  handleInput(data: string): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  focused: boolean;
  dispose(): void;
};

function open(
  kind: "create" | "tweak" = "create",
  options: { rows?: number; width?: number; body?: string; cwd?: string } = {},
) {
  const ctx = createMockExtensionContext();
  if (options.cwd) (ctx as unknown as { cwd: string }).cwd = options.cwd;
  let dialog: Dialog | undefined;
  let tui: TUI | undefined;
  let overlay = false;
  let settled = false;
  let width = options.width ?? 90;
  let frame: string[] = [];
  const body =
    options.body ??
    Array.from({ length: 50 }, (_, index) => `body-item-${index}`).join("\n");
  (ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = ((
    factory: Parameters<ExtensionUIContext["custom"]>[0],
  ) =>
    new Promise<unknown>((resolve) => {
      tui = createMockTUI({ terminalRows: options.rows ?? 35 }).tui;
      Object.assign(tui, { hasOverlay: () => overlay });
      dialog = factory(
        tui,
        createMockTheme(),
        {} as KeybindingsManager,
        (value: unknown) => {
          settled = true;
          resolve(value);
        },
      ) as Dialog;
    })) as ExtensionUIContext["custom"];
  const result: Promise<TweakProposalDialogResult> =
    kind === "create"
      ? showProposalDialog(ctx, body, "goal", true)
      : showTweakProposalDialog(ctx, {
          defaultAuditorEnabled: true,
          presentation: (enabled) => ({
            diffText: `${body}\naudit=${enabled}`,
            fullText: `FULL\n${body}`,
          }),
        });
  assert.ok(dialog);
  assert.ok(tui);
  const component = dialog;
  const terminal = tui;
  component.focused = true;
  const render = (nextWidth = width): string[] => {
    width = nextWidth;
    frame = component.render(width);
    return frame;
  };
  const find = (needle: string, end = false) => {
    for (let y = 0; y < frame.length; y++) {
      const index = frame[y]!.indexOf(needle);
      if (index >= 0)
        return {
          x:
            visibleWidth(frame[y]!.slice(0, index)) +
            (end ? visibleWidth(needle) - 1 : 0),
          y,
        };
    }
    throw new Error(`not visible: ${needle}\n${frame.join("\n")}`);
  };
  const mouse = (
    type: TuiMouseEvent["type"],
    at: { x: number; y: number },
    extra: Partial<TuiMouseEvent> = {},
  ) =>
    component.handleMouse({
      type,
      button: "left",
      x: at.x,
      y: at.y,
      screenX: at.x,
      screenY: at.y,
      width,
      height: frame.length,
      shift: false,
      ctrl: false,
      alt: false,
      ...extra,
    });
  const click = (at: { x: number; y: number }, count = 1) => {
    const press = mouse("press", at);
    const release = mouse("release", at);
    const result = mouse("click", at, { clickCount: count });
    return { press, release, result };
  };
  const key = (value: string) => {
    component.handleInput(value);
    if (!settled) render();
  };
  const rows = (value: number) => {
    (terminal as unknown as { terminal: { rows: number } }).terminal.rows =
      value;
    render();
  };
  const setOverlay = (value: boolean, redraw = true) => {
    overlay = value;
    if (redraw) render();
  };
  render();
  return {
    component,
    terminal,
    result,
    render,
    find,
    mouse,
    click,
    key,
    rows,
    setOverlay,
    settled: () => settled,
    text: () => frame.join("\n"),
  };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return () => t.mock.timers.tick(521);
}

test("creation option click only selects; Enter opens feedback and keeps typed value", async () => {
  const h = open();
  const target = h.find("2. Continue chatting");
  const click = h.click(target);
  assert.equal(click.press, undefined);
  assert.equal(click.release, undefined);
  assert.equal(click.result?.handled, true);
  assert.equal(h.settled(), false);
  h.render();
  assert.match(h.text(), /> 2\. Continue chatting/);
  h.key(ENTER);
  assert.match(h.text(), /refinement feedback/);
  h.key("change the tests");
  h.key(ENTER);
  const outcome = await h.result;
  assert.equal(outcome.decision, "continue");
  assert.equal(outcome.feedback, "change the tests");
});

test("default highlighted decision can be confirmed only by the separate delayed control", async (t) => {
  const advance = clock(t);
  const h = open();
  const click = h.click(h.find("[Confirm selection]"));
  assert.equal(click.press, undefined);
  assert.equal(click.release, undefined);
  assert.equal(click.result?.handled, true);
  assert.equal(h.settled(), false);
  t.mock.timers.tick(519);
  assert.equal(h.settled(), false);
  advance();
  assert.equal((await h.result).decision, "confirm");
});

test("tweak rows select without deciding; separate control executes continue or cancel", async (t) => {
  const advance = clock(t);
  for (const choice of ["continue", "cancel"] as const) {
    const h = open("tweak");
    h.click(
      h.find(choice === "continue" ? "2. Continue chatting" : "3. Cancel"),
    );
    h.render();
    assert.equal(h.settled(), false);
    h.click(h.find("[Confirm selection]"));
    advance();
    if (choice === "continue") {
      h.render();
      h.key("refine");
      h.key(ENTER);
    }
    const result = await h.result;
    assert.equal(result.decision, choice);
    if (choice === "continue") assert.equal(result.feedback, "refine");
  }
});

test("a real-timer single click fires once after the host double-click window", async () => {
  const h = open();
  h.click(h.find("[Confirm selection]"));
  assert.equal(h.settled(), false);
  await new Promise((resolve) => setTimeout(resolve, 560));
  assert.equal((await h.result).decision, "confirm");
});

test("auditor and tweak view controls use direct, delayed, read-only actions", async (t) => {
  const advance = clock(t);
  const h = open("tweak");
  h.click(h.find("● Auditor enabled"));
  advance();
  h.render();
  assert.match(h.text(), /○ Auditor disabled/);
  assert.equal(h.settled(), false);
  h.click(h.find("4. View the full modified goal"));
  advance();
  h.render();
  assert.match(h.text(), /Modified goal — full effective content/);
  assert.equal(h.settled(), false);
  h.key(ESC);
  const result = await h.result;
  assert.equal(result.decision, "continue");
  assert.equal(result.auditorEnabled, false);
});

test("double click, drag, modifiers and other buttons do not execute controls", async (t) => {
  const advance = clock(t);
  const h = open();
  const at = h.find("[Confirm selection]");
  h.click(at, 1);
  h.click(at, 2);
  advance();
  assert.equal(h.settled(), false);
  h.mouse("press", at);
  h.mouse("drag", { x: at.x + 1, y: at.y });
  h.mouse("release", at);
  h.mouse("click", at);
  advance();
  assert.equal(h.settled(), false);
  for (const extra of [
    { button: "right" as const },
    { shift: true },
    { ctrl: true },
    { alt: true },
  ]) {
    h.mouse("press", at, extra);
    h.mouse("release", at, extra);
    h.mouse("click", at, extra);
    advance();
    assert.equal(h.settled(), false);
  }
  h.key(ESC);
  assert.equal((await h.result).decision, "continue");
});

test("wheel uses signed logical steps, consumes frame boundaries, and leaves outside unhandled", async () => {
  const h = open("create", { rows: 35 });
  const at = { x: 3, y: 7 };
  assert.equal(h.mouse("wheel", at, { wheelDelta: -10 })?.handled, true);
  h.render();
  const top = h.text();
  assert.equal(h.mouse("wheel", at, { wheelDelta: -3 })?.handled, true);
  h.render();
  assert.equal(h.text(), top);
  assert.equal(h.mouse("wheel", at, { wheelDelta: 3 })?.handled, true);
  h.render();
  assert.notEqual(h.text(), top);
  assert.match(h.text(), /▲ 3 more/);
  for (let i = 0; i < 3; i++)
    assert.equal(h.mouse("wheel", at, { wheelDelta: 1 })?.handled, true);
  h.render();
  assert.match(
    h.text(),
    /▲ 6 more/,
    "wheel bursts before redraw do not lose steps",
  );
  assert.equal(h.mouse("wheel", { x: -1, y: 3 }, { wheelDelta: 1 }), undefined);
  h.mouse("wheel", at, { wheelDelta: 1000 });
  h.render();
  const bottom = h.text();
  h.mouse("wheel", at, { wheelDelta: 3 });
  h.render();
  assert.equal(h.text(), bottom);
  h.key(ESC);
  await h.result;
  const short = open("create", { body: "short" });
  assert.equal(
    short.mouse("wheel", { x: 1, y: 1 }, { wheelDelta: -1 })?.handled,
    true,
  );
  short.key(ESC);
  await short.result;
});

test("visible control endpoints work, while frame, padding and hidden rows cannot click", async (t) => {
  const advance = clock(t);
  for (const end of [false, true]) {
    const h = open();
    const at = h.find("[Confirm selection] Create", end);
    for (const x of [0, 1, 89, end ? at.x + 1 : at.x - 1]) {
      h.click({ x, y: at.y });
      advance();
      assert.equal(h.settled(), false);
    }
    h.click(at);
    advance();
    assert.equal((await h.result).decision, "confirm");
  }
  const h = open("create", { rows: 10 });
  assert.doesNotMatch(h.text(), /Confirm selection/);
  const outside = { x: 4, y: h.component.render(90).length + 1 };
  assert.equal(h.click(outside).result, undefined);
  advance();
  assert.equal(h.settled(), false);
  h.key(ESC);
  await h.result;
});

test("visible decision label endpoints select, surrounding whitespace is inert", async () => {
  for (const end of [false, true]) {
    const h = open();
    const at = end
      ? h.find("keep refining", true)
      : h.find("2. Continue chatting");
    const inert = end ? { x: at.x + 1, y: at.y } : { x: at.x - 1, y: at.y };
    assert.equal(h.click(inert).result, undefined);
    assert.match(h.text(), /> 1\. Confirm/);
    assert.equal(h.click(at).result?.handled, true);
    h.render();
    assert.match(h.text(), /> 2\. Continue/);
    h.key(ESC);
    await h.result;
  }
});

test("narrow frames provide complete compact auditor and confirmation targets", async (t) => {
  const advance = clock(t);
  const h = open("create", { rows: 100, width: 14, body: "short" });
  h.click(h.find("[A+]"));
  advance();
  h.render();
  assert.ok(h.text().includes("[A-]"));
  h.click(h.find("[Create]"));
  advance();
  const result = await h.result;
  assert.equal(result.decision, "confirm");
  assert.equal(result.auditorEnabled, false);
});

test("one to three columns degrade to visible single-cell controls", async (t) => {
  const advance = clock(t);
  for (const width of [1, 2, 3]) {
    const h = open("create", { rows: 1000, width, body: "x" });
    const auditor = h.find("+");
    h.click(auditor);
    advance();
    h.render();
    assert.ok(
      h.text().includes("-"),
      `auditor did not change at width ${width}`,
    );
    h.click(h.find("+"));
    advance();
    const result = await h.result;
    assert.equal(result.decision, "confirm");
    assert.equal(result.auditorEnabled, false);
  }
});

test("wrapped decision label continuation selects the same option", async () => {
  const h = open("create", { rows: 100, width: 25, body: "short" });
  const continuation = h.find("keep refining");
  assert.equal(h.click(continuation).result?.handled, true);
  h.render();
  assert.match(h.text(), /> 2\. Continue/);
  h.key(ESC);
  await h.result;
});

test("native editor receives local coordinates and leaves press/drag selection transparent", async (t) => {
  const advance = clock(t);
  const h = open();
  h.click(h.find("2. Continue chatting"));
  h.render();
  h.click(h.find("[Confirm selection]"));
  advance();
  h.render();
  h.key("abcdef");
  const at = h.find("abcdef");
  at.x += 3;
  assert.equal(h.mouse("press", at), undefined);
  assert.equal(h.mouse("release", at), undefined);
  const clicked = h.mouse("click", at);
  assert.equal(clicked?.handled, true);
  assert.equal(clicked?.focus, true);
  h.render();
  h.key("X");
  h.key(ENTER);
  assert.equal((await h.result).feedback, "abcXdef");
});

test("a click consumed by the host link path never schedules a decision", async (t) => {
  const advance = clock(t);
  const h = open();
  const at = h.find("[Confirm selection]");
  assert.equal(h.mouse("press", at), undefined);
  assert.equal(h.mouse("release", at), undefined);
  // Pi's OSC 8 path consumes the completed click before component dispatch.
  advance();
  assert.equal(h.settled(), false);
  h.key(ESC);
  assert.equal((await h.result).decision, "continue");
});

test("press and pending actions are irreversibly invalidated by state round trips", async (t) => {
  const advance = clock(t);
  const mutations: Record<string, (h: ReturnType<typeof open>) => void> = {
    width: (h) => {
      h.render(70);
      h.render(90);
    },
    height: (h) => {
      h.rows(29);
      h.rows(35);
    },
    overlay: (h) => {
      h.setOverlay(true);
      h.setOverlay(false);
    },
    selection: (h) => {
      h.key(DOWN);
      h.key(UP);
    },
    auditor: (h) => {
      h.key("a");
      h.key("a");
    },
    scroll: (h) => {
      h.mouse("wheel", { x: 3, y: 7 }, { wheelDelta: 1 });
      h.render();
      h.mouse("wheel", { x: 3, y: 7 }, { wheelDelta: -1 });
      h.render();
    },
    view: (h) => {
      for (let i = 0; i < 3; i++) h.key(DOWN);
      h.key(ENTER);
      h.key(ENTER);
      for (let i = 0; i < 3; i++) h.key(UP);
    },
  };
  for (const phase of ["press", "pending"] as const)
    for (const [name, mutate] of Object.entries(mutations)) {
      const h = open("tweak");
      const at = h.find("[Confirm selection]");
      if (phase === "press") h.mouse("press", at);
      else h.click(at);
      mutate(h);
      if (phase === "press") {
        h.mouse("release", at);
        h.mouse("click", at);
      }
      advance();
      assert.equal(h.settled(), false, `${phase} revived after ${name}`);
      h.key(ESC);
      await h.result;
    }
});

test("overlay and dispatch resize observed without a redraw invalidate stale gestures", async (t) => {
  const advance = clock(t);
  for (const phase of ["press", "pending"] as const)
    for (const change of ["width", "overlay"] as const) {
      const h = open();
      const at = h.find("[Confirm selection]");
      if (phase === "press") h.mouse("press", at);
      else h.click(at);
      // Observe the changed host state on an event, without an intervening
      // redraw, then restore it before the release or deferred action.
      if (change === "width") h.mouse("move", at, { width: 70 });
      else {
        h.setOverlay(true, false);
        h.mouse("move", at);
        h.setOverlay(false, false);
      }
      h.render(90);
      if (phase === "press") {
        h.mouse("release", at);
        h.mouse("click", at);
      }
      advance();
      assert.equal(h.settled(), false, `${phase}: ${change}`);
      h.key(ESC);
      await h.result;
    }
});

test("browsing and unsubmitted feedback leave seeded goal and ledger bytes untouched", async (t) => {
  const advance = clock(t);
  const cwd = mkdtempSync(path.join(tmpdir(), "goal-dialog-transaction-"));
  try {
    const dir = path.join(cwd, ".pi", "goals");
    mkdirSync(dir, { recursive: true });
    const goal = path.join(dir, "active_goal_seed.md"),
      ledger = path.join(cwd, ".pi", "goal_events.jsonl");
    writeFileSync(goal, "seed goal\n");
    writeFileSync(ledger, '{"event":"seed"}\n');
    const before = [readFileSync(goal, "utf8"), readFileSync(ledger, "utf8")];
    const h = open("tweak", { cwd });
    h.mouse("wheel", { x: 3, y: 7 }, { wheelDelta: 4 });
    h.render();
    h.click(h.find("● Auditor enabled"));
    advance();
    h.render();
    h.click(h.find("4. View the full modified goal"));
    advance();
    h.render();
    h.click(h.find("2. Continue chatting"));
    h.render();
    h.click(h.find("[Confirm selection]"));
    advance();
    h.render();
    h.key("unsubmitted feedback");
    assert.equal(h.settled(), false);
    assert.deepEqual(
      [readFileSync(goal, "utf8"), readFileSync(ledger, "utf8")],
      before,
    );
    h.key(ESC);
    h.key(ESC);
    await h.result;
    assert.deepEqual(
      [readFileSync(goal, "utf8"), readFileSync(ledger, "utf8")],
      before,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hosts without overlay routing details still consume wheels and guard clicks", async (t) => {
  const advance = clock(t);
  const h = open();
  const at = h.find("[Confirm selection]");
  h.setOverlay(true);
  assert.equal(h.mouse("press", at), undefined);
  assert.equal(h.mouse("click", at), undefined);
  assert.equal(h.mouse("wheel", at, { wheelDelta: 2 })?.handled, true);
  assert.equal(h.mouse("wheel", at, { wheelDelta: 1 })?.handled, true);
  h.render();
  assert.match(h.text(), /▲ 3 more/);
  h.setOverlay(false);
  advance();
  assert.equal(h.settled(), false);
  h.key(ESC);
  await h.result;
});

test("ordinary identical redraw and pointer motion keep a pending click, while disposal cancels it", async (t) => {
  const advance = clock(t);
  const h = open();
  h.click(h.find("[Confirm selection]"));
  h.render();
  h.render();
  h.mouse("move", { x: 8, y: 2 }, { button: "none" });
  advance();
  assert.equal((await h.result).decision, "confirm");
  const stopped = open();
  stopped.click(stopped.find("[Confirm selection]"));
  stopped.component.dispose();
  advance();
  assert.equal(stopped.settled(), false);
});
