import type {
  TuiMouseEvent,
  TuiMouseEventResult,
  TUI,
} from "@earendil-works/pi-tui";
import { TaskTreeMouse } from "./fork-task-tree-mouse.ts";
import type { AuditDashboardGeometry } from "./fork-auditor-dashboard-renderer.ts";

/** Host terminal rows, unavailable in mock or embedded TUIs. */
export function auditTerminalRows(tui: TUI): number | undefined {
  // SAFETY: the live host TUI owns this optional terminal; absent on mocks.
  return (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows;
}

/** Audit events stay local to the visible audit panel and never touch task state. */
export class AuditDashboardMouse {
  private readonly mouse = new TaskTreeMouse();
  private observedSignature?: string;
  private observedLifecycle?: object | null;
  private pending?: {
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  };
  observe(
    identity: string | undefined,
    lifecycle: object | null,
    width: number,
    geometry: AuditDashboardGeometry,
    overlayVisible: boolean,
  ): void {
    const signature = JSON.stringify([
      identity,
      width,
      geometry,
      overlayVisible,
    ]);
    if (
      signature !== this.observedSignature ||
      lifecycle !== this.observedLifecycle
    )
      this.clear();
    this.observedSignature = signature;
    this.observedLifecycle = lifecycle;
  }
  clear(): void {
    this.mouse.clear();
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }
  handle(
    event: TuiMouseEvent,
    options: {
      enabled: boolean;
      identity: unknown;
      width: number;
      geometry: AuditDashboardGeometry;
      toggle: () => void;
      isCurrent: () => boolean;
      scroll: (delta: number) => void;
    },
  ): TuiMouseEventResult | undefined {
    if (!options.enabled) {
      this.clear();
      return undefined;
    }
    if (
      event.type === "press" &&
      this.pending &&
      event.x === this.pending.x &&
      event.y === this.pending.y
    ) {
      clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
    const { control, body } = options.geometry;
    const signature = JSON.stringify([
      options.identity,
      options.width,
      control,
      body,
    ]);
    return this.mouse.handle(
      event,
      {
        signature,
        target: (x, y) =>
          control && y === control.line && x >= control.start && x < control.end
            ? { kind: "toggle" }
            : undefined,
        inTaskArea: (x, y) =>
          !!body &&
          x >= 1 &&
          x < options.width - 1 &&
          y >= body.first &&
          y <= body.last,
      },
      () => {
        if (this.pending) clearTimeout(this.pending.timer);
        const timer = setTimeout(() => {
          this.pending = undefined;
          if (options.isCurrent()) options.toggle();
        }, 520);
        timer.unref?.();
        this.pending = { x: event.x, y: event.y, timer };
      },
      options.scroll,
    );
  }
}
