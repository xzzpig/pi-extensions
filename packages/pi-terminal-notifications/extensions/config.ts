import { readFileSync } from "node:fs";
import { join } from "node:path";

export type NotificationProtocol = "osc9" | "osc99" | "osc777";

export interface TerminalNotificationConfig {
  fallback: NotificationProtocol;
  termPrograms: Record<string, NotificationProtocol>;
}

export const DEFAULT_NOTIFICATION_PROTOCOL: NotificationProtocol = "osc99";

export const DEFAULT_TERM_PROGRAM_PROTOCOLS: Readonly<
  Record<string, NotificationProtocol>
> = {
  WarpTerminal: "osc777",
  WezTerm: "osc9",
  ghostty: "osc9",
  "iTerm.app": "osc9",
  kitty: "osc99",
  vscode: "osc99",
};

const PROTOCOLS = new Set<NotificationProtocol>(["osc9", "osc99", "osc777"]);

export function getTerminalNotificationConfigPath(agentDir: string): string {
  return join(
    agentDir,
    "extensions",
    "pi-terminal-notifications",
    "config.json",
  );
}

export function createDefaultTerminalNotificationConfig(): TerminalNotificationConfig {
  return {
    fallback: DEFAULT_NOTIFICATION_PROTOCOL,
    termPrograms: { ...DEFAULT_TERM_PROGRAM_PROTOCOLS },
  };
}

export function parseTerminalNotificationConfig(
  value: unknown,
): TerminalNotificationConfig {
  const config = createDefaultTerminalNotificationConfig();
  if (!isRecord(value)) {
    return config;
  }

  const fallback = notificationProtocol(value.fallback);
  if (fallback) {
    config.fallback = fallback;
  }

  if (!isRecord(value.termPrograms)) {
    return config;
  }

  for (const [termProgram, rawProtocol] of Object.entries(value.termPrograms)) {
    const normalizedTermProgram = termProgram.trim();
    const protocol = notificationProtocol(rawProtocol);
    if (normalizedTermProgram && protocol) {
      config.termPrograms[normalizedTermProgram] = protocol;
    }
  }

  return config;
}

export function loadTerminalNotificationConfig(
  agentDir: string,
): TerminalNotificationConfig {
  try {
    const raw = readFileSync(
      getTerminalNotificationConfigPath(agentDir),
      "utf8",
    );
    return parseTerminalNotificationConfig(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultTerminalNotificationConfig();
  }
}

export function resolveNotificationProtocol(
  config: TerminalNotificationConfig,
  termProgram: string | undefined,
): NotificationProtocol {
  const normalizedTermProgram = termProgram?.trim();
  if (!normalizedTermProgram) {
    return config.fallback;
  }

  const exactMatch = config.termPrograms[normalizedTermProgram];
  if (exactMatch) {
    return exactMatch;
  }

  const caseInsensitiveMatch = Object.entries(config.termPrograms).find(
    ([configuredTermProgram]) =>
      configuredTermProgram.toLowerCase() ===
      normalizedTermProgram.toLowerCase(),
  );
  return caseInsensitiveMatch?.[1] ?? config.fallback;
}

function notificationProtocol(
  value: unknown,
): NotificationProtocol | undefined {
  return typeof value === "string" &&
    PROTOCOLS.has(value as NotificationProtocol)
    ? (value as NotificationProtocol)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
