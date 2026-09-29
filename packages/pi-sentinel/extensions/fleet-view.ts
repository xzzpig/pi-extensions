import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";
import type { LiveAuditDetails } from "./audit-loop.js";
import type { FleetKeybindingAction, SourcedRule } from "./config.js";
import type { ConfigureDialogView, SentinelRegistry } from "./registry.js";
import type { HistoryEntry, RunnerStatus } from "./runner.js";

/**
 * `/sentinel:fleet`: a compact interactive inspector over the registry.
 *
 * The overlay lists every sentinel plus running configuration dialogs, shows a
 * live detail panel for the selection, auto-refreshes, and can steer a running
 * audit (delivered / ended receipt). `ui.custom` is TUI-only, so the mode guard
 * is `ctx.mode === "tui"`; other modes are pointed at `/sentinel:list`.
 */

export const FLEET_REFRESH_MS = 1000;

export interface FleetRow {
  name: string;
  kind: "rule" | "configure";
  trigger: string;
  mode: string;
  state: string;
  queuedCount: number;
  lastVerdict?: string;
  lastCached?: boolean;
  detail?: string;
  live?: LiveAuditDetails;
}

export interface BuildFleetRowsInput {
  rules: SourcedRule[];
  statuses: RunnerStatus[];
  dialogs: ConfigureDialogView[];
  isDisabled?: (name: string) => boolean;
  history?: HistoryEntry[];
}

/** Assemble the fleet list from rules, live runner status, and dialogs. */
export function buildFleetRows(input: BuildFleetRowsInput): FleetRow[] {
  const statusByName = new Map(
    input.statuses.map((status) => [status.ruleName, status]),
  );
  const history = input.history ?? [];
  const rows: FleetRow[] = input.rules.map((rule) => {
    const status = statusByName.get(rule.name);
    const disabled =
      rule.enabled === false || (input.isDisabled?.(rule.name) ?? false);
    return {
      name: rule.name,
      kind: "rule",
      trigger: describeTriggerShort(rule),
      mode: rule.mode,
      state: disabled ? "disabled" : (status?.state ?? "idle"),
      queuedCount: status?.queuedCount ?? 0,
      lastVerdict: latestVerdict(history, rule.name),
      lastCached: latestCached(history, rule.name),
      live: status?.live[0],
    };
  });

  for (const dialog of input.dialogs) {
    rows.push({
      name: dialog.id,
      kind: "configure",
      trigger: "configure",
      mode: "-",
      state: dialog.status === "running" ? "running" : "done",
      queuedCount: 0,
      detail: `第 ${dialog.turnCount} 轮 · 草稿 ${dialog.draftSummary ?? "(无)"} · 最近交互 ${
        dialog.transcript.at(-1)?.text ?? "(无)"
      }`,
    });
  }
  return rows;
}

function latestVerdict(
  history: HistoryEntry[],
  name: string,
): string | undefined {
  const entry = [...history]
    .reverse()
    .find((item) => item.ruleName === name && item.verdict);
  return entry?.verdict
    ? `${entry.verdict.verdict}: ${entry.verdict.message}`
    : undefined;
}
function latestCached(
  history: HistoryEntry[],
  name: string,
): boolean | undefined {
  const entry = [...history]
    .reverse()
    .find((item) => item.ruleName === name && item.verdict);
  return entry?.cached;
}
function describeTriggerShort(rule: SourcedRule): string {
  const { type, tools, threshold, event } = rule.trigger;
  if (
    (type === "tool_call" || type === "tool_result") &&
    tools &&
    tools.length > 0
  ) {
    return `${type}[${tools.join("|")}]`;
  }
  if (type === "event") return `event:${event ?? ""}`;
  if (type === "context_tokens") return `ctx@${threshold ?? 0}`;
  return type;
}

/** Render the inspector body (list + detail panel). */
export function renderFleetLines(
  rows: FleetRow[],
  selectedIndex: number,
  width: number,
  receipt?: string,
): string[] {
  const lines: string[] = [
    "pi-sentinel fleet  (↑/↓ 选择, s 引导, r 刷新, q 关闭)",
  ];
  if (rows.length === 0) {
    lines.push("  （没有已加载的哨兵）");
  }
  rows.forEach((row, index) => {
    const marker = index === selectedIndex ? ">" : " ";
    lines.push(
      truncateToWidth(
        `${marker} ${row.name} [${row.trigger}] ${row.mode} ${row.state}${
          row.queuedCount > 0 ? ` queued×${row.queuedCount}` : ""
        }${row.lastVerdict ? ` 最近=${row.lastVerdict}` : ""}`,
        width,
      ),
    );
  });

  const selected = rows[selectedIndex];
  lines.push("", "── 详情 ──");
  if (!selected) {
    lines.push("  （无选中项）");
  } else if (selected.kind === "configure") {
    lines.push(`  配置对话 ${selected.name}：${selected.state}`);
    if (selected.detail) lines.push(`  ${selected.detail}`);
  } else if (!selected.live) {
    lines.push(`  ${selected.name}：无进行中的审计（状态 ${selected.state}）`);
    if (selected.lastVerdict) {
      lines.push(
        `  最近裁决：${selected.lastVerdict}（缓存：${selected.lastCached ? "命中" : "未命中"}）`,
      );
    }
  } else {
    const live = selected.live;
    const elapsed = Date.now() - live.startedAt;
    lines.push(`  规则：${live.ruleName}`);
    lines.push(`  已耗时：${elapsed}ms`);
    lines.push(`  模型：${live.model}`);
    lines.push(`  工具调用：${live.toolCallCount}`);
    lines.push(`  缓存：${selected.lastCached ? "命中" : "未命中"}`);
    lines.push(
      `  prompt 概要：${truncateToWidth(live.promptSummary, Math.max(10, width - 16))}`,
    );
    lines.push(
      `  范围概要：${truncateToWidth(live.scopeSummary, Math.max(10, width - 16))}`,
    );
    if (live.unresolvedPaths.length > 0) {
      lines.push(`  未解析变量：${live.unresolvedPaths.join(", ")}`);
    }
    if (live.streamTail) {
      lines.push("  流式输出尾部：");
      for (const tailLine of live.streamTail.split("\n").slice(-4)) {
        lines.push(`    ${truncateToWidth(tailLine, Math.max(10, width - 6))}`);
      }
    }
  }
  if (receipt) lines.push("", `  steer：${receipt}`);
  return lines;
}

