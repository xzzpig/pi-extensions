import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	GOAL_EVENT_ENTRY,
	assistantTurnTokens,
	extractGoalIdFromInjectedMessage,
	goalEventMessageId,
	hasAbortedAssistantMessage,
	hasErrorAssistantMessage,
	isAbortedAssistantMessage,
	isErrorAssistantMessage,
	isMeaningfulProgressToolCall,
	isToolUseAssistantMessage,
} from "./goal-format.ts";
import { buildCompactionSummary } from "./goal-compaction.ts";
import { latestAuditorResultForGoal, loadLedgerState, readGoalLedger, invalidateGoalLedgerCache } from "./goal-ledger.ts";
import { shouldArmPostCompactReminder, shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { formatTokenValue } from "./goal-core.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { budgetLine, budgetRemaining } from "./goal-accounting.ts";
import { asRecord, nowIso, type AssistantMessageLike } from "./goal-record.ts";
import { goalSelectorLabel } from "./goal-pool.ts";
import { invalidateGoalPoolCache } from "./storage/goal-files.ts";import {
	goalPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { rehydrateDraft } from "./goal-drafting.ts";
import { syncTerminalInputPause } from "./goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";
import type { GoalMutationOutcome } from "./goal-service.ts";

/**
 * The goal extension's lifecycle event handlers (context, turn_start,
 * tool_call, tool_execution_end, turn_end, message_end, session_start,
 * session_before_compact, session_compact, session_tree, before_agent_start,
 * agent_end, agent_settled, session_shutdown). All state flows through the
 * GoalCore.
 */
export function registerGoalEvents(core: GoalCore): void {
	const { pi } = core;
	let continuationAfterSettleFor: string | null = null;

	pi.on("context", async (event): Promise<{ messages: typeof event.messages } | undefined> => {
		let changed = false;
		const latestGoalEventIndex = new Map<string, number>();
		event.messages.forEach((message, index) => {
			const queuedGoalId = goalEventMessageId(message as { customType?: string; details?: unknown; content?: unknown });
			if (queuedGoalId) latestGoalEventIndex.set(queuedGoalId, index);
		});

		const messages = event.messages.map((message, index) => {
			const candidate = message as { customType?: string; details?: unknown; content?: unknown };
			const queuedGoalId = goalEventMessageId(candidate);
			if (!queuedGoalId) return message;
			if (
				core.state.goal?.id === queuedGoalId
				&& (core.state.goal.status === "active")
				&& core.state.goal.autoContinue
				&& latestGoalEventIndex.get(queuedGoalId) === index
			) return message;
			changed = true;
			const details = asRecord(candidate.details) ?? {};
			return {
				...message,
				content: staleContinuationPrompt(queuedGoalId, core.state.goal),
				display: false,
				details: {
					...details,
					kind: "stale",
					goalId: queuedGoalId,
					currentGoalId: core.state.goal?.id ?? null,
					currentStatus: core.state.goal?.status ?? null,
				},
			} as typeof message;
		});
		return changed ? { messages } : undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		// Per-turn flag resets (#4 + C9 fix).
		core.advanceTurnSeq();
		core.goalWorkToolCalledThisTurn = false;
		core.beginAccounting();
		core.goalService.beginTurn(ctx, core.focusedGoalId); // P1-3 transaction buffer
		core.touchGoalActivity(); // F5
		core.updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event, ctx) => {
		const stoppedGoalId = core.currentTurnStoppedGoalId();
		// Post-stop in-turn block: after update_goal / set_goal_tasks (or a user
		// lifecycle command) fires in this turn, block all subsequent tool calls
		// except read-only inspection.
		if (stoppedGoalId !== null && core.runtime.isStaleCheckpointBlocked(event.toolName)) {
			return {
				block: true,
				reason: `The goal was already stopped earlier in this turn (goalId=${stoppedGoalId}). ` +
					`Do not call more tools; end the turn with a brief summary and yield to the user.`,
			};
		}
		// Stale checkpoint guard: if the turn was triggered by a queued continuation
		// for a goal that is no longer active/autoContinue, block work tools.
		const checkpointGoalId = core.runtime.getCheckpointGoalId();
		if (checkpointGoalId !== null && !core.isActionableContinuationGoal(checkpointGoalId) && core.isStaleCheckpointBlockedToolCall(event.toolName)) {
			// Block the tool call with a stale-checkpoint message.
			return {
				block: true,
				reason: `Cannot call ${event.toolName}: the goal checkpoint that triggered this turn is no longer active. ` +
					`Goal ${checkpointGoalId} has been paused, cleared, or replaced. ` +
					`End the turn with a brief summary and yield to the user.`,
			};
		}
		// Track for #4 empty-turn gate.
		if (isMeaningfulProgressToolCall(event.toolName, asRecord(event)?.args)) {
			core.goalWorkToolCalledThisTurn = true;
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		core.touchGoalActivity(); // F5
		core.accountProgress(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		const tokens = assistantTurnTokens(message);
		core.touchGoalActivity(); // F5
		core.accountProgress(ctx, { completedTurnTokens: tokens });

		if (isAbortedAssistantMessage(message)) {
			core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: do not turn one failed turn
		// into an unbounded auto-continue retry storm. Keep the display
		// reconciled (and accounting already ran above), but never queue a
		// continuation for an error turn (danim47c pattern).
		if (isErrorAssistantMessage(message)) {
			core.refreshGoalDisplayFromDisk(ctx);
			core.updateUI(ctx);
			return;
		}
		core.refreshGoalDisplayFromDisk(ctx);

		// Archive a goal that was marked complete but whose archival was deferred
		// so the agent could see/recognize the audit result first.
		// This runs after the agent's turn ends — the agent has now seen the result.
		if (core.state.goal?.status === "complete" && !core.state.goal?.archivedPath) {
			const completedGoal = core.state.goal;
			let archiveResult: GoalMutationOutcome;
			try {
				archiveResult = core.goalService.apply(ctx, {
					reconcile: false,
					archive: true,
					commitFocused: false,
					mutate: () => completedGoal,
					ledger: (written) => [{
						type: "goal_completed",
						goalId: completedGoal.id,
						archivePath: written.archivedPath,
						at: nowIso(),
					}],
				});
			} catch (err) {
				// The archive write throws on failure (e.g. unwritable archived
				// directory); surface it as a typed outcome (follow-up Stage 3).
				archiveResult = { ok: false, message: err instanceof Error ? err.message : String(err) };
			}
			if (archiveResult.ok) {
				core.goalsById.delete(completedGoal.id);
				core.assignFocusedGoalId(null);
				core.appendFocusEntry(null, "completed");
				// §16.6: append the dedicated goal_archived event (the completion
				// transaction keeps goal_completed for compatibility) and emit the
				// real archive path.
				try {
					core.goalService.appendEvents(ctx, [{
						type: "goal_archived",
						goalId: completedGoal.id,
						archivePath: archiveResult.goal?.archivedPath ?? "",
						at: nowIso(),
					}]);
				} catch {
					// Best-effort; the archive itself already succeeded.
				}
				const path = archiveResult.goal?.archivedPath ?? "";
				ctx.ui.notify(path ? `Goal archived.\nFile: ${path}` : "Goal archived.", "info");
			} else {
				// §16.6 failure behavior: never claim success, keep the complete
				// record recoverable at its active path, and write a diagnostic
				// ledger event when possible.
				const remainingPath = completedGoal.activePath ?? "(unknown)";
				ctx.ui.notify(`Failed to archive completed goal: ${archiveResult.message}. The complete record remains at ${remainingPath}.`, "warning");
				try {
					core.goalService.appendEvents(ctx, [{
						type: "goal_archive_failed",
						goalId: completedGoal.id,
						message: archiveResult.message ?? "archive write failed",
						at: nowIso(),
					}]);
				} catch {
					// Diagnostic write is best-effort.
				}
			}
			core.updateUI(ctx);
		}

		// If the assistant ended a turn without queuing more tool calls, push a continuation right away.
		// #4: only queue if some real work was done this turn — otherwise the model is
		// just chatting and we should not keep firing turns on noise.
		if (
			!isToolUseAssistantMessage(message)
			&& core.state.goal?.status === "active"
			&& core.state.goal.autoContinue
			&& core.goalWorkToolCalledThisTurn
		) {
			core.queueContinuation(ctx);
		}
		core.goalService.endTurn(ctx); // P1-3: single flush (lock + write + ledger batch)
	});

	pi.on("message_end", async (event, ctx) => {
		if (isAbortedAssistantMessage(event.message)) core.pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false) {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		// NAF: the zero-op read caches are session-scoped — a new session always
		// re-reads settings/pool/ledger fresh from disk (cross-process and
		// hand-edited changes are picked up at the session boundary).
		invalidateGoalSettingsCache();
		invalidateGoalPoolCache();
		invalidateGoalLedgerCache();
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		await core.loadState(ctx);
		core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		if (event.reason === "resume" && !core.state.goal && !core.hasExplicitSessionFocus && core.openGoals().length > 1 && ctx.hasUI) {
			// Prompt the user to pick which open goal to focus (mirrors /goal-focus).
			const open = core.openGoals();
			const labels = open.map((item) => goalSelectorLabel(item, core.focusedGoalId));
			const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
			core.enterGoalModal();
			try {
				const selected = await ctx.ui.select("Focus open goal", labels);
				const selectedId = selected ? byLabel.get(selected) : undefined;
				if (selectedId) {
					core.setFocusedGoalId(selectedId, ctx, "selected");
					core.armFocusedContinuation(ctx);
				}
			} finally {
				core.exitGoalModal();
			}
		}
		// Codex behavior: prompt before reactivating a paused goal on resume.
		if (event.reason === "resume" && core.state.goal?.status === "paused" && ctx.hasUI) {
			const current = core.state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				core.setGoal({ ...current, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
			}
		}
		core.beginAccounting();
		core.queueContinuation(ctx, true);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		core.accountProgress(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		if (core.state.goal) core.persist(ctx);
		core.beginAccounting();
		// Arm a deterministic compaction summary for the next agent turn.
		// This replaces the generic reminder with artifact-backed state.
		if (shouldArmPostCompactReminder(core.state.goal)) {
			core.runtime.armPostCompactReminder();
		}
		core.queueContinuation(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		await core.loadState(ctx);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		core.beginAccounting();
		core.queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		core.advanceTurnSeq();
		const currentSystemPrompt = () => ctx.getSystemPrompt?.() || event.systemPrompt;
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");
		// Several prompt enrichments may need the same ledger snapshot. Keep one
		// local read for this hook instead of repeatedly traversing the cached
		// ledger when rejection and post-compaction steering overlap.
		let promptLedger: ReturnType<typeof readGoalLedger> | undefined;
		const getPromptLedger = () => promptLedger ??= readGoalLedger(ctx);

		// If this turn was triggered by a hidden goal checkpoint that no longer
		// matches the active goal, abort the whole turn instead of letting the
		// model act on a stale instruction.
		if (incomingGoalId !== null) {
			// Reconcile from disk to pick up any external state changes before
			// evaluating whether the checkpoint is actionable.
			core.reconcileFocusedGoalFromDisk(ctx);
			core.runtime.setCheckpoint(incomingGoalId);
			core.clearContinuationState();
			if (!core.isActionableContinuationGoal(incomingGoalId)) {
				try {
					ctx.abort?.();
				} catch {}
				core.updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, core.state.goal)}`,
				};
			}
			core.runtime.setCheckpoint(null);
		} else {
			// A user-driven turn — clear any queued continuation so we don't
			// double-fire after the user's own message returns. Also reset the
			// autoContinue nudge state so the user always gets a fresh chain.
			core.runtime.setCheckpoint(null);
			core.clearContinuationState();
		}

		if (!core.state.goal) {
			core.runningGoalId = null;
			const openCount = core.openGoals().length;
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			core.runningGoalId = null;
			const openCount = core.openGoals().length;
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		core.runningGoalId = core.state.goal.status === "active" ? core.state.goal.id : null;
		if (core.state.goal.status === "complete") return;
		if (core.state.goal.status === "paused") {
			const current = core.state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason: ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`Suggested action: ${current.pauseSuggestedAction}`);
			}
				// Inject durable auditor feedback if available
				let auditorExtra = "";
				try {
					const ledger = getPromptLedger();
				const auditorResult = latestAuditorResultForGoal(ledger.events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n[AUDITOR REJECTION] An independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
				}
			} catch {
				// Ledger read failure should not break the prompt
			}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with /goal-resume. If the user explicitly asks to finish the paused goal and the objective is already satisfied based on available evidence, you may call update_goal({status: "complete"}). To abandon a goal, the user runs /goal-clear. Do not report the goal blocked in response to a pause.`,
			};
		}
		// Token-budget-limited goals get one-time wrap-up steering: summarize,
		// do not start new substantive work, never claim completion unless real.
		if (core.state.goal?.status === "budget_limited") {
			const limitedGoal = core.state.goal;
			const budgetText = budgetLine(limitedGoal);
			// E4: surface the remaining-vs-overshoot fact in the wrap-up steering.
			const remaining = budgetRemaining(limitedGoal);
			const balanceText = typeof remaining === "number"
				? remaining < 0
					? ` — ${formatTokenValue(-remaining)} over the budget`
					: ` — ${formatTokenValue(remaining)} remaining`
				: "";
			const reminder = core.runtime.consumePostBudgetReminder()
				? `\n\n[TOKEN BUDGET REACHED goalId=${limitedGoal.id}]\nThe goal's token budget has been reached${budgetText ? ` (${budgetText}${balanceText})` : ""}. Wrap up the current work in one final response: summarize what was accomplished and what remains, do not start new substantive work, and do not claim the goal is complete unless it actually is. To continue, the user must raise or remove the budget and resume the goal.`
				: "";
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL BUDGET LIMITED goalId=${limitedGoal.id}]\n${untrustedObjectiveBlock(limitedGoal)}${budgetText ? `\n${budgetText}` : ""}${reminder}`,
			};
		}
		const activeGoal = core.state.goal;
		const settings = loadGoalSettings(ctx.cwd);
		let prompt = goalPrompt(activeGoal, settings);
		// F5: [GOAL STALLED] steering note when the detector fired.
		const stalledNote = core.checkStall(ctx);
		if (stalledNote) prompt += stalledNote;
		// Inject durable auditor feedback if the latest result was a rejection
		try {
			const ledger = getPromptLedger();
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved" && ledger.events.some((e) => e.type === "completion_requested" && e.goalId === activeGoal.id)) {
				prompt = `${prompt}\n\n[AUDITOR REJECTION goalId=${activeGoal.id}]\nAn independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
			}
		} catch {
			// Ledger read failure should not break the prompt
		}
		if (core.runtime.isPostCompactReminderPending() && shouldInjectPostCompactReminder({ pending: true, goal: activeGoal })) {
			core.runtime.clearPostCompactReminder();
				// Use deterministic compaction summary instead of generic reminder
				try {
					const ledger = getPromptLedger();
				const compaction = buildCompactionSummary({ goalsById: core.goalsById, focusedGoalId: core.focusedGoalId, ledgerState: loadLedgerState(ctx) });
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${activeGoal.id}]\n${compaction}`;
			} catch {
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${core.state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		const endedGoalId = core.runningGoalId;
		core.runningGoalId = null;
		continuationAfterSettleFor = null;

		// Account for any tokens from aborted in-flight assistant messages so
		// they are not silently lost (but charge them to the original goal).
		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && core.state.goal?.id === endedGoalId) {
			core.accountProgress(ctx, { completedTurnTokens: abortedTokens });
		}

		core.runtime.clearContinuationState();
		if (!core.state.goal || core.state.goal.status !== "active" || !core.state.goal.autoContinue) return;
		if (endedGoalId && core.state.goal.id !== endedGoalId) return;
		if (!core.reconcileFocusedGoalFromDisk(ctx)) return;
		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
			core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: persist and refresh the
		// display, but never queue a continuation for a run whose messages
		// include an assistant error (danim47c pattern).
		if (hasErrorAssistantMessage(event.messages)) {
			core.persist(ctx);
			core.updateUI(ctx);
			return;
		}
		core.persist(ctx);
		core.updateUI(ctx);
		// agent_end runs before pi finishes retries, compaction, terminating-tool
		// settlement, and queued messages. Starting the continuation timer here
		// can poll a stale busy context for minutes on pi 0.84. agent_settled is
		// available in both supported SDK lines (0.83 and 0.84) and is the first
		// point where pi guarantees no automatic work remains.
		continuationAfterSettleFor = core.state.goal.id;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const goalId = continuationAfterSettleFor;
		continuationAfterSettleFor = null;
		if (!goalId || !core.isActionableContinuationGoal(goalId)) return;
		core.queueContinuation(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		continuationAfterSettleFor = null;
		core.accountProgress(ctx);
		core.clearContinuationTimer();
		core.terminalInputUnsubscribe?.();
		core.terminalInputUnsubscribe = null;
		if (core.state.goal) core.persist(ctx);
	});
}
