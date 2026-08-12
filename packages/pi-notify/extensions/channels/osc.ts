/**
 * OSC terminal notification channel.
 *
 * Protocol auto-selection: KITTY_WINDOW_ID present -> OSC 99; otherwise the
 * user-extended TERM_PROGRAM mapping; otherwise the configured fallback
 * (default OSC 9). Sequences are only ever written in TUI mode (enforced by
 * the router). All payload text is sanitized against terminal control
 * characters and OSC separators, and limited to 512 code points.
 */
import type { NotificationProtocol, OscChannelConfig } from "../config.js";
import {
  formatOscBody,
  notificationTitle,
  osc9BodyWithTitle,
  OSC_MAX_BODY_CHARS,
} from "../messages.js";
import type { InternalNotificationEvent } from "../events.js";
import { sanitizeLabel } from "../events.js";

export type OscWriter = (sequence: string) => unknown;

export interface OscSenderOptions extends OscChannelConfig {
  termProgram: string | undefined;
  kittyWindowId: string | undefined;
  write?: OscWriter;
}

export interface OscSender {
  send(event: InternalNotificationEvent): void;
  resolveProtocol(): NotificationProtocol;
}

let identifierCounter = 0;

export function createOscSender(options: OscSenderOptions): OscSender {
  const write =
    options.write ?? ((sequence: string) => process.stdout.write(sequence));

  return {
    resolveProtocol() {
      return resolveOscProtocol(options);
    },
    send(event) {
      const protocol = resolveOscProtocol(options);
      const title = notificationTitle(event.id);
      const body = sanitizeOscText(formatOscBody(event));
      const identifier = uniqueIdentifier(event, options.kittyWindowId);

      writeSequences(write, protocol, { title, body, identifier });
    },
  };
}

export function resolveOscProtocol(
  options: Pick<
    OscSenderOptions,
    "termProgram" | "kittyWindowId" | "termPrograms" | "fallback"
  >,
): NotificationProtocol {
  if (options.kittyWindowId) {
    return "osc99";
  }

  const termProgram = options.termProgram?.trim();
  if (termProgram) {
    const exact = options.termPrograms[termProgram];
    if (exact) {
      return exact;
    }
    const caseInsensitive = Object.entries(options.termPrograms).find(
      ([configured]) => configured.toLowerCase() === termProgram.toLowerCase(),
    );
    if (caseInsensitive) {
      return caseInsensitive[1];
    }
  }

  return options.fallback;
}

export interface OscNotificationText {
  title: string;
  body: string;
  identifier: string;
}

/** Build the escape sequence(s) for one notification; undefined when empty. */
export function buildOscSequences(
  protocol: NotificationProtocol,
  text: OscNotificationText,
): string[] {
  const title = sanitizeOscText(text.title);
  const body = sanitizeOscText(text.body);
  if (!body && !title) {
    return [];
  }

  switch (protocol) {
    case "osc9":
      // OSC 9 has no title slot; the title is prepended to the body.
      if (!body) {
        return [];
      }
      return [`\x1b]9;${osc9BodyWithTitle(title, body)}\x1b\\`];
    case "osc99":
      // kitty format: <ESC>]99;metadata;payload<ESC>\. One sequence carries
      // one text chunk; identifier uniqueness is required for replacement.
      return [
        ...(title
          ? [`\x1b]99;i=${text.identifier}:p=title;${title}\x1b\\`]
          : []),
        ...(body ? [`\x1b]99;i=${text.identifier}:p=body;${body}\x1b\\`] : []),
      ];
    case "osc777":
      return [`\x1b]777;notify;${title || "Pi"};${body}\x1b\\`];
    default:
      return [];
  }
}

export function emitOscSequences(
  sequences: string[],
  write: OscWriter,
): boolean {
  for (const sequence of sequences) {
    try {
      write(sequence);
    } catch {
      return false;
    }
  }
  return sequences.length > 0;
}

export function sanitizeOscText(value: string): string {
  const printable = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    // Same policy as `sanitizeLabel`: printable ASCII plus non-ASCII above
    // U+00A0, excluding bidi/format control characters (zero-width, bidi
    // overrides, BOM, soft hyphen) so a label cannot reorder rendered text.
    if (
      ((codePoint >= 0x20 && codePoint < 0x7f) || codePoint >= 0xa0) &&
      !isBidiOrFormatCharacter(character)
    ) {
      return character;
    }
    return " ";
  })
    .join("")
    .replaceAll(";", ":")
    .replaceAll(/\s+/g, " ")
    .trim();

  return Array.from(printable).slice(0, OSC_MAX_BODY_CHARS).join("");
}

function isBidiOrFormatCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x200b && codePoint <= 0x206f) || // ZWSP/ZWNJ/bidi controls
    codePoint === 0xad || // soft hyphen
    codePoint === 0xfeff // BOM / zero-width no-break space
  );
}

function writeSequences(
  write: OscWriter,
  protocol: NotificationProtocol,
  text: OscNotificationText,
): void {
  const sequences = buildOscSequences(protocol, text);
  emitOscSequences(sequences, write);
}

/** Unique per-notification identifier (OSC 99 replacement semantics). */
function uniqueIdentifier(
  event: InternalNotificationEvent,
  kittyWindowId: string | undefined,
): string {
  identifierCounter += 1;
  const raw = `${event.id}-${event.timestamp}-${identifierCounter}${kittyWindowId ? `-k${kittyWindowId}` : ""}`;
  return sanitizeIdentifier(raw);
}

function sanitizeIdentifier(value: string): string {
  const identifier = sanitizeLabel(value)
    .replaceAll(/[^A-Za-z0-9._-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  return identifier || "pi";
}
