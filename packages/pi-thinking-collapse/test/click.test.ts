/**
 * The click protocol, exercised against real `AssistantMessageComponent`
 * instances inside a real `Container`, with a fake layout tree and a fake
 * mouse-events api (injected through the same `Symbol.for` slot the real
 * extension reads).
 */

import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
  MOUSE_EVENTS_API_KEY,
  type MouseEventsApi,
} from "@xzzpig/pi-mouse-events/api";
import { describe, expect, test } from "vitest";

import {
  dispatchClick,
  installClickHandling,
  isButtonMotion,
  isLeftButtonPress,
  isLeftButtonRelease,
} from "../src/click.ts";
import type { LayoutBox } from "../src/ownership.ts";
import { CollapseController } from "../src/state.ts";

initTheme();

const WIDTH = 80;

type Handler = (ctx: {
  event: unknown;
  tui: unknown;
}) => { handled: true } | undefined;

function fakeMouseApi(): Handler[] {
  const handlers: Handler[] = [];
  const api = {
    version: 1,
    eventChannel: "pi-mouse-events:mouse",
    addMouseHandler: (handler: Handler) => {
      handlers.push(handler);
      return () => {};
    },
    addCopyHandler: () => () => {},
    hitTest: () => undefined,
    parseMouseEvent: () => undefined,
    isMouseSequence: () => false,
    copySlotAvailable: false,
    liveReceiver: () => undefined,
    refreshBus: () => {},
  } as MouseEventsApi;
  (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY] = api;
  return handlers;
}

function clearMouseApi(): void {
  delete (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY];
}

type Receiver = {
  currentLayout: { root: LayoutBox };
  requestRender: () => void;
  hasOverlay: () => boolean;
};

type Fixture = {
  component: AssistantMessageComponent;
  tui: Receiver;
  rendered: number;
};

/** The public slice of the real class that carries the flags under test. */
type Like = { hideThinkingBlock: boolean };

function like(component: unknown): Like {
  // SAFETY: the tests assert runtime behavior of the real class through its
  // documented state fields; only the flags under test are read.
  return component as Like;
}

function assistantMessage(text: string, thinking: string): object {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
  };
}

/**
 * A transcript of `[Spacer, message, Spacer]` inside a scroll view whose
 * content starts 5 rows down the screen. The message ends collapsed (the
 * `message_end` call). The message renders a leading spacer, then the label:
 * as content rows: `[spacer, osc-spacer, label, spacer, answer, spacer]`.
 */
function makeFixture(
  _controller: CollapseController,
  message: object,
): Fixture {
  const component = new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
  );
  component.updateContent(message as never, true);
  component.updateContent(message as never, false); // message_end: collapsed

  const chat = new Container();
  chat.addChild(new Spacer(1));
  chat.addChild(component);
  chat.addChild(new Spacer(1));

  const contentY = 5;
  const lines = chat.render(WIDTH);
  const fixture: Fixture = {
    component,
    rendered: 0,
    tui: {
      currentLayout: {
        root: {
          rect: { x: 0, y: 0, width: WIDTH + 20, height: 60 },
          children: [
            {
              rect: { x: 0, y: 0, width: WIDTH + 20, height: 60 },
              scrollView: {},
              scrollContentLines: lines,
              children: [
                {
                  component: chat,
                  rect: {
                    x: 0,
                    y: contentY,
                    width: WIDTH,
                    height: lines.length,
                  },
                },
              ],
            },
          ],
        },
      },
      requestRender: () => {
        fixture.rendered++;
        // Production: the renderer re-lays out the transcript on a toggle.
        // Recompute the fake layout's lines the same way.
        const fresh = chat.render(WIDTH);
        const scrollBox = fixture.tui.currentLayout.root.children![0]!;
        scrollBox.scrollContentLines = fresh;
        scrollBox.children![0]!.rect.height = fresh.length;
      },
      hasOverlay: () => false,
    },
  };
  return fixture;
}

let controller: CollapseController;

function press(
  fixture: Fixture,
  y: number,
  now: number,
  x = 2,
): { handled: true } | undefined {
  return dispatchClick(
    controller,
    { button: 0, x, y, release: false },
    fixture.tui,
    now,
  );
}

function release(
  fixture: Fixture,
  y: number,
  now: number,
  x = 2,
): { handled: true } | undefined {
  return dispatchClick(
    controller,
    { button: 0, x, y, release: true },
    fixture.tui,
    now,
  );
}

