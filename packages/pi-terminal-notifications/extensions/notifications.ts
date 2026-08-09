import type { NotificationProtocol } from "./config.js";

const MAX_NOTIFICATION_CHARS = 256;

export interface TerminalNotification {
  body: string;
  identifier: string;
  title: string;
}

export type TerminalWriter = (sequence: string) => unknown;

export function sanitizeOscText(value: string): string {
  const printable = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0x20 && codePoint < 0x7f) || codePoint >= 0xa0) {
      return character;
    }

    return " ";
  })
    .join("")
    .replaceAll(";", ":")
    .replaceAll(/\s+/g, " ")
    .trim();

  return Array.from(printable).slice(0, MAX_NOTIFICATION_CHARS).join("");
}

export function buildTerminalNotification(
  protocol: NotificationProtocol,
  notification: TerminalNotification,
): string | undefined {
  const title = sanitizeOscText(notification.title);
  const body = sanitizeOscText(notification.body) || title;
  if (!body) {
    return undefined;
  }

  switch (protocol) {
    case "osc9":
      return `\x1b]9;${body}\x1b\\`;
    case "osc99":
      return `\x1b]99;i=${sanitizeIdentifier(notification.identifier)}:p=body;${body}\x1b\\`;
    case "osc777":
      return `\x1b]777;notify;${title || "Pi"};${body}\x1b\\`;
    default:
      return undefined;
  }
}

export function emitTerminalNotification(
  protocol: NotificationProtocol,
  notification: TerminalNotification,
  write: TerminalWriter = (sequence) => process.stdout.write(sequence),
): boolean {
  const sequence = buildTerminalNotification(protocol, notification);
  if (!sequence) {
    return false;
  }

  try {
    write(sequence);
    return true;
  } catch {
    return false;
  }
}

function sanitizeIdentifier(value: string): string {
  const identifier = sanitizeOscText(value)
    .replaceAll(/[^A-Za-z0-9._-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  return identifier || "pi";
}
