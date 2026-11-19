import type {
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export type ConfirmationTarget =
  | { kind: "decision"; index: number }
  | { kind: "confirm" }
  | { kind: "auditor" }
  | { kind: "view" };

export interface ConfirmationHit {
  y: number;
  start: number;
  end: number;
  target: ConfirmationTarget;
}

export interface ConfirmationMouseLayout {
  width: number;
  height: number;
  hits: readonly ConfirmationHit[];
}

interface MouseActions {
  select(index: number): void;
  activate(target: ConfirmationTarget): void;
  scroll(delta: number): void;
  isCurrent(): boolean;
}

function inside(
  event: TuiMouseEvent,
  layout: ConfirmationMouseLayout,
): boolean {
  return (
    event.x >= 0 &&
    event.x < layout.width &&
    event.y >= 0 &&
    event.y < layout.height
  );
}

function plainPrimary(event: TuiMouseEvent): boolean {
  return (
    (event.button === "left" || event.button === "none") &&
    !event.shift &&
    !event.ctrl &&
    !event.alt
  );
}

/** Native press remains transparent to Pi selection; only a complete click
 * acts. Potentially executing actions wait out the host double-click window. */
export class ConfirmationMouse {
  private signature?: string;
  private generation = 0;
  private press?: { x: number; y: number; target: string; generation: number };
  private pending?: ReturnType<typeof setTimeout>;

  observe(signature: string): void {
    if (this.signature !== signature) this.invalidate();
    this.signature = signature;
  }

  invalidate(): void {
    this.generation++;
    this.press = undefined;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
  }

  dispose(): void {
    this.invalidate();
    this.signature = undefined;
  }

  /** Keep native editor cursor clicks tied to a press in the same frame state. */
  allowEditorEvent(event: TuiMouseEvent): boolean {
    const target = "editor";
    if (event.type === "press") {
      this.invalidate();
      if (event.button === "left")
        this.press = {
          x: event.x,
          y: event.y,
          target,
          generation: this.generation,
        };
    } else if (event.type === "click") {
      const press = this.press;
      this.press = undefined;
      return (
        !!press &&
        press.target === target &&
        press.generation === this.generation &&
        press.x === event.x &&
        press.y === event.y
      );
    } else if (
      event.type === "drag" ||
      event.type === "move" ||
      (event.type === "release" &&
        this.press &&
        (this.press.x !== event.x || this.press.y !== event.y))
    ) {
      this.invalidate();
    }
    return true;
  }

  handle(
    event: TuiMouseEvent,
    layout: ConfirmationMouseLayout,
    actions: MouseActions,
  ): TuiMouseEventResult | undefined {
    switch (event.type) {
      case "wheel":
        this.invalidate();
        if (!inside(event, layout)) return undefined;
        if (event.wheelDelta) actions.scroll(event.wheelDelta);
        return { handled: true };
      case "press":
        this.beginPress(event, layout);
        return undefined;
      case "drag":
      case "move":
        // Pointer motion after a completed click must not cancel its timer.
        if (this.press) this.invalidate();
        return undefined;
      case "release":
        if (
          this.press &&
          (event.x !== this.press.x || event.y !== this.press.y)
        )
          this.invalidate();
        return undefined;
      case "click":
        return this.completeClick(event, layout, actions);
    }
  }

  private beginPress(
    event: TuiMouseEvent,
    layout: ConfirmationMouseLayout,
  ): void {
    // A second press cancels the first click before double-click selection.
    this.invalidate();
    if (
      !inside(event, layout) ||
      event.button !== "left" ||
      !plainPrimary(event)
    )
      return;
    const target = this.hit(layout, event.x, event.y);
    if (target)
      this.press = {
        x: event.x,
        y: event.y,
        target: JSON.stringify(target),
        generation: this.generation,
      };
  }

  private completeClick(
    event: TuiMouseEvent,
    layout: ConfirmationMouseLayout,
    actions: MouseActions,
  ): TuiMouseEventResult | undefined {
    const press = this.press;
    this.press = undefined;
    const target = inside(event, layout)
      ? this.hit(layout, event.x, event.y)
      : undefined;
    if (
      !press ||
      !target ||
      !plainPrimary(event) ||
      (event.clickCount ?? 1) !== 1 ||
      press.x !== event.x ||
      press.y !== event.y ||
      press.generation !== this.generation ||
      press.target !== JSON.stringify(target)
    )
      return undefined;
    if (target.kind === "decision") {
      this.invalidate();
      actions.select(target.index);
    } else {
      this.defer(target, actions);
    }
    return { handled: true };
  }

  private defer(target: ConfirmationTarget, actions: MouseActions): void {
    const generation = this.generation;
    const signature = this.signature;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (
        generation !== this.generation ||
        signature !== this.signature ||
        !actions.isCurrent()
      )
        return;
      this.invalidate();
      actions.activate(target);
    }, 520);
    this.pending.unref?.();
  }

  private hit(
    layout: ConfirmationMouseLayout,
    x: number,
    y: number,
  ): ConfirmationTarget | undefined {
    return layout.hits.find(
      (hit) => hit.y === y && x >= hit.start && x < hit.end,
    )?.target;
  }
}