/** Screen y where the transcript content starts. */
function contentY(fixture: Fixture): number {
  return fixture.tui.currentLayout.root.children![0]!.children![0]!.rect.y;
}

/** Screen y of the message's label row (content row 2). */
function labelY(fixture: Fixture): number {
  return contentY(fixture) + 2;
}

/** Screen y of the message's answer row (content row 4). */
function answerY(fixture: Fixture): number {
  return contentY(fixture) + 4;
}

describe("click protocol", () => {
  let fixture: Fixture;

  test.beforeEach(() => {
    controller = new CollapseController();
    controller.install();
    fakeMouseApi();
    fixture = makeFixture(
      controller,
      assistantMessage("done", "checking files"),
    );
  });

  test("press is never consumed; release on the collapsed label toggles", () => {
    expect(like(fixture.component).hideThinkingBlock).toBe(true);

    const pressResult = press(fixture, labelY(fixture), 10_000);
    expect(pressResult).toBeUndefined();

    const releaseResult = release(fixture, labelY(fixture), 10_001);
    expect(releaseResult).toEqual({ handled: true });
    expect(like(fixture.component).hideThinkingBlock).toBe(false); // expanded
    expect(fixture.rendered).toBe(1);
  });

  test("click on the answer text does not toggle", () => {
    const result =
      press(fixture, answerY(fixture), 20_000) ??
      release(fixture, answerY(fixture), 20_001);
    expect(result).toBeUndefined();
    expect(like(fixture.component).hideThinkingBlock).toBe(true);
  });

  test("a drag cancels the click", () => {
    press(fixture, labelY(fixture), 30_000);
    dispatchClick(
      controller,
      { button: 32, x: 2, y: answerY(fixture), release: false },
      fixture.tui,
      30_001,
    );
    const result = release(fixture, labelY(fixture), 30_002);
    expect(result).toBeUndefined();
    expect(like(fixture.component).hideThinkingBlock).toBe(true);
  });

  test("release on a different cell cancels the click", () => {
    press(fixture, labelY(fixture), 40_000);
    const result = release(fixture, labelY(fixture) + 1, 40_001);
    expect(result).toBeUndefined();
    expect(like(fixture.component).hideThinkingBlock).toBe(true);
  });

  test("a second click on the same cell within 500ms is ignored", () => {
    press(fixture, labelY(fixture), 50_000);
    release(fixture, labelY(fixture), 50_001); // toggles to expanded
    expect(like(fixture.component).hideThinkingBlock).toBe(false);

    press(fixture, labelY(fixture), 50_100);
    const second = release(fixture, labelY(fixture), 50_101);
    expect(second).toBeUndefined();
    expect(like(fixture.component).hideThinkingBlock).toBe(false); // still expanded

    // After the debounce window a click on the (now expanded) thinking row
    // collapses again.
    press(fixture, labelY(fixture), 51_000);
    const third = release(fixture, labelY(fixture), 51_001);
    expect(third).toEqual({ handled: true });
    expect(like(fixture.component).hideThinkingBlock).toBe(true);
  });

  test("clicks are rejected while an overlay is open", () => {
    fixture.tui.hasOverlay = () => true;
    const result =
      press(fixture, labelY(fixture), 60_000) ??
      release(fixture, labelY(fixture), 60_001);
    expect(result).toBeUndefined();
    expect(like(fixture.component).hideThinkingBlock).toBe(true);
  });

  test("expanded: click on the thinking text collapses", () => {
    // Expand first.
    press(fixture, labelY(fixture), 70_000);
    release(fixture, labelY(fixture), 70_001);
    expect(like(fixture.component).hideThinkingBlock).toBe(false);

    // Expanded message rows are [spacer, thinking text, spacer, answer];
    // the thinking text still sits at content row 2.
    press(fixture, labelY(fixture), 71_000);
    const result = release(fixture, labelY(fixture), 71_001);
    expect(result).toEqual({ handled: true });
    expect(like(fixture.component).hideThinkingBlock).toBe(true);
  });

  test("row attribution accumulates through nested preceding siblings", () => {
    // Mirrors the real transcript tree: a welcome block and a user message
    // sit before a wrapper that contains the assistant message, so the
    // message's rows start at a non-zero global offset. The walk must report
    // rows relative to the message, not to its parent.
    const msg = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    msg.updateContent(
      assistantMessage("done", "checking files") as never,
      true,
    );
    msg.updateContent(
      assistantMessage("done", "checking files") as never,
      false,
    );

    const welcome = new Container();
    welcome.addChild(new Spacer(1));
    welcome.addChild(new Text("welcome block"));
    welcome.addChild(new Spacer(1));

    const user = new Container();
    user.addChild(new Text("user asks something"));

    const wrapper = new Container();
    wrapper.addChild(new Spacer(1));
    wrapper.addChild(msg);
    wrapper.addChild(new Spacer(1));

    const chat = new Container();
    chat.addChild(welcome);
    chat.addChild(user);
    chat.addChild(wrapper);

    const lines = chat.render(WIDTH);
    const labelRow = lines.findIndex((l) => l.includes("Thinking"));
    expect(labelRow).toBeGreaterThanOrEqual(0);

    const contentY = 5;
    const tui: Receiver = {
      currentLayout: {
        root: {
          rect: { x: 0, y: 0, width: WIDTH + 20, height: 60 },
          children: [
            {
              rect: { x: 0, y: 0, width: WIDTH + 20, height: 60 },
              scrollView: {},
              scrollContentLines: lines,
              children: [
                {
                  component: chat,
                  rect: {
                    x: 0,
                    y: contentY,
                    width: WIDTH,
                    height: lines.length,
                  },
                },
              ],
            },
          ],
        },
      },
      requestRender: () => {},
      hasOverlay: () => false,
    };

    const p = dispatchClick(
      controller,
      { button: 0, x: 2, y: contentY + labelRow, release: false },
      tui,
      80_000,
    );
    expect(p).toBeUndefined();
    const r = dispatchClick(
      controller,
      { button: 0, x: 2, y: contentY + labelRow, release: true },
      tui,
      80_001,
    );
    expect(r).toEqual({ handled: true });
    expect(like(msg).hideThinkingBlock).toBe(false);
  });
});

