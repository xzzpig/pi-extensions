/**
 * Flow entries, the turn status snapshot, and the progress line renderers
 * (design D8; openspec change add-pi-openspec-x, task 9.1).
 *
 * Flow state is recorded as custom session entries (mode in/out, phase change,
 * verdict, task ticked) plus a `display: false`-style status snapshot appended
 * each turn. Custom entries never enter the LLM context, so the snapshot keeps
 * the interface recoverable after a compaction without perturbing the prompt
 * cache. The renderers turn entries and messages into compact progress lines.
 *
 * The state model and text renderers are pure; the registration wiring only
 * wraps them in minimal components.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  TurnEndEvent,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";

export const OPSX_ENTRY_TYPES = {
  modeEntered: "pi-openspec-x/mode-entered",
  modeExited: "pi-openspec-x/mode-exited",
  phaseChanged: "pi-openspec-x/phase-changed",
  verdict: "pi-openspec-x/verdict",
  approval: "pi-openspec-x/approval",
  taskTicked: "pi-openspec-x/task-ticked",
  rollback: "pi-openspec-x/rollback",
  progress: "pi-openspec-x/progress",
  statusSnapshot: "pi-openspec-x/status-snapshot",
} as const;

type OpsxEntryType = (typeof OPSX_ENTRY_TYPES)[keyof typeof OPSX_ENTRY_TYPES];

type OpsxFlowMode = "plan" | "agent" | "direct";

export interface OpsxFlowState {
  mode?: OpsxFlowMode;
  changeId?: string;
  phase?: string;
  round?: number;
  tasksTotal?: number;
  tasksDone?: number;
  lastVerdict?: string;
  updatedAt?: string;
  /** Set on the snapshot written when the flow ends, so a restored snapshot
   * from a previous process is not shown as if the flow were still running. */
  ended?: boolean;
}

/** Append a flow entry. Best-effort: a failed append never breaks the flow. */
export function appendFlowEntry(
  pi: Pick<ExtensionAPI, "appendEntry">,
  type: OpsxEntryType,
  data: Record<string, unknown>,
): void {
  try {
    pi.appendEntry(type, data);
  } catch {
    // Observability is best-effort.
  }
}

/**
 * Append the per-turn status snapshot (a custom entry, so it stays out of the
 * LLM context and survives compaction for interface recovery).
 */
export function appendStatusSnapshot(
  pi: Pick<ExtensionAPI, "appendEntry">,
  state: OpsxFlowState,
): OpsxFlowState {
  const snapshot: OpsxFlowState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  appendFlowEntry(pi, OPSX_ENTRY_TYPES.statusSnapshot, {
    ...snapshot,
  });
  return snapshot;
}

/** Minimal session-entry view (pi's CustomEntry shape). */
export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/**
 * Recover the latest flow state from session entries. Used after a compaction
 * (or a reload) to restore the status line. Returns undefined when no snapshot
 * was ever written.
 */
export function restoreFlowState(
  entries: readonly SessionEntryLike[],
): OpsxFlowState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === OPSX_ENTRY_TYPES.statusSnapshot &&
      entry.data &&
      typeof entry.data === "object"
    ) {
      return { ...(entry.data as OpsxFlowState) };
    }
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Render one flow entry as a compact progress line. */
export function renderFlowEntryText(
  customType: string,
  data: Record<string, unknown> | undefined,
): string | undefined {
  const change = asText(data?.changeId) ?? "?";
  switch (customType) {
    case OPSX_ENTRY_TYPES.modeEntered:
      return `◆ opsx ${asText(data?.mode) ?? "?"} mode entered (${change})`;
    case OPSX_ENTRY_TYPES.modeExited:
      return `◇ opsx ${asText(data?.mode) ?? "?"} mode exited (${change})`;
    case OPSX_ENTRY_TYPES.phaseChanged:
      return `→ phase ${asText(data?.phase) ?? "?"} (${change})`;
    case OPSX_ENTRY_TYPES.verdict: {
      const round = asNumber(data?.round);
      return `⚖ ${asText(data?.verdict) ?? "?"}${round ? ` round ${round}` : ""} (${change})`;
    }
    case OPSX_ENTRY_TYPES.approval:
      return `✍ plan ${asText(data?.decision) ?? "?"} (${change})`;
    case OPSX_ENTRY_TYPES.taskTicked:
      return `☑ ${asText(data?.taskId) ?? "?"} (${change})`;
    case OPSX_ENTRY_TYPES.rollback: {
      const restored = asNumber(data?.restored) ?? 0;
      const deleted = asNumber(data?.deleted) ?? 0;
      return `↩ rollback: ${restored} restored, ${deleted} removed (${change})`;
    }
    default:
      return undefined;
  }
}

