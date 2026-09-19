import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { padCell, terminalRows } from "./mapping-view.ts";

// ============================================================================
// Category Picker (temporary suspension management)
//
// Interactive multi-select: toggle the global suspension or individual
// categories with Space/Enter. Changes apply immediately and are synced to
// the status bar; q/Esc closes. Renders to the local TUI only.
// ============================================================================

export interface CategoryPickerOptions {
  tui: TUI;
  theme: Theme;
  done: () => void;
  /** Known, sanitized, sorted categories. */
  categories: string[];
  getGlobal: () => boolean;
  isSuspended: (category: string) => boolean;
  setGlobal: (value: boolean) => void;
  setCategory: (category: string, suspended: boolean) => void;
  /** Called after each toggle so the status bar stays in sync. */
  onStatusSync: () => void;
}

interface PickerRow {
  kind: "global" | "category";
  category?: string;
}

export class CategoryPickerModal implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly categories: string[];
  private readonly getGlobal: () => boolean;
  private readonly isSuspended: (category: string) => boolean;
  private readonly setGlobal: (value: boolean) => void;
  private readonly setCategory: (category: string, suspended: boolean) => void;
  private readonly onStatusSync: () => void;
  private selected = 0;

  constructor(options: CategoryPickerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.categories = options.categories;
    this.getGlobal = options.getGlobal;
    this.isSuspended = options.isSuspended;
    this.setGlobal = options.setGlobal;
    this.setCategory = options.setCategory;
    this.onStatusSync = options.onStatusSync;
  }

  private rows(): PickerRow[] {
    return [
      { kind: "global" },
      ...this.categories.map((category) => ({ kind: "category" as const, category })),
    ];
  }

  private frameTop(label: string, color: "accent" | "warning", width: number): string {
    const t = this.theme;
    const fixed = visibleWidth("┌─ ") + visibleWidth(" ") + visibleWidth("┐");
    let lab = label;
    if (visibleWidth(lab) + 1 > Math.max(0, width - fixed)) {
      lab = truncateToWidth(lab, Math.max(0, width - fixed - 1), "…");
    }
    const fill = Math.max(0, width - fixed - visibleWidth(lab));
    return t.fg(color, "┌─ ") + t.fg(color, t.bold(lab)) + t.fg(color, " " + "─".repeat(fill) + "┐");
  }

  private frameBottom(label: string, width: number): string {
    const t = this.theme;
    const fixed = visibleWidth("└─ ") + visibleWidth(" ") + visibleWidth("┘");
    let lab = label;
    if (visibleWidth(lab) + 1 > Math.max(0, width - fixed)) lab = "";
    const fill = Math.max(0, width - fixed - visibleWidth(lab));
    return t.fg("dim", "└─ " + lab + " " + "─".repeat(fill) + "┘");
  }

  private frameRows(lines: string[], width: number): string[] {
    const t = this.theme;
    const contentW = Math.max(1, width - 4);
    return lines.map((line) => {
      const cell = padCell(truncateToWidth(line, contentW, "…"), contentW);
      return t.fg("borderAccent", "│ ") + cell + t.fg("borderAccent", " │");
    });
  }

  invalidate(): void {
    // All rendering is computed per-call; nothing cached to invalidate.
  }

  render(width: number): string[] {
    const t = this.theme;
    const suspendedCount = this.categories.filter((c) => this.isSuspended(c)).length;
    const title = this.getGlobal()
      ? ` VibeGuard 挂起管理 · ${this.categories.length} 类 · 整体挂起 `
      : ` VibeGuard 挂起管理 · ${this.categories.length} 类 · 已挂起 ${suspendedCount} `;

    const rows = this.rows();
    const viewport = Math.max(4, Math.min(20, terminalRows() - 14));
    const start = Math.min(this.selected, Math.max(0, rows.length - viewport));
    const content: string[] = [""];
    for (let i = start; i < Math.min(rows.length, start + viewport); i++) {
      const row = rows[i]!;
      const active = i === this.selected;
      const prefix = active ? t.fg("accent", t.bold("▸")) : " ";
      if (row.kind === "global") {
        const on = this.getGlobal();
        const mark = on ? t.fg("warning", "☑") : t.fg("dim", "☐");
        const label = on
          ? "整体挂起（新内容不再脱敏，历史仍恢复）"
          : "整体挂起（点击 Space 切换）";
        content.push(` ${prefix} ${mark} ${active ? t.fg("text", t.bold(label)) : t.fg("text", label)}`);
      } else {
        const category = row.category ?? "";
        const on = this.isSuspended(category);
        const mark = on ? t.fg("warning", "☑") : t.fg("dim", "☐");
        const label = on ? `${category}（已挂起）` : category;
        content.push(` ${prefix} ${mark} ${active ? t.fg("text", t.bold(label)) : t.fg("text", label)}`);
      }
    }

    return [
      this.frameTop(title, this.getGlobal() ? "warning" : "accent", width),
      ...this.frameRows(content, width),
      this.frameBottom("↑/↓ j/k 选择 · Space/Enter 切换 · q/Esc 关闭", width),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.done();
      return;
    }

    const rows = this.rows();
    if (
      data === " " ||
      data === "\r" ||
      data === "\n" ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.space)
    ) {
      const row = rows[this.selected];
      if (!row) return;
      if (row.kind === "global") this.setGlobal(!this.getGlobal());
      else if (row.category) this.setCategory(row.category, !this.isSuspended(row.category));
      this.onStatusSync();
      this.tui.requestRender();
      return;
    }

    let next = this.selected;
    if (matchesKey(data, Key.up) || data === "k") next -= 1;
    else if (matchesKey(data, Key.down) || data === "j") next += 1;
    else if (matchesKey(data, Key.home)) next = 0;
    else if (matchesKey(data, Key.end)) next = rows.length - 1;
    else return;
    this.selected = Math.min(rows.length - 1, Math.max(0, next));
    this.tui.requestRender();
  }
}
