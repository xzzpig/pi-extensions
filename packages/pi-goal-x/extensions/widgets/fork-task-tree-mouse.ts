import type {
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export type TaskMouseTarget =
  | { kind: "task"; id: string }
  | { kind: "toggle" }
  | { kind: "follow" };
export interface TaskMouseLayout {
  /** A signature of the effective goal, positions and identities, not of changing decoration. */
  signature: string;
  target(x: number, y: number): TaskMouseTarget | undefined;
  inTaskArea(x: number, y: number): boolean;
}

/** Native component mouse handling; an unconsumed press preserves text selection. */
export class TaskTreeMouse {
  private press:
    | { x: number; y: number; signature: string; target: string }
    | undefined;

  clear(): void {
    this.press = undefined;
  }

  handle(
    event: TuiMouseEvent,
    layout: TaskMouseLayout,
    act: (target: TaskMouseTarget) => void,
    scroll: (delta: number) => void,
  ): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.clear();
      if (!layout.inTaskArea(event.x, event.y)) return undefined;
      if (event.wheelDelta) scroll(event.wheelDelta);
      return { handled: true };
    }
    if (event.type === "press") {
      this.clear();
      if (event.button !== "left" || event.ctrl || event.alt || event.shift)
        return undefined;
      const target = layout.target(event.x, event.y);
      if (target)
        this.press = {
          x: event.x,
          y: event.y,
          signature: layout.signature,
          target: JSON.stringify(target),
        };
      return undefined;
    }
    if (event.type === "drag") {
      this.clear();
      return undefined;
    }
    if (event.type !== "click") return undefined;
    const press = this.press;
    this.clear();
    if (
      !press ||
      (event.button !== "left" && event.button !== "none") ||
      (event.clickCount ?? 1) !== 1 ||
      event.ctrl ||
      event.alt ||
      event.shift
    )
      return undefined;
    const target = layout.target(event.x, event.y);
    if (
      !target ||
      press.x !== event.x ||
      press.y !== event.y ||
      press.signature !== layout.signature ||
      press.target !== JSON.stringify(target)
    )
      return undefined;
    act(target);
    return { handled: true };
  }
}
