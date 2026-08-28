/**
 * Standalone test for pi-vibeguard core engine (zero deps).
 * Run: node --experimental-strip-types test-engine.ts
 * Or:  npx tsx test-engine.ts
 */

import { createHmac, randomBytes } from "node:crypto";

// ===== Minimal copies of core functions for testing =====

function sanitizeCategory(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "TEXT";
  const upper = raw.toUpperCase();
  const safe = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_");
  if (!safe) return "TEXT";
  return safe;
}

function toHexLower(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("hex");
}

interface BuiltinRule { pattern: string; flags: string; category: string; }
const BUILTIN: Map<string, BuiltinRule> = new Map([
  ["email", { pattern: String.raw`[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`, flags: "i", category: "EMAIL" }],
  ["china_phone", { pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`, flags: "", category: "CHINA_PHONE" }],
  ["uuid", { pattern: String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}`, flags: "", category: "UUID" }],
  ["ipv4", { pattern: String.raw`(?:\d{1,3}\.){3}\d{1,3}`, flags: "", category: "IPV4" }],
]);

interface KeywordRule { value: string; category: string; }
interface RegexRule { pattern: string; flags: string; category: string; }

class PlaceholderSession {
  prefix: string;
  secret: Uint8Array;
  forward = new Map<string, string>();
  reverse = new Map<string, string>();

  constructor(prefix: string) {
    this.prefix = prefix;
    this.secret = randomBytes(32);
  }

  generatePlaceholder(original: string, category: string): string {
    const cat = sanitizeCategory(category);
    const h = createHmac("sha256", this.secret);
    h.update(String(original));
    const hash12 = toHexLower(h.digest()).slice(0, 12);
    return `${this.prefix}${cat}_${hash12}__`;
  }

  getOrCreatePlaceholder(original: string, category: string): string {
    const existing = this.reverse.get(original);
    if (existing) return existing;
    const ph = this.generatePlaceholder(original, category);
    this.forward.set(ph, original);
    this.reverse.set(original, ph);
    return ph;
  }

  lookup(ph: string): string | undefined {
    return this.forward.get(ph);
  }

  lookupReverse(original: string): string | undefined {
    return this.reverse.get(original);
  }
}

// Simplified redact (keyword + regex)
function redactText(
  input: string,
  keywords: KeywordRule[],
  regexRules: RegexRule[],
  exclude: Set<string>,
  session: PlaceholderSession,
): string {
  const text = String(input ?? "");
  if (!text) return text;

  interface Hit { start: number; end: number; original: string; placeholder?: string; }
  const hits: Hit[] = [];

  for (const k of keywords) {
    if (!k.value) continue;
    let idx = 0;
    for (;;) {
      const pos = text.indexOf(k.value, idx);
      if (pos === -1) break;
      const end = pos + k.value.length;
      const orig = text.slice(pos, end);
      idx = end;
      if (exclude.has(orig)) continue;
      hits.push({ start: pos, end, original: k.value });
    }
  }

  for (const r of regexRules) {
    const flags = r.flags.includes("g") ? r.flags : r.flags + "g";
    const re = new RegExp(r.pattern, flags);
    for (const m of text.matchAll(re)) {
      if (!m[0] || m.index == null) continue;
      const orig = m[0];
      if (exclude.has(orig)) continue;
      hits.push({ start: m.index, end: m.index + orig.length, original: orig });
    }
  }

  if (hits.length === 0) return text;

  // Simple right-to-left replace (no overlap handling for test)
  hits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const h of hits) {
    const ph = session.getOrCreatePlaceholder(h.original, "TEST");
    out = out.slice(0, h.start) + ph + out.slice(h.end);
  }
  return out;
}

// ===== Tests =====

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.error(`    ${e}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- Test suite ---

console.log("\npi-vibeguard Engine Tests\n");

// 1. Keyword exact match
test("keyword exact match", () => {
  const session = new PlaceholderSession("__VG_");
  const result = redactText(
    "my key is sk-a0d309c77dd44d57be0f1a675c099999 here",
    [{ value: "sk-a0d309c77dd44d57be0f1a675c099999", category: "OPENAI_KEY" }],
    [],
    new Set(),
    session,
  );
  assert(!result.includes("sk-a0d309"), `key still in output: ${result}`);
  assert(result.includes("__VG_"), `no placeholder in output: ${result}`);
  console.log(`    input:  "my key is sk-a0d309c77dd44d57be0f1a675c099999 here"`);
  console.log(`    output: "${result}"`);
});

// 2. Regex match (email)
test("regex email match", () => {
  const session = new PlaceholderSession("__VG_");
  const result = redactText(
    "contact test@example.com for help",
    [],
    [{ pattern: BUILTIN.get("email")!.pattern, flags: BUILTIN.get("email")!.flags, category: "EMAIL" }],
    new Set(),
    session,
  );
  assert(!result.includes("test@example.com"), `email still in output: ${result}`);
  assert(result.includes("__VG_EMAIL_"), `no EMAIL placeholder: ${result}`);
  console.log(`    output: "${result}"`);
});

// 3. Exclude list
test("exclude list", () => {
  const session = new PlaceholderSession("__VG_");
  const result = redactText(
    "test@example.com and user@real.com",
    [],
    [{ pattern: BUILTIN.get("email")!.pattern, flags: BUILTIN.get("email")!.flags, category: "EMAIL" }],
    new Set(["test@example.com"]),
    session,
  );
  assert(result.includes("test@example.com"), "excluded email should remain");
  assert(!result.includes("user@real.com"), "non-excluded email should be redacted");
  console.log(`    output: "${result}"`);
});

// 4. Idempotent placeholder (same original → same placeholder)
test("idempotent placeholder", () => {
  const session = new PlaceholderSession("__VG_");
  const r1 = redactText("key: abc123", [{ value: "abc123", category: "KEY" }], [], new Set(), session);
  const r2 = redactText("key: abc123", [{ value: "abc123", category: "KEY" }], [], new Set(), session);
  const ph = session.reverse.get("abc123");
  assert(ph != null, "no placeholder created");
  assert(r1.includes(ph!), `first call missing placeholder`);
  assert(r2.includes(ph!), `second call missing placeholder`);
  assert(ph === session.lookupReverse("abc123"), "placeholder mismatch");
  console.log(`    placeholder: ${ph}`);
});

// 5. No false positive for no match
test("no false positive", () => {
  const session = new PlaceholderSession("__VG_");
  const input = "just normal text nothing sensitive here";
  const result = redactText(input, [], [], new Set(), session);
  assert(result === input, "should be unchanged");
});

// 6. Restore works
test("restore placeholder", () => {
  const session = new PlaceholderSession("__VG_");
  const redacted = redactText("key: abc123", [{ value: "abc123", category: "KEY" }], [], new Set(), session);
  const ph = session.lookupReverse("abc123")!;
  const regex = new RegExp(`__VG_[A-Za-z0-9_]+_[a-f0-9A-F]{12}(?:_\\d+)?__`, "g");
  const restored = redacted.replace(regex, (m) => session.lookup(m) ?? m);
  assert(restored === "key: abc123", `restore failed: "${restored}"`);
  console.log(`    redacted: "${redacted}"`);
  console.log(`    restored: "${restored}"`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
