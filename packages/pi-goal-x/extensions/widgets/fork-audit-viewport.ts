import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AuditorProgress } from "../goal-auditor.ts";
import type { GoalKeybinding } from "../goal-controls.ts";
import { deriveAuditorDashboardModel } from "./auditor-dashboard-model.ts";
import {
  auditDashboardBody,
  renderDynamicAuditorDashboard,
} from "./fork-auditor-dashboard-renderer.ts";

export type AuditNavigationKey =
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end";

/** Viewport belongs to the widget, not the model or persisted goal. */
export class AuditDashboardViewport {
  maxRows = 15;
  private attemptId: string | undefined;
  private offset = 0;
  private rows = 12;
  private length = 0;
  private expanded = false;

  render(
    progress: AuditorProgress & { auditorLabel?: string },
    theme: Theme,
    width: number,
    opts: { expanded: boolean; interruptKey?: GoalKeybinding },
  ): string[] {
    if (progress.attemptId !== this.attemptId) {
      this.attemptId = progress.attemptId;
      this.offset = 0;
    }
    this.expanded = opts.expanded;
    this.rows = Math.max(1, Math.min(14, Math.floor(this.maxRows) - 3));
    const model = deriveAuditorDashboardModel(progress, {
      auditorLabel: progress.auditorLabel,
    });
    this.length = auditDashboardBody(model, Math.max(10, width)).length;
    this.offset = Math.max(0, Math.min(this.offset, this.length - this.rows));
    return renderDynamicAuditorDashboard(model, theme, width, {
      showToolDetails: opts.expanded,
      interruptKey: opts.interruptKey,
      viewportRows: this.rows,
      scrollOffset: this.offset,
    });
  }

  navigate(key: AuditNavigationKey, invalidate: () => void): boolean {
    if (!this.expanded) return false;
    const max = Math.max(0, this.length - this.rows);
    if (key === "home") this.offset = 0;
    else if (key === "end") this.offset = max;
    else {
      const direction = key === "up" || key === "pageUp" ? -1 : 1;
      this.offset +=
        direction * (key === "pageUp" || key === "pageDown" ? this.rows : 1);
      this.offset = Math.max(0, Math.min(max, this.offset));
    }
    invalidate();
    return true;
  }
}
