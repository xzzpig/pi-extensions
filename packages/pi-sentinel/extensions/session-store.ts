import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { validateRule, type SentinelRule, type SourcedRule } from "./config.js";

/**
 * Session-level sentinel configuration, persisted as an append-only op-log.
 *
 * Each user action (add / disable / enable / remove) appends one custom entry.
 * Replaying the active branch rebuilds the session rule set and mask table, so
 * a resumed session restores its configuration and a fork inherits it through
 * entry copying. Session config is not part of runtime-state reset.
 */

export const SESSION_CONFIG_CUSTOM_TYPE = "pi-sentinel-session-config";

export type SessionConfigOp =
  | { op: "add-rule"; rule: SentinelRule }
  | { op: "disable"; name: string }
  | { op: "enable"; name: string }
  | { op: "remove"; name: string };

const OP_NAMES = new Set(["add-rule", "disable", "enable", "remove"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a replayed op, validating any embedded rule with the shared validator. */
export function parseSessionOp(value: unknown): SessionConfigOp | null {
  if (!isRecord(value)) return null;
  const op = value.op;
  if (typeof op !== "string" || !OP_NAMES.has(op)) return null;
  if (op === "add-rule") {
    const result = validateRule(value.rule);
    if (!result.ok) return null;
    return { op: "add-rule", rule: result.rule };
  }
  if (typeof value.name !== "string" || value.name.length === 0) return null;
  return { op: op as "disable" | "enable" | "remove", name: value.name };
}

export class SessionConfigStore {
  private readonly rules = new Map<string, SentinelRule>();
  private readonly disabled = new Set<string>();

  /** Rebuild state from the active branch's entries (idempotent). */
  replay(entries: readonly SessionEntry[]): void {
    this.rules.clear();
    this.disabled.clear();
    for (const entry of entries) {
      if (
        entry.type !== "custom" ||
        entry.customType !== SESSION_CONFIG_CUSTOM_TYPE
      )
        continue;
      const op = parseSessionOp(entry.data);
      if (!op) continue;
      this.apply(op);
    }
  }

  apply(op: SessionConfigOp): void {
    switch (op.op) {
      case "add-rule":
        this.rules.set(op.rule.name, op.rule);
        this.disabled.delete(op.rule.name);
        break;
      case "disable":
        this.disabled.add(op.name);
        break;
      case "enable":
        this.disabled.delete(op.name);
        break;
      case "remove":
        this.rules.delete(op.name);
        // A name mask must not outlive the rule it was masking, otherwise a
        // restored inherited namesake would stay disabled forever.
        this.disabled.delete(op.name);
        break;
    }
  }

  sessionRules(): SourcedRule[] {
    return [...this.rules.values()].map((rule) => ({
      ...rule,
      source: "session" as const,
    }));
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  hasSessionRule(name: string): boolean {
    return this.rules.has(name);
  }

  disabledNames(): string[] {
    return [...this.disabled];
  }

  clear(): void {
    this.rules.clear();
    this.disabled.clear();
  }
}
