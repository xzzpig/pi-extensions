import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ============================================================================
// Mapping View (local fork addition: /vibeguard:list and /vibeguard:stats)
// ============================================================================

export interface MappingEntry {
  category: string;
  placeholder: string;
  original: string;
  createdAt: number;
}

export interface CategoryStat {
  category: string;
  count: number;
}

/** Structural view of PlaceholderSession's in-memory mapping tables. */
export interface MappingSnapshotSource {
  prefix: string;
  forward: Map<string, string>;
  created: Map<string, number>;
}

/**
 * Extract the embedded category from a placeholder
 * (`${prefix}<CATEGORY>_<hash12>__` or `${prefix}<CATEGORY>_<hash12>_<N>__`).
 * Returns "UNKNOWN" for anything that does not match the expected shape.
 */
export function parseCategoryFromPlaceholder(placeholder: string, prefix: string): string {
  const raw = String(placeholder ?? "");
  const pfx = String(prefix ?? "");
  let body = raw;
  if (pfx && raw.startsWith(pfx)) body = raw.slice(pfx.length);
  if (body.endsWith("__")) body = body.slice(0, -2);
  const m = /^([A-Za-z0-9_]+)_([0-9a-fA-F]{12})(?:_[0-9]+)?$/.exec(body);
  return m ? m[1] : "UNKNOWN";
}

/** Mask an original value: keep first 3 + … + last 4; wholly mask short values. */
export function maskOriginal(original: string): string {
  const chars = Array.from(String(original ?? ""));
  if (chars.length <= 7) return "•";
  return `${chars.slice(0, 3).join("")}…${chars.slice(-4).join("")}`;
}

/** Read-only snapshot of the live mapping tables (no cleanup, no eviction). */
export function buildMappingSnapshot(source: MappingSnapshotSource): MappingEntry[] {
  const entries: MappingEntry[] = [];
  for (const [placeholder, original] of source.forward) {
    entries.push({
      category: parseCategoryFromPlaceholder(placeholder, source.prefix),
      placeholder,
      original,
      createdAt: source.created.get(placeholder) ?? 0,
    });
  }
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.createdAt - b.createdAt);
  return entries;
}