/** Steer a rule's running audits through the registry; returns the receipt. */
export function steerAudit(
  registry: SentinelRegistry,
  ruleName: string,
  message: string,
): "delivered" | "ended" {
  const runner = registry.getRunner(ruleName);
  if (!runner) return "ended";
  if (runner.status().state === "idle") return "ended";
  return runner.steer(message);
}

export interface FleetInspectorDeps {
  registry: SentinelRegistry;
  buildRows: () => FleetRow[];
  keybindings: Record<FleetKeybindingAction, string[]>;
  /** Prompt for a steering message (uses the host's input dialog). */
  promptSteer: () => Promise<string | undefined>;
  refreshMs?: number;
  /** Register a programmatic closer so a preview dialog can close the overlay. */
  registerClose?: (close: () => void) => void;
}

export class FleetInspector implements Component {
  private selectedIndex = 0;
  private receipt: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: FleetInspectorDeps,
    private readonly tui: TUI,
    private readonly close: () => void,
  ) {
    this.timer = setInterval(
      () => this.tui.requestRender(),
      deps.refreshMs ?? FLEET_REFRESH_MS,
    );
  }

  private matches(data: string, action: FleetKeybindingAction): boolean {
    return this.deps.keybindings[action].some((key) =>
      matchesKey(data, key as KeyId),
    );
  }

  render(width: number): string[] {
    const rows = this.deps.buildRows();
    if (this.selectedIndex >= rows.length)
      this.selectedIndex = Math.max(0, rows.length - 1);
    return renderFleetLines(rows, this.selectedIndex, width, this.receipt);
  }

  invalidate(): void {
    // Rendered fresh from the registry on every frame.
  }

  handleInput(data: string): void {
    const rows = this.deps.buildRows();
    if (this.matches(data, "close")) {
      this.dispose();
      this.close();
      return;
    }
    if (this.matches(data, "refresh")) {
      this.tui.requestRender(true);
      return;
    }
    if (this.matches(data, "selectUp") && rows.length > 0) {
      this.selectedIndex = (this.selectedIndex - 1 + rows.length) % rows.length;
      this.tui.requestRender();
      return;
    }
    if (this.matches(data, "selectDown") && rows.length > 0) {
      this.selectedIndex = (this.selectedIndex + 1) % rows.length;
      this.tui.requestRender();
      return;
    }
    if (this.matches(data, "steer")) {
      void this.steerSelected(rows);
    }
  }

  private async steerSelected(rows: FleetRow[]): Promise<void> {
    const selected = rows[this.selectedIndex];
    if (
      !selected ||
      selected.kind !== "rule" ||
      selected.state === "idle" ||
      selected.state === "disabled"
    ) {
      this.receipt = "无可引导的进行中审计";
      this.tui.requestRender();
      return;
    }
    const message = await this.deps.promptSteer();
    if (!message) {
      this.receipt = "已取消";
    } else {
      const result = steerAudit(this.deps.registry, selected.name, message);
      this.receipt = result === "delivered" ? "已送达" : "已结束未能送达";
    }
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** Open the inspector overlay; non-TUI modes get a pointer to `/sentinel:list`. */
export async function openFleetInspector(
  ctx: ExtensionContext,
  deps: FleetInspectorDeps,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "pi-sentinel: /sentinel:fleet 仅在交互（TUI）模式下可用；请使用 /sentinel:list 查看清单",
      "warning",
    );
    return;
  }
  await ctx.ui.custom<undefined>(
    (tui, _theme, _keybindings, done) => {
      const inspector = new FleetInspector(deps, tui, () => done(undefined));
      deps.registerClose?.(() => {
        inspector.dispose();
        done(undefined);
      });
      return inspector;
    },
    { overlay: true },
  );
}

/** Keep the footer status and one-line widget in sync with running audits. */
export function updateSentinelStatus(
  ui: ExtensionContext["ui"],
  rows: FleetRow[],
): void {
  const running = rows.filter(
    (row) => row.kind === "rule" && row.state === "running",
  );
  ui.setStatus(
    "sentinel",
    running.length > 0 ? `▶${running.length}` : undefined,
  );
  ui.setWidget(
    "sentinel",
    running.length > 0
      ? [
          running
            .map(
              (row) =>
                `${row.name}${row.queuedCount > 0 ? `(+${row.queuedCount})` : ""}`,
            )
            .join("  "),
        ]
      : undefined,
  );
}
