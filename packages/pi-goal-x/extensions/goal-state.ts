import { type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { FOCUS_ENTRY, STATE_ENTRY, GOAL_CONTEXT_EVENT_ENTRY, GOAL_EVENT_ENTRY, GOAL_STATE_EVENT_ENTRY, GOAL_STEERING_EVENT_ENTRY, goalDetails } from "./goal-format.ts";
import { goalContextMessagePrompt, goalStateSnapshotPrompt, budgetReachedReminderNote, unfocusedOpenGoalsPrompt } from "./prompts/goal-prompts.ts";
import { loadGoalSettings, loadGoalSettingsFileConfig } from "./goal-settings.ts";
import { ALL_REGISTERED_GOAL_TOOLS } from "./goal-tool-names.ts";
import { budgetReached } from "./goal-accounting.ts";
import {
	asRecord,
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalFocusEntry,
	normalizeGoalRecord,
	nowIso,
	type GoalContextMessageDetails,
	type GoalCreationConfig,
	type GoalEventDetails,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalRecord,
	type GoalStateSnapshotDetails,
	type GoalStatus,
	type StopReason,
} from "./goal-record.ts";
import {
	mergeGoalPromptFromDisk,
	readActiveGoalPoolAsync,
	sanitizeGoalPaths,
} from "./storage/goal-files.ts";
import { GoalService } from "./goal-service.ts";
import { goalActivityEvents, latestAuditorResultForGoal, readGoalLedger } from "./goal-ledger.ts";
import { GoalAccounting } from "./goal-accounting.ts";
import { GoalRuntime } from "./goal-runtime.ts";
import { GoalAuditMessages } from "./goal-session-safety.ts";
import {
	focusedGoalFromPool,
	openGoalsFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
} from "./goal-pool.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { GOAL_WIDGET_KEY, GoalWidgetComponent, liveDisplayGoal, makeGoalWidgetFactory, type AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import type { AuditVerdict } from "./widgets/auditor-dashboard-model.ts";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";



/**
 * The shared mutable core of the goal extension. All state lives here; the
 * tools/commands/events/widget modules receive this core and operate on it.
 * `state.goal` mirrors the old `state` object: reading returns the focused
 * goal, assigning replaces it in the pool and updates the focus.
 */
export interface GoalCore {
	pi: ExtensionAPI;
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor };
	state: { goal: GoalRecord | null };
	readonly goalsById: Map<string, GoalRecord>;
	readonly focusedGoalId: string | null;
	readonly focusRevision: number;
	hasExplicitSessionFocus: boolean;
	runningGoalId: string | null;
	auditProgress: AuditorWidgetProgress | null;
	auditAnimationTimer: ReturnType<typeof setInterval> | null;
	auditAbortController: AbortController | null;
	/** §15.4: finished audit result card shown briefly before the dashboard returns. */
	auditResult: { verdict: AuditVerdict; report: string; at: string } | null;
	setAuditResult(verdict: AuditVerdict, report: string): void;
	clearAuditResult(): void;
	goalModalDepth: number;
	enterGoalModal(): void;
	exitGoalModal(): void;
	/**
	 * Number of open blocking `ctx.ui.*` dialog spans reported by pi core's
	 * `ui_prompt_start`/`ui_prompt_end` events (>= 0.84.4; the OUTERMOST span
	 * only, shared across every extension). While it is > 0 a dialog owns the
	 * keyboard, so goal-widget.ts must not intercept terminal input.
	 */
	uiPromptDepth: number;
	enterUiPrompt(): void;
	exitUiPrompt(): void;
	/** Clears a leaked span at a session boundary so Escape can never stay trapped. */
	resetUiPromptDepth(): void;
	auditAborted: boolean;
	goalWorkToolCalledThisTurn: boolean;
	tasksEnabled: boolean;
	debugMode: boolean;
	terminalInputUnsubscribe: (() => void) | null;
	goalWidgetComponentRef: { current: GoalWidgetComponent | null };
	/** Host TUI instance captured when the goal widget factory runs; null before the first render or in headless contexts. Used to observe TUI-wide overlay state so foreign overlays (pi-subagents fleet, pi selectors) own Escape while open. */
	goalTui: TUI | null;
	goalService: GoalService;
	runtime: GoalRuntime;
	auditMessages: GoalAuditMessages;
	accounting: GoalAccounting;

	assignFocusedGoalId(goalId: string | null): void;
	focusedOperationToken(goalId: string): { goalId: string; revision: number };
	isFocusedOperationCurrent(token: { goalId: string; revision: number }): boolean;
	focusedOperationCancelledResult(action: string, token: { goalId: string; revision: number }): AgentToolResult<unknown>;
	installGoalTools(): void;
	/**
	 * Send the full goal-context message (objective + contract + lifecycle
	 * policy + task tree) for the focused goal as an append-only custom
	 * message. Used at creation, after compaction, and on rehydration.
	 */
	sendGoalContextMessage(ctx: ExtensionContext, reason: GoalContextMessageDetails["reason"]): void;
	/**
	 * Build the per-turn state snapshot for a user-driven turn (mode "turn"),
	 * with one-shot steering notes folded in. Null when no snapshot applies
	 * (no focused goal, or a complete one).
	 */
	buildTurnSnapshot(ctx: ExtensionContext): { customType: typeof GOAL_STATE_EVENT_ENTRY; content: string; display: false; details: GoalStateSnapshotDetails } | null;
	/**
	 * True while a guided goal draft is active. Execution tools guard on this
	 * instead of relying on the (removed) drafting tool-profile switch.
	 */
	goalDraftActive: boolean;
	stopAuditAnimation(): void;
	abortAudit(ctx: ExtensionContext): void;
	clearContinuationTimer(): void;
	clearContinuationState(resetNetworkErrorBackoff?: boolean): void;
	clearActiveAccounting(): void;
	advanceTurnSeq(): void;
	currentTurnStoppedGoalId(): string | null;
	isActionableContinuationGoal(goalId: string | null | undefined): goalId is string;
	isStaleCheckpointBlockedToolCall(toolName: string): boolean;
	clearStoppedRuntimeState(): void;
	openGoals(): GoalRecord[];
	/** §10: toggle the unified dashboard between compact and expanded modes. */
	toggleDashboardExpanded(): void;
	/** §10: whether the unified dashboard is currently expanded. */
	isDashboardExpanded(): boolean;
	reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts?: { preserveMemoryUsage?: boolean }): boolean;
	appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void;
	setFocusedGoalId(goalId: string | null, ctx: ExtensionContext, reason: GoalFocusReason, opts?: { recordLedger?: boolean }): void;
	updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist?: boolean): void;
	armFocusedContinuation(ctx: ExtensionContext): void;
	removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void;
	beginAccounting(): void;
	goalForDisplay(): GoalRecord | null;
	accountProgress(ctx: ExtensionContext, opts?: { completedTurnTokens?: number }): void;
	syncGoalPromptFromDisk(ctx: ExtensionContext): boolean;
	persist(ctx?: ExtensionContext): void;
	refreshGoalDisplayFromDisk(ctx: ExtensionContext): void;
	updateUI(ctx: ExtensionContext): void;
	clearGoalWidget(ctx: ExtensionContext): void;
	loadState(ctx: ExtensionContext): Promise<void>;
	setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist?: boolean, focusReason?: GoalFocusReason): void;
	archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null;
	stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void;
	pauseActiveGoal(ctx: ExtensionContext): void;
	/** §auditor-toggle: flip the focused goal's persisted per-goal skipAuditor and record the ledger event. */
	toggleGoalAuditor(ctx: ExtensionContext): void;
	queueContinuation(ctx: ExtensionContext, force?: boolean): void;
	flushGoalTransaction(ctx: ExtensionContext): void;
	replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow?: boolean, verificationContract?: string, tokenBudget?: number): void;
	/** F5: bump the last-activity timestamp (called on real work events). */
	touchGoalActivity(): void;
	/** F5: detect a stalled active auto-continue goal; returns the [GOAL STALLED] steering note. */
	checkStall(ctx: ExtensionContext): string;
}

