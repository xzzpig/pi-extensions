/**
 * group-collapse.json loading and strict validation (change task 1.4).
 *
 * Two layers, fixed resolution order:
 *
 * - global: `<agentDir>/group-collapse.json` (the host's actual agent
 *   directory, so isolated test runs with PI_CODING_AGENT_DIR just work);
 * - project: `<cwd>/.pi/group-collapse.json`, no parent search.
 *
 * A project file that provides a `rules` field replaces the global table
 * entirely — never concatenated. A missing `rules` field inherits the
 * global table; `rules: []` restores the built-in defaults explicitly.
 *
 * Each layer is validated as a whole: invalid JSON, unknown fields, wrong
 * kinds/actions, or empty selection conditions reject that entire layer,
 * falling back to the valid upper layer (or the defaults). Every rejection
 * is reported once with its file and reason so the runtime can surface a
 * deduplicated notice; the notice text itself never participates in
 * matching. Missing files are not errors.
 *
 * The returned snapshot is immutable and detached from the files: nothing
 * watches, nothing re-reads, nothing is ever written back. Only a fresh
 * load (extension load, `/reload`) sees new content.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NotificationLevel, Rule, RuleAction, RuleKind } from "./rules.ts";

export const CONFIG_FILE_NAME = "group-collapse.json";

export type ConfigIssue = {
  readonly file: string;
  readonly reason: string;
};

export type GroupCollapseSnapshot = {
  /** The effective rule table (empty = built-in defaults). */
  readonly rules: readonly Rule[];
  /** Which layer the effective table came from. */
  readonly source: "defaults" | "global" | "project";
  /** Rejected layers, in resolution order, for deduplicated notices. */
  readonly issues: readonly ConfigIssue[];
};

export type ConfigLoadOptions = {
  /** Project directory (the extension context cwd). */
  readonly cwd: string;
  /**
   * Agent directory override. Defaults to the host's `getAgentDir()`, which
   * honors PI_CODING_AGENT_DIR for isolated runs.
   */
  readonly agentDir?: string;
  /**
   * File reader injection point for tests. Returning undefined means
   * "missing file"; throwing is treated as unreadable.
   */
  readonly readFile?: (path: string) => string | undefined;
};

const ALLOWED_ACTIONS: readonly RuleAction[] = ["group", "keep"];
const ALLOWED_LEVELS: readonly NotificationLevel[] = [
  "info",
  "warning",
  "error",
];

const FIELDS_BY_KIND: Record<RuleKind, readonly string[]> = {
  tool: ["kind", "name", "action"],
  customMessage: ["kind", "customType", "action"],
  notification: ["kind", "textPrefix", "level", "action"],
};

type LayerResult =
  | { readonly status: "missing" }
  | { readonly status: "rejected"; readonly reasons: readonly string[] }
  | {
      readonly status: "ok";
      readonly rules: readonly Rule[] | undefined;
    };

export function loadGroupCollapseConfig(
  options: ConfigLoadOptions,
): GroupCollapseSnapshot {
  const readFile =
    options.readFile ??
    ((path: string): string | undefined => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    });
  const agentDir = options.agentDir ?? getAgentDir();
  const globalPath = join(agentDir, CONFIG_FILE_NAME);
  const projectPath = join(join(options.cwd, ".pi"), CONFIG_FILE_NAME);

  const issues: ConfigIssue[] = [];

  const globalLayer = readLayer(globalPath, readFile, "rules", (reason) =>
    issues.push({ file: globalPath, reason }),
  );
  const projectLayer = readLayer(projectPath, readFile, "rules", (reason) =>
    issues.push({ file: projectPath, reason }),
  );

  // Project rules replace the global table entirely when present; a missing
  // field inherits, and a rejected layer falls back to the valid one.
  const projectRules =
    projectLayer.status === "ok" ? projectLayer.rules : undefined;
  if (projectRules !== undefined) {
    return freeze({ rules: projectRules, source: "project", issues });
  }
  if (globalLayer.status === "ok" && globalLayer.rules !== undefined) {
    return freeze({ rules: globalLayer.rules, source: "global", issues });
  }
  return freeze({ rules: [], source: "defaults", issues });
}

