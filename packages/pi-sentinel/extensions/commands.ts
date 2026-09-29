import type { AuditVerdict } from "./audit-loop.js";
import type { SentinelDefaults, SourcedRule } from "./config.js";
import type { HistoryEntry, RunnerStatus } from "./runner.js";

/**
 * `/sentinel:list` presentation and `/sentinel:test` result formatting.
 *
 * Pure assembly functions so the command handlers stay thin and the output is
 * unit-testable without a TUI.
 */

export interface RuleListEntry {
  name: string;
  trigger: string;
  mode: string;
  model: string;
  enabled: boolean;
  source: string;
  state: string;
  activeCount: number;
  queuedCount: number;
  coolingDown: boolean;
  lastVerdict?: AuditVerdict;
  lastCached?: boolean;
}

/** Human-readable trigger summary, including tool patterns and threshold. */
export function describeTrigger(rule: SourcedRule): string {
  const { type, tools, threshold } = rule.trigger;
  if (type === "tool_call" || type === "tool_result") {
    return tools && tools.length > 0 ? `${type} [${tools.join(", ")}]` : type;
  }
  if (type === "context_tokens") return `${type} @${threshold ?? 0}`;
  return type;
}

export function modelLabelFor(
  rule: SourcedRule,
  defaults: SentinelDefaults,
): string {
  if (rule.model) return rule.model;
  if (defaults.model) return defaults.model;
  return "(会话模型)";
}

/** Assemble the list view from rules, live runner status, and audit history. */
export function buildListEntries(
  rules: SourcedRule[],
  statuses: Map<string, RunnerStatus>,
  history: HistoryEntry[],
  defaults: SentinelDefaults,
  isDisabled: (name: string) => boolean = () => false,
): RuleListEntry[] {
  return rules.map((rule) => {
    const status = statuses.get(rule.name);
    const latest = [...history]
      .reverse()
      .find(
        (entry) => entry.ruleName === rule.name && entry.verdict !== undefined,
      );
    return {
      name: rule.name,
      trigger: describeTrigger(rule),
      mode: rule.mode,
      model: modelLabelFor(rule, defaults),
      enabled: rule.enabled !== false && !isDisabled(rule.name),
      source: rule.source,
      state: status?.state ?? "idle",
      activeCount: status?.activeCount ?? 0,
      queuedCount: status?.queuedCount ?? 0,
      coolingDown: (status?.cooldownUntil ?? 0) > Date.now(),
      lastVerdict: latest?.verdict,
      lastCached: latest?.cached,
    };
  });
}

/** Text overview used in non-interactive modes and as the list body. */
export function formatListText(entries: RuleListEntry[]): string {
  if (entries.length === 0) return "pi-sentinel: 未加载任何哨兵规则";
  const lines = [`pi-sentinel 哨兵清单（${entries.length} 条）`];
  for (const entry of entries) {
    const status = entry.enabled ? entry.state : "disabled";
    const extras: string[] = [];
    if (entry.activeCount > 0) extras.push(`running×${entry.activeCount}`);
    if (entry.queuedCount > 0) extras.push(`queued×${entry.queuedCount}`);
    if (entry.coolingDown) extras.push("cooldown");
    if (entry.lastVerdict) {
      extras.push(
        `最近=${entry.lastVerdict.verdict}${entry.lastCached ? "(cached)" : ""}: ${entry.lastVerdict.message}`,
      );
    }
    lines.push(
      `- ${entry.name} [${entry.trigger}] mode=${entry.mode} model=${entry.model} ${status} source=${entry.source}${
        extras.length > 0 ? ` (${extras.join(", ")})` : ""
      }`,
    );
  }
  return lines.join("\n");
}

/** Compact one-line label used as the interactive select option. */
export function formatListOption(entry: RuleListEntry): string {
  const status = entry.enabled ? entry.state : "disabled";
  const extras: string[] = [];
  if (entry.coolingDown) extras.push("cooldown");
  if (entry.lastVerdict) {
    extras.push(
      `最近=${entry.lastVerdict.verdict}${entry.lastCached ? "(cached)" : ""}`,
    );
  }
  return `${entry.name} [${entry.trigger}] ${entry.mode} model=${entry.model} ${status} (${
    entry.source
  })${extras.length > 0 ? ` ${extras.join(" ")}` : ""}`;
}

export interface TestRunSummary {
  ruleName: string;
  verdict?: AuditVerdict;
  failureReason?: string;
  model?: string;
  durationMs: number;
  unresolvedPaths?: string[];
}

/** `/sentinel:test` output. */
export function formatTestResult(summary: TestRunSummary): string {
  if (summary.verdict) {
    return [
      `pi-sentinel 试运行：规则 "${summary.ruleName}"`,
      `裁决：${summary.verdict.verdict}`,
      `说明：${summary.verdict.message}`,
      `模型：${summary.model ?? "(未知)"}`,
      `耗时：${summary.durationMs}ms`,
    ].join("\n");
  }
  return [
    `pi-sentinel 试运行：规则 "${summary.ruleName}"`,
    `结果：审计失败`,
    `原因：${summary.failureReason ?? "未知"}`,
    `耗时：${summary.durationMs}ms`,
  ].join("\n");
}