describe("event classification", () => {
  test("left press", () => {
    expect(isLeftButtonPress({ button: 0, x: 1, y: 1, release: false })).toBe(
      true,
    );
    expect(isLeftButtonPress({ button: 2, x: 1, y: 1, release: false })).toBe(
      false,
    );
    expect(isLeftButtonPress({ button: 0, x: 1, y: 1, release: true })).toBe(
      false,
    );
    expect(isLeftButtonPress({ button: 32, x: 1, y: 1, release: false })).toBe(
      false,
    );
    expect(isLeftButtonPress({ button: 64, x: 1, y: 1, release: false })).toBe(
      false,
    );
    expect(isLeftButtonPress(undefined)).toBe(false);
  });

  test("left release", () => {
    expect(isLeftButtonRelease({ button: 0, x: 1, y: 1, release: true })).toBe(
      true,
    );
    expect(isLeftButtonRelease({ button: 0, x: 1, y: 1, release: false })).toBe(
      false,
    );
    expect(isLeftButtonRelease({ button: 3, x: 1, y: 1, release: true })).toBe(
      false,
    );
  });

  test("motion", () => {
    expect(isButtonMotion({ button: 32, x: 1, y: 1, release: false })).toBe(
      true,
    );
    expect(isButtonMotion({ button: 0, x: 1, y: 1, release: false })).toBe(
      false,
    );
  });
});

describe("installClickHandling", () => {
  test("registers on the api and dispatches through it", () => {
    const handlers = fakeMouseApi();
    controller = new CollapseController();
    controller.install();
    const cleanup = installClickHandling(controller);
    expect(typeof cleanup).toBe("function");
    expect(handlers.length).toBe(1);

    const fixture = makeFixture(
      controller,
      assistantMessage("done", "checking files"),
    );
    handlers[0]!({
      event: { button: 0, x: 2, y: labelY(fixture), release: false },
      tui: fixture.tui,
    });
    const result = handlers[0]!({
      event: { button: 0, x: 2, y: labelY(fixture), release: true },
      tui: fixture.tui,
    });
    expect(result).toEqual({ handled: true });
    expect(like(fixture.component).hideThinkingBlock).toBe(false);
  });

  test("returns undefined when the api is not loaded", () => {
    clearMouseApi();
    const cleanup = installClickHandling(controller);
    expect(cleanup).toBeUndefined();
  });
});
