import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

interface VibeguardConfig {
  enabled: boolean;
  debug: boolean;
  prefix: string;
  ttlMs: number;
  maxMappings: number;
  patterns: {
    keywords?: Array<{ value: string; category: string }>;
    regex?: Array<{ pattern: string; flags?: string; category: string }>;
    builtin?: string[];
    exclude?: string[];
  };
  loadedFrom?: string;
}

interface KeywordRule {
  value: string;
  category: string;
}

interface RegexRule {
  pattern: string;
  flags: string;
  category: string;
}

interface PatternSet {
  keywords: KeywordRule[];
  regex: RegexRule[];
  exclude: Set<string>;
}

interface Match {
  start: number;
  end: number;
  original: string;
  category: string;
  placeholder?: string;
}

interface Span {
  start: number;
  end: number;
}

// ============================================================================
// Configuration
// ============================================================================

function parseDurationMs(input: string): number {
  const raw = String(input ?? "").trim();
  if (!raw) return 60 * 60 * 1000;
  const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!m) return 60 * 60 * 1000;
  const value = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(value) || value < 0) return 60 * 60 * 1000;
  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 60 * 60 * 1000;
  }
}

async function readJson(filepath: string): Promise<Record<string, unknown> | null> {
  try {
    const s = await fs.readFile(filepath, "utf8");
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeConfig(raw: any): VibeguardConfig {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const enabled = Boolean(cfg.enabled);
  const debug = Boolean(cfg.debug);
  const prefix = typeof cfg.placeholder_prefix === "string" && cfg.placeholder_prefix
    ? cfg.placeholder_prefix
    : "__VG_";

  const session = cfg.session && typeof cfg.session === "object" ? cfg.session : {};
  const ttlMs = parseDurationMs(String(session.ttl ?? "1h"));
  const maxMappings = Number.isFinite(session.max_mappings) && Number(session.max_mappings) > 0
    ? Number(session.max_mappings)
    : 100000;

  const patterns = cfg.patterns && typeof cfg.patterns === "object" ? cfg.patterns : {};

  return { enabled, debug, prefix, ttlMs, maxMappings, patterns };
}

function getConfigCandidates(directory: string): string[] {
  const dir = String(directory ?? process.cwd());
  const home = os.homedir();
  const env = process.env.PI_VIBEGUARD_CONFIG;
  const projectRoot = path.join(dir, "vibeguard.config.json");
  const projectOpenCode = path.join(dir, ".pi", "vibeguard.config.json");
  const globalConfig = path.join(home, ".pi", "agent", "vibeguard.config.json");

  if (env) return [path.resolve(dir, env), projectRoot, projectOpenCode, globalConfig];
  return [projectRoot, projectOpenCode, globalConfig];
}

async function loadConfig(
  directory: string,
  debugLog: (msg: string) => void,
): Promise<VibeguardConfig> {
  const candidates = getConfigCandidates(directory);
  for (const file of candidates) {
    if (!file) continue;
    if (!existsSync(file)) continue;
    const raw = await readJson(file);
    if (!raw) continue;
    const cfg = normalizeConfig(raw);
    debugLog(`Config loaded: ${file} enabled=${cfg.enabled}`);
    return { ...cfg, loadedFrom: file };
  }
  const cfg = normalizeConfig({ enabled: false });
  debugLog(`No config file found (extension will no-op)`);
  return { ...cfg, loadedFrom: "" };
}

// ============================================================================
// Patterns
// ============================================================================

function sanitizeCategory(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "TEXT";
  const upper = raw.toUpperCase();
  const safe = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_");
  if (!safe) return "TEXT";
  return safe;
}

interface BuiltinRule {
  pattern: string;
  flags: string;
  category: string;
}

const BUILTIN: Map<string, BuiltinRule> = new Map([
  ["email", {
    pattern: String.raw`[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`,
    flags: "i",
    category: "EMAIL",
  }],
  ["china_phone", {
    pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
    flags: "",
    category: "CHINA_PHONE",
  }],
  ["china_id", {
    pattern: String.raw`(?<!\d)\d{17}[\dXx](?!\d)`,
    flags: "",
    category: "CHINA_ID",
  }],
  ["uuid", {
    pattern: String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}`,
    flags: "",
    category: "UUID",
  }],
  ["ipv4", {
    pattern: String.raw`(?:\d{1,3}\.){3}\d{1,3}`,
    flags: "",
    category: "IPV4",
  }],
  ["mac", {
    pattern: String.raw`(?:[0-9a-f]{2}:){5}[0-9a-f]{2}`,
    flags: "i",
    category: "MAC",
  }],
]);

function peelInlineFlags(
  pattern: string,
  flags: string,
): { pattern: string; flags: string } {
  let p = String(pattern ?? "");
  let f = String(flags ?? "");
  for (;;) {
    if (p.startsWith("(?i)")) { p = p.slice(4); if (!f.includes("i")) f += "i"; continue; }
    if (p.startsWith("(?m)")) { p = p.slice(4); if (!f.includes("m")) f += "m"; continue; }
    break;
  }
  return { pattern: p, flags: f };
}

function buildPatternSet(patterns: VibeguardConfig["patterns"]): PatternSet {
  const raw = patterns && typeof patterns === "object" ? patterns : {} as VibeguardConfig["patterns"];

  const keywords = Array.isArray(raw.keywords) ? raw.keywords : [];
  const regex = Array.isArray(raw.regex) ? raw.regex : [];
  const builtin = Array.isArray(raw.builtin) ? raw.builtin : [];
  const exclude = Array.isArray(raw.exclude) ? raw.exclude : [];

  const keywordRules: KeywordRule[] = [];
  for (const x of keywords) {
    if (!x || typeof x !== "object") continue;
    const value = String(x.value ?? "").trim();
    if (!value) continue;
    const category = sanitizeCategory(x.category ?? "");
    keywordRules.push({ value, category });
  }

  const regexRules: RegexRule[] = [];
  for (const x of regex) {
    if (!x || typeof x !== "object") continue;
    const pattern = String(x.pattern ?? "").trim();
    if (!pattern) continue;
    const category = sanitizeCategory(x.category ?? "");
    const flags = typeof x.flags === "string" ? x.flags : "";
    const peeled = peelInlineFlags(pattern, flags);
    regexRules.push({ pattern: peeled.pattern, flags: peeled.flags, category });
  }

  for (const name of builtin) {
    const key = String(name ?? "").trim();
    if (!key) continue;
    const rule = BUILTIN.get(key);
    if (!rule) continue;
    regexRules.push({ pattern: rule.pattern, flags: rule.flags, category: rule.category });
  }

  const excludeSet = new Set(exclude.map((x) => String(x ?? "")));

  return { keywords: keywordRules, regex: regexRules, exclude: excludeSet };
}

// ============================================================================
// PlaceholderSession
// ============================================================================

function toHexLower(buffer: Buffer): string {
  return Buffer.from(buffer).toString("hex");
}

function getPlaceholderRegex(prefix: string): RegExp {
  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}[A-Za-z0-9_]+_[a-f0-9A-F]{12}(?:_\\d+)?__`, "g");
}

class PlaceholderSession {
  prefix: string;
  ttlMs: number;
  maxMappings: number;
  secret: Uint8Array;
  forward: Map<string, string> = new Map();
  reverse: Map<string, string> = new Map();
  created: Map<string, number> = new Map();

  constructor(options: {
    prefix: string;
    ttlMs: number;
    maxMappings: number;
    secret?: Uint8Array;
  }) {
    this.prefix = options.prefix;
    this.ttlMs = options.ttlMs;
    this.maxMappings = options.maxMappings;
    this.secret = options.secret ?? randomBytes(32);
  }

  cleanup(now = Date.now()): void {
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) return;
    for (const [placeholder, createdAt] of this.created.entries()) {
      if (now - createdAt <= this.ttlMs) continue;
      const original = this.forward.get(placeholder);
      this.forward.delete(placeholder);
      this.created.delete(placeholder);
      if (original !== undefined) this.reverse.delete(original);
    }
  }

  private evictOldest(): void {
    let oldestPlaceholder = "";
    let oldestTime = Infinity;
    for (const [placeholder, createdAt] of this.created.entries()) {
      if (createdAt >= oldestTime) continue;
      oldestTime = createdAt;
      oldestPlaceholder = placeholder;
    }
    if (!oldestPlaceholder) return;
    const original = this.forward.get(oldestPlaceholder);
    this.forward.delete(oldestPlaceholder);
    this.created.delete(oldestPlaceholder);
    if (original !== undefined) this.reverse.delete(original);
  }

  lookup(placeholder: string): string | undefined {
    return this.forward.get(placeholder);
  }

  lookupReverse(original: string): string | undefined {
    return this.reverse.get(original);
  }

  private generatePlaceholder(original: string, category: string): string {
    const cat = sanitizeCategory(category);
    const h = createHmac("sha256", this.secret);
    h.update(String(original));
    const sum = h.digest();
    const hash12 = toHexLower(sum).slice(0, 12);
    const base = `${this.prefix}${cat}_${hash12}`;
    return `${base}__`;
  }

  getOrCreatePlaceholder(original: string, category: string): string {
    const existing = this.lookupReverse(original);
    if (existing) return existing;

    const now = Date.now();
    this.cleanup(now);

    if (Number.isFinite(this.maxMappings) && this.maxMappings > 0) {
      while (this.forward.size >= this.maxMappings) this.evictOldest();
    }

    const base = this.generatePlaceholder(original, category);
    const current = this.forward.get(base);
    if (current === undefined) {
      this.forward.set(base, original);
      this.reverse.set(original, base);
      this.created.set(base, now);
      return base;
    }
    if (current === original) {
      this.reverse.set(original, base);
      this.created.set(base, now);
      return base;
    }
    // hash12 collision: append _N suffix
    const withoutSuffix = base.slice(0, -2);
    for (let i = 2; ; i++) {
      const candidate = `${withoutSuffix}_${i}__`;
      const prev = this.forward.get(candidate);
      if (prev === undefined) {
        this.forward.set(candidate, original);
        this.reverse.set(original, candidate);
        this.created.set(candidate, now);
        return candidate;
      }
      if (prev === original) {
        this.reverse.set(original, candidate);
        this.created.set(candidate, now);
        return candidate;
      }
    }
  }
}

// ============================================================================
// Redact Engine
// ============================================================================

function subtractCovered(start: number, end: number, covered: Span[]): Span[] {
  if (start >= end) return [];
  const out: Span[] = [];
  let cur = start;
  for (const c of covered) {
    if (c.end <= cur) continue;
    if (c.start >= end) break;
    if (c.start > cur) out.push({ start: cur, end: Math.min(c.start, end) });
    if (c.end >= end) { cur = end; break; }
    cur = Math.max(cur, c.end);
  }
  if (cur < end) out.push({ start: cur, end });
  return out;
}

function insertCovered(covered: Span[], span: Span): Span[] {
  if (span.start >= span.end) return covered;
  let i = 0;
  for (; i < covered.length; i++) {
    if (covered[i].start > span.start) break;
  }
  covered.splice(i, 0, span);
  if (covered.length <= 1) return covered;

  const merged: Span[] = [];
  for (const c of covered) {
    const last = merged.at(-1);
    if (!last) { merged.push(c); continue; }
    if (c.start <= last.end) {
      if (c.end > last.end) last.end = c.end;
      continue;
    }
    merged.push(c);
  }
  return merged;
}

function redactText(
  input: string,
  patterns: PatternSet,
  session: PlaceholderSession,
): { text: string; matches: Match[] } {
  const text = String(input ?? "");
  if (!text) return { text, matches: [] };

  const found: Match[] = [];

  // Keywords
  for (const rule of patterns.keywords) {
    const needle = rule.value;
    if (!needle) continue;
    let idx = 0;
    for (;;) {
      const pos = text.indexOf(needle, idx);
      if (pos === -1) break;
      const start = pos;
      const end = pos + needle.length;
      const original = text.slice(start, end);
      idx = end;
      if (patterns.exclude.has(original)) continue;
      found.push({ start, end, original, category: rule.category });
    }
  }

  // Regex
  for (const rule of patterns.regex) {
    const baseFlags = String(rule.flags ?? "");
    const flags = baseFlags.includes("g") ? baseFlags : `${baseFlags}g`;
    const re = new RegExp(rule.pattern, flags);
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      const start = m.index ?? -1;
      if (start < 0) continue;
      const end = start + m[0].length;
      const original = text.slice(start, end);
      if (patterns.exclude.has(original)) continue;
      found.push({ start, end, original, category: rule.category });
    }
  }

  if (found.length === 0) return { text, matches: [] };

  // Sort: rightmost first; same start → longer first
  found.sort((a, b) => {
    if (a.start !== b.start) return b.start - a.start;
    return b.end - a.end;
  });

  const planned: Match[] = [];
  let covered: Span[] = [];
  for (const m of found) {
    const segments = subtractCovered(m.start, m.end, covered);
    for (const seg of segments) {
      if (seg.start < 0 || seg.end > text.length || seg.start >= seg.end) continue;
      planned.push({
        start: seg.start,
        end: seg.end,
        original: text.slice(seg.start, seg.end),
        category: m.category,
      });
      covered = insertCovered(covered, seg);
    }
  }

  // Process right-to-left to preserve indices
  planned.sort((a, b) => b.start - a.start);

  let out = text;
  for (const m of planned) {
    const placeholder = session.getOrCreatePlaceholder(m.original, m.category);
    out = out.slice(0, m.start) + placeholder + out.slice(m.end);
    m.placeholder = placeholder;
  }

  return { text: out, matches: planned };
}

// ============================================================================
// Restore Engine
// ============================================================================

function restoreText(input: string, session: PlaceholderSession): string {
  const text = String(input ?? "");
  if (!text) return text;
  const re = getPlaceholderRegex(session.prefix);
  return text.replace(re, (ph) => session.lookup(ph) ?? ph);
}

// ============================================================================
// Deep Traversal
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactDeep(
  value: unknown,
  patterns: PatternSet,
  session: PlaceholderSession,
): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") node[i] = redactText(v, patterns, session).text;
        if (v && typeof v === "object") walk(v);
      }
      return;
    }

    if (!isPlainObject(node)) return;

    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === "string") node[key] = redactText(v, patterns, session).text;
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(value);
}

