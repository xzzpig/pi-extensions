/**
 * Fork-only runtime suspension state for pi-vibeguard.
 *
 * Why this file exists: temporary suspension (global or per-category) is a fork
 * addition — upstream only redacts or stays disabled via config. Keeping the
 * class and its summary text next to the command family in fork-only files
 * removes ~90 lines of fork code from the upstream `index.ts`, which used to
 * carry the class, its helper and the six `/vibeguard:*` registrations.
 *
 * Restore paths (`tool_call` / `message_end`) are deliberately NOT part of this
 * state: historical placeholders already in the session keep being restored
 * regardless of suspension; only NEW placeholder generation stops.
 */

/** Normalize a category name the way the config loader does. */
export function sanitizeCategory(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "TEXT";
  const upper = raw.toUpperCase();
  const safe = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_");
  if (!safe) return "TEXT";
  return safe;
}

export class SuspensionState {
  private all = false;
  private categories = new Set<string>();

  /** True when redaction is globally suspended (no new placeholder generation). */
  get globallySuspended(): boolean {
    return this.all;
  }

  /** Sanitized category names whose redaction is currently suspended. */
  get suspendedCategories(): ReadonlySet<string> {
    return this.categories;
  }

  /** True when any form of suspension is active (global or per-category). */
  get anySuspended(): boolean {
    return this.all || this.categories.size > 0;
  }

  setGlobal(value: boolean): void {
    this.all = value;
  }

  /** Suspend/resume one category (input is normalized like config categories). */
  setCategory(category: string, suspended: boolean): void {
    const normalized = sanitizeCategory(category);
    if (suspended) this.categories.add(normalized);
    else this.categories.delete(normalized);
  }

  /** Toggle one category; returns the new suspended state of that category. */
  toggleCategory(category: string): boolean {
    const normalized = sanitizeCategory(category);
    if (this.categories.has(normalized)) {
      this.categories.delete(normalized);
      return false;
    }
    this.categories.add(normalized);
    return true;
  }

  isCategorySuspended(category: string): boolean {
    return this.categories.has(sanitizeCategory(category));
  }

  /** Global suspension overrides everything; otherwise checks one category. */
  isSuspended(category?: string): boolean {
    if (this.all) return true;
    if (category) return this.categories.has(sanitizeCategory(category));
    return false;
  }

  /** Sorted snapshot of suspended categories (for status/list display). */
  suspendedCategoryList(): string[] {
    return [...this.categories].sort((a, b) => a.localeCompare(b));
  }

  /** Fresh session state: nothing suspended, back to config.enabled semantics. */
  reset(): void {
    this.all = false;
    this.categories.clear();
  }
}

/** Human-readable suspension summary ("" when fully active). */
export function suspensionSummary(suspension: SuspensionState): string {
  if (suspension.globallySuspended) {
    return "整体挂起：新内容不再脱敏，历史占位符仍照常恢复";
  }
  const cats = suspension.suspendedCategoryList();
  if (cats.length === 0) return "";
  return `挂起类别：${cats.join(", ")}（该类新内容不再脱敏，历史占位符仍照常恢复）`;
}

/** Reflect the current suspension state in the status bar. */
export function setSuspensionStatus(
  suspension: SuspensionState,
  ui: { setStatus(key: string, text: string): void },
): void {
  if (suspension.globallySuspended) {
    ui.setStatus("vibeguard", "\x1b[33mVibeGuard[OFF]\x1b[0m");
    return;
  }
  const cats = suspension.suspendedCategoryList();
  ui.setStatus(
    "vibeguard",
    cats.length > 0
      ? `\x1b[33mVibeGuard[OFF:${cats.join(",")}]\x1b[0m`
      : "\x1b[33mVibeGuard[ON]\x1b[0m",
  );
}
