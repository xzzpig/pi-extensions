import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AuditorProgress } from "../goal-auditor.ts";
import type { GoalKeybinding } from "../goal-controls.ts";
import type { DashboardFooterKeys } from "../fork-dashboard-key-routes.ts";
import { deriveAuditorDashboardModel } from "./auditor-dashboard-model.ts";
import {
  AUDIT_DASHBOARD_CHROME_ROWS,
  auditDashboardBody,
  renderDynamicAuditorDashboard,
  type AuditDashboardGeometry,
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
  private goalId: string | undefined;
  private active = false;
  private lifecycle: object | undefined;
  private parkedOffset: number | undefined;
  geometry: AuditDashboardGeometry = {};
  private offset = 0;
  private rows = 12;
  private length = 0;
  private expanded = false;

  render(
    progress: AuditorProgress & { auditorLabel?: string },
    theme: Theme,
    width: number,
    opts: {
      expanded: boolean;
      interruptKey?: GoalKeybinding;
      footerKeys?: DashboardFooterKeys;
      interactive?: boolean;
      goalId?: string;
      lifecycle?: object;
    },
  ): string[] {
    if (
      !this.active ||
      (opts.lifecycle
        ? opts.lifecycle !== this.lifecycle ||
          (!!progress.attemptId &&
            !!this.attemptId &&
            progress.attemptId !== this.attemptId)
        : progress.attemptId !== this.attemptId ||
          this.lifecycle !== undefined) ||
      opts.goalId !== this.goalId
    ) {
      this.attemptId = progress.attemptId;
      this.goalId = opts.goalId;
      this.lifecycle = opts.lifecycle;
      this.offset = 0;
      this.parkedOffset = undefined;
    }
    this.active = true;
    if (progress.attemptId) this.attemptId = progress.attemptId;
    this.expanded = opts.expanded;
    this.rows = Math.max(
      opts.interactive ? 0 : 1,
      Math.min(14, Math.floor(this.maxRows) - AUDIT_DASHBOARD_CHROME_ROWS),
    );
    const model = deriveAuditorDashboardModel(progress, {
      auditorLabel: progress.auditorLabel,
    });
    this.length = auditDashboardBody(model, Math.max(10, width)).length;
    if (this.parkedOffset !== undefined && progress.checks?.length) {
      this.offset = this.parkedOffset;
      this.parkedOffset = undefined;
    }
    this.offset = Math.max(0, Math.min(this.offset, this.length - this.rows));
    return renderDynamicAuditorDashboard(model, theme, width, {
      showToolDetails: opts.expanded,
      interruptKey: opts.interruptKey,
      footerKeys: opts.footerKeys,
      viewportRows: this.rows,
      scrollOffset: this.offset,
      interactive: opts.interactive,
      maxHeight: this.maxRows,
      onGeometry: (geometry) => {
        this.geometry = geometry;
      },
    });
  }

  clipGeometry(height: number): void {
    const { control, body } = this.geometry;
    if (control && control.line >= height) delete this.geometry.control;
    if (body) {
      if (body.first >= height) delete this.geometry.body;
      else body.last = Math.min(body.last, height - 1);
    }
  }

  leave(): void {
    this.active = false;
    this.parkedOffset = undefined;
    this.geometry = {};
  }

  park(): void {
    if (this.active && this.parkedOffset === undefined)
      this.parkedOffset = this.offset;
    this.geometry = {};
  }

  scroll(delta: number, invalidate: () => void): boolean {
    if (!this.expanded || !this.geometry.body) return false;
    this.parkedOffset = undefined;
    this.offset = Math.max(
      0,
      Math.min(
        Math.max(0, this.length - this.rows),
        this.offset + (Number.isFinite(delta) ? Math.trunc(delta) : 0),
      ),
    );
    invalidate();
    return true;
  }

  navigate(key: AuditNavigationKey, invalidate: () => void): boolean {
    if (!this.expanded) return false;
    this.parkedOffset = undefined;
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
