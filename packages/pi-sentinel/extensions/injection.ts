import { createHash } from "node:crypto";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import type { AuditVerdict, VerdictLevel } from "./audit-loop.js";
import type { SourcedRule } from "./config.js";

/**
 * Background finding injection.
 *
 * Findings are delivered as `pi-sentinel-finding` custom messages. Delivery is
 * dual-path: while the main loop is streaming they are sent as a steer message
 * (visible at the next LLM call boundary), and while it is idle they are sent
 * without `deliverAs` so they persist immediately. `nextTurn` is never used
 * because it can strand an idle finding until the user submits again.
 *
 * Dedupe uses a normalized content hash with a cooldown window; cooldown state
 * is session runtime state and is cleared on session switch.
 */

export const FINDING_CUSTOM_TYPE = "pi-sentinel-finding";

export interface FindingDetails {
  rule: string;
  verdict: VerdictLevel;
  message: string;
  kind: "audit";
  at: number;
  durationMs?: number;
}

/** Message shape accepted by `pi.sendMessage`. */
export interface FindingMessage {
  customType: string;
  content: string;
  display: boolean;
  details: FindingDetails;
}

/** Minimal target surface (the real `pi` API satisfies it). */
export interface SendMessageTarget {
  sendMessage(
    message: FindingMessage,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  isIdle(): boolean;
}

/** Normalize a finding message for dedupe: lowercase + collapsed whitespace. */
export function normalizeMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Dedupe key: rule + verdict + normalized message. */
export function findingKey(
  rule: string,
  verdict: VerdictLevel,
  message: string,
): string {
  return createHash("sha256")
    .update(`${rule}\n${verdict}\n${normalizeMessage(message)}`, "utf8")
    .digest("hex");
}

/** Human-readable finding text injected into the session. */
export function renderFindingContent(
  ruleName: string,
  verdict: AuditVerdict,
): string {
  return `[pi-sentinel][${verdict.verdict}] 规则 "${ruleName}"：${verdict.message}`;
}

export type InjectionOutcome = "injected" | "deduped" | "silent";

export interface InjectionOptions {
  now?: () => number;
  /** Called when a duplicate finding is suppressed (recorded as deduped). */
  onDeduped?: (rule: SourcedRule, verdict: AuditVerdict) => void;
}

export class FindingInjector {
  private readonly cooldowns = new Map<
    string,
    { ruleName: string; at: number }
  >();

  constructor(
    private readonly target: SendMessageTarget,
    private readonly options: InjectionOptions = {},
  ) {}

  /**
   * Inject a finding unless the rule says otherwise, the verdict is `pass`, or
   * an equivalent finding is still inside its cooldown window.
   */
  inject(
    rule: SourcedRule,
    verdict: AuditVerdict,
    cooldownMs: number,
    durationMs?: number,
  ): InjectionOutcome {
    if (verdict.verdict === "pass") return "silent";

    const now = this.options.now ? this.options.now() : Date.now();
    const key = findingKey(rule.name, verdict.verdict, verdict.message);

    if (rule.dedupe !== false) {
      const last = this.cooldowns.get(key);
      if (last !== undefined && now - last.at < cooldownMs) {
        this.options.onDeduped?.(rule, verdict);
        return "deduped";
      }
      this.cooldowns.set(key, { ruleName: rule.name, at: now });
    }

    const details: FindingDetails = {
      rule: rule.name,
      verdict: verdict.verdict,
      message: verdict.message,
      kind: "audit",
      at: now,
      durationMs,
    };
    const message: FindingMessage = {
      customType: FINDING_CUSTOM_TYPE,
      content: renderFindingContent(rule.name, verdict),
      display: true,
      details,
    };

    // Dual-path delivery: steer while streaming, plain send while idle.
    this.target.sendMessage(
      message,
      this.target.isIdle() ? undefined : { deliverAs: "steer" },
    );
    return "injected";
  }

  /** Session switch/shutdown: forget cooldowns. */
  clear(): void {
    this.cooldowns.clear();
  }

  /**
   * Hot reload: only the replaced/removed rule's dedupe cooldowns expire.
   * Unchanged rules keep theirs, so an unrelated config change cannot make an
   * equivalent finding inject twice inside the window.
   */
  invalidateRule(ruleName: string): number {
    let removed = 0;
    for (const [key, entry] of this.cooldowns) {
      if (entry.ruleName === ruleName) {
        this.cooldowns.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.cooldowns.size;
  }
}

/** Renderer registered for `pi-sentinel-finding` messages. */
export const findingRenderer: MessageRenderer<FindingDetails> = (
  message,
  _options,
  _theme,
) => {
  const details = message.details;
  const verdict = details?.verdict ?? "warn";
  const rule = details?.rule ?? "sentinel";
  const duration =
    details?.durationMs !== undefined ? ` (${details.durationMs}ms)` : "";
  const badge = `[pi-sentinel][${verdict.toUpperCase()}]`;
  const header = `${badge} ${rule}${duration}`;
  const body =
    details?.message ??
    (typeof message.content === "string" ? message.content : "");

  return {
    render(width: number): string[] {
      const lines = [header, ...body.split("\n").map((line) => `  ${line}`)];
      return lines.map((line) =>
        line.length > width ? line.slice(0, width) : line,
      );
    },
    invalidate(): void {
      // Stateless renderer: nothing to invalidate.
    },
  };
};