export function createGoalCore(
	pi: ExtensionAPI,
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor } = {},
): GoalCore {
	let goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	let focusRevision = 0;
	let hasExplicitSessionFocus = false;

	function assignFocusedGoalId(next: string | null): void {
		if (focusedGoalId !== next) focusRevision += 1;
		focusedGoalId = next;
	}

	function focusedOperationToken(goalId: string): { goalId: string; revision: number } {
		return { goalId, revision: focusRevision };
	}

	function isFocusedOperationCurrent(token: { goalId: string; revision: number }): boolean {
		return focusedGoalId === token.goalId && focusRevision === token.revision;
	}

	function focusedOperationCancelledResult(action: string, token: { goalId: string; revision: number }) {
		return {
			content: [{
				type: "text" as const,
				text: `${action} cancelled because goal ${token.goalId} is no longer focused in this session. The shared goal was not modified.`,
			}],
			details: goalDetails(state.goal),
			terminate: true,
		};
	}

	const state = {
		get goal(): GoalRecord | null {
			return focusedGoalFromPool(goalsById, focusedGoalId);
		},
		set goal(next: GoalRecord | null) {
			if (next) {
				goalsById.set(next.id, next);
				assignFocusedGoalId(next.id);
				return;
			}
			if (focusedGoalId) goalsById.delete(focusedGoalId);
			assignFocusedGoalId(null);
		},
	};

	/**
	 * Sole mutation boundary for goal records. All goal-file writes, ledger
	 * appends, and ordered write→ledger→memory commits route through this
	 * service; handlers keep validation and runtime/UI effects.
	 */
	const goalService = new GoalService({
		getFocused: () => state.goal,
		setFocused: (goal) => {
			state.goal = goal;
		},
		getPool: () => goalsById,
		replacePool: (pool) => {
			goalsById = pool;
		},
		getFocusedGoalId: () => focusedGoalId,
		assignFocusedGoalId: (goalId) => assignFocusedGoalId(goalId),
		focusToken: (goalId) => focusedOperationToken(goalId),
		isTokenCurrent: (token) => isFocusedOperationCurrent(token),
		appendFocusEntry: (goalId, reason) => appendFocusEntry(goalId, reason),
		onFocusedGoalLost: (lostGoalId, ctx) => {
			clearStoppedRuntimeState();
			// SAFETY: GoalServiceContext is the structural subset `{ cwd: string }`,
			// but every goal-service caller passes the live host ExtensionContext
			// (goal-events.ts, goal-tools.ts) — no synthetic context is ever built.
			updateUI(ctx as unknown as ExtensionContext);
		},
		onReconciled: (goal) => {
			if (goal.status !== "active" || !goal.autoContinue) clearContinuationState();
			if (goal.status !== "active") clearActiveAccounting();
		},
		onFocusChanged: () => {
			clearContinuationState();
			clearActiveAccounting();
		},
		onDiagnostic: (diagnostic) => {
			// Non-fatal failure sink: ledger appends must never roll back the
			// authoritative state write, but they stay observable.
			console.warn(`[pi-goal] ${diagnostic.source} diagnostic: ${diagnostic.message}`);
		},
	});
	let runningGoalId: string | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let auditProgress: AuditorWidgetProgress | null = null;
	let auditAnimationTimer: ReturnType<typeof setInterval> | null = null;
	let auditResult: { verdict: AuditVerdict; report: string; at: string } | null = null;
	let auditResultClearTimer: ReturnType<typeof setTimeout> | null = null;

	function setAuditResult(verdict: AuditVerdict, report: string): void {
		auditResult = { verdict, report, at: nowIso() };
		if (auditResultClearTimer) clearTimeout(auditResultClearTimer);
		// Short-lived foreground display (§2.5): the card is visible while the
		// user reads it, then the normal dashboard returns automatically.
		auditResultClearTimer = setTimeout(() => {
			auditResult = null;
			auditResultClearTimer = null;
			goalWidgetComponentRef.current?.invalidate();
		}, 6000);
		auditResultClearTimer.unref?.();
		goalWidgetComponentRef.current?.invalidate();
	}

	function clearAuditResult(): void {
		if (auditResultClearTimer) clearTimeout(auditResultClearTimer);
		auditResultClearTimer = null;
		auditResult = null;
	}
	let auditAbortController: AbortController | null = null;
	let auditAborted = false;

	let goalModalDepth = 0;
	let uiPromptDepth = 0;
	let debugMode = false;
	// §10: unified dashboard expansion state (compact vs expanded task view),
	// owned by the core so it survives host-side widget re-instantiation.
	let dashboardExpanded = false;
	// Edge-triggered flag for the one-shot unfocused-with-open-goals steering
	// message; reset whenever a goal becomes focused.
	let unfocusedNotified = false;

	// Per-turn flags reset in turn_start (#4, C9 fix).
	// goalWorkToolCalledThisTurn: tracks whether a real goal-work tool was called.
	//   If false at turn_end, we don't queue another autoContinue (empty chat turn).
	// turn-stop guard, stale checkpoint, continuation scheduling, and one-time
	// steering reminders live in `runtime` (extensions/goal-runtime.ts);
	// token/time accounting lives in `accounting` (extensions/goal-accounting.ts).
	let goalWorkToolCalledThisTurn = false;

	const runtime = new GoalRuntime({
		sendFollowUp: (content, details) => {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content,
					display: false,
					// SAFETY: GoalRuntime hands back the details object it received from
					// the goal tracker, which is always built as GoalEventDetails
					// (goal-runtime.ts call sites); the widening only crosses a
					// Record<string, unknown> boundary.
					details: details as unknown as GoalEventDetails,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		sendStateSnapshot: (ctx, goal, checkpointSeq) => {
			const current = state.goal;
			if (!current || current.id !== goal.id || current.status !== "active") return;
			pi.sendMessage<GoalStateSnapshotDetails>(
				{
					customType: GOAL_STATE_EVENT_ENTRY,
					content: goalStateSnapshotPrompt(current, loadGoalSettings(ctx.cwd), {
						mode: "continuation",
						foldedNotes: snapshotFoldedNotes(ctx, current, false),
					}),
					display: false,
					details: {
						version: 3,
						kind: "state",
						goalId: current.id,
						revision: current.revision ?? 0,
						checkpointSeq,
						timestamp: Date.now(),
					},
				},
				{ deliverAs: "followUp" },
			);
		},
		getGoal: () => state.goal,
		isActionable: (goalId) => isActionableContinuationGoal(goalId),
	});
	const accounting = new GoalAccounting();

	// Whether the task tools are advertised, decided once at session start from
	// settings (disableTasks). Stage 4 replaces them with the two task tools.
	let tasksEnabled = true;

	// Whether a guided goal draft is active. Maintained by goal-drafting (which
	// owns the draft lifecycle) and read by the execution-tool guards — with
	// the tool surface constant, drafting isolation is guard-based.
	let goalDraftActive = false;

	// Transient runtime state: set when the user aborts a running audit via
	// Escape. No ledger event is appended from the low-level abort callback;
	// the completion flow appends exactly one canonical event after the
	// user's dialog choice (follow-up Stage 2).

	/**
	 * Activate every registered goal tool, once, on top of the host's ordinary
	 * work-tool selection. The tool surface is deliberately CONSTANT for the
	 * whole session: every `setActiveTools` call rebuilds the base system
	 * prompt AND changes the tools block, which sits at the very front of the
	 * provider cache prefix — a switch invalidates the entire cached history.
	 * Drafting isolation is enforced by guards inside tool execute() instead
	 * (core.goalDraftActive), and disableTasks by the settings guards already
	 * present in the task tools.
	 */
	function installGoalTools(): void {
		try {
			const current = new Set(pi.getActiveTools());
			for (const knownGoalTool of ALL_REGISTERED_GOAL_TOOLS) current.add(knownGoalTool);
			const next = [...current].sort();
			const before = [...pi.getActiveTools()].sort();
			// Idempotent: never rebuild (or re-report) a surface that is already
			// in place.
			if (next.length !== before.length || next.some((name, index) => name !== before[index])) {
				pi.setActiveTools([...current]);
			}
		} catch (err) {
			console.error("[pi-goal] installGoalTools error:", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Send the full goal-context message (objective + verification contract +
	 * lifecycle policy + task tree) for the focused goal. Persisted append-only
	 * and never rewritten: this is where the lifecycle policy lives now that
	 * the system prompt carries no goal content. `triggerTurn: false` appends
	 * immediately when idle and defers to the next turn boundary mid-run,
	 * without forcing a continuation turn.
	 */
	function sendGoalContextMessage(ctx: ExtensionContext, reason: GoalContextMessageDetails["reason"]): void {
		const goal = state.goal;
		if (!goal || goal.status === "complete") return;
		try {
			pi.sendMessage<GoalContextMessageDetails>(
				{
					customType: GOAL_CONTEXT_EVENT_ENTRY,
					content: goalContextMessagePrompt(goal, loadGoalSettings(ctx.cwd)),
					display: false,
					details: {
						version: 1,
						kind: "context",
						goalId: goal.id,
						revision: goal.revision ?? 0,
						reason,
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: false },
			);
		} catch (err) {
			console.error("[pi-goal] sendGoalContextMessage error:", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Steering notes folded into a state snapshot (consumed once by the
	 * caller): the [GOAL STALLED] note (user-turn path only — the detector runs
	 * at before_agent_start), the one-time budget wrap-up reminder armed at the
	 * budget_limited transition, and an unresolved auditor disapproval
	 * (persistent while unresolved, as the old system-prompt block was).
	 */
	function snapshotFoldedNotes(ctx: ExtensionContext, goal: GoalRecord, includeStall: boolean): string[] {
		const foldedNotes: string[] = [];
		if (includeStall) {
			const stalledNote = checkStall(ctx);
			if (stalledNote) foldedNotes.push(stalledNote);
		}
		if (runtime.consumePostBudgetReminder()) foldedNotes.push(budgetReachedReminderNote(goal));
		const rejection = auditorRejectionNote(ctx, goal);
		if (rejection) foldedNotes.push(rejection);
		return foldedNotes;
	}

	/**
	 * Build the per-turn state snapshot for a user-driven turn. The system
	 * prompt carries no goal content, so the snapshot rides as an append-only
	 * custom message right after the user's prompt (the before_agent_start
	 * message return). Null when no snapshot applies.
	 */
	function buildTurnSnapshot(ctx: ExtensionContext): { customType: typeof GOAL_STATE_EVENT_ENTRY; content: string; display: false; details: GoalStateSnapshotDetails } | null {
		const goal = state.goal;
		if (!goal || goal.status === "complete") return null;
		return {
			customType: GOAL_STATE_EVENT_ENTRY,
			content: goalStateSnapshotPrompt(goal, loadGoalSettings(ctx.cwd), {
				mode: "turn",
				foldedNotes: snapshotFoldedNotes(ctx, goal, true),
			}),
			display: false,
			details: {
				version: 3,
				kind: "state",
				goalId: goal.id,
				revision: goal.revision ?? 0,
				timestamp: Date.now(),
			},
		};
	}

	/**
	 * Send the full goal-context message only when the current branch has no
	 * copy after its last compaction entry. Covers sessions that restart after
	 * a compaction, branches focused onto a goal created elsewhere, and legacy
	 * sessions upgrading to the message channel.
	 */
	function ensureGoalContextMessage(ctx: ExtensionContext): void {
		const goal = state.goal;
		if (!goal || goal.status === "complete") return;
		try {
			const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string }>;
			let lastCompaction = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i]?.type === "compaction") {
					lastCompaction = i;
					break;
				}
			}
			for (let i = lastCompaction + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry?.type === "custom_message" && entry.customType === GOAL_CONTEXT_EVENT_ENTRY) return;
			}
		} catch {
			// Scan failure degrades to a safe duplicate send.
		}
		sendGoalContextMessage(ctx, "rehydrated");
	}

	/**
	 * Steering note for an unresolved auditor disapproval (bounded). Empty
	 * unless the latest audit verdict is a disapproval following a completion
	 * request — mirrors the condition the old system-prompt block used.
	 */
	function auditorRejectionNote(ctx: ExtensionContext, goal: GoalRecord): string {
		try {
			const ledger = readGoalLedger(ctx);
			const result = latestAuditorResultForGoal(ledger.events, goal.id);
			if (result && result.verdict === "disapproved" && ledger.events.some((e) => e.type === "completion_requested" && e.goalId === goal.id)) {
				return `[AUDITOR REJECTION goalId=${goal.id}]\nAn independent auditor previously rejected a completion request for this goal. Reason: ${result.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
			}
		} catch {
			// Ledger read failure should not break the snapshot.
		}
		return "";
	}

	function stopAuditAnimation(): void {
		if (auditAnimationTimer) {
			clearInterval(auditAnimationTimer);
			auditAnimationTimer = null;
		}
	}

	// ctx is part of the GoalCore API surface (callers pass it) but the abort
	// path itself only touches the audit controller/UI state.
	function abortAudit(_ctx: ExtensionContext): void {
		if (!auditAbortController || !auditProgress) return;
		auditAbortController.abort();
		auditAbortController = null;
		stopAuditAnimation();
		auditProgress = null;
		goalWidgetComponentRef.current?.invalidate();
		// Record the abort as transient runtime state only; the completion flow
		// decides the single canonical ledger outcome after the dialog choice.
		auditAborted = true;
	}

	function clearContinuationTimer(): void {
		runtime.clearContinuationTimer();
	}

	function clearContinuationState(resetNetworkErrorBackoff = true): void {
		runtime.clearContinuationState(resetNetworkErrorBackoff);
	}

	function clearActiveAccounting(): void {
		accounting.clear();
	}

	function advanceTurnSeq(): void {
		runtime.advanceTurn();
	}

	function currentTurnStoppedGoalId(): string | null {
		return runtime.currentTurnStoppedGoalId();
	}

	function isActionableContinuationGoal(goalId: string | null | undefined): goalId is string {
		return !!goalId && state.goal?.id === goalId && state.goal.status === "active" && state.goal.autoContinue;
	}

	function isStaleCheckpointBlockedToolCall(toolName: string): boolean {
		return runtime.isStaleCheckpointBlocked(toolName);
	}

	function clearStoppedRuntimeState(): void {
		clearContinuationState();
		clearActiveAccounting();
	}

	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(goalsById);
	}

	function reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		return goalService.reconcileFocused(ctx, opts);
	}

	function appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void {
		hasExplicitSessionFocus = true;
		pi.appendEntry(FOCUS_ENTRY, goalFocusDetails(goalId, reason));
	}

	function setFocusedGoalId(
		goalId: string | null,
		ctx: ExtensionContext,
		reason: GoalFocusReason,
		opts: { recordLedger?: boolean } = {},
	): void {
		const previousGoalId = focusedGoalId;
		if (previousGoalId !== goalId) goalService.flushTurn(ctx); // P1-3: persist the old buffer before switching focus
		assignFocusedGoalId(goalId && goalsById.has(goalId) ? goalId : null);
		if (previousGoalId !== focusedGoalId) {
			clearContinuationState();
			clearActiveAccounting();
		}
		appendFocusEntry(focusedGoalId, reason);
		// Append ledger event for focus changes
		try {
			if (opts.recordLedger !== false && focusedGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_focused", goalId: focusedGoalId, reason, at: nowIso() }]);
			} else if (opts.recordLedger !== false && previousGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_unfocused", reason, at: nowIso() }]);
			}
		} catch {
			// Ledger append failure should not crash focus change
		}
		notifyUnfocusedIfNeeded(ctx);
		updateUI(ctx);
	}

	/**
	 * Unfocused-with-open-goals is a one-shot steering message now (the old
	 * per-turn system-prompt block is gone). Edge-triggered: once per
	 * unfocused spell, reset the moment a goal is focused again.
	 */
	function notifyUnfocusedIfNeeded(_ctx: ExtensionContext): void {
		if (focusedGoalId) {
			unfocusedNotified = false;
			return;
		}
		if (unfocusedNotified || openGoals().length === 0) return;
		unfocusedNotified = true;
		try {
			pi.sendMessage(
				{
					customType: GOAL_STEERING_EVENT_ENTRY,
					content: unfocusedOpenGoalsPrompt(openGoals().length),
					display: false,
					details: { reason: "unfocused", timestamp: Date.now() },
				},
				{ triggerTurn: false },
			);
		} catch {
			// Steering must never crash session load or focus changes.
		}
	}

	function updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		goalsById.set(next.id, next);
		assignFocusedGoalId(next.id);
		if (shouldPersist) persist(ctx);
		updateUI(ctx);
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		if (state.goal?.status === "active" && state.goal.autoContinue) queueContinuation(ctx, true);
	}

	function removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void {
		goalService.flushTurn(ctx); // P1-3: persist pending mutations before the goal leaves the session
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		assignFocusedGoalId(null);
		clearStoppedRuntimeState();
		appendFocusEntry(null, reason);
		updateUI(ctx);
	}

	function beginAccounting(): void {
		if (!state.goal || (state.goal.status !== "active")) {
			clearActiveAccounting();
			return;
		}
		accounting.begin(state.goal.id);
	}

	function goalForDisplay(): GoalRecord | null {
		// P1-12: extracted live-usage view.
		return liveDisplayGoal(state.goal, accounting);
	}

	function accountProgress(ctx: ExtensionContext, opts: { completedTurnTokens?: number } = {}): void {
		// Skip disk reconciliation for complete goals — they are pending archival at turn_end.
		if (state.goal?.activePath && state.goal?.status !== "complete" && !reconcileFocusedGoalFromDisk(ctx, { preserveMemoryUsage: true })) return;
		if (!state.goal || state.goal.status !== "active" || !accounting.isActiveFor(state.goal.id)) {
			beginAccounting();
			return;
		}

		// Serialized idempotent charge: never double-charges the same interval.
		const { tokens, seconds } = accounting.charge({ completedTurnTokens: opts.completedTurnTokens });
		if (tokens === 0 && seconds === 0) return;

		const next = cloneGoal(state.goal);
		next.usage.tokensUsed += tokens;
		next.usage.activeSeconds += seconds;
		next.updatedAt = nowIso();
		state.goal = next;
		persist(ctx);

		// F6: threshold alerts at 50/75/90% — one ledger event + notification each.
		const budgetGoal = state.goal;
		if (budgetGoal && budgetGoal.status === "active" && typeof budgetGoal.tokenBudget === "number" && budgetGoal.tokenBudget > 0 && budgetGoal.usage.tokensUsed > 0) {
			const pct = budgetGoal.usage.tokensUsed / budgetGoal.tokenBudget;
			for (const threshold of [0.5, 0.75, 0.9]) {
				const key = `${budgetGoal.id}:${threshold}`;
				if (!budgetWarningsFired.has(key) && pct >= threshold) {
					budgetWarningsFired.add(key);
					try {
						goalService.appendEvents(ctx, [{
							type: "goal_budget_warning",
							goalId: budgetGoal.id,
							budget: budgetGoal.tokenBudget,
							tokensUsed: budgetGoal.usage.tokensUsed,
							pct: Math.round(pct * 100),
							at: nowIso(),
						}]);
					} catch {
						// Alert must never crash the turn.
					}
					ctx.ui.notify(`Token budget ${Math.round(pct * 100)}% used (${budgetGoal.usage.tokensUsed}/${budgetGoal.tokenBudget} tokens) — consider raising or trimming scope before the limit.`, "warning");
				}
			}
		}

		// Token-budget transition: when accounted usage reaches the budget, mark the
		// goal budget_limited exactly once (status no longer active, so accounting
		// stops and the transition cannot re-fire), emit the ledger event, arm the
		// one-time wrap-up steering, and cancel pending continuations.
		if (budgetGoal && budgetGoal.status === "active" && typeof budgetGoal.tokenBudget === "number" && budgetReached(budgetGoal)) {
			const transition = goalService.apply(ctx, {
				reconcile: false,
				mutate: (g) => ({ ...g, status: "budget_limited" as const, updatedAt: nowIso() }),
				ledger: (written) => [{
					type: "goal_budget_limited",
					goalId: written.id,
					budget: budgetGoal.tokenBudget ?? 0,
					tokensUsed: written.usage.tokensUsed,
					at: written.updatedAt,
				}],
			});
			if (transition.ok) {
				runtime.armPostBudgetReminder();
				runtime.clearContinuationState();
				accounting.clear();
				updateUI(ctx);
			}
		}
	}

	function syncGoalPromptFromDisk(ctx: ExtensionContext): boolean {
		if (!state.goal || state.goal.status === "complete") return false;
		const previousObjective = state.goal.objective;
		state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
		return state.goal.objective !== previousObjective;
	}

	function persist(ctx?: ExtensionContext): void {
		if (ctx) {
			goalService.persist(ctx);
		} else {
			const current = state.goal;
			if (current) state.goal = { ...current, updatedAt: nowIso() };
		}
		if (ctx) updateUI(ctx);
	}

	function refreshGoalDisplayFromDisk(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status === "complete") return;
		if (syncGoalPromptFromDisk(ctx)) {
			state.goal = { ...state.goal, updatedAt: nowIso() };
		}
		updateUI(ctx);
	}

	const goalWidgetComponentRef: { current: GoalWidgetComponent | null } = { current: null };
	const goalTuiRef: { current: TUI | null } = { current: null };
	let widgetRegistered = false;

	function clearGoalWidget(ctx: ExtensionContext): void {
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
		widgetRegistered = false;
		goalWidgetComponentRef.current = null;
		goalTuiRef.current = null;
	}

	/**
	 * Live above-editor widget for the active goal. Inspired by rpiv-todo's
	 * TodoOverlay: register the widget once with a factory, read live state
	 * via the closure at render time, and call `tui.requestRender()` on every
	 * state change so the overlay refreshes without re-registration. Normal pi
	 * renders still read current values through the closure; do not request
	 * periodic renders just to tick elapsed time because terminal redraws pull
	 * users out of scrollback while they review long goals and earlier context.
	 *
	 * Layout (sisyphus, running):
	 *   ◆ Sisyphus  [▰▰▰▱▱] 3/5
	 *   ├─ ⟡ extract validator … wire it … update tests.
	 *   ├─ Status: sisyphus running · auto-continue · 14m 21s · 24.3k tokens
	 *   └─ .pi/goals/active_goal_xxx.md
	 *
	 * Layout (paused with blocker):
	 *   ⊘ Goal paused
	 *   ├─ ⟡ improve benchmark coverage for the parser
	 *   ├─ Status: paused (agent) · 2m 14s · 12.4k tokens
	 *   ├─ Blocker: cannot find the tests directory
	 *   └─ Suggested: ask the user for the test location
	 */

	let lastGoalActivityAt = Date.now();
	let stallNotified = false;
	const budgetWarningsFired = new Set<string>(); // "goalId:threshold"

	function touchGoalActivity(): void {
		lastGoalActivityAt = Date.now();
		stallNotified = false;
	}

	function checkStall(ctx: ExtensionContext): string {
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return "";
		const timeoutMinutes = loadGoalSettings(ctx.cwd).stallTimeoutMinutes ?? 0;
		if (timeoutMinutes <= 0 || stallNotified) return "";
		const idleMs = Date.now() - lastGoalActivityAt;
		if (idleMs < timeoutMinutes * 60_000) return "";
		stallNotified = true;
		const goalId = state.goal.id;
		try {
			goalService.appendEvents(ctx, [{
				type: "goal_stalled",
				goalId,
				reason: `No continuation or tool activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.`,
				at: nowIso(),
			}]);
		} catch {
			// Stall detection must never crash the turn.
		}
		ctx.ui.notify(`Goal stalled: no activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.`, "warning");
		return `\n\n[GOAL STALLED goalId=${goalId}]\nNo continuation or tool activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}. Report your progress or ask the user to pause or resume the goal.`;
	}

	let uiFlushScheduled = false;
	let lastUiCtx: ExtensionContext | null = null;

	/**
	 * P1-9: coalesced widget updates. Multiple updateUI calls within one
	 * synchronous block (a tool handler typically calls it 2–4 times) collapse
	 * into a single microtask render; the final turn_end render still shows the
	 * latest state. The render itself reads live state at flush time.
	 */
	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		lastUiCtx = ctx;
		if (uiFlushScheduled) return;
		uiFlushScheduled = true;
		queueMicrotask(() => {
			uiFlushScheduled = false;
			if (lastUiCtx) renderUI(lastUiCtx);
		});
	}

	function renderUI(ctx: ExtensionContext): void {
		const totalOpen = otherOpenGoalCount(goalsById, null);
		if (!state.goal && totalOpen === 0) {
			clearGoalWidget(ctx);
			return;
		}
		if (!state.goal) {
			// PR #29: layered hideUnfocusedBanner suppresses BOTH the unfocused
			// widget and the status hint. Focused dashboards and audit UI are
			// unaffected; the model-facing [PI GOAL UNFOCUSED] prompt is unchanged.
			if (loadGoalSettings(ctx.cwd).hideUnfocusedBanner === true) {
				clearGoalWidget(ctx);
				return;
			}
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - /goal-focus`);
			if (!widgetRegistered) {
				ctx.ui.setWidget(
					GOAL_WIDGET_KEY,
					makeGoalWidgetFactory({
						getGoal: () => goalForDisplay() ?? state.goal,
						getOpenGoalCount: () => otherOpenGoalCount(goalsById, null),
						getAuditorProgress: () => auditProgress,
						getSettings: () => loadGoalSettings(ctx.cwd),
						getDebugMode: () => debugMode,
						getStalled: () => stallNotified,
						getExpanded: () => dashboardExpanded,
						getLedgerEvents: () => state.goal ? goalActivityEvents(ctx, state.goal.id) : [],
						getAuditResult: () => auditResult,
						onTui: (tui) => {
							goalTuiRef.current = tui;
						},
					}),
					{ placement: "aboveEditor" },
				);
				widgetRegistered = true;
			} else {
				goalWidgetComponentRef.current?.update();
			}
			return;
		}

		// The goal widget is the single home for goal status: the status line
		// lives in the compact/expanded dashboard (goal: <label> [<usage>]
		// (+N open)), so the focused-goal footer segment is cleared — a stale
		// unfocused hint or earlier status must not linger once a goal is
		// focused. The unfocused branch above still sets its own hint.
		ctx.ui.setStatus("goal", undefined);

		if (!widgetRegistered) {
			ctx.ui.setWidget(
				GOAL_WIDGET_KEY,
				makeGoalWidgetFactory({
					getGoal: () => goalForDisplay() ?? state.goal,
					getOpenGoalCount: () => otherOpenGoalCount(goalsById, null),
					getAuditorProgress: () => auditProgress,
					getSettings: () => loadGoalSettings(ctx.cwd),
					getDebugMode: () => debugMode,
					getStalled: () => stallNotified,
					getExpanded: () => dashboardExpanded,
					getLedgerEvents: () => state.goal ? goalActivityEvents(ctx, state.goal.id) : [],
					getAuditResult: () => auditResult,
					onTui: (tui) => {
						goalTuiRef.current = tui;
					},
				}),
				{ placement: "aboveEditor" },
			);
			widgetRegistered = true;
		} else {
			goalWidgetComponentRef.current?.update();
		}
	}

	function restoreInferredFocusEntry(
		ctx: ExtensionContext,
		goalId: string,
		reason: GoalFocusReason,
	): void {
		try {
			appendFocusEntry(goalId, reason);
		} catch (error) {
			ctx.ui.notify(
				`Could not record inferred goal focus: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	async function loadState(ctx: ExtensionContext): Promise<void> {
		goalsById = await readActiveGoalPoolAsync(ctx);
		tasksEnabled = !loadGoalSettings(ctx.cwd).disableTasks;
		focusRevision += 1; // Session reload/tree navigation invalidates pending async focus operations.
		assignFocusedGoalId(null);
		hasExplicitSessionFocus = false;
		let focusEntry: GoalFocusEntry | null = null;
		let legacyGoal: GoalRecord | null = null;
		let legacyStateSeen = false;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (entry.type !== "custom") continue;
			if (!focusEntry && entry.customType === FOCUS_ENTRY) {
				focusEntry = normalizeGoalFocusEntry(entry.data);
			}
			if (!legacyStateSeen && entry.customType === STATE_ENTRY) {
				legacyGoal = normalizeGoalRecord(asRecord(entry.data)?.goal);
				legacyStateSeen = true;
			}
			if (focusEntry && legacyStateSeen) break;
		}
		if (legacyGoal && legacyGoal.status !== "complete") {
			legacyGoal = sanitizeGoalPaths(ctx, mergeGoalPromptFromDisk(ctx, legacyGoal));
		}
		const settings = loadGoalSettings(ctx.cwd);
		hasExplicitSessionFocus = focusEntry !== null;
		assignFocusedGoalId(resolveSessionFocus({ pool: goalsById, focusEntry, legacyGoal, autoSelectSingleGoal: settings.autoSelectSingleGoal }));
		if (!focusEntry && focusedGoalId) {
			restoreInferredFocusEntry(
				ctx,
				focusedGoalId,
				legacyGoal?.id === focusedGoalId ? "migrated" : "selected",
			);
		}
		for (const [id, current] of goalsById) {
			if (current.status === "complete") {
				goalsById.delete(id);
			}
		}
		clearStoppedRuntimeState();
		runningGoalId = null;
		updateUI(ctx);
		// Re-supply the full goal context when this branch has no copy after its
		// last compaction (restart after compaction, cross-branch focus, legacy
		// sessions upgrading to the message channel). Also fires the one-shot
		// unfocused notice on the transition edge.
		notifyUnfocusedIfNeeded(ctx);
		ensureGoalContextMessage(ctx);
	}

	function setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true, focusReason?: GoalFocusReason): void {
		const previousGoalId = state.goal?.id ?? null;
		state.goal = next;
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			clearContinuationState();
			clearActiveAccounting();
		}
		if (focusReason && focusChanged) appendFocusEntry(focusedGoalId, focusReason);
		if (!state.goal || (state.goal.status !== "active") || !state.goal.autoContinue) {
			clearContinuationState();
		}
		if (!state.goal || state.goal.status === "paused" || state.goal.status === "complete") {
			clearActiveAccounting();
		}
		if (shouldPersist) persist(ctx);
		updateUI(ctx);
	}

	function archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null {
		if (!state.goal) return null;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			archive: true,
			commitFocused: false,
			mutate: (g) => {
				const status = g.status === "complete" ? "complete" : "paused";
				return { ...g, status, stopReason: reason };
			},
		});
		return result.ok ? result.goal : null;
	}

	function stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		if (!state.goal) return;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, status, stopReason: reason, updatedAt: nowIso() }),
			ledger: (written) => status === "paused"
				? [{
					type: "goal_paused",
					goalId: written.id,
					reason: reason ?? "unknown",
					suggestedAction: written.pauseSuggestedAction,
					status,
					at: written.updatedAt,
				}]
				: [],
		});
		if (result.ok) {
			// setGoal() glue: a stopped goal can no longer queue continuations or
			// accrue time, and the UI must reflect the new status immediately.
			clearContinuationState();
			clearActiveAccounting();
			goalService.flushTurn(ctx); // P1-3: user-visible status change persists now, not at turn end
			updateUI(ctx);
		}
	}

	function pauseActiveGoal(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status !== "active") return;
		// User-initiated pause (Esc / aborted turn). Clear any stale agent pause reason.
		state.goal = { ...state.goal, autoContinue: false, pauseReason: undefined, pauseSuggestedAction: undefined };
		stopActiveGoal("paused", "user", ctx);
		ctx.ui.notify("Goal paused.", "info");
	}

	/**
	 * §auditor-toggle: flip the focused goal's independent-auditor setting.
	 * Persisted per-goal (revision-safe via goalService.apply), recorded as an
	 * auditor_toggled ledger event, reflected in the dashboard, and announced.
	 * Inert when no goal is focused or the goal is complete; the widget's
	 * modal-depth guard keeps it inert while a goal modal is open.
	 */
	function toggleGoalAuditor(ctx: ExtensionContext): void {
		if (!state.goal) {
			ctx.ui.notify("No focused goal to toggle the auditor for.", "info");
			return;
		}
		if (state.goal.status === "complete") {
			ctx.ui.notify("This goal is complete; the auditor no longer applies.", "info");
			return;
		}
		const nextEnabled = state.goal.skipAuditor === true;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, skipAuditor: g.skipAuditor === true ? undefined : true, updatedAt: nowIso() }),
			ledger: (written) => [{ type: "auditor_toggled" as const, goalId: written.id, enabled: nextEnabled, at: written.updatedAt }],
		});
		if (!result.ok) {
			ctx.ui.notify("Could not toggle the auditor: " + result.message, "error");
			return;
		}
		goalService.flushTurn(ctx); // P1-3: user-visible setting change persists now, not at turn end
		updateUI(ctx);
		ctx.ui.notify(nextEnabled ? "Auditor enabled for this goal." : "Auditor disabled for this goal.", "info");
	}

	function flushGoalTransaction(ctx: ExtensionContext): void {
		goalService.flushTurn(ctx);
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		if (!state.goal) return;
		runtime.queueContinuation(ctx, state.goal, force);
	}

	function enterGoalModal(): void {
		goalModalDepth++;
	}

	function exitGoalModal(): void {
		goalModalDepth = Math.max(0, goalModalDepth - 1);
	}

	// pi core emits ui_prompt_start/ui_prompt_end for the OUTERMOST blocking
	// ctx.ui.* dialog only, so a plain depth counter cannot over-count from a
	// nested dialog. Clamp at 0 defensively: an unmatched end (host bug, or an
	// end delivered after a session reset) must never drive the depth negative
	// and re-enable Escape while a real dialog is still open.
	function enterUiPrompt(): void {
		uiPromptDepth++;
	}

	function exitUiPrompt(): void {
		uiPromptDepth = Math.max(0, uiPromptDepth - 1);
	}

	function resetUiPromptDepth(): void {
		uiPromptDepth = 0;
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true, verificationContract?: string, tokenBudget?: number): void {
		const goal = createGoal(config);
		if (verificationContract) goal.verificationContract = verificationContract;
		if (config.taskList) goal.taskList = config.taskList;
		if (typeof tokenBudget === "number" && tokenBudget > 0) goal.tokenBudget = Math.floor(tokenBudget);
		const result = goalService.create(ctx, {
			goal,
		ledger: [
			{
				type: "goal_created",
				goalId: goal.id,
				objective: goal.objective,
				sisyphus: goal.sisyphus,
				autoContinue: goal.autoContinue,
				at: goal.createdAt,
			},
			...(goal.taskList ? [{
				type: "task_list_set" as const,
				goalId: goal.id,
				taskCount: goal.taskList.tasks.length,
				blockCompletion: goal.taskList.blockCompletion,
				at: goal.createdAt,
			}] : []),
		],
		});
		if (result.focusChanged) appendFocusEntry(result.goalId, "created");
		beginAccounting();
		ctx.ui.notify(buildGoalRunningNotification(config), "info");
		// The lifecycle policy rides this persisted append-only message now that
		// the system prompt carries no goal content. It must exist in the branch
		// before the first snapshot/turn.
		sendGoalContextMessage(ctx, "created");
		if (startNow && state.goal?.autoContinue) queueContinuation(ctx, true);
	}

	return {
		pi,
		dependencies,
		state,
		get goalsById() {
			return goalsById;
		},
		get focusedGoalId() {
			return focusedGoalId;
		},
		get focusRevision() {
			return focusRevision;
		},
		get hasExplicitSessionFocus() {
			return hasExplicitSessionFocus;
		},
		set hasExplicitSessionFocus(value: boolean) {
			hasExplicitSessionFocus = value;
		},
		get runningGoalId() {
			return runningGoalId;
		},
		set runningGoalId(value: string | null) {
			runningGoalId = value;
		},
		get auditProgress() {
			return auditProgress;
		},
		set auditProgress(value: AuditorWidgetProgress | null) {
			auditProgress = value;
		},
		get auditResult() {
			return auditResult;
		},
		set auditResult(value: { verdict: AuditVerdict; report: string; at: string } | null) {
			auditResult = value;
		},
		setAuditResult,
		clearAuditResult,
		get auditAnimationTimer() {
			return auditAnimationTimer;
		},
		set auditAnimationTimer(value: ReturnType<typeof setInterval> | null) {
			auditAnimationTimer = value;
		},
		get auditAbortController() {
			return auditAbortController;
		},
		set auditAbortController(value: AbortController | null) {
			auditAbortController = value;
		},
		get goalModalDepth() {
			return goalModalDepth;
		},
		set goalModalDepth(value: number) {
			goalModalDepth = value;
		},
		get uiPromptDepth() {
			return uiPromptDepth;
		},
		set uiPromptDepth(value: number) {
			uiPromptDepth = value;
		},
		get auditAborted() {
			return auditAborted;
		},
		set auditAborted(value: boolean) {
			auditAborted = value;
		},
		get goalWorkToolCalledThisTurn() {
			return goalWorkToolCalledThisTurn;
		},
		set goalWorkToolCalledThisTurn(value: boolean) {
			goalWorkToolCalledThisTurn = value;
		},
		get tasksEnabled() {
			return tasksEnabled;
		},
		set tasksEnabled(value: boolean) {
			tasksEnabled = value;
		},
		get goalDraftActive() {
			return goalDraftActive;
		},
		set goalDraftActive(value: boolean) {
			goalDraftActive = value;
		},
		get debugMode() {
			return debugMode;
		},
		set debugMode(value: boolean) {
			debugMode = value;
		},
		get terminalInputUnsubscribe() {
			return terminalInputUnsubscribe;
		},
		set terminalInputUnsubscribe(value: (() => void) | null) {
			terminalInputUnsubscribe = value;
		},
		toggleDashboardExpanded() {
			dashboardExpanded = !dashboardExpanded;
			goalWidgetComponentRef.current?.invalidate();
		},
		isDashboardExpanded() {
			return dashboardExpanded;
		},
		goalWidgetComponentRef,
		get goalTui() {
			return goalTuiRef.current;
		},
		goalService,
		runtime,
		auditMessages: new GoalAuditMessages(),
		accounting,
		assignFocusedGoalId,
		focusedOperationToken,
		isFocusedOperationCurrent,
		focusedOperationCancelledResult,
		installGoalTools,
		sendGoalContextMessage,
		buildTurnSnapshot,
		stopAuditAnimation,
		abortAudit,
		clearContinuationTimer,
		clearContinuationState,
		clearActiveAccounting,
		advanceTurnSeq,
		currentTurnStoppedGoalId,
		isActionableContinuationGoal,
		isStaleCheckpointBlockedToolCall,
		clearStoppedRuntimeState,
		enterGoalModal,
		exitGoalModal,
		enterUiPrompt,
		exitUiPrompt,
		resetUiPromptDepth,
		openGoals,
		reconcileFocusedGoalFromDisk,
		appendFocusEntry,
		setFocusedGoalId,
		updateFocusedGoal,
		armFocusedContinuation,
		removeFocusedGoal,
		beginAccounting,
		goalForDisplay,
		accountProgress,
		syncGoalPromptFromDisk,
		persist,
		refreshGoalDisplayFromDisk,
		updateUI,
		clearGoalWidget,
		loadState,
		setGoal,
		archiveCurrentGoal,
		stopActiveGoal,
		pauseActiveGoal,
		toggleGoalAuditor,
		queueContinuation,
		flushGoalTransaction,
		touchGoalActivity,
		checkStall,
		replaceGoal,
	};
}