function restoreDeep(value: unknown, session: PlaceholderSession): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") node[i] = restoreText(v, session);
        if (v && typeof v === "object") walk(v);
      }
      return;
    }

    if (!isPlainObject(node)) return;

    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === "string") node[key] = restoreText(v, session);
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(value);
}

// ============================================================================
// Message helpers for pi's AgentMessage types
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function redactMessageContent(msg: any, patterns: PatternSet, session: PlaceholderSession): void {
  if (!msg) return;

  // UserMessage, CustomMessage: content is string or array of {type, text}
  if (msg.role === "user" || msg.role === "custom") {
    if (typeof msg.content === "string") {
      msg.content = redactText(msg.content, patterns, session).text;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
          part.text = redactText(part.text, patterns, session).text;
        }
      }
    }
  }

  // AssistantMessage: content is array of {type: "text"|"thinking"|"toolCall", ...}
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      // TextContent: {type: "text", text: string}
      if (part.type === "text" && typeof part.text === "string") {
        part.text = redactText(part.text, patterns, session).text;
      }
      // ThinkingContent: {type: "thinking", thinking: string}
      if (part.type === "thinking" && typeof part.thinking === "string") {
        part.thinking = redactText(part.thinking, patterns, session).text;
      }
      // ToolCall: {type: "toolCall", id, name, arguments: Record<string, any>}
      if (part.type === "toolCall" && part.arguments && typeof part.arguments === "object") {
        redactDeep(part.arguments, patterns, session);
      }
    }
  }

  // ToolResultMessage: content is array of {type: "text", text}
  if (msg.role === "toolResult" && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        part.text = redactText(part.text, patterns, session).text;
      }
    }
  }

  // BashExecutionMessage: command and output strings
  if (msg.role === "bashExecution") {
    if (typeof msg.command === "string") {
      msg.command = redactText(msg.command, patterns, session).text;
    }
    if (typeof msg.output === "string") {
      msg.output = redactText(msg.output, patterns, session).text;
    }
  }

  // CompactionSummaryMessage / BranchSummaryMessage: summary string
  if ((msg.role === "compactionSummary" || msg.role === "branchSummary") && typeof msg.summary === "string") {
    msg.summary = redactText(msg.summary, patterns, session).text;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function restoreMessageContent(msg: any, session: PlaceholderSession): void {
  if (!msg) return;

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        part.text = restoreText(part.text, session);
      }
      if (part.type === "thinking" && typeof part.thinking === "string") {
        part.thinking = restoreText(part.thinking, session);
      }
      if (part.type === "toolCall" && part.arguments && typeof part.arguments === "object") {
        restoreDeep(part.arguments, session);
      }
    }
  }
}

