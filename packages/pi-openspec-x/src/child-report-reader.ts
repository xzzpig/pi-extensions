/**
 * Child report attempts and the child-only tool wrapper (design D1), plus the
 * canonical-session readers the parent-side ingestion uses (design D2).
 *
 * Why this module exists: the three structured reporting tools used to be
 * registered into the main session, so they leaked into the parent's tool
 * declaration and prompt rules. They are now registered only inside the
 * matching subagent's child process, each entry wrapping exactly one tool
 * (design D1). A wrapper result carries an *envelope* —
 * `{ version, attemptId, agent, report }` — where `report` is the unchanged
 * business payload. The envelope is result metadata consumed by the parent
 * ingestion; it never adds a model-fillable parameter, and the parent
 * re-validates `report` against the original tool schema.
 *
 * The attempt is the anti-forgery anchor: `before_agent_start` records a fresh
 * random `attemptId` plus the SHA-256 of the actual prompt in a
 * `pi-openspec-x/child-report-attempt:v1` session entry. A report is only
 * attributable to the turn whose attempt it names, so a resumed child that
 * reuses the same session file cannot smuggle an earlier run's report into the
 * current dispatch.
 *
 * Deliberately NOT here: any reading of pi-subagents' private `AsyncStatus`
 * or lifecycle constants (design D3). This module declares the minimal v3
 * structure it supports and validates real fields at runtime.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createReportTools } from "./report-tools.ts";

/** Session entry type holding one child report attempt. */
export const CHILD_REPORT_ATTEMPT_ENTRY = "pi-openspec-x/child-report-attempt";

/** Version of the attempt entry payload (design D1). */
export const CHILD_REPORT_ATTEMPT_VERSION = 1;

/** Version of the tool-result envelope wrapping a business report. */
export const CHILD_REPORT_ENVELOPE_VERSION = 1;

/** Prefix of the worker dispatch task marker carried in the Task section. */
export const DISPATCH_TASK_MARKER_PREFIX = "[OPSX WORKER DISPATCH task=";

/** Closing delimiter of the worker dispatch task marker. */
export const DISPATCH_TASK_MARKER_SUFFIX = "]";

/**
 * Persisted attempt metadata. `taskMarker` is present only when the prompt
 * named exactly one distinct dispatch task (design D3: uniqueness, not
 * line-anchoring, is the safety property).
 */
export interface ChildReportAttempt {
  version: typeof CHILD_REPORT_ATTEMPT_VERSION;
  attemptId: string;
  agent: string;
  sessionId?: string;
  startedAt: string;
  promptSha256: string;
  taskMarker?: string;
}

/** Distinct dispatch task ids found in one prompt, in first-seen order. */
export function scanDispatchMarkers(prompt: string): string[] {
  const found: string[] = [];
  // Tolerant of the shapes a model actually writes: casing, an optional colon
  // after DISPATCH, and whitespace around `=`. Attribution still requires
  // exactly one distinct marker, so widening the syntax cannot make a run
  // ambiguous (design D3) — it only stops a well-meant marker from being
  // silently ignored, which left every live dispatch `taskUnknown`.
  const pattern = /\[OPSX\s+WORKER\s+DISPATCH\s*:?\s*task\s*=\s*([^\]\n]+)\]/gi;
  for (const match of prompt.matchAll(pattern)) {
    const encoded = match[1]?.trim();
    if (!encoded) continue;
    let decoded = encoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      // A malformed escape sequence stays as written; the value is still
      // compared verbatim against the report's taskId.
      decoded = encoded;
    }
    if (!found.includes(decoded)) found.push(decoded);
  }
  return found;
}

/** SHA-256 of the actual prompt text, hex encoded. */
export function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/** Build the attempt payload for one prompt. */
export function buildChildReportAttempt(input: {
  agent: string;
  prompt: string;
  sessionId?: string | undefined;
  now?: Date | undefined;
  attemptId?: string | undefined;
}): ChildReportAttempt {
  const markers = scanDispatchMarkers(input.prompt);
  const attempt: ChildReportAttempt = {
    version: CHILD_REPORT_ATTEMPT_VERSION,
    attemptId: input.attemptId ?? randomUUID(),
    agent: input.agent,
    startedAt: (input.now ?? new Date()).toISOString(),
    promptSha256: promptDigest(input.prompt),
  };
  if (input.sessionId) attempt.sessionId = input.sessionId;
  // Exactly one distinct marker names the task; zero or several do not.
  if (markers.length === 1) attempt.taskMarker = markers[0];
  return attempt;
}

