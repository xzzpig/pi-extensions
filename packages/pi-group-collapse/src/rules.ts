/**
 * Pure member-selection rule types and matching (change task 1.5).
 *
 * Rules are the only way users steer which transcript items may join a
 * group. Matching is deliberately literal: exact, case-sensitive identity
 * for tools and custom message types, a raw-prefix match against the
 * notification's verified original text for notifications. No regex, no
 * wildcards, no user code — the first version of this contract has no
 * escape hatches that could silently widen membership.
 */

/** What a rule selects its candidate by. */
export type RuleKind = "tool" | "customMessage" | "notification";

/** `group` joins (and never splits) a run; `keep` stays visible and splits. */
export type RuleAction = "group" | "keep";

export type NotificationLevel = "info" | "warning" | "error";

export type Rule =
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly action: RuleAction;
    }
  | {
      readonly kind: "customMessage";
      readonly customType: string;
      readonly action: RuleAction;
    }
  | {
      readonly kind: "notification";
      readonly textPrefix: string;
      readonly level?: NotificationLevel;
      readonly action: RuleAction;
    };

/** Which member class a candidate belongs to; kinds never cross-match. */
export type CandidateKind = RuleKind;

export type ToolCandidate = {
  readonly kind: "tool";
  readonly name: string;
};

export type CustomMessageCandidate = {
  readonly kind: "customMessage";
  readonly customType: string;
};

export type NotificationCandidate = {
  readonly kind: "notification";
  /** The verified original text, ANSI stripped, un-trimmed. */
  readonly text: string;
  readonly level: NotificationLevel;
};

export type RuleCandidate =
  | ToolCandidate
  | CustomMessageCandidate
  | NotificationCandidate;

/**
 * The action a candidate resolves to. Kinds that no rule table can ever
 * select (assistant text, user messages, native diagnostics) never reach
 * this function — they are excluded before rule matching, not by rules.
 */
export type MemberAction = "group" | "keep";

export function actionForCandidate(
  rules: readonly Rule[],
  candidate: RuleCandidate,
): MemberAction {
  let action: MemberAction | undefined;
  for (const rule of rules) {
    if (matches(rule, candidate)) action = rule.action;
  }
  return action ?? defaultActionFor(candidate.kind);
}

/** Default when no rule hits: tools join, everything else stays visible. */
export function defaultActionFor(kind: CandidateKind): MemberAction {
  return kind === "tool" ? "group" : "keep";
}

function matches(rule: Rule, candidate: RuleCandidate): boolean {
  // Kinds are mutually exclusive discriminators: a tool rule never matches
  // a custom message that happens to share the name, and vice versa.
  if (rule.kind !== candidate.kind) return false;
  if (candidate.kind === "tool") {
    return rule.kind === "tool" && rule.name === candidate.name;
  }
  if (candidate.kind === "customMessage") {
    return (
      rule.kind === "customMessage" && rule.customType === candidate.customType
    );
  }
  if (rule.kind !== "notification") return false;
  if (rule.level !== undefined && rule.level !== candidate.level) {
    return false;
  }
  // Raw prefix on the verified original text: case-sensitive, no trim,
  // no substring search — the caller supplies the provenance.
  return candidate.text.startsWith(rule.textPrefix);
}

/**
 * Compile a rule table into lookup indexes so membership checks never scan
 * the full table per candidate. Notifications stay prefix-matched; they are
 * evaluated only when a notification's content version changes, never per
 * member render.
 */
export type CompiledRules = {
  readonly tools: ReadonlyMap<string, RuleAction>;
  readonly customMessages: ReadonlyMap<string, RuleAction>;
  readonly notifications: readonly {
    textPrefix: string;
    level?: NotificationLevel;
    action: RuleAction;
  }[];
};

export function compileRules(rules: readonly Rule[]): CompiledRules {
  const tools = new Map<string, RuleAction>();
  const customMessages = new Map<string, RuleAction>();
  const notifications: CompiledRules["notifications"][number][] = [];
  for (const rule of rules) {
    switch (rule.kind) {
      case "tool":
        // Last hit wins: later rules overwrite earlier entries.
        tools.set(rule.name, rule.action);
        break;
      case "customMessage":
        customMessages.set(rule.customType, rule.action);
        break;
      case "notification":
        notifications.push({
          textPrefix: rule.textPrefix,
          level: rule.level,
          action: rule.action,
        });
        break;
    }
  }
  return { tools, customMessages, notifications };
}

export function actionForCandidateCompiled(
  compiled: CompiledRules,
  candidate: RuleCandidate,
): MemberAction {
  switch (candidate.kind) {
    case "tool": {
      const action = compiled.tools.get(candidate.name);
      return action ?? "group";
    }
    case "customMessage": {
      const action = compiled.customMessages.get(candidate.customType);
      return action ?? "keep";
    }
    case "notification": {
      let action: MemberAction | undefined;
      for (const rule of compiled.notifications) {
        if (rule.level !== undefined && rule.level !== candidate.level) {
          continue;
        }
        if (candidate.text.startsWith(rule.textPrefix)) action = rule.action;
      }
      return action ?? "keep";
    }
  }
}