// ============================================================================
// Mapping View (local fork addition: /vibeguard:list and /vibeguard:stats)
// ============================================================================

export interface MappingEntry {
  category: string;
  placeholder: string;
  original: string;
  createdAt: number;
}

export interface CategoryStat {
  category: string;
  count: number;
}

/** Structural view of PlaceholderSession's in-memory mapping tables. */
export interface MappingSnapshotSource {
  prefix: string;
  forward: Map<string, string>;
  created: Map<string, number>;
}

/**
 * Extract the embedded category from a placeholder
 * (`${prefix}<CATEGORY>_<hash12>__` or `${prefix}<CATEGORY>_<hash12>_<N>__`).
 * Returns "UNKNOWN" for anything that does not match the expected shape.
 */
export function parseCategoryFromPlaceholder(placeholder: string, prefix: string): string {
  const raw = String(placeholder ?? "");
  const pfx = String(prefix ?? "");
  let body = raw;
  if (pfx && raw.startsWith(pfx)) body = raw.slice(pfx.length);
  if (body.endsWith("__")) body = body.slice(0, -2);
  const m = /^([A-Za-z0-9_]+)_([0-9a-fA-F]{12})(?:_[0-9]+)?$/.exec(body);
  return m ? m[1] : "UNKNOWN";
}