/** Outcome of recording an attempt: either persisted or explicitly refused. */
export type ChildReportAttemptOutcome =
  | { ok: true; attempt: ChildReportAttempt }
  | { ok: false; reason: string };

/**
 * Record a fresh attempt entry for the prompt about to run. Persistence
 * failure is reported, never swallowed: an attempt that is not on the branch
 * cannot authorize anything, and the wrapper must fail loudly instead of
 * returning a fake success (design D1).
 */
export function beginChildReportAttempt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: {
    agent: string;
    prompt: string;
    now?: Date | undefined;
    attemptId?: string | undefined;
  },
): ChildReportAttemptOutcome {
  const attempt = buildChildReportAttempt({
    agent: input.agent,
    prompt: input.prompt,
    sessionId: ctx.sessionManager.getSessionId(),
    now: input.now,
    attemptId: input.attemptId,
  });
  try {
    pi.appendEntry(CHILD_REPORT_ATTEMPT_ENTRY, attempt);
  } catch (error) {
    return {
      ok: false,
      reason: `could not record the child report attempt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true, attempt };
}

/** Human-readable refusal text for a report that cannot be attributed. */
export function attemptUnavailableMessage(agent: string): string {
  return (
    `Report rejected: no child report attempt is recorded for ${agent} in this turn. ` +
    `The parent cannot attribute this report to a verified run, so it would be ignored; ` +
    `the attempt entry is written by this extension at the start of every turn.`
  );
}

/**
 * Wrap one role's reporting tool with the attempt envelope and register it.
 *
 * The wrapped tool keeps the original name, schema, confirmation text and
 * `sequential` execution mode; only `details` changes into the envelope. When
 * the current turn has no persisted attempt, the call fails explicitly instead
 * of returning a report the parent would have to discard.
 */
export function registerChildReportTool(
  pi: ExtensionAPI,
  options: { agent: string; tool: ToolDefinition },
): void {
  let current: ChildReportAttemptOutcome | undefined;

  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    current = beginChildReportAttempt(pi, ctx, {
      agent: options.agent,
      prompt: event.prompt,
    });
  });

  const base = options.tool;
  // Derive the parameter and callback types from the wrapped definition so
  // the wrapper is exactly as typed as the tool it wraps — no `unknown`
  // escapes, and the model-visible schema is untouched.
  type BaseParams = Parameters<typeof base.execute>[1];
  type BaseOnUpdate = Parameters<typeof base.execute>[3];

  const wrapped: ToolDefinition = {
    ...base,
    async execute(
      toolCallId: string,
      params: BaseParams,
      signal: AbortSignal | undefined,
      onUpdate: BaseOnUpdate,
      ctx: ExtensionToolContext,
    ) {
      if (!current || !current.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: attemptUnavailableMessage(options.agent),
            },
          ],
          details: {
            version: CHILD_REPORT_ENVELOPE_VERSION,
            agent: options.agent,
            error: "attempt-unavailable",
          },
          isError: true,
        };
      }
      const attemptId = current.attempt.attemptId;
      const result = await base.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      return {
        ...result,
        details: {
          version: CHILD_REPORT_ENVELOPE_VERSION,
          attemptId,
          agent: options.agent,
          report: params,
        },
      };
    },
  };

  pi.registerTool(wrapped);
}

// ---------------------------------------------------------------------------
// D2: reading a structured report out of a run's messages
// ---------------------------------------------------------------------------

/** The only three roles that carry a report tool, and the tool each carries. */
export const CHILD_REPORT_TOOL_BY_AGENT: Record<string, string> = {
  "opsx-gap-analysis": "report_gap_analysis",
  "opsx-plan-review": "report_plan_review",
  "opsx-worker": "report_work",
};

/** Result of reading one run's messages for a report. */
export type ChildReportReadResult =
  | {
      status: "ready";
      toolCallId: string;
      toolName: string;
      report: Record<string, unknown>;
    }
  | { status: "none"; reason: string }
  | { status: "rejected"; reason: string };

/**
 * Minimal structural view of the message fields this reader consumes. The
 * real values come from pi-ai's `Message` union; only these fields are ever
 * read, and `content` is never parsed as a delivery channel (design D2: free
 * text and previews are not evidence).
 */
interface MessageLike {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
}

interface FoundCall {
  id: string;
  arguments: unknown;
  order: number;
}

/** The report tool definitions keyed by name, for host-identical validation. */
const REPORT_TOOLS_BY_NAME = new Map(
  createReportTools().map((tool) => [tool.name, tool as unknown]),
);

/**
 * Validate a business report against the original tool schema using the same
 * validator the host applies to tool calls, so a report the host would have
 * refused can never be accepted here.
 */
export function validateChildReport(
  toolName: string,
  candidate: unknown,
):
  | { ok: true; report: Record<string, unknown> }
  | { ok: false; reason: string } {
  const tool = REPORT_TOOLS_BY_NAME.get(toolName);
  if (!tool) return { ok: false, reason: `unknown report tool ${toolName}` };
  try {
    const validated = validateToolArguments(
      tool as never,
      {
        type: "toolCall",
        id: "child-report-validation",
        name: toolName,
        arguments: candidate,
      } as never,
    ) as unknown;
    if (!validated || typeof validated !== "object") {
      return { ok: false, reason: "the report is not an object" };
    }
    // The report budget is enforced, not merely declared: an oversized payload
    // must be refused rather than truncated and then treated as complete
    // (design D4).
    const size = Buffer.byteLength(JSON.stringify(validated), "utf8");
    if (size > MAX_REPORT_BYTES) {
      return {
        ok: false,
        reason: `the report is ${size} bytes, which exceeds the ${MAX_REPORT_BYTES} byte report budget`,
      };
    }
    return { ok: true, report: validated as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function assistantReportCalls(
  message: MessageLike,
  toolName: string,
): FoundCall[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const calls: FoundCall[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (candidate.type !== "toolCall") continue;
    if (candidate.name !== toolName) continue;
    if (typeof candidate.id !== "string") continue;
    calls.push({ id: candidate.id, arguments: candidate.arguments, order: -1 });
  }
  return calls;
}

function readEnvelope(
  details: unknown,
  expected: { agent: string; attemptId: string },
): { ok: true; report: unknown } | { ok: false; reason: string } {
  if (!details || typeof details !== "object") {
    return { ok: false, reason: "the tool result carries no envelope details" };
  }
  const envelope = details as {
    version?: unknown;
    attemptId?: unknown;
    agent?: unknown;
    report?: unknown;
  };
  if (envelope.version !== CHILD_REPORT_ENVELOPE_VERSION) {
    return {
      ok: false,
      reason: `unsupported envelope version ${String(envelope.version)}`,
    };
  }
  if (envelope.agent !== expected.agent) {
    return {
      ok: false,
      reason: `the envelope belongs to ${String(envelope.agent)}, not ${expected.agent}`,
    };
  }
  if (envelope.attemptId !== expected.attemptId) {
    return {
      ok: false,
      reason: "the envelope names a different attempt than this turn's",
    };
  }
  return { ok: true, report: envelope.report };
}

/**
 * Read the report a run submitted, from that run's own messages.
 *
 * Ordering follows the *call* order, never the arrival order of duplicated
 * results: the last report call decides. A last call that is missing, failed,
 * mis-addressed or schema-invalid makes the run unreportable — it never falls
 * back to an earlier success (design D2 rule 4).
 */
export function readChildReportMessages(
  messages: readonly unknown[],
  expected: {
    agent: string;
    toolName: string;
    attemptId: string;
    taskId?: string | undefined;
  },
): ChildReportReadResult {
  const calls: FoundCall[] = [];
  const resultsByCallId = new Map<string, MessageLike>();

  messages.forEach((raw, order) => {
    const message = raw as MessageLike;
    if (!message || typeof message !== "object") return;
    if (message.role === "assistant") {
      for (const call of assistantReportCalls(message, expected.toolName)) {
        // Idempotent dedupe: one call id counts once, at its first position.
        if (calls.some((existing) => existing.id === call.id)) continue;
        calls.push({ ...call, order });
      }
      return;
    }
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string"
    ) {
      if (!resultsByCallId.has(message.toolCallId)) {
        resultsByCallId.set(message.toolCallId, message);
      }
    }
  });

  if (calls.length === 0) {
    return {
      status: "none",
      reason: `this run made no ${expected.toolName} call`,
    };
  }

  // More calls than the budget allows is a refusal, never a truncation: the
  // "last call wins" rule must not be applied to a run we cannot fully read.
  if (calls.length > MAX_REPORT_CALLS) {
    return {
      status: "rejected",
      reason: `this run made more than ${MAX_REPORT_CALLS} ${expected.toolName} calls, which exceeds the report-call budget`,
    };
  }

  const last = calls[calls.length - 1];

  // The call arguments must themselves be a valid report; a call the host
  // would have rejected is not delivery (design D2: arguments alone are not a
  // report either).
  const callValidation = validateChildReport(expected.toolName, last.arguments);
  if (!callValidation.ok) {
    return {
      status: "rejected",
      reason: `the latest ${expected.toolName} call arguments are invalid: ${callValidation.reason}`,
    };
  }

  const result = resultsByCallId.get(last.id);
  if (!result) {
    return {
      status: "rejected",
      reason: `the latest ${expected.toolName} call has no paired tool result`,
    };
  }
  if (result.isError === true) {
    return {
      status: "rejected",
      reason: `the latest ${expected.toolName} call failed`,
    };
  }
  if (result.toolName !== expected.toolName) {
    return {
      status: "rejected",
      reason: `the paired result belongs to ${String(result.toolName)}`,
    };
  }

  // A report that cannot be bound to an attempt nonce is not delivery: the
  // caller (readChildReportSession) adopts the newest attempt on the branch
  // and passes it here, so an absent nonce means the caller never resolved
  // one (design D2).
  if (expected.attemptId === undefined) {
    return {
      status: "rejected",
      reason: "the report cannot be bound to an attempt nonce",
    };
  }
  const envelope = readEnvelope(result.details, {
    agent: expected.agent,
    attemptId: expected.attemptId,
  });
  if (!envelope.ok) {
    return { status: "rejected", reason: envelope.reason };
  }

  const report = validateChildReport(expected.toolName, envelope.report);
  if (!report.ok) {
    return {
      status: "rejected",
      reason: `the reported payload is invalid: ${report.reason}`,
    };
  }
  if (
    expected.taskId !== undefined &&
    report.report.taskId !== expected.taskId
  ) {
    return {
      status: "rejected",
      reason: `the report names task ${String(report.report.taskId)}, not ${expected.taskId}`,
    };
  }

  return {
    status: "ready",
    toolCallId: last.id,
    toolName: expected.toolName,
    report: report.report,
  };
}

// ---------------------------------------------------------------------------
// D2/D4: reading the canonical Pi session record
// ---------------------------------------------------------------------------

/** Pi session format version this reader understands. */
export const SUPPORTED_SESSION_VERSION = 3;

/** Resource budgets (design D4). Exceeding one makes a run unusable, not truncated. */
export const MAX_SESSION_BYTES = 32 * 1024 * 1024;
export const MAX_SESSION_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_ENTRIES = 32768;
export const MAX_REPORT_BYTES = 512 * 1024;
export const MAX_REPORT_CALLS = 128;

/** Native child runs observed for one flow at once (design D4). */
export const MAX_ACTIVE_CHILDREN = 32;

/** One raw session line, structurally validated before use. */
interface RawEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  version?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
}

/** What the caller knows about the run from its own launch records. */
export interface ChildSessionExpectation {
  agent: string;
  toolName: string;
  /**
   * The nonce to bind to. Omit it to adopt the newest attempt entry on the
   * current branch: the child writes the nonce into its own session, so the
   * parent only learns it by reading that session, and requiring it up front
   * would make readiness unreachable. The step window and the branch scan
   * still bound which attempt may be adopted.
   */
  attemptId?: string | undefined;
  taskId?: string | undefined;
  runId: string;
  stepIndex: number;
  sessionRoot: string;
  sessionFile: string;
  stepStartedAt?: string | undefined;
  stepEndedAt?: string | undefined;
  /** True once the native step reached a successful terminal state. */
  stepTerminal: boolean;
}

/** Outcome of reading a child's canonical session record. */
export type ChildSessionOutcome =
  | {
      status: "ready";
      toolCallId: string;
      toolName: string;
      report: Record<string, unknown>;
      attempt: ChildReportAttempt;
    }
  | { status: "pending"; reason: string }
  | { status: "failed"; reason: string };

function fail(reason: string): ChildSessionOutcome {
  return { status: "failed", reason };
}

/** True when `child` resolves to a location inside `root` (both realpaths). */
export function isPathWithinRoot(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Parse the session file strictly: every line must be valid JSON, the header
 * must be a supported v3 header, ids must be unique and every `parentId` must
 * resolve. The public parser tolerates skipped lines; tolerating them here
 * would let a dropped line silently erase the evidence that a later report
 * failed (design D2 constraint 1).
 */
function parseStrictSession(
  content: string,
): { ok: true; entries: RawEntry[] } | { ok: false; reason: string } {
  const lines = content.split("\n");
  // A trailing newline produces one empty tail element, which is expected.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0)
    return { ok: false, reason: "the session file is empty" };

  const entries: RawEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (Buffer.byteLength(line, "utf8") > MAX_SESSION_LINE_BYTES) {
      return {
        ok: false,
        reason: `session line ${index + 1} exceeds the ${MAX_SESSION_LINE_BYTES} byte line budget`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {
        ok: false,
        reason: `session line ${index + 1} is not valid JSON`,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: `session line ${index + 1} is not an object`,
      };
    }
    entries.push(parsed as RawEntry);
  }

  const header = entries[0];
  if (header.type !== "session") {
    return { ok: false, reason: "the session file has no session header" };
  }
  if (header.version !== SUPPORTED_SESSION_VERSION) {
    return {
      ok: false,
      reason: `unsupported session version ${String(header.version)}`,
    };
  }

  const ids = new Set<string>();
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (typeof entry.id !== "string" || entry.id === "") {
      return { ok: false, reason: `session entry ${index} has no id` };
    }
    if (ids.has(entry.id)) {
      return { ok: false, reason: `duplicate session entry id ${entry.id}` };
    }
    ids.add(entry.id);
    if (typeof entry.type !== "string") {
      return { ok: false, reason: `session entry ${entry.id} has no type` };
    }
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      return { ok: false, reason: `session entry ${entry.id} has no parentId` };
    }
    if (typeof entry.parentId === "string" && !ids.has(entry.parentId)) {
      return {
        ok: false,
        reason: `session entry ${entry.id} points at a missing parent ${entry.parentId}`,
      };
    }
  }
  if (entries.length - 1 > MAX_SESSION_ENTRIES) {
    return {
      ok: false,
      reason: `the session holds more than ${MAX_SESSION_ENTRIES} entries`,
    };
  }
  return { ok: true, entries };
}

/** The current leaf branch, root-first, derived from the last appended entry. */
function branchOf(entries: readonly RawEntry[]): RawEntry[] {
  const byId = new Map<string, RawEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const branch: RawEntry[] = [];
  let cursor: RawEntry | undefined = entries[entries.length - 1];
  while (cursor) {
    branch.push(cursor);
    cursor =
      typeof cursor.parentId === "string"
        ? byId.get(cursor.parentId)
        : undefined;
  }
  return branch.reverse();
}

// ---------------------------------------------------------------------------
// Incremental reading (design D4)
// ---------------------------------------------------------------------------

function unresolvedToolCalls(messages: readonly MessageLike[]): number {
  const resolved = new Set<string>();
  for (const message of messages) {
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string"
    ) {
      resolved.add(message.toolCallId);
    }
  }
  let pending = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const candidate = part as { type?: unknown; id?: unknown };
      if (candidate.type !== "toolCall") continue;
      if (typeof candidate.id === "string" && !resolved.has(candidate.id)) {
        pending += 1;
      }
    }
  }
  return pending;
}

/**
 * Read a child's report from its canonical Pi session record.
 *
 * The record is the authority (design D2): the best-effort diagnostic log is
 * never consulted, and a missing line, broken parent chain, absent tail or
 * changed file keeps the run unreportable rather than falling back to an
 * earlier success. `SessionManager.open` is deliberately not used — it may
 * repair the file it reads.
 */
export function readChildReportSession(
  expected: ChildSessionExpectation,
): ChildSessionOutcome {
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(expected.sessionRoot);
    file = fs.realpathSync(expected.sessionFile);
  } catch (error) {
    return fail(
      `the attributed session path cannot be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPathWithinRoot(file, root)) {
    return fail(
      "the session file resolves outside the attributed session root",
    );
  }

  let before: fs.Stats;
  let content: string;
  try {
    before = fs.statSync(file);
    if (before.size > MAX_SESSION_BYTES) {
      return fail(
        `the session file exceeds the ${MAX_SESSION_BYTES} byte budget`,
      );
    }
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        status: "pending",
        reason: "the child session file does not exist yet",
      };
    }
    return fail(
      `the child session file cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parsed = parseStrictSession(content);
  if (!parsed.ok) return fail(parsed.reason);
  const branch = branchOf(parsed.entries);

  // The latest recorded attempt on this branch must be this turn's.
  let attemptIndex = -1;
  let attempt: ChildReportAttempt | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry.type !== "custom" ||
      entry.customType !== CHILD_REPORT_ATTEMPT_ENTRY
    ) {
      continue;
    }
    const data = entry.data as ChildReportAttempt | undefined;
    if (!data || data.version !== CHILD_REPORT_ATTEMPT_VERSION) continue;
    if (
      expected.attemptId !== undefined &&
      data.attemptId !== expected.attemptId
    ) {
      continue;
    }
    if (data.agent !== expected.agent) continue;
    attemptIndex = index;
    attempt = data;
    break;
  }
  if (!attempt || attemptIndex === -1) {
    return fail("the current branch carries no matching child report attempt");
  }
  const attemptId = attempt.attemptId;

  if (
    expected.stepStartedAt !== undefined &&
    attempt.startedAt < expected.stepStartedAt
  ) {
    return fail("the attempt predates the attributed native step");
  }
  if (
    expected.stepEndedAt !== undefined &&
    attempt.startedAt > expected.stepEndedAt
  ) {
    return fail("the attempt postdates the attributed native step");
  }

  // The attempt must follow a real user dispatch on this branch: a report can
  // never be attributed to an inherited turn.
  let dispatchIndex = -1;
  for (let index = attemptIndex - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const message = entry.message as MessageLike | undefined;
    if (message?.role === "user") {
      dispatchIndex = index;
      break;
    }
  }
  if (dispatchIndex === -1) {
    // The attempt entry is written by `before_agent_start`, which the host runs
    // just before the user message is persisted, so the dispatch for this turn
    // legitimately lands immediately *after* the attempt. What matters is that
    // a real dispatch exists and the report follows it — not the attempt's
    // position relative to it. Live, requiring "preceded by" rejected every
    // genuine report.
    for (let index = attemptIndex + 1; index < branch.length; index += 1) {
      const entry = branch[index];
      if (entry.type !== "message") continue;
      const message = entry.message as MessageLike | undefined;
      if (message?.role === "user") {
        dispatchIndex = index;
        break;
      }
    }
  }
  if (dispatchIndex === -1) {
    return fail(
      "the attempt is not preceded by a user dispatch on this branch",
    );
  }

  const turnMessages: MessageLike[] = [];
  for (let index = attemptIndex + 1; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    if (entry.message && typeof entry.message === "object") {
      turnMessages.push(entry.message as MessageLike);
    }
  }

  // A normal ending: every tool call was answered, so the turn actually
  // finished rather than being cut off mid-flight.
  if (unresolvedToolCalls(turnMessages) > 0) {
    return {
      status: "pending",
      reason: "the child turn still has an unresolved tool call",
    };
  }

  const read = readChildReportMessages(turnMessages, {
    agent: expected.agent,
    toolName: expected.toolName,
    attemptId,
    taskId: expected.taskId,
  });

  // Reading is only trustworthy if the file did not move under us.
  let after: fs.Stats;
  try {
    after = fs.statSync(file);
  } catch (error) {
    return fail(
      `the child session file disappeared while reading: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    return fail("the child session file changed while it was being read");
  }

  if (read.status !== "ready") {
    if (read.status === "none" && !expected.stepTerminal) {
      return { status: "pending", reason: read.reason };
    }
    return fail(read.reason);
  }

  if (!expected.stepTerminal) {
    // A report observed while the child is still running is a candidate, never
    // a receipt (design D3).
    return {
      status: "pending",
      reason: "the child run has not reached a successful terminal state",
    };
  }
  if (expected.stepEndedAt === undefined) {
    return fail(
      "the terminal native step carries no end boundary, so the report cannot be bounded to it",
    );
  }

  return {
    status: "ready",
    toolCallId: read.toolCallId,
    toolName: read.toolName,
    report: read.report,
    attempt,
  };
}
