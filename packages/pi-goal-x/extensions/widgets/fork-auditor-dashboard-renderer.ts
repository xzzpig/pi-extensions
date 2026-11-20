import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GoalKeybinding } from "../goal-controls.ts";
import { bindingKeys } from "../goal-controls.ts";
import { formatGoalKeybinding } from "../goal-settings.ts";
import {
  dashboardFooterKeys,
  type DashboardFooterKeys,
} from "../fork-dashboard-key-routes.ts";
import type { AuditorDashboardModel } from "./auditor-dashboard-model.ts";
import { formatAuditElapsed } from "./auditor-dashboard-model.ts";
import {
  boxHeader,
  boxLine,
  boxFooter,
  clampLinesToWidth,
} from "./goal-dashboard-renderer.ts";
import {
  layoutDashboardFooter,
  type FooterEntry,
} from "./fork-dashboard-footer.ts";
import { wrapTextWithAnsi } from "./text-cache.ts";

// Header, summary and the bottom border remain outside the scrolling body.
export const AUDIT_DASHBOARD_CHROME_ROWS = 3;

export interface AuditDashboardRenderOptions {
  showToolDetails?: boolean;
  interruptKey?: GoalKeybinding;
  footerKeys?: DashboardFooterKeys;
  scrollOffset?: number;
  viewportRows?: number;
  interactive?: boolean;
  maxHeight?: number;
  onGeometry?: (geometry: AuditDashboardGeometry) => void;
}

export interface AuditDashboardGeometry {
  body?: { first: number; last: number };
  control?: { line: number; start: number; end: number };
}

/** User/model text is data, not terminal control sequences. */
function plain(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("");
}

export function auditDashboardBody(
  model: AuditorDashboardModel,
  width: number,
): string[] {
  const lines: string[] = [];
  const inner = Math.max(1, width - 4);
  for (const item of model.checks) {
    const marker = {
      pending: "·",
      running: model.active ? "◌" : "·",
      passed: "✓",
      failed: "✗",
    }[item.state];
    const ended =
      item.state === "running" && !model.active ? "（检查中时审计已结束）" : "";
    lines.push(
      ...wrapTextWithAnsi(
        `${marker} ${plain(item.label)} ${ended}`.trim(),
        inner,
      ),
    );
    if (item.detail)
      lines.push(...wrapTextWithAnsi(`  ${plain(item.detail)}`, inner));
  }
  if (!model.checks.length) lines.push("没有配置检查项");
  if (model.progressDiagnostic)
    lines.push(...wrapTextWithAnsi(plain(model.progressDiagnostic), inner));
  if (model.currentTool)
    lines.push(
      ...wrapTextWithAnsi(
        `tool ${plain(model.currentTool)} ${plain(model.currentToolArgs ?? "")}`,
        inner,
      ),
    );
  for (const text of model.recentOutput.slice(-3))
    lines.push(...wrapTextWithAnsi(plain(text), inner));
  return lines;
}

function auditFooter(
  width: number,
  theme: Theme,
  expanded: boolean,
  keys: DashboardFooterKeys,
  active: boolean,
  scrollRange: string,
  estimate: string,
) {
  const frame = (text: string) => theme.fg("muted", text);
  const entries: FooterEntry<"toggle">[] = [
    {
      text: frame(expanded ? "[收起清单]" : "[展开清单]"),
      shortText: frame(expanded ? "[收起]" : "[展开]"),
      action: "toggle",
    },
  ];
  if (active && keys.stopAudit.length) {
    const stopHint = keys.stopAudit.map(formatGoalKeybinding).join("/");
    entries.push({
      text: frame(`${stopHint}: stop audit`),
      shortText: frame(`${stopHint}: stop`),
    });
  }
  if (keys.toggle.length)
    entries.push({
      text: frame(keys.toggle.map(formatGoalKeybinding).join("/")),
      after: "toggle",
    });
  if (scrollRange) {
    const scrollKeys = [...keys.scrollUp, ...keys.scrollDown]
      .map(formatGoalKeybinding)
      .join("/");
    entries.push({
      text: frame(scrollKeys ? `${scrollKeys} ${scrollRange}` : scrollRange),
    });
  }
  if (estimate) entries.push({ text: frame(estimate), right: true });
  return layoutDashboardFooter(width, frame, entries);
}