/** Mask an original value: keep first 3 + … + last 4; wholly mask short values. */
export function maskOriginal(original: string): string {
  const chars = Array.from(String(original ?? ""));
  if (chars.length <= 7) return "•";
  return `${chars.slice(0, 3).join("")}…${chars.slice(-4).join("")}`;
}

/** Read-only snapshot of the live mapping tables (no cleanup, no eviction). */
export function buildMappingSnapshot(source: MappingSnapshotSource): MappingEntry[] {
  const entries: MappingEntry[] = [];
  for (const [placeholder, original] of source.forward) {
    entries.push({
      category: parseCategoryFromPlaceholder(placeholder, source.prefix),
      placeholder,
      original,
      createdAt: source.created.get(placeholder) ?? 0,
    });
  }
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.createdAt - b.createdAt);
  return entries;
}

/** Per-category counts, sorted by count desc then name asc. */
export function buildCategoryStats(entries: MappingEntry[]): CategoryStat[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Human duration with minute granularity ("<1m", "43m", "1h5m"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
}

export function formatTtlRemaining(createdAt: number, ttlMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return "∞";
  return formatDuration(createdAt + ttlMs - now);
}

function padCell(text: string, width: number): string {
  const vw = visibleWidth(text);
  return vw >= width ? text : text + " ".repeat(width - vw);
}

function terminalRows(): number {
  const r = process.stdout.rows;
  return typeof r === "number" && Number.isFinite(r) ? r : 36;
}

function resolveMappingOverlayOptions(): OverlayOptions {
  const cols = process.stdout.columns;
  const width = Math.max(80, Math.min(120, (typeof cols === "number" && Number.isFinite(cols) ? cols : 120) - 4));
  return { anchor: "center", width, maxHeight: Math.max(14, terminalRows() - 4), margin: 1 };
}

type MappingViewMode = "list" | "stats";

interface MappingViewOptions {
  tui: TUI;
  theme: Theme;
  done: () => void;
  mode: MappingViewMode;
  entries: MappingEntry[];
  ttlMs: number;
}

export class MappingViewModal implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly mode: MappingViewMode;
  private readonly entries: MappingEntry[];
  private readonly stats: CategoryStat[];
  private readonly ttlMs: number;
  private reveal = false;
  private scrollOffset = 0;

  constructor(options: MappingViewOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.mode = options.mode;
    this.entries = options.entries;
    this.stats = buildCategoryStats(options.entries);
    this.ttlMs = options.ttlMs;
  }

  private dataRowCount(): number {
    return this.mode === "list" ? this.entries.length : this.stats.length;
  }

  private viewportRows(): number {
    // Reserve room for the frame (top border + bottom border) and inner padding.
    return Math.max(6, Math.min(22, terminalRows() - 14));
  }

  /** Top border with the title embedded: `┌─ title ───…┐` (exactly `width` visible columns). */
  private frameTop(label: string, color: "accent" | "warning", width: number): string {
    const t = this.theme;
    const fixed = visibleWidth("┌─ ") + visibleWidth(" ") + visibleWidth("┐");
    let lab = label;
    if (visibleWidth(lab) + 1 > Math.max(0, width - fixed)) {
      lab = truncateToWidth(lab, Math.max(0, width - fixed - 1), "…");
    }
    const fill = Math.max(0, width - fixed - visibleWidth(lab));
    return t.fg(color, "┌─ ") + t.fg(color, t.bold(lab)) + t.fg(color, " " + "─".repeat(fill) + "┐");
  }

  /** Bottom border with the key hints embedded: `└─ hints ───…┘` (exactly `width` visible columns). */
  private frameBottom(label: string, width: number): string {
    const t = this.theme;
    const fixed = visibleWidth("└─ ") + visibleWidth(" ") + visibleWidth("┘");
    let lab = label;
    if (visibleWidth(lab) + 1 > Math.max(0, width - fixed)) lab = "";
    const fill = Math.max(0, width - fixed - visibleWidth(lab));
    return t.fg("dim", "└─ " + lab + " " + "─".repeat(fill) + "┘");
  }

  /** Wrap content lines with side borders, truncating/padding to fit. */
  private frameRows(lines: string[], width: number): string[] {
    const t = this.theme;
    const contentW = Math.max(1, width - 4);
    return lines.map((line) => {
      const cell = padCell(truncateToWidth(line, contentW, "…"), contentW);
      return t.fg("borderAccent", "│ ") + cell + t.fg("borderAccent", " │");
    });
  }

  invalidate(): void {
    // All rendering is computed per-call; nothing cached to invalidate.
  }

  render(width: number): string[] {
    const revealColor = this.reveal ? "warning" : "accent";
    const total = this.entries.length;
    const title = this.reveal
      ? ` VibeGuard 映射 · ${total} 条 · TTL ${formatDuration(this.ttlMs)} · 明文显示 `
      : ` VibeGuard 映射 · ${total} 条 · TTL ${formatDuration(this.ttlMs)} `;

    if (this.mode === "stats") {
      const statsTitle = ` VibeGuard 统计 · ${total} 条 / ${this.stats.length} 类 `;
      return [
        this.frameTop(statsTitle, "accent", width),
        ...this.frameRows(this.renderStatsContent(width), width),
        this.frameBottom("↑/↓ j/k 滚动 · q/Esc 关闭", width),
      ];
    }

    return [
      this.frameTop(title, revealColor, width),
      ...this.frameRows(this.renderListContent(width), width),
      this.frameBottom("↑/↓ j/k 滚动 · PgUp/PgDn 翻页 · r 切换原文 · q/Esc 关闭", width),
    ];
  }

  private renderListContent(width: number): string[] {
    const t = this.theme;
    const now = Date.now();
    const total = this.entries.length;
    const out: string[] = [];
    out.push("");

    const catW = Math.min(18, Math.max(12, ...this.entries.map((e) => visibleWidth(e.category)))) + 1;
    const phW = Math.min(38, Math.max(28, ...this.entries.map((e) => visibleWidth(e.placeholder))));
    const ttlW = 6;
    const origW = Math.max(8, width - catW - phW - ttlW - 12);

    const header = ` ${padCell("CATEGORY", catW)}  ${padCell("PLACEHOLDER", phW)}  ${padCell("ORIGINAL", origW)}  ${padCell("TTL", ttlW)}`;
    out.push(t.fg("muted", truncateToWidth(header, width - 4)));
    out.push(t.fg("borderMuted", "─".repeat(Math.max(20, Math.min(width - 5, catW + phW + ttlW + origW + 7)))));

    const rows = this.viewportRows();
    const start = Math.min(this.scrollOffset, Math.max(0, total - rows));
    for (let i = start; i < Math.min(total, start + rows); i++) {
      const e = this.entries[i];
      const remainingMs = e.createdAt + this.ttlMs - now;
      const cat = t.fg("warning", padCell(truncateToWidth(e.category, catW), catW));
      const ph = t.fg("muted", padCell(truncateToWidth(e.placeholder, phW), phW));
      const shown = this.reveal ? e.original : maskOriginal(e.original);
      const orig = t.fg(this.reveal ? "text" : "dim", truncateToWidth(shown, origW));
      const ttl = t.fg(remainingMs <= 5 * 60000 ? "warning" : "muted", padCell(formatTtlRemaining(e.createdAt, this.ttlMs, now), ttlW));
      out.push(` ${cat}  ${ph}  ${orig}  ${ttl}`);
    }

    if (total > rows) {
      out.push("");
      out.push(t.fg("dim", ` 第 ${start + 1}-${Math.min(total, start + rows)} / ${total} 条 · 继续滚动查看更多`));
    }
    return out;
  }

  private renderStatsContent(width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    out.push("");

    const maxLabel = Math.max(8, ...this.stats.map((s) => visibleWidth(s.category)));
    const labelW = Math.min(24, maxLabel);
    const barMax = Math.max(8, Math.min(28, width - 4 - labelW - 12));
    const maxCount = Math.max(1, ...this.stats.map((s) => s.count));

    const rows = this.viewportRows();
    const start = Math.min(this.scrollOffset, Math.max(0, this.stats.length - rows));
    for (let i = start; i < Math.min(this.stats.length, start + rows); i++) {
      const s = this.stats[i];
      const barLen = Math.max(1, Math.round((s.count / maxCount) * barMax));
      const bar = t.fg("accent", "█".repeat(barLen)) + t.fg("dim", "·".repeat(Math.max(0, barMax - barLen)));
      const count = t.fg("text", String(s.count).padStart(4));
      out.push(` ${padCell(truncateToWidth(s.category, labelW), labelW)}  ${bar}  ${count}`);
    }

    if (this.stats.length > rows) {
      out.push("");
      out.push(t.fg("dim", ` 第 ${start + 1}-${Math.min(this.stats.length, start + rows)} / ${this.stats.length} 类 · 继续滚动查看更多`));
    }
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.done();
      return;
    }
    if (this.mode === "list" && (data === "r" || data === "R")) {
      this.reveal = !this.reveal;
      this.tui.requestRender();
      return;
    }
    const view = this.viewportRows();
    const maxOffset = Math.max(0, this.dataRowCount() - view);
    const page = Math.max(1, view - 1);
    let next = this.scrollOffset;
    if (matchesKey(data, Key.up) || data === "k") next -= 1;
    else if (matchesKey(data, Key.down) || data === "j") next += 1;
    else if (matchesKey(data, Key.pageUp)) next -= page;
    else if (matchesKey(data, Key.pageDown)) next += page;
    else if (matchesKey(data, Key.home)) next = 0;
    else if (matchesKey(data, Key.end)) next = maxOffset;
    else return;
    this.scrollOffset = Math.min(maxOffset, Math.max(0, next));
    this.tui.requestRender();
  }
}