/** Render the session status line from the current flow state. */
export function renderStatusLine(state: OpsxFlowState): string {
  const parts: string[] = ["opsx"];
  if (state.mode) parts.push(state.mode);
  if (state.changeId) parts.push(state.changeId);
  if (state.phase) parts.push(state.phase);
  if (typeof state.round === "number") parts.push(`round ${state.round}`);
  if (
    typeof state.tasksTotal === "number" &&
    typeof state.tasksDone === "number"
  ) {
    parts.push(`tasks ${state.tasksDone}/${state.tasksTotal}`);
  }
  if (state.lastVerdict) parts.push(`last ${state.lastVerdict}`);
  return parts.join(" · ");
}

/** A minimal TUI component (render + invalidate are required by pi's Component). */
interface MinimalComponent {
  render(width: number): string[];
  invalidate(): void;
}

function lineComponent(text: string): MinimalComponent {
  return { render: () => [text], invalidate: () => {} };
}

/**
 * Register the entry renderers for the flow entries. Each renders a single
 * compact line; unknown shapes fall back to the default renderer.
 */
export function registerFlowRenderers(pi: ExtensionAPI): void {
  const entryTypes: OpsxEntryType[] = [
    OPSX_ENTRY_TYPES.modeEntered,
    OPSX_ENTRY_TYPES.modeExited,
    OPSX_ENTRY_TYPES.phaseChanged,
    OPSX_ENTRY_TYPES.verdict,
    OPSX_ENTRY_TYPES.approval,
    OPSX_ENTRY_TYPES.taskTicked,
    OPSX_ENTRY_TYPES.rollback,
  ];
  for (const entryType of entryTypes) {
    pi.registerEntryRenderer(entryType, (entry) => {
      const data =
        entry.data && typeof entry.data === "object"
          ? (entry.data as Record<string, unknown>)
          : undefined;
      const text = renderFlowEntryText(entryType, data);
      return text ? lineComponent(text) : undefined;
    });
  }
}

/** The current flow state, recovered from the session snapshot. */
function currentFlowState(ctx: ExtensionContext): OpsxFlowState | undefined {
  try {
    return restoreFlowState(ctx.sessionManager.getEntries());
  } catch {
    return undefined;
  }
}

/**
 * Build the turn_end handler that appends the per-turn status snapshot. The
 * snapshot is a custom entry (never sent to the LLM), so it keeps the
 * interface recoverable after a compaction without touching the prompt cache.
 */
export function createStatusSnapshotTurnEndHandler(
  pi: Pick<ExtensionAPI, "appendEntry">,
  getState: (sessionId: string) => OpsxFlowState | undefined,
): ExtensionHandler<TurnEndEvent, TurnEndEventResult> {
  return (_event: TurnEndEvent, ctx: ExtensionContext): void => {
    let sessionId: string;
    try {
      sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
    } catch {
      return;
    }
    const live = getState(sessionId);
    if (live) {
      appendStatusSnapshot(pi, live);
    }
    // A process restart leaves the in-memory flow registry empty; the last
    // persisted snapshot is then the only record of where the flow stood, so
    // restore it instead of showing nothing (spec: 流程快照 SHALL 随会话持久化，
    // 并在会话压缩后仍能恢复显示当前状态).
    const restored = live ? undefined : currentFlowState(ctx);
    const state = live ?? (restored?.ended ? undefined : restored);
    if (!state) {
      // A finished (or never-started) flow must not leave a stale mode/phase
      // on the footer; clearing is idempotent when nothing was set.
      try {
        if (ctx.hasUI) ctx.ui.setStatus("opsx", undefined);
      } catch {
        // Status is best-effort.
      }
      return;
    }
    // The session status line keeps the current mode/phase visible (task 9.2).
    try {
      if (ctx.hasUI) ctx.ui.setStatus("opsx", renderStatusLine(state));
    } catch {
      // Status is best-effort.
    }
  };
}
