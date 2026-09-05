/**
 * Test scaffolding.
 *
 * Receivers are `Object.create(TuiAltScreen.prototype)` with the instance
 * fields the constructor would have set — the same approach pi-starline's
 * suite uses, so the REAL prototype methods (`parseWheelEvent`,
 * `resolveOverlayLayout`, `isOverlayVisible`, `getSelectionBounds`) run
 * against hand-built state. Layouts are built from pi-tui's real components
 * through the real `renderLayoutFrame`, so box rects cannot drift from what
 * production produces.
 */

import {
  Container,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ComponentMouseEventResult,
  ComponentMouseEventWithTarget,
} from "../api.ts";
import type {
  LayoutBoxLike,
  MouseReceiver,
  OverlayStackEntryLike,
} from "../extensions/receiver.ts";

export const WIDTH = 40;
export const HEIGHT = 12;

/** A component that records mouse events and optionally handles them. */
export class MouseComponent extends Container {
  readonly events: ComponentMouseEventWithTarget[] = [];

  constructor(
    lines: readonly string[],
    private readonly handle?: (
      event: ComponentMouseEventWithTarget,
    ) => ComponentMouseEventResult | undefined,
  ) {
    super();
    if (lines.length > 0) this.addChild(new Text(lines.join("\n"), 0, 0));
  }

  onMouse(
    event: ComponentMouseEventWithTarget,
  ): ComponentMouseEventResult | undefined {
    this.events.push(event);
    // Same default as pi-tui PR #8037's test component: handle unless told to decline.
    return this.handle ? this.handle(event) : { handled: true };
  }
}

export type ReceiverStub = MouseReceiver & {
  overlayStack: OverlayStackEntryLike[];
  currentLayout: { root: LayoutBoxLike } | undefined;
  terminal: { columns: number; rows: number; write: (data: string) => void };
};

export interface ReceiverWithWrites extends ReceiverStub {
  written: string[];
}

export function makeReceiver(): ReceiverWithWrites {
  const written: string[] = [];
  const instance = Object.create(TuiAltScreen.prototype) as ReceiverWithWrites;
  instance.overlayStack = [];
  instance.currentLayout = undefined;
  instance.terminal = {
    columns: WIDTH,
    rows: HEIGHT,
    write: (data: string) => {
      written.push(data);
    },
  };
  instance.written = written;
  return instance;
}

/** A transcript plus a docked target below it, laid out for real. */
export function layoutWithTarget(
  receiver: ReceiverStub,
  target: Container,
  options?: { lines?: number; rows?: number },
): { transcript: ScrollView; transcriptText: Text } {
  const lines = options?.lines ?? 20;
  const rows = options?.rows ?? HEIGHT;
  const transcriptText = new Text(
    Array.from({ length: lines }, (_value, index) => `line ${index + 1}`).join(
      "\n",
    ),
    0,
    0,
  );
  const transcript = new ScrollView(transcriptText, {
    follow: "end",
    primary: true,
  });
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, minSize: 1 },
    { component: target, basis: "auto", minSize: 1 },
  ]);
  receiver.terminal.rows = rows;
  receiver.currentLayout = renderLayoutFrame(root, WIDTH, rows, () => {}) as {
    root: LayoutBoxLike;
  };
  return { transcript, transcriptText };
}

export function makeOverlay(
  component: unknown,
  options?: { focusOrder?: number; hidden?: boolean },
): OverlayStackEntryLike {
  return {
    component,
    hidden: options?.hidden ?? false,
    focusOrder: options?.focusOrder ?? 1,
  };
}

export function makePi(): {
  pi: ExtensionAPI;
  emitted: Array<{ channel: string; data: unknown }>;
} {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
      },
    },
  } as unknown as ExtensionAPI;
  return { pi, emitted };
}
