import {
  isKittyProtocolActive,
  matchesKey,
  type KeyId,
} from "@earendil-works/pi-tui";
import { normalizeGoalKey } from "./goal-controls.ts";

// Legacy control/printable inputs can match multiple key IDs, including Pi's
// terminal-specific interpretations of ESC followed by a single byte. Ask
// the installed decoder rather than keeping a second table of those aliases.
const rawInputs = Array.from({ length: 128 }, (_, code) =>
  String.fromCharCode(code),
).flatMap((byte) => [byte, `\x1b${byte}`]);
const keyMatches = new Map<
  KeyId,
  { raw: readonly string[]; supported: boolean }
>();
let rawMode = "";

function keyMatch(key: KeyId): { raw: readonly string[]; supported: boolean } {
  // Pi distinguishes plain Backspace from Ctrl+Backspace on local Windows Terminal.
  const mode = `${isKittyProtocolActive()}:${matchesKey("\b", "backspace")}`;
  if (rawMode !== mode || keyMatches.size >= 128) {
    keyMatches.clear();
    rawMode = mode;
  }
  let match = keyMatches.get(key);
  if (!match) {
    const raw = rawInputs.filter((input) => matchesKey(input, key));
    match = {
      raw,
      supported:
        raw.length > 0 ||
        namedKeyInputs(key).some((input) => matchesKey(input, key)),
    };
    keyMatches.set(key, match);
  }
  return match;
}

const modifiers = { shift: 1, alt: 2, ctrl: 4, super: 8 } as const;

function keyParts(key: KeyId): {
  base: string;
  code: number | undefined;
  mask: number;
} {
  const prefix = key.match(/^(?:(?:shift|alt|ctrl|super)\+)*/)?.[0] ?? "";
  let mask = 0;
  for (const [name, bit] of Object.entries(modifiers)) {
    if (prefix.includes(`${name}+`)) mask |= bit;
  }
  const base = key.slice(prefix.length);
  return {
    base,
    code:
      base.length === 1
        ? base.charCodeAt(0)
        : base === "space"
          ? 32
          : undefined,
    mask,
  };
}

const controlCodes = new Map([
  ["escape", 27],
  ["tab", 9],
  ["enter", 13],
  ["backspace", 127],
]);
const csiFinal = new Map([
  ["up", "A"],
  ["down", "B"],
  ["right", "C"],
  ["left", "D"],
  ["end", "F"],
  ["home", "H"],
]);
const csiTilde = new Map([
  ["insert", 2],
  ["delete", 3],
  ["pageUp", 5],
  ["pageDown", 6],
]);
const functionCodes = [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24];

/** Probe ordinary terminal encodings; being valid configuration syntax does not mean Pi can match it. */
function namedKeyInputs(key: KeyId): string[] {
  const { base, code, mask } = keyParts(key);
  const modifier = mask + 1;
  const point = code ?? controlCodes.get(base);
  if (point !== undefined)
    return [`\x1b[${point};${modifier}u`, `\x1b[27;${modifier};${point}~`];
  const final = csiFinal.get(base);
  if (final) return [`\x1b[1;${modifier}${final}`];
  const tilde =
    csiTilde.get(base) ??
    (/^f(?:[1-9]|1[012])$/.test(base)
      ? functionCodes[Number(base.slice(1)) - 1]
      : undefined);
  if (tilde !== undefined)
    return [mask ? `\x1b[${tilde};${modifier}~` : `\x1b[${tilde}~`];
  return base === "clear" ? ["\x1b[E", "\x1b[e", "\x1bOe"] : [];
}

export function dashboardKeyIsSupported(key: KeyId): boolean {
  return keyMatch(normalizeGoalKey(key) ?? key).supported;
}

function structuredOverlap(first: KeyId, second: KeyId): boolean {
  const a = keyParts(first);
  const b = keyParts(second);
  if (a.code === undefined || b.code === undefined) return false;
  const matchesBoth = (input: string) =>
    matchesKey(input, first) && matchesKey(input, second);
  // CSI-u can report a separate base-layout code. Without the keyboard's
  // layout, ask the decoder whether that form would make the hint ambiguous.
  if (a.mask === b.mask) {
    return (
      matchesBoth(`\x1b[${a.code}::${b.code};${a.mask + 1}u`) ||
      matchesBoth(`\x1b[${b.code}::${a.code};${a.mask + 1}u`)
    );
  }
  if ((a.mask ^ b.mask) !== modifiers.shift) return false;
  const [physical, logical] = a.mask & modifiers.shift ? [a, b] : [b, a];
  const modifier = physical.mask + 1;
  // The shifted character is supplied by the user's layout, not a US table.
  // Pi itself determines which logical characters actually match these forms.
  return (
    matchesBoth(`\x1b[${physical.code}:${logical.code};${modifier}u`) ||
    matchesBoth(`\x1b[27;${modifier};${logical.code}~`)
  );
}

export function dashboardKeyOverlaps(key: KeyId, earlier: KeyId): boolean {
  const candidate = normalizeGoalKey(key) ?? key;
  const claimed = normalizeGoalKey(earlier) ?? earlier;
  return (
    candidate === claimed ||
    keyMatch(candidate).raw.some((input) => matchesKey(input, claimed)) ||
    structuredOverlap(candidate, claimed)
  );
}
