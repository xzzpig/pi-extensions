import { createHash } from "node:crypto";
import type { AuditOutcome, AuditVerdict } from "./audit-loop.js";
import type { SentinelRule } from "./config.js";

/**
 * In-process verdict cache.
 *
 * The key mixes the rule name, a hash of the rule definition, the rendered
 * prompt, and the scope text, so replacing a same-name rule invalidates its old
 * entries without any extra bookkeeping. Only successful verdicts are stored;
 * audit failures are never cached (the runner pairs them with a negative
 * cooldown instead).
 */

export interface CacheEntry {
  ruleName: string;
  verdict: AuditVerdict;
  at: number;
}

/** Stable hash of a rule definition (key order independent). */
export function hashRuleDefinition(rule: SentinelRule): string {
  const ordered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    ordered[key] = value;
  }
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** Full cache key: rule name + rule definition hash + prompt + scope. */
export function cacheKey(
  ruleName: string,
  rule: SentinelRule,
  renderedPrompt: string,
  scopeText: string,
): string {
  return createHash("sha256")
    .update(
      [ruleName, hashRuleDefinition(rule), renderedPrompt, scopeText].join(
        "\n",
      ),
      "utf8",
    )
    .digest("hex");
}

export class VerdictCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Return the cached verdict when present and still within its TTL. */
  get(key: string, ttlMs: number): AuditVerdict | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at >= ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.verdict;
  }

  /**
   * Store an audit outcome. Only `status: "verdict"` outcomes are cached;
   * failures and cancellations are ignored. Returns whether anything was stored.
   */
  put(key: string, ruleName: string, outcome: AuditOutcome): boolean {
    if (outcome.status !== "verdict" || !outcome.verdict) return false;
    this.entries.set(key, {
      ruleName,
      verdict: outcome.verdict,
      at: this.now(),
    });
    return true;
  }

  /** Drop every entry belonging to a rule (hot replace/remove). */
  invalidateRule(ruleName: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.ruleName === ruleName) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Clear the whole cache (session switch/shutdown). */
  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
