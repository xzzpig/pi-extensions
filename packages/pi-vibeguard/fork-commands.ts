/**
 * Fork-only `/vibeguard:*` command family.
 *
 * Why this file exists: `/vibeguard:list`, `:stats`, `:disable`, `:enable`,
 * `:status` and `:categories` are fork additions (temporary suspension and the
 * mapping viewers). They used to live inside the upstream `index.ts` factory,
 * together with the helpers they need (`requireActive`, `handleSuspendChange`,
 * `knownCategories`, the status sync). Keeping them here leaves `index.ts` with
 * one registration call, so an upstream sync never replays ~140 lines of fork
 * command code.
 *
 * Suspension never touches the on-disk config, never survives `session_start`
 * (the factory resets the state there), and only stops NEW placeholder
 * generation: restore paths keep restoring historical placeholders.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { CategoryPickerModal } from "./category-picker.ts";
import { resolveMappingOverlayOptions } from "./mapping-view.ts";
import {
  sanitizeCategory,
  setSuspensionStatus,
  suspensionSummary,
  type SuspensionState,
} from "./suspension-state.ts";

export interface VibeguardCommandDeps {
  /** Session-scoped suspension state owned by the extension factory. */
  suspension: SuspensionState;
  /** Why the extension cannot act, or null when it is active. */
  extensionActiveReason(): string | null;
  /** Category names known to the loaded pattern set (sorted). */
  knownCategories(): string[];
  /** Open the mapping viewer for `list` or `stats`. */
  openMappingView(mode: "list" | "stats", ctx: ExtensionCommandContext): Promise<void>;
}

/** Register the six fork-only `/vibeguard:*` commands. */
export function registerVibeguardCommands(pi: ExtensionAPI, deps: VibeguardCommandDeps): void {
  const { suspension } = deps;

  const requireActive = (ctx: ExtensionCommandContext): boolean => {
    const reason = deps.extensionActiveReason();
    if (reason) {
      ctx.ui.notify(`VibeGuard: ${reason}`, "warning");
      return false;
    }
    return true;
  };

  const syncStatus = (ctx: ExtensionCommandContext): void => {
    setSuspensionStatus(suspension, ctx.ui);
  };

  /** Shared body of /vibeguard:disable and /vibeguard:enable. */
  const handleSuspendChange = async (
    args: string,
    suspend: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    if (!requireActive(ctx)) return;

    const category = String(args ?? "").trim().split(/\s+/)[0] ?? "";

    // No category: toggle the whole extension (global suspend / full resume).
    if (!category) {
      if (suspend) {
        suspension.setGlobal(true);
        ctx.ui.notify(
          "VibeGuard: 已整体挂起 —— 新内容不再脱敏；会话历史中的占位符仍会照常恢复（/vibeguard:enable 恢复）",
          "warning",
        );
      } else {
        suspension.setGlobal(false);
        for (const c of suspension.suspendedCategoryList()) suspension.setCategory(c, false);
        ctx.ui.notify("VibeGuard: 已整体恢复 —— 新内容将重新脱敏", "info");
      }
      syncStatus(ctx);
      return;
    }

    const normalized = sanitizeCategory(category);
    const known = deps.knownCategories();
    if (!known.includes(normalized)) {
      ctx.ui.notify(
        `VibeGuard: 未知类别 ${normalized}（可用类别：${known.length ? known.join(", ") : "（无）"}）`,
        "warning",
      );
      return;
    }

    suspension.setCategory(normalized, suspend);
    ctx.ui.notify(
      suspend
        ? `VibeGuard: 已挂起类别 ${normalized} —— 该类新内容不再脱敏，历史占位符仍会恢复`
        : `VibeGuard: 已恢复类别 ${normalized}`,
      suspend ? "warning" : "info",
    );
    syncStatus(ctx);
  };

  pi.registerCommand("vibeguard:list", {
    description: "VibeGuard: 查看当前会话存活的脱敏映射（category / placeholder / 原文 / 剩余 TTL）",
    handler: (_args, ctx) => deps.openMappingView("list", ctx),
  });

  pi.registerCommand("vibeguard:stats", {
    description: "VibeGuard: 按 category 汇总当前会话的存活映射",
    handler: (_args, ctx) => deps.openMappingView("stats", ctx),
  });

  pi.registerCommand("vibeguard:disable", {
    description: "VibeGuard: 临时挂起脱敏。无参数=整体挂起（新内容不再脱敏，历史映射仍恢复）；带类别=只挂起该类别",
    handler: (args, ctx) => handleSuspendChange(args, true, ctx),
  });

  pi.registerCommand("vibeguard:enable", {
    description: "VibeGuard: 恢复脱敏。无参数=整体恢复；带类别=恢复该类别",
    handler: (args, ctx) => handleSuspendChange(args, false, ctx),
  });

  pi.registerCommand("vibeguard:status", {
    description: "VibeGuard: 显示当前脱敏状态（启用/挂起类别）",
    handler: async (_args, ctx) => {
      if (!requireActive(ctx)) return;
      const summary = suspensionSummary(suspension);
      const msg = summary
        ? `VibeGuard: 已启用 · ${summary}（/vibeguard:enable 恢复）`
        : "VibeGuard: 已启用 · 全部规则生效中（/vibeguard:disable 临时挂起）";
      ctx.ui.notify(msg, summary ? "warning" : "info");
      syncStatus(ctx);
    },
  });

  pi.registerCommand("vibeguard:categories", {
    description: "VibeGuard: 打开类别挂起管理弹窗（整体/按类别切换临时挂起）",
    handler: async (_args, ctx) => {
      if (!requireActive(ctx)) return;
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new CategoryPickerModal({
            tui,
            theme,
            done,
            categories: deps.knownCategories(),
            getGlobal: () => suspension.globallySuspended,
            isSuspended: (c) => suspension.isCategorySuspended(c),
            setGlobal: (v) => suspension.setGlobal(v),
            setCategory: (c, v) => suspension.setCategory(c, v),
            onStatusSync: () => syncStatus(ctx),
          }),
        { overlay: true, overlayOptions: resolveMappingOverlayOptions() },
      );
    },
  });
}