export function renderDynamicAuditorDashboard(
  model: AuditorDashboardModel,
  theme: Theme,
  width: number,
  opts: AuditDashboardRenderOptions = {},
): string[] {
  const safeWidth = Math.max(10, width);
  const passed = model.checks.filter((i) => i.state === "passed").length;
  const failed = model.checks.filter((i) => i.state === "failed").length;
  const current = model.checks
    .filter((i) => i.state === "running")
    .toSorted((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
  const expanded =
    opts.showToolDetails === true ||
    model.verdict === "disapproved" ||
    model.verdict === "error";
  const body = expanded
    ? auditDashboardBody(model, safeWidth)
    : [
        model.checks.length === 0
          ? "没有配置检查项"
          : current
            ? `${model.active ? "◌" : "·"} ${plain(current.label)}${model.active ? "" : "（审计已结束）"}`
            : model.active
              ? opts.interactive
                ? "等待逐项上报"
                : "等待逐项上报 · 展开查看清单"
              : "审计已结束 · 未检查项不自动补勾",
      ];
  const cap = opts.interactive
    ? Math.max(1, Math.floor(opts.maxHeight ?? 18))
    : Infinity;
  const rows = opts.interactive
    ? Math.min(
        expanded ? Math.max(0, Math.floor(opts.viewportRows ?? 12)) : 1,
        Math.max(0, cap - AUDIT_DASHBOARD_CHROME_ROWS),
      )
    : expanded
      ? Math.max(1, Math.floor(opts.viewportRows ?? 12))
      : 1;
  const offset = expanded
    ? Math.max(
        0,
        Math.min(
          Math.floor(opts.scrollOffset ?? 0),
          Math.max(0, body.length - rows),
        ),
      )
    : 0;
  const visible = body.slice(offset, offset + rows);
  while (visible.length < rows) visible.push("");
  const estimate =
    model.percentage === undefined ? "" : `审计员估计 ${model.percentage}%`;
  const interruptKeys = model.active
    ? bindingKeys(opts.interruptKey ?? "escape")
    : [];
  const scrollRange =
    expanded && body.length > rows && rows > 0
      ? `${offset + 1}–${Math.min(offset + rows, body.length)}/${body.length}`
      : "";
  const lines = [
    boxHeader(
      theme,
      safeWidth,
      `Independent completion audit ─ ${plain(model.auditorLabel)}`,
      formatAuditElapsed(model.elapsedMs),
    ),
    boxLine(
      theme,
      safeWidth,
      `已检查 ${passed + failed}/${model.checks.length} · 通过 ${passed} · 不通过 ${failed}`,
    ),
    ...visible.map((line) => boxLine(theme, safeWidth, line)),
  ];
  const geometry: AuditDashboardGeometry = {};
  if (opts.interactive && expanded && rows > 0)
    geometry.body = { first: 2, last: 1 + rows };
  if (opts.interactive) {
    if (lines.length < cap) {
      const footer = auditFooter(
        width,
        theme,
        expanded,
        opts.footerKeys ??
          dashboardFooterKeys({
            settings: { keybindings: { interruptAudit: opts.interruptKey } },
            audit: true,
            expanded,
            isIdle: () => true,
          }),
        model.active,
        scrollRange,
        estimate,
      );
      const control = footer.actions[0];
      if (control)
        geometry.control = {
          line: lines.length,
          start: control.start,
          end: control.end,
        };
      lines.push(footer.text);
    }
  } else {
    const hints = [
      interruptKeys.length
        ? `${formatGoalKeybinding(opts.interruptKey ?? "escape")}: stop audit`
        : "",
      scrollRange ? `↑/↓ ${scrollRange}` : "",
      !expanded ? "展开查看清单" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(boxFooter(theme, safeWidth, hints, estimate));
  }
  if (opts.interactive && lines.length > cap) lines.length = cap;
  opts.onGeometry?.(geometry);
  return clampLinesToWidth(lines, width);
}