function readLayer(
  path: string,
  readFile: (path: string) => string | undefined,
  topLevelField: "rules",
  report: (reason: string) => void,
): LayerResult {
  let text: string | undefined;
  try {
    text = readFile(path);
  } catch (error) {
    report(`unreadable file: ${errorMessage(error)}`);
    return { status: "rejected", reasons: [] };
  }
  if (text === undefined) return { status: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    report(`invalid JSON: ${errorMessage(error)}`);
    return { status: "rejected", reasons: [] };
  }
  if (!isPlainObject(parsed)) {
    report("top level must be a JSON object");
    return { status: "rejected", reasons: [] };
  }
  const unknownKeys = Object.keys(parsed).filter(
    (key) => key !== topLevelField,
  );
  if (unknownKeys.length > 0) {
    report(`unknown top-level field(s): ${unknownKeys.join(", ")}`);
    return { status: "rejected", reasons: [] };
  }
  const rawRules = (parsed as Record<string, unknown>)[topLevelField];
  if (rawRules === undefined) {
    // Valid file without a rules field: the layer inherits the upper one.
    return { status: "ok", rules: undefined };
  }
  if (!Array.isArray(rawRules)) {
    report(`"${topLevelField}" must be an array`);
    return { status: "rejected", reasons: [] };
  }

  const reasons: string[] = [];
  const rules: Rule[] = [];
  rawRules.forEach((entry, index) => {
    const rule = parseRule(entry);
    if (rule.ok) {
      rules.push(rule.rule);
    } else {
      reasons.push(`rules[${index}]: ${rule.reason}`);
    }
  });
  if (reasons.length > 0) {
    for (const reason of reasons) report(reason);
    return { status: "rejected", reasons };
  }
  return { status: "ok", rules };
}

type ParsedRule =
  | { readonly ok: true; readonly rule: Rule }
  | { readonly ok: false; readonly reason: string };

function parseRule(entry: unknown): ParsedRule {
  if (!isPlainObject(entry)) return fail("must be an object");
  const record = entry as Record<string, unknown>;

  const kind = record.kind;
  if (typeof kind !== "string" || !isRuleKind(kind)) {
    return fail(`kind must be one of tool, customMessage, notification`);
  }
  const allowed = FIELDS_BY_KIND[kind];
  const present = Object.keys(record).sort();
  const unknownFields = present.filter((key) => !allowed.includes(key));
  if (unknownFields.length > 0) {
    return fail(
      `unknown field(s) for kind ${kind}: ${unknownFields.join(", ")}`,
    );
  }
  for (const required of allowed) {
    if (required !== "level" && !(required in record)) {
      return fail(`missing required field "${required}"`);
    }
  }

  const action = record.action;
  if (
    typeof action !== "string" ||
    !ALLOWED_ACTIONS.includes(action as RuleAction)
  ) {
    return fail(`action must be one of group, keep`);
  }

  switch (kind) {
    case "tool": {
      const name = record.name;
      if (!isNonEmptyString(name)) {
        return fail(`name must be a non-empty string`);
      }
      return ok({ kind: "tool", name, action: action as RuleAction });
    }
    case "customMessage": {
      const customType = record.customType;
      if (!isNonEmptyString(customType)) {
        return fail(`customType must be a non-empty string`);
      }
      return ok({
        kind: "customMessage",
        customType,
        action: action as RuleAction,
      });
    }
    case "notification": {
      const textPrefix = record.textPrefix;
      if (!isNonEmptyString(textPrefix)) {
        return fail(`textPrefix must be a non-empty string`);
      }
      if ("level" in record) {
        const level = record.level;
        if (
          typeof level !== "string" ||
          !ALLOWED_LEVELS.includes(level as NotificationLevel)
        ) {
          return fail(`level must be one of info, warning, error`);
        }
        return ok({
          kind: "notification",
          textPrefix,
          level: level as NotificationLevel,
          action: action as RuleAction,
        });
      }
      return ok({
        kind: "notification",
        textPrefix,
        action: action as RuleAction,
      });
    }
  }
}

function isRuleKind(value: string): value is RuleKind {
  return (
    value === "tool" || value === "customMessage" || value === "notification"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok(rule: Rule): ParsedRule {
  return { ok: true, rule };
}

function fail(reason: string): ParsedRule {
  return { ok: false, reason };
}

function freeze(snapshot: GroupCollapseSnapshot): GroupCollapseSnapshot {
  return Object.freeze({
    ...snapshot,
    rules: Object.freeze([...snapshot.rules]),
    issues: Object.freeze([...snapshot.issues]),
  });
}
