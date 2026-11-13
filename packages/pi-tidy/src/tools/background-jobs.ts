/**
 * Background jobs: work a tool call started that outlives the call — a dev
 * server, a test watcher. The call itself finishes in milliseconds, so to pi
 * (and to the grouping) it is done; the job's real state lives in whichever
 * extension runs it.
 *
 * pi has no notion of these, so each such extension gets a small provider
 * here. A provider says which tool results start a job, which messages report
 * on one, and where live updates come from. pi-processes is the first. If a
 * provider's protocol stops matching (renamed fields, different events) it
 * simply finds no jobs, and rows render the way they did before.
 *
 * State is derived, not persisted: a job is seeded from its start call's
 * result, corrected by the extension's live answer, and — when a session is
 * reloaded — rebuilt from the notification messages the extension persisted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { liveSlot } from "../live.ts";

export type JobStatus = "running" | "done" | "failed" | "killed" | "gone";

export interface JobState {
  id: string;
  name: string;
  status: JobStatus;
  /** Epoch ms. */
  startTime?: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string;
  /** The latest thing worth surfacing, e.g. `READY matched`. */
  note?: string;
  /** What the job reported, oldest first: the rows under its own row. */
  notifications?: JobNotification[];
}

/** One thing a job told the session about itself — a matched log line, today. */
export interface JobNotification {
  /** One line, already stripped of what a terminal would obey. */
  text: string;
  /** Epoch ms, so the same report arriving twice (live event and its message) lands once. */
  at?: number;
}

export interface JobDetails {
  command?: string;
  cwd?: string;
  /** Undefined means unavailable; an empty array means no output yet. */
  logs?: Array<{ type: "stdout" | "stderr"; text: string }>;
}

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ToolSnapshot {
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  isPartial: boolean;
  result?: { isError?: boolean; details?: unknown };
}

export interface MessageSnapshot {
  customType?: unknown;
  details?: unknown;
}

