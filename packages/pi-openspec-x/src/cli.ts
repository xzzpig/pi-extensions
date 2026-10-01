/**
 * OpenSpec CLI integration for pi-openspec-x.
 *
 * Responsibilities:
 * - resolve the `openspec` binary on PATH (self-implemented `which`)
 * - probe `--version` at most once per binary per session (module-level cache)
 * - run `--json` subcommands through one execution/parse/validation layer with
 *   typed errors: CLI missing (`OpenspecCliMissingError`), non-zero exit or
 *   spawn failure (`OpenspecCliExitError`), and malformed output
 *   (`OpenspecJsonParseError`)
 *
 * The generic `runOpenspecJson` channel is deliberately reusable: later groups
 * (e.g. the /opsx:plan instructions wiring) add more subcommands on top of it
 * without touching the execution plumbing.
 */
import { spawnSync } from "node:child_process";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The CLI binary pi-openspec-x drives. */
const OPENSPEC_COMMAND = "openspec";

/** Minimal spawnSync shape this module relies on; injectable for tests. */
export type SpawnSyncLike = (
  file: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

// ── typed errors ────────────────────────────────────────────────────────────

/** The openspec binary could not be found on PATH. */
export class OpenspecCliMissingError extends Error {
  readonly command = OPENSPEC_COMMAND;

  constructor() {
    super(
      `OpenSpec CLI '${OPENSPEC_COMMAND}' was not found on PATH. Install openspec so pi-openspec-x can provide the official workflow skills.`,
    );
    this.name = "OpenspecCliMissingError";
  }
}

/** openspec ran but exited non-zero, or the process could not be executed. */
export class OpenspecCliExitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(
    args: readonly string[],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ) {
    const detail = stderr.trim();
    super(
      `openspec ${args.join(" ")} ${exitCode === null ? `failed (${signal ?? "unknown signal"})` : `exited with code ${exitCode}`}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "OpenspecCliExitError";
    this.args = [...args];
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = detail;
  }
}

/** openspec ran successfully but its stdout was not the expected JSON. */
export class OpenspecJsonParseError extends Error {
  readonly args: readonly string[];
  readonly stdout: string;

  constructor(
    args: readonly string[],
    message: string,
    options?: { stdout?: string; cause?: unknown },
  ) {
    super(`openspec ${args.join(" ")} produced invalid JSON: ${message}`);
    this.name = "OpenspecJsonParseError";
    this.args = [...args];
    this.stdout = options?.stdout ?? "";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function isOpenspecCliMissingError(
  error: unknown,
): error is OpenspecCliMissingError {
  return error instanceof OpenspecCliMissingError;
}

// ── PATH resolution ─────────────────────────────────────────────────────────

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-implemented `which` for the openspec binary. Honors absolute commands,
 * Windows PATHEXT, and every directory in `env.PATH`. Returns the real path of
 * the first executable candidate, or undefined when nothing matches.
 */
export function resolveOpenspecBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (
    path.isAbsolute(OPENSPEC_COMMAND) ||
    OPENSPEC_COMMAND.includes(path.sep)
  ) {
    const resolved = path.resolve(OPENSPEC_COMMAND);
    return isExecutable(resolved) ? resolved : undefined;
  }
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${OPENSPEC_COMMAND}${extension}`);
      if (!isExecutable(candidate)) continue;
      try {
        return fs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return undefined;
}

// ── command execution ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface OpenspecCliOptions {
  /** Environment used for PATH resolution and the child process. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd?: string;
  /** Child-process timeout in milliseconds. */
  timeoutMs?: number;
  /** spawnSync replacement for tests. */
  spawnImpl?: SpawnSyncLike;
}

function executeOpenspec(
  args: readonly string[],
  options: OpenspecCliOptions,
): string {
  const env = options.env ?? process.env;
  const binaryPath = resolveOpenspecBinary(env);
  if (!binaryPath) throw new OpenspecCliMissingError();
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env,
    encoding: "utf-8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  };
  const result = spawnImpl(binaryPath, [...args], spawnOptions);
  if (result.error) {
    throw new OpenspecCliExitError(
      args,
      null,
      result.signal ?? null,
      result.error.message,
    );
  }
  if (result.status !== 0) {
    throw new OpenspecCliExitError(
      args,
      result.status,
      result.signal ?? null,
      result.stderr || result.stdout,
    );
  }
  return result.stdout;
}

/**
 * Generic JSON channel for openspec `--json` subcommands. Callers pass the
 * full argument list, e.g. `["instructions", "proposal", "--change", id,
 * "--json"]`.
 */
export function runOpenspecJson<T>(
  args: readonly string[],
  options: OpenspecCliOptions = {},
): T {
  const stdout = executeOpenspec(args, options);
  try {
    return JSON.parse(stdout) as T;
  } catch (cause) {
    throw new OpenspecJsonParseError(
      args,
      cause instanceof Error ? cause.message : String(cause),
      {
        stdout,
        cause,
      },
    );
  }
}

// ── version probe (once per session) ────────────────────────────────────────

const versionCache = new Map<string, string>();

/** Drop the per-session version cache. Test-only. */
export function resetOpenspecVersionCacheForTests(): void {
  versionCache.clear();
}

/**
 * Probe `openspec --version`. The resolved binary path is the cache key, so
 * the child process runs at most once per binary per session; later calls
 * return the cached version without spawning.
 */
export function probeOpenspecVersion(options: OpenspecCliOptions = {}): string {
  const env = options.env ?? process.env;
  const binaryPath = resolveOpenspecBinary(env);
  if (!binaryPath) throw new OpenspecCliMissingError();
  const cached = versionCache.get(binaryPath);
  if (cached !== undefined) return cached;
  const version = executeOpenspec(["--version"], { ...options, env }).trim();
  if (!version) {
    throw new OpenspecCliExitError(
      ["--version"],
      0,
      null,
      "openspec --version produced empty output",
    );
  }
  versionCache.set(binaryPath, version);
  return version;
}

// ── schemas & templates ─────────────────────────────────────────────────────

/** One entry of `openspec schemas --json`. */
export interface OpenspecSchemaInfo {
  name: string;
  description: string;
  artifacts: string[];
  source: string;
}

/** One value of the `openspec templates --json` object. */
interface OpenspecTemplateInfo {
  path: string;
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  return Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : typeof value;
}

function requireString(
  entry: Record<string, unknown>,
  field: string,
  args: readonly string[],
  where: string,
): string {
  const value = entry[field];
  if (typeof value !== "string") {
    throw new OpenspecJsonParseError(
      args,
      `${where}.${field} should be a string, got ${typeOf(value)}`,
    );
  }
  return value;
}

function parseSchemasOutput(
  parsed: unknown,
  args: readonly string[],
): OpenspecSchemaInfo[] {
  if (!Array.isArray(parsed)) {
    throw new OpenspecJsonParseError(
      args,
      `expected a JSON array, got ${typeOf(parsed)}`,
    );
  }
  return parsed.map((entry, index) => {
    const where = `schemas[${index}]`;
    if (!isRecord(entry)) {
      throw new OpenspecJsonParseError(
        args,
        `${where} should be an object, got ${typeOf(entry)}`,
      );
    }
    const artifacts = entry.artifacts;
    if (
      !Array.isArray(artifacts) ||
      !artifacts.every((item) => typeof item === "string")
    ) {
      throw new OpenspecJsonParseError(
        args,
        `${where}.artifacts should be an array of strings`,
      );
    }
    return {
      name: requireString(entry, "name", args, where),
      description: requireString(entry, "description", args, where),
      artifacts: [...artifacts],
      source: requireString(entry, "source", args, where),
    };
  });
}

/** Run `openspec schemas --json` and validate its output. */
export function listOpenspecSchemas(
  options: OpenspecCliOptions = {},
): OpenspecSchemaInfo[] {
  const args = ["schemas", "--json"] as const;
  return parseSchemasOutput(runOpenspecJson<unknown>(args, options), args);
}

function parseTemplatesOutput(
  parsed: unknown,
  args: readonly string[],
): Record<string, OpenspecTemplateInfo> {
  if (!isRecord(parsed)) {
    throw new OpenspecJsonParseError(
      args,
      `expected a JSON object, got ${typeOf(parsed)}`,
    );
  }
  const templates: Record<string, OpenspecTemplateInfo> = {};
  for (const [artifact, value] of Object.entries(parsed)) {
    const where = `templates.${artifact}`;
    if (!isRecord(value)) {
      throw new OpenspecJsonParseError(
        args,
        `${where} should be an object, got ${typeOf(value)}`,
      );
    }
    templates[artifact] = {
      path: requireString(value, "path", args, where),
      source: requireString(value, "source", args, where),
    };
  }
  return templates;
}

/** Run `openspec templates --json` and validate its output. */
export function listOpenspecTemplates(
  options: OpenspecCliOptions = {},
): Record<string, OpenspecTemplateInfo> {
  const args = ["templates", "--json"] as const;
  return parseTemplatesOutput(runOpenspecJson<unknown>(args, options), args);
}

// ── per-artifact instructions ───────────────────────────────────────────────

/**
 * The validated slice of `openspec instructions <artifact> --change <id> --json`
 * the plan flow consumes. The CLI is the source of truth for what to write;
 * these fields are only what the injection block renders.
 */
export interface OpenspecArtifactInstructions {
  artifactId: string;
  changeName: string;
  instruction: string;
  /** The artifact template the CLI wants written to `resolvedOutputPath`. */
  template?: string;
  /** Project context the CLI returns (openspec/config.yaml context). */
  context?: string;
  rules?: string[];
  resolvedOutputPath?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

/**
 * Run `openspec instructions <artifact> --change <id> --json` and validate the
 * fields the plan flow uses. A missing `instruction` is a parse error: the
 * caller must degrade rather than inject an empty phase block.
 */
export function getOpenspecArtifactInstructions(
  artifact: string,
  changeId: string,
  options: OpenspecCliOptions = {},
): OpenspecArtifactInstructions {
  const args = [
    "instructions",
    artifact,
    "--change",
    changeId,
    "--json",
  ] as const;
  const parsed = runOpenspecJson<unknown>(args, options);
  if (!isRecord(parsed)) {
    throw new OpenspecJsonParseError(
      args,
      `expected a JSON object, got ${typeOf(parsed)}`,
    );
  }
  const template = optionalString(parsed.template);
  const context = optionalString(parsed.context);
  const rules = optionalStringArray(parsed.rules);
  const resolvedOutputPath = optionalString(parsed.resolvedOutputPath);
  return {
    artifactId: requireString(parsed, "artifactId", args, "instructions"),
    changeName: requireString(parsed, "changeName", args, "instructions"),
    instruction: requireString(parsed, "instruction", args, "instructions"),
    ...(template ? { template } : {}),
    ...(context ? { context } : {}),
    ...(rules ? { rules } : {}),
    ...(resolvedOutputPath ? { resolvedOutputPath } : {}),
  };
}