/** Per-category counts, sorted by count desc then name asc. */
export function buildCategoryStats(entries: MappingEntry[]): CategoryStat[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Human duration with minute granularity ("<1m", "43m", "1h5m"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
}

export function formatTtlRemaining(createdAt: number, ttlMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return "∞";
  return formatDuration(createdAt + ttlMs - now);
}

export function padCell(text: string, width: number): string {
  const vw = visibleWidth(text);
  return vw >= width ? text : text + " ".repeat(width - vw);
}

export function terminalRows(): number {
  const r = process.stdout.rows;
  return typeof r === "number" && Number.isFinite(r) ? r : 36;
}

export function resolveMappingOverlayOptions(): OverlayOptions {
  const cols = process.stdout.columns;
  const width = Math.max(80, Math.min(120, (typeof cols === "number" && Number.isFinite(cols) ? cols : 120) - 4));
  return { anchor: "center", width, maxHeight: Math.max(14, terminalRows() - 4), margin: 1 };
}

export type MappingViewMode = "list" | "stats";

interface MappingViewOptions {
  tui: TUI;
  theme: Theme;
  done: () => void;
  mode: MappingViewMode;
  entries: MappingEntry[];
  ttlMs: number;
  /** Warning line shown under the title when redaction is temporarily suspended. */
  suspensionNote?: string;
}

export class MappingViewModal implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly mode: MappingViewMode;
  private readonly entries: MappingEntry[];
  private readonly stats: CategoryStat[];
  private readonly ttlMs: number;
  private readonly suspensionNote: string;
  private reveal = false;
  private scrollOffset = 0;

  constructor(options: MappingViewOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.mode = options.mode;
    this.entries = options.entries;
    this.stats = buildCategoryStats(options.entries);
    this.ttlMs = options.ttlMs;
    this.suspensionNote = options.suspensionNote ?? "";
  }

  private dataRowCount(): number {
    return this.mode === "list" ? this.entries.length : this.stats.length;
  }

  private viewportRows(): number {
    // Reserve room for the frame (top border + bottom border) and inner padding.
    return Math.max(6, Math.min(22, terminalRows() - 14));
  }

  /** Top border with the title embedded: `┌─ title ───…┐` (exactly `width` visible columns). */
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

  /** Bottom border with the key hints embedded: `└─ hints ───…┘` (exactly `width` visible columns). */
  private frameBottom(label: string, width: number): string {
    const t = this.theme;
    const fixed = visibleWidth("└─ ") + visibleWidth(" ") + visibleWidth("┘");
    let lab = label;
    if (visibleWidth(lab) + 1 > Math.max(0, width - fixed)) lab = "";
    const fill = Math.max(0, width - fixed - visibleWidth(lab));
    return t.fg("dim", "└─ " + lab + " " + "─".repeat(fill) + "┘");
  }

  /** Wrap content lines with side borders, truncating/padding to fit. */
  private frameRows(lines: string[], width: number): string[] {
    const t = this.theme;
    const contentW = Math.max(1, width - 4);
    return lines.map((line) => {
      const cell = padCell(truncateToWidth(line, contentW, "…"), contentW);
      return t.fg("borderAccent", "│ ") + cell + t.fg("borderAccent", " │");
    });
  }

  /** Warning banner shown while redaction is temporarily suspended. */
  private renderSuspensionNote(width: number): string[] {
    if (!this.suspensionNote) return [];
    return this.frameRows([this.theme.fg("warning", `⚠ ${this.suspensionNote}`)], width);
  }

  invalidate(): void {
    // All rendering is computed per-call; nothing cached to invalidate.
  }

  render(width: number): string[] {
    const revealColor = this.reveal ? "warning" : "accent";
    const total = this.entries.length;
    const title = this.reveal
      ? ` VibeGuard 映射 · ${total} 条 · TTL ${formatDuration(this.ttlMs)} · 明文显示 `
      : ` VibeGuard 映射 · ${total} 条 · TTL ${formatDuration(this.ttlMs)} `;

    if (this.mode === "stats") {
      const statsTitle = ` VibeGuard 统计 · ${total} 条 / ${this.stats.length} 类 `;
      return [
        this.frameTop(statsTitle, "accent", width),
        ...this.renderSuspensionNote(width),
        ...this.frameRows(this.renderStatsContent(width), width),
        this.frameBottom("↑/↓ j/k 滚动 · q/Esc 关闭", width),
      ];
    }

    return [
      this.frameTop(title, revealColor, width),
      ...this.renderSuspensionNote(width),
      ...this.frameRows(this.renderListContent(width), width),
      this.frameBottom("↑/↓ j/k 滚动 · PgUp/PgDn 翻页 · r 切换原文 · q/Esc 关闭", width),
    ];
  }

  private renderListContent(width: number): string[] {
    const t = this.theme;
    const now = Date.now();
    const total = this.entries.length;
    const out: string[] = [];
    out.push("");

    const catW = Math.min(18, Math.max(12, ...this.entries.map((e) => visibleWidth(e.category)))) + 1;
    const phW = Math.min(38, Math.max(28, ...this.entries.map((e) => visibleWidth(e.placeholder))));
    const ttlW = 6;
    const origW = Math.max(8, width - catW - phW - ttlW - 12);

    const header = ` ${padCell("CATEGORY", catW)}  ${padCell("PLACEHOLDER", phW)}  ${padCell("ORIGINAL", origW)}  ${padCell("TTL", ttlW)}`;
    out.push(t.fg("muted", truncateToWidth(header, width - 4)));
    out.push(t.fg("borderMuted", "─".repeat(Math.max(20, Math.min(width - 5, catW + phW + ttlW + origW + 7)))));

    const rows = this.viewportRows();
    const start = Math.min(this.scrollOffset, Math.max(0, total - rows));
    for (let i = start; i < Math.min(total, start + rows); i++) {
      const e = this.entries[i];
      const remainingMs = e.createdAt + this.ttlMs - now;
      const cat = t.fg("warning", padCell(truncateToWidth(e.category, catW), catW));
      const ph = t.fg("muted", padCell(truncateToWidth(e.placeholder, phW), phW));
      const shown = this.reveal ? e.original : maskOriginal(e.original);
      const orig = t.fg(this.reveal ? "text" : "dim", truncateToWidth(shown, origW));
      const ttl = t.fg(remainingMs <= 5 * 60000 ? "warning" : "muted", padCell(formatTtlRemaining(e.createdAt, this.ttlMs, now), ttlW));
      out.push(` ${cat}  ${ph}  ${orig}  ${ttl}`);
    }

    if (total > rows) {
      out.push("");
      out.push(t.fg("dim", ` 第 ${start + 1}-${Math.min(total, start + rows)} / ${total} 条 · 继续滚动查看更多`));
    }
    return out;
  }

  private renderStatsContent(width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    out.push("");

    const maxLabel = Math.max(8, ...this.stats.map((s) => visibleWidth(s.category)));
    const labelW = Math.min(24, maxLabel);
    const barMax = Math.max(8, Math.min(28, width - 4 - labelW - 12));
    const maxCount = Math.max(1, ...this.stats.map((s) => s.count));

    const rows = this.viewportRows();
    const start = Math.min(this.scrollOffset, Math.max(0, this.stats.length - rows));
    for (let i = start; i < Math.min(this.stats.length, start + rows); i++) {
      const s = this.stats[i];
      const barLen = Math.max(1, Math.round((s.count / maxCount) * barMax));
      const bar = t.fg("accent", "█".repeat(barLen)) + t.fg("dim", "·".repeat(Math.max(0, barMax - barLen)));
      const count = t.fg("text", String(s.count).padStart(4));
      out.push(` ${padCell(truncateToWidth(s.category, labelW), labelW)}  ${bar}  ${count}`);
    }

    if (this.stats.length > rows) {
      out.push("");
      out.push(t.fg("dim", ` 第 ${start + 1}-${Math.min(this.stats.length, start + rows)} / ${this.stats.length} 类 · 继续滚动查看更多`));
    }
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.done();
      return;
    }
    if (this.mode === "list" && (data === "r" || data === "R")) {
      this.reveal = !this.reveal;
      this.tui.requestRender();
      return;
    }
    const view = this.viewportRows();
    const maxOffset = Math.max(0, this.dataRowCount() - view);
    const page = Math.max(1, view - 1);
    let next = this.scrollOffset;
    if (matchesKey(data, Key.up) || data === "k") next -= 1;
    else if (matchesKey(data, Key.down) || data === "j") next += 1;
    else if (matchesKey(data, Key.pageUp)) next -= page;
    else if (matchesKey(data, Key.pageDown)) next += page;
    else if (matchesKey(data, Key.home)) next = 0;
    else if (matchesKey(data, Key.end)) next = maxOffset;
    else return;
    this.scrollOffset = Math.min(maxOffset, Math.max(0, next));
    this.tui.requestRender();
  }
}