// ============================================================================
// Pi Extension Entry
// ============================================================================

export default function (pi: ExtensionAPI) {
  let config: VibeguardConfig = { enabled: false, debug: false, prefix: "__VG_", ttlMs: 3600000, maxMappings: 100000, patterns: {} };
  let patterns: PatternSet = { keywords: [], regex: [], exclude: new Set() };
  let session: PlaceholderSession | null = null;

  const debug = (msg: string): void => {
    if (config.debug) console.log(`[pi-vibeguard] ${msg}`);
  };

  // Load config and init on session start
  pi.on("session_start", async (_event, ctx) => {
    try {
      config = await loadConfig(ctx.cwd, debug);
      if (config.debug) {
        debug(`Startup: prefix=${config.prefix} ttl=${config.ttlMs}ms maxMappings=${config.maxMappings}`);
      }
      if (!config.enabled) {
        debug("Disabled, no-op");
        ctx.ui.notify("VibeGuard: Disabled", "info");
        return;
      }

      patterns = buildPatternSet(config.patterns);
      session = new PlaceholderSession({
        prefix: config.prefix,
        ttlMs: config.ttlMs,
        maxMappings: config.maxMappings,
      });
      const msg = `VibeGuard: Active (${patterns.keywords.length} keywords + ${patterns.regex.length} regex)`;
      debug(msg);
      ctx.ui.notify(msg, "info");
    } catch (err) {
      console.error("[pi-vibeguard] session_start error:", err);
      ctx.ui.notify(`VibeGuard error: ${String(err)}`, "error");
    }
  });

  // Redact messages before each LLM call
  pi.on("context", async (event, ctx) => {
    if (!config.enabled || !session) return;
    session.cleanup();

    const msgs = event.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return;

    try {
      let changedCount = 0;
      for (const msg of msgs) {
        const before = JSON.stringify(msg).length;
        redactMessageContent(msg, patterns, session);
        const after = JSON.stringify(msg).length;
        if (after !== before) changedCount++;
      }

      if (changedCount > 0) {
        const info = `\x1b[33mVibeGuard[${changedCount}]\x1b[0m`;
        debug(info);
        ctx.ui.setStatus("vibeguard", info);
      }
    } catch (err) {
      console.error("[pi-vibeguard] context error:", err);
    }

    return { messages: event.messages };
  });

  // Restore tool arguments before execution
  pi.on("tool_call", async (event, ctx) => {
    if (!config.enabled || !session) return;
    session.cleanup();

    if (event.input && typeof event.input === "object") {
      const before = JSON.stringify(event.input).length;
      restoreDeep(event.input, session);
      const after = JSON.stringify(event.input).length;
      if (after !== before) {
        const info = `VibeGuard: restored ${event.toolName} args`;
        debug(info);
        ctx.ui.setStatus("vibeguard", info);
      }
    }
  });

  // Restore assistant message after LLM response
  pi.on("message_end", async (event) => {
    if (!config.enabled || !session) return;
    session.cleanup();

    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    const restored = { ...msg };
    // Deep clone content array to avoid mutating the original
    if (Array.isArray(restored.content)) {
      restored.content = restored.content.map((part) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p: any = { ...part };
        if (p.type === "toolCall" && p.arguments) {
          p.arguments = { ...p.arguments };
        }
        return p;
      });
    }

    restoreMessageContent(restored, session);

    debug("message_end: restored assistant message");
    return { message: restored };
  });

  // Mapping viewers (local fork addition): /vibeguard:list and /vibeguard:stats.
  // Output is rendered to the local TUI only — never written to the session,
  // so nothing here can reach the LLM provider.
  const openMappingView = async (mode: MappingViewMode, ctx: ExtensionCommandContext): Promise<void> => {
    if (!config.enabled || !session) {
      const reason = config.loadedFrom
        ? `插件未启用（配置：${config.loadedFrom}）`
        : "插件未启用（未找到 vibeguard.config.json）";
      ctx.ui.notify(`VibeGuard: ${reason}`, "warning");
      return;
    }
    const current = session;
    // Reuse the engine's own cleanup so the snapshot reflects "alive right now"
    // (entries whose TTL elapsed since the last context/tool_call event). This
    // is the same public cleanup the extension already runs on every event —
    // the mapping tables themselves are untouched otherwise.
    current.cleanup();
    const entries = buildMappingSnapshot(current);
    if (entries.length === 0) {
      ctx.ui.notify("VibeGuard: 当前会话暂无存活映射", "info");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new MappingViewModal({
          tui,
          theme,
          done,
          mode,
          entries,
          ttlMs: current.ttlMs,
        }),
      { overlay: true, overlayOptions: resolveMappingOverlayOptions() },
    );
  };

  pi.registerCommand("vibeguard:list", {
    description: "VibeGuard: 查看当前会话存活的脱敏映射（category / placeholder / 原文 / 剩余 TTL）",
    handler: (_args, ctx) => openMappingView("list", ctx),
  });

  pi.registerCommand("vibeguard:stats", {
    description: "VibeGuard: 按 category 汇总当前会话的存活映射",
    handler: (_args, ctx) => openMappingView("stats", ctx),
  });

  debug("Extension loaded");
}