export interface JobProvider {
  /** The job a finished call started, as of its result. */
  fromToolResult(tool: ToolSnapshot): JobState | undefined;
  /** Ask the extension for the job's live state; `null` = it doesn't know it. */
  lookup(events: EventBusLike, id: string): Partial<JobState> | null | undefined;
  /** A message reporting on a job: which one, and what it says. */
  fromMessage(message: MessageSnapshot): { id: string; patch: Partial<JobState> } | undefined;
  /** Live updates. Returns the unsubscribe. */
  subscribe(events: EventBusLike, update: (id: string, patch: Partial<JobState>) => void): () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// pi-processes (@aliou/pi-processes)
// ─────────────────────────────────────────────────────────────────────────────

interface ProcessInfoLike {
  id?: unknown;
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  status?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  exitCode?: unknown;
  success?: unknown;
  endReason?: unknown;
  signal?: { name?: unknown } | null;
  errorMessage?: unknown;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/**
 * A raw log line on its way into a row. Matched text is whatever the process
 * printed, so it can carry colours and control sequences a terminal obeys.
 */
function plainLine(value: string): string {
  return value
    .replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** pi-processes' `ProcessInfo` → our state. */
function fromProcessInfo(info: ProcessInfoLike): Partial<JobState> {
  const live = info.status === "running" || info.status === "terminating" || info.status === "terminate_timeout";
  const status: JobStatus = live
    ? "running"
    : info.status === "killed" || info.endReason === "signal"
      ? "killed"
      : info.success === true
        ? "done"
        : "failed";
  const patch: Partial<JobState> = { status, startTime: num(info.startTime) };
  if (!live) {
    patch.endTime = num(info.endTime);
    patch.exitCode = num(info.exitCode) ?? null;
    patch.signal = str(info.signal?.name);
    if (status === "failed" && info.endReason !== "exit") patch.note = str(info.errorMessage) ?? str(info.endReason);
  }
  return patch;
}

const PROCESS_NOTIFICATION = "ad-process:notification";

/** A notification payload (live event or persisted message details) → a patch. */
function fromProcessNotification(details: unknown): { id: string; patch: Partial<JobState> } | undefined {
  const d = details as {
    kind?: unknown;
    processId?: unknown;
    timestamp?: unknown;
    exitCode?: unknown;
    signal?: { name?: unknown } | null;
    logMatch?: { pattern?: unknown; line?: unknown; stream?: unknown };
  };
  const id = str(d?.processId);
  if (!id) return undefined;
  const endTime = num(d.timestamp);
  switch (d.kind) {
    case "success":
      return { id, patch: { status: "done", endTime, exitCode: num(d.exitCode) ?? 0 } };
    case "failure":
    case "crash":
      return { id, patch: { status: "failed", endTime, exitCode: num(d.exitCode) ?? null } };
    case "killed":
      return { id, patch: { status: "killed", endTime, signal: str(d.signal?.name) } };
    case "log_match": {
      const pattern = str(d.logMatch?.pattern);
      if (!pattern) return undefined;
      // The pattern is what the row carries; the matched line is the part the
      // row cannot hold, and the reason the notifications get rows of their own.
      const line = plainLine(str(d.logMatch?.line) ?? "");
      const stream = str(d.logMatch?.stream) === "stderr" ? "stderr" : "stdout";
      return line
        ? { id, patch: { note: `${pattern} matched`, notifications: [{ text: `matched ${stream}: ${line}`, at: endTime }] } }
        : { id, patch: { note: `${pattern} matched` } };
    }
    default:
      return undefined;
  }
}

export const piProcessesProvider: JobProvider = {
  fromToolResult(tool) {
    if (tool.toolName !== "process" || tool.isPartial || tool.result?.isError) return undefined;
    if ((tool.args as { action?: unknown } | undefined)?.action !== "start") return undefined;
    const process = (tool.result?.details as { process?: ProcessInfoLike } | undefined)?.process;
    const id = str(process?.id);
    if (!process || !id) return undefined;
    return { id, name: str(process.name) ?? id, status: "running", ...fromProcessInfo(process) };
  },
  lookup(events, id) {
    let reply: ProcessInfoLike | null | undefined;
    events.emit("processes:request:get", {
      id,
      reply: (info: ProcessInfoLike | null | undefined) => {
        reply = info ?? null;
      },
    });
    if (reply === undefined) return undefined; // nobody answered: pi-processes isn't loaded
    return reply ? fromProcessInfo(reply) : null;
  },
  fromMessage(message) {
    return message.customType === PROCESS_NOTIFICATION ? fromProcessNotification(message.details) : undefined;
  },
  subscribe(events, update) {
    const off = [
      events.on("processes:ended", (info) => {
        const id = str((info as ProcessInfoLike)?.id);
        if (id) update(id, fromProcessInfo(info as ProcessInfoLike));
      }),
      events.on("processes:notification", (payload) => {
        const hit = fromProcessNotification(payload);
        if (hit) update(hit.id, hit.patch);
      }),
    ];
    return () => {
      for (const dispose of off) dispose();
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global so a `/reload` shares it: the patches installed by the first load
 * read it, the reloaded module's event subscription writes it.
 */
interface Store {
  providers: JobProvider[];
  jobs: Map<string, JobState>;
  /** Jobs whose start row has rendered — their notifications are redundant. */
  rows: Set<string>;
  /** Call id → the jobs that call started, so a turn's summary can count what they said. */
  callJobs: Map<string, string[]>;
  /** Nested call → transcript-visible root, and the jobs owned by each root. */
  parents: Map<string, string>;
  nested: Map<string, JobState[]>;
  /** Notifications can arrive before the start result or its first render. */
  pending: Map<string, Partial<JobState>>;
  /** Presence means expanded; undefined means its cached snapshot is dirty. */
  details: Map<string, JobDetails | undefined>;
  events?: EventBusLike;
  ui?: { requestRender?(): void };
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  options: { enabled: boolean; hideNotifications: boolean };
}

const store = liveSlot<Store | undefined>("background-jobs", undefined);

function jobsStore(): Store {
  let s = store.get();
  if (!s) {
    s = {
      providers: [piProcessesProvider],
      jobs: new Map(),
      rows: new Set(),
      callJobs: new Map(),
      parents: new Map(),
      nested: new Map(),
      pending: new Map(),
      details: new Map(),
      options: { enabled: true, hideNotifications: true },
    };
    store.set(s);
  }
  // A /reload can inherit the store created by an earlier package version.
  s.parents ??= new Map();
  s.nested ??= new Map();
  s.pending ??= new Map();
  s.details ??= new Map();
  s.callJobs ??= new Map();
  return s;
}

export function setJobOptions(options: { enabled: boolean; hideNotifications: boolean }): void {
  jobsStore().options = options;
}

export function jobsEnabled(): boolean {
  return jobsStore().options.enabled;
}

/** A watcher that ticks every second must not grow the session file. */
const NOTE_LIMIT = 10;

/** Notifications pile up; the same one arriving twice (event and message) lands once. */
function appendNotes(job: JobState, incoming: readonly JobNotification[]): boolean {
  const list = job.notifications ?? (job.notifications = []);
  let added = false;
  for (const note of incoming) {
    if (list.some((seen) => seen.text === note.text && seen.at === note.at)) continue;
    list.push(note);
    added = true;
  }
  if (list.length > NOTE_LIMIT) list.splice(0, list.length - NOTE_LIMIT);
  return added;
}

/** Ended states never go back to running; "gone" yields to a real answer. */
function apply(s: Store, id: string, patch: Partial<JobState>): boolean {
  const job = s.jobs.get(id);
  if (!job) return false;
  if (patch.status === "running" && job.status !== "running") patch = { ...patch, status: job.status };
  if (job.status !== "running" && job.status !== "gone" && patch.status && patch.status !== job.status) {
    patch = { ...patch, status: job.status };
  }
  let changed = false;
  for (const [key, value] of Object.entries(patch) as Array<[keyof JobState, unknown]>) {
    if (value === undefined || key === "notifications" || job[key] === value) continue;
    (job as unknown as Record<string, unknown>)[key] = value;
    changed = true;
  }
  if (patch.notifications?.length && appendNotes(job, patch.notifications)) changed = true;
  return changed;
}

/** Pending patches merge field by field; notifications append rather than replace. */
function mergePending(s: Store, id: string, patch: Partial<JobState>): void {
  const previous = s.pending.get(id);
  const notifications = [...(previous?.notifications ?? []), ...(patch.notifications ?? [])];
  s.pending.set(id, { ...previous, ...patch, ...(notifications.length ? { notifications } : {}) });
}

/** Which call started a job: a turn's summary counts what its calls' jobs said. */
function linkCall(s: Store, toolCallId: string | undefined, jobId: string): void {
  if (!toolCallId) return;
  const ids = s.callJobs.get(toolCallId) ?? [];
  if (!ids.includes(jobId)) s.callJobs.set(toolCallId, [...ids, jobId]);
}

function repaint(s: Store): void {
  s.ui?.requestRender?.();
}

/** Subscribe to every provider's live updates (replacing an earlier load's). */
export function connectJobs(events: EventBusLike | undefined): void {
  const s = jobsStore();
  s.unsubscribe?.();
  s.unsubscribe = undefined;
  s.events = events;
  if (!events) return;
  const disposers = s.providers.map((provider) =>
    provider.subscribe(events, (id, patch) => {
      const inspecting = invalidateJobDetails(s, id);
      if (!s.jobs.has(id)) mergePending(s, id, patch);
      const changed = apply(s, id, patch);
      if (changed || inspecting) repaint(s);
    }),
  );
  disposers.push(
    events.on("processes:output_changed", (payload) => {
      const id = str((payload as { id?: unknown })?.id);
      if (id && invalidateJobDetails(s, id)) repaint(s);
    }),
    events.on("processes:changed", (payload) => {
      if ((payload as { reason?: unknown })?.reason !== "cleared") return;
      for (const id of s.details.keys()) invalidateJobDetails(s, id);
      if (s.details.size) repaint(s);
    }),
  );
  s.unsubscribe = () => {
    for (const dispose of disposers) dispose();
  };
}

function invalidateJobDetails(s: Store, id: string): boolean {
  if (!s.details.has(id)) return false;
  s.details.set(id, undefined);
  return true;
}

export function toggleJobDetails(id: string): void {
  const s = jobsStore();
  if (s.details.has(id)) s.details.delete(id);
  else s.details.set(id, undefined);
}

export function closeJobDetails(ids: Iterable<string>): void {
  const s = jobsStore();
  for (const id of ids) s.details.delete(id);
}

/** Only expanded rows read logs, once per output/end event, never once per frame. */
export function jobDetails(id: string): JobDetails | undefined {
  const s = jobsStore();
  if (!s.details.has(id)) return undefined;
  const cached = s.details.get(id);
  if (cached) return cached;
  let info: ProcessInfoLike | null | undefined;
  let output: unknown;
  try {
    s.events?.emit("processes:request:get", { id, reply: (value: ProcessInfoLike | null) => { info = value; } });
    s.events?.emit("processes:request:combined_output", { id, tailLines: 20, reply: (value: unknown) => { output = value; } });
  } catch {
    // Missing/stale process providers must not break the transcript.
  }
  const details: JobDetails = { command: str(info?.command), cwd: str(info?.cwd) };
  if (Array.isArray(output)) {
    details.logs = output.slice(-20).filter((line): line is { type: "stdout" | "stderr"; text: string } =>
      line && (line.type === "stdout" || line.type === "stderr") && typeof line.text === "string",
    );
  }
  s.details.set(id, details);
  return details;
}

/** Seed once, then correct the snapshot from live state and early notifications. */
function rememberJob(s: Store, seed: JobState, provider: JobProvider): JobState {
  let job = s.jobs.get(seed.id);
  if (!job) {
    job = { ...seed };
    s.jobs.set(seed.id, job);
    const live = s.events ? provider.lookup(s.events, seed.id) : undefined;
    if (live === null) job.status = "gone";
    else if (live) apply(s, seed.id, live);
    const pending = s.pending.get(seed.id);
    if (pending) apply(s, seed.id, pending);
    s.pending.delete(seed.id);
  }
  return job;
}

type RenderedTool = ToolSnapshot & { ui?: { requestRender?(): void } };

/** A direct start still replaces its call's row, just as before. */
export function jobForTool(tool: RenderedTool): JobState | undefined {
  const s = jobsStore();
  if (!s.options.enabled) return undefined;
  for (const provider of s.providers) {
    const seed = provider.fromToolResult(tool);
    if (!seed) continue;
    if (tool.ui) s.ui = tool.ui;
    s.rows.add(seed.id);
    linkCall(s, tool.toolCallId, seed.id);
    const job = rememberJob(s, seed, provider);
    ensureTicker(s);
    return job;
  }
  return undefined;
}

/** All jobs this row owns, including starts made inside another tool. */
export function jobsForTool(tool: RenderedTool): JobState[] {
  const s = jobsStore();
  if (!s.options.enabled) return [];
  if (tool.ui) s.ui = tool.ui;
  const direct = jobForTool(tool);
  const details = tool.result?.details as { tidyBackgroundJobs?: unknown } | undefined;
  const saved = details?.tidyBackgroundJobs;
  const nested = tool.toolCallId ? s.nested.get(tool.toolCallId) : undefined;
  if (!direct && !nested?.length && !Array.isArray(saved)) return [];
  const jobs = new Map<string, JobState>(direct ? [[direct.id, direct]] : []);
  const seeds = [...(nested ?? [])];
  if (Array.isArray(saved)) {
    for (const seed of saved) {
      if (seed && str(seed.id) && str(seed.name) && ["running", "done", "failed", "killed", "gone"].includes(seed.status)) {
        seeds.push(seed as JobState);
      }
    }
  }
  for (const seed of seeds) {
    const job = rememberJob(s, seed, piProcessesProvider);
    jobs.set(job.id, job);
    s.rows.add(job.id);
    linkCall(s, tool.toolCallId, job.id);
  }
  ensureTicker(s);
  return [...jobs.values()];
}

/** Clear branch/session ownership, without changing options or event subscriptions. */
function clearJobSession(): void {
  const s = jobsStore();
  if (s.timer) clearTimeout(s.timer);
  s.timer = undefined;
  s.ui = undefined;
  s.jobs.clear();
  s.rows.clear();
  s.callJobs.clear();
  s.parents.clear();
  s.nested.clear();
  s.pending.clear();
  s.details.clear();
}

/** Use pi's structured nested-call events, never script source or printed output. */
export function registerNestedJobs(pi: ExtensionAPI): void {
  pi.on("tool_execution_start", (event) => {
    const s = jobsStore();
    if (s.options.enabled && event.parentToolCallId) {
      s.parents.set(event.toolCallId, s.parents.get(event.parentToolCallId) ?? event.parentToolCallId);
    }
  });
  pi.on("tool_result", (event) => {
    const s = jobsStore();
    if (!s.options.enabled) return;
    if (event.parentToolCallId) {
      const root = s.parents.get(event.parentToolCallId) ?? event.parentToolCallId;
      const seed = piProcessesProvider.fromToolResult({
        toolName: event.toolName,
        args: event.input,
        isPartial: false,
        result: event,
      });
      if (!seed) return;
      const jobs = s.nested.get(root) ?? [];
      if (!jobs.some((job) => job.id === seed.id)) jobs.push(rememberJob(s, seed, piProcessesProvider));
      s.nested.set(root, jobs);
      repaint(s);
      return;
    }
    for (const [id, root] of s.parents) if (root === event.toolCallId) s.parents.delete(id);
    const jobs = s.nested.get(event.toolCallId);
    if (!jobs?.length) return;
    // Preserve the tool's own details contract. Unknown non-object details keep
    // live tracking, but cannot carry our metadata safely on a resumed session.
    const details = event.details;
    if (details !== undefined && (details === null || typeof details !== "object" || Array.isArray(details))) return;
    return { details: { ...details, tidyBackgroundJobs: jobs.map((job) => ({ ...job })) } };
  });
  pi.on("session_start", clearJobSession);
  pi.on("session_tree", clearJobSession);
  pi.on("session_shutdown", () => {
    clearJobSession();
    connectJobs(undefined);
  });
}

/**
 * The rows a job's notifications deserve. None while `hideJobNotifications` is
 * off: the messages are still drawn as their own blocks, and the same report
 * twice in one group is worse than the block it replaced.
 */
export function jobNotes(job: JobState): readonly JobNotification[] {
  return jobsStore().options.hideNotifications ? job.notifications ?? [] : [];
}

/**
 * How many notifications the jobs of one call have collected. A folded turn's
 * summary says so, because the rows that carry them are not drawn there.
 */
export function jobNoteCount(toolCallId: string | undefined): number {
  const s = jobsStore();
  if (!toolCallId || !s.options.hideNotifications) return 0;
  let total = 0;
  for (const id of s.callJobs.get(toolCallId) ?? []) total += s.jobs.get(id)?.notifications?.length ?? 0;
  return total;
}

/**
 * A message rendered: fold what it reports into its job. Returns true when it
 * should be hidden — its job has a row showing the same thing.
 */
export function noteJobMessage(message: MessageSnapshot | undefined): boolean {
  const s = jobsStore();
  if (!s.options.enabled || !message) return false;
  for (const provider of s.providers) {
    const hit = provider.fromMessage(message);
    if (!hit) continue;
    // On a reload the row rendered first, with the start snapshot: one more
    // frame lets it show what this message says.
    if (!s.jobs.has(hit.id)) mergePending(s, hit.id, hit.patch);
    else if (apply(s, hit.id, hit.patch)) repaint(s);
    return s.options.hideNotifications && s.rows.has(hit.id);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock
// ─────────────────────────────────────────────────────────────────────────────

/** A spinner frame per second for the first minutes, then a still dot. */
const SPINNER = ["◐", "◓", "◑", "◒"];
export const ANIMATE_MS = 5 * 60_000;

export function spinnerFrame(job: JobState, now = Date.now()): string {
  const age = job.startTime !== undefined ? now - job.startTime : 0;
  return age < ANIMATE_MS ? SPINNER[Math.floor(now / 1000) % SPINNER.length] : "●";
}

/**
 * One repaint per second while a young job runs, one per minute once every
 * running job is past the animation window (a dev server can run for hours —
 * the whole transcript re-renders on each tick). Stops when nothing runs.
 */
function ensureTicker(s: Store): void {
  if (s.timer) return;
  const running = [...s.jobs.values()].filter((job) => job.status === "running" && s.rows.has(job.id));
  if (running.length === 0) return;
  const now = Date.now();
  const young = running.some((job) => job.startTime === undefined || now - job.startTime < ANIMATE_MS);
  s.timer = setTimeout(
    () => {
      s.timer = undefined;
      repaint(s);
      ensureTicker(s);
    },
    young ? 1000 : 60_000,
  );
  s.timer.unref?.();
}

/** Test seam. */
export function resetJobs(providers: JobProvider[] = [piProcessesProvider]): void {
  const s = jobsStore();
  if (s.timer) clearTimeout(s.timer);
  s.unsubscribe?.();
  store.set({
    providers,
    jobs: new Map(),
    rows: new Set(),
    callJobs: new Map(),
    parents: new Map(),
    nested: new Map(),
    pending: new Map(),
    details: new Map(),
    options: { enabled: true, hideNotifications: true },
  });
}
