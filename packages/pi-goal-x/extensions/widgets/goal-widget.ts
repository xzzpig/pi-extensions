import { dashboardKeyboardAvailable } from "../fork-dashboard-host-keys.ts";
import { dashboardFooterKeys, type DashboardFooterKeys } from "../fork-dashboard-key-routes.ts";
import { dashboardHostFrame, observeDashboardHostFrame, sameDashboardHostFrame, type DashboardHostFrame } from "./fork-dashboard-host-frame.ts";
import type { GoalKeybinding, GoalCommands } from "../goal-controls.ts";
import type { AuditorProgress } from "../goal-auditor.ts";
import { AuditDashboardViewport } from "./fork-audit-viewport.ts";
import { AuditDashboardMouse, auditTerminalRows } from "./fork-audit-mouse.ts";
import { TaskTreeView, type TaskTreeProjection } from "./fork-task-tree-view.ts";
import { TaskTreeMouse } from "./fork-task-tree-mouse.ts";
import { handleTaskWidgetMouse, taskWidgetMouseSignature, taskWidgetSourceSignature } from "./fork-task-widget-mouse.ts";
import { dashboardDockChildren, renderFittingTaskWidget, measureOrdinaryTaskWindow } from "./fork-task-widget-layout.ts";
import type { AuditFailureMinimumLayout, GoalAuditFailure } from "./fork-goal-audit-failure.ts";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidth } from "./text-cache.ts";
import {
	displayObjectiveTitle,
	formatDuration,
	formatTokenValue,
	truncateText,
	type GoalDisplayRecordLike,
} from "../goal-core.ts";
import type { GoalRecord, GoalTask, GoalTaskList, TaskStatus } from "../goal-record.ts";
import type { GoalDashboardKeybindings, GoalSettings } from "../goal-settings.ts";
import { sisyphusStepProgress } from "../goal-policy.ts";
import type { GoalLedgerEvent } from "../goal-ledger.ts";
import {
	clampScrollOffset,
	compactTaskViewportRows,
	deriveGoalDashboardModel,
	expandedTaskViewportRows,
	maxScrollOffset,
	taskViewportPageSize,
	type GoalDashboardModel,
	type DashboardTaskNode,
} from "./goal-dashboard-model.ts";
import {
	clampLinesToWidth,
	renderAuditResultCard,
	renderAuditorDashboard,
	renderCompactDashboard,
	renderExpandedDashboard,
	renderUnfocusedDashboard,
} from "./goal-dashboard-renderer.ts";
import { deriveAuditResultCard, deriveAuditorDashboardModel } from "./auditor-dashboard-model.ts";
import type { TaskFooterControls } from "./fork-task-dashboard-footer.ts";

type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	id: string;
	createdAt: string;
	updatedAt: string;
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList | null;
	verificationContract?: string;
	tokenBudget?: number;
	currentTaskId?: string;
}

export const GOAL_WIDGET_KEY = "goal";

/**
 * Live display record for the widget/status line: the accounted usage view
 * (clone with live elapsed seconds) when accounting is active for the goal,
 * otherwise the goal as-is (P1-12 extraction from goal-state).
 */
export function liveDisplayGoal(goal: GoalRecord | null, accounting: { isActiveFor(goalId: string): boolean; liveSeconds(): number }): GoalRecord | null {
	if (!goal || goal.status !== "active" || !accounting.isActiveFor(goal.id)) return goal;
	const liveSeconds = accounting.liveSeconds();
	if (liveSeconds === 0) return goal;
	return {
		...goal,
		usage: { ...goal.usage, activeSeconds: goal.usage.activeSeconds + liveSeconds },
	};
}

/**
 * The above-editor widget registration factory (P1-12 extraction): builds the
 * GoalWidgetComponent factory the host UI calls at render time. Reads live
 * state through getters so renders always see the current goal.
 */
export function makeGoalWidgetFactory(opts: {
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount: () => number;
	getAuditorProgress: () => AuditorWidgetProgress | null;
	getAuditLifecycle?: () => object | null;
	isIdle?: () => boolean;
	isKeyboardBlocked?: () => boolean;
	getSettings: () => GoalSettings;
	getDebugMode: () => boolean;
	getStalled: () => boolean;
	getExpanded?: () => boolean;
	onToggleExpanded?: () => void;
	getLedgerEvents?: () => GoalLedgerEvent[];
	getAuditFailure?: (goalId: string) => GoalAuditFailure | undefined;
	getAuditResult?: () => AuditResultView | null;
	/** Called with the host TUI instance when the factory runs, so goal-widget.ts can observe TUI-wide overlay state (any extension's overlays block goal ESC handling). */
	onTui?: (tui: TUI) => void;
	/** Receives the live widget so terminal shortcuts can scroll its viewports. */
	componentRef?: { current: GoalWidgetComponent | null };
}) {
	return (tui: TUI, theme: Theme) => {
		opts.onTui?.(tui);
		const component = new GoalWidgetComponent({
			tui,
			theme,
			getGoal: opts.getGoal,
			getOpenGoalCount: opts.getOpenGoalCount,
			getAuditorProgress: opts.getAuditorProgress,
			getAuditLifecycle: opts.getAuditLifecycle,
			isIdle: opts.isIdle,
			isKeyboardBlocked: opts.isKeyboardBlocked,
			getSettings: opts.getSettings,
			getDebugMode: opts.getDebugMode,
			getStalled: opts.getStalled,
			getExpanded: opts.getExpanded,
			onToggleExpanded: opts.onToggleExpanded,
			getLedgerEvents: opts.getLedgerEvents,
			getAuditFailure: opts.getAuditFailure,
			getAuditResult: opts.getAuditResult,
		});
		if (opts.componentRef) opts.componentRef.current = component;
		return component;
	};
}

export interface AuditorWidgetProgress extends AuditorProgress {
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentOutput: string[];
	phase: "running" | "tool_executing" | "producing_report" | "thinking" | "done";
	elapsedMs: number;
	/** Current step label shown to the user */
	label?: string;
	/** Completion percentage from 0 to 100 */
	percentage?: number;
	/** §15: auditor identity (provider/model) for the audit dashboard header. */
	auditorLabel?: string;
}

export interface GoalWidgetOptions {
	theme: Theme;
	tui: TUI;
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount?: () => number;
	getAuditorProgress?: () => AuditorWidgetProgress | null;
	getAuditLifecycle?: () => object | null;
	isIdle?: () => boolean;
	isKeyboardBlocked?: () => boolean;
	getSettings?: () => GoalSettings;
	getDebugMode?: () => boolean;
	/** F5: stalled badge (active auto-continue goal with no recent activity). */
	getStalled?: () => boolean;
	/** §10: dashboard expansion state (compact vs expanded task view). */
	getExpanded?: () => boolean;
	onToggleExpanded?: () => void;
	/** §12: durable ledger events for the recent-activity feed. */
	getLedgerEvents?: () => GoalLedgerEvent[];
	getAuditFailure?: (goalId: string) => GoalAuditFailure | undefined;
	/** §15.4: finished audit result card (cleared after a short display). */
	getAuditResult?: () => AuditResultView | null;
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

// ── terminal-height bound (spec 2026-08-10-widget-height-bound-scrollback-fix) ──

/**
 * Minimum rows reserved below/around the widget so pi's frame stays usable
 * when the widget is at its cap: status line (1) + editor minimum (3) +
 * footer (1) + a chat row (1). With the widget capped at
 * `terminalRows − WIDGET_HEIGHT_RESERVE`, the widget never fills the terminal:
 * the chat row stays in the frame, the widget's top lines stay within the
 * viewport (no pi-tui full-render scrollback wipe), and the editor/footer
 * stay visible — the equal-height scroll-up failure is impossible. Kept at
 * the minimum that still guarantees the chat row: a larger reserve would
 * slice dashboards that genuinely fit (e.g. the expanded 24-line dashboard
 * on a 30-row terminal renders unchanged at 24 + 5 chrome + 1 chat = 30).
 */
export const WIDGET_HEIGHT_RESERVE = 6;

/**
 * Deterministic height guard: cap rendered lines to the terminal height minus
 * the reserved chrome. Head slice, because the dashboard's content priority
 * is top-down (identity → status → progress → tasks → details → hints); the
 * goal identity/status and the interactive task list stay in frame. Pure
 * index function — stable across renders, so the widget never shrinks on its
 * own and can never trigger pi-tui's clearOnShrink full-render
 * (`\x1b[2J\x1b[H\x1b[3J` scrollback wipe). No-op (unbounded) when
 * terminalRows is missing (mock TUI, headless contexts, /goal-status text).
 *
 * This pure head-slice is the terminal bound for direct callers. The live
 * component additionally applies the stable-height bound
 * (spec 2026-08-11-stable-widget-height) so the rendered height stays
 * constant within each regime — see applyStableHeightBound.
 */
export function boundWidgetRenderLines(lines: string[], terminalRows: number | undefined): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - WIDGET_HEIGHT_RESERVE);
	if (lines.length <= cap) return lines;
	return lines.slice(0, cap);
}

/**
 * Stable rendered height per regime (spec 2026-08-11-stable-widget-height).
 *
 * The widget's natural (unbounded) height varies with goal state — activity
 * feed growth, current-task contract/evidence wrapping, verification text,
 * budget, task growth (measured 4..31 lines on a 24-row terminal). Every
 * natural-height change alters the dock height → the terminal buffer's line
 * count changes → the terminal scrolls to the bottom and the user cannot hold
 * a scroll position to read the chat. The latch makes the rendered height
 * invariant to goal-state changes in EVERY case (fits and capped):
 *
 * - the first render of each regime commits the rendered height
 *   (min(natural, cap)) and every later render of that regime renders exactly
 *   that many lines — growth is head-sliced, shrink is blank-padded, the
 *   height never changes;
 * - resizing the terminal clears the latch and re-evaluates
 *   min(natural, newCap): growing the terminal reveals more of the widget,
 *   shrinking re-caps;
 * - a regime change (goal id/status, widget state kind, compact↔expanded,
 *   debug mode, tasks disabled, first task appearing) clears the latch so the
 *   new mode starts from its own natural height.
 *
 * Pure given the persisted latch state: deterministic, no timers, no
 * randomness — the same goal state on the same terminal renders the same
 * lines on every render.
 */
export function applyStableHeightBound(
	lines: string[],
	terminalRows: number | undefined,
	state: { stickyCap: number | undefined; stickyRegime: string | undefined; stickyTerminalRows: number | undefined; stickyReserve?: number },
	regime: string,
	reserve: number = WIDGET_HEIGHT_RESERVE,
): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - reserve);
	if (state.stickyTerminalRows !== terminalRows) {
		// Terminal resized: adapt to the new height (grow/shrink to fit).
		state.stickyCap = undefined;
		state.stickyTerminalRows = terminalRows;
	}
	if (state.stickyReserve !== reserve) {
		// The chrome below the widget changed (editor grew/shrunk, status,
		// footer, pending): re-evaluate so the widget's block plus the chrome
		// never exceeds the terminal — otherwise the chat's appended lines
		// and the status line land above pi-tui's viewport top and every
		// agent write triggers a 2J+3J scrollback wipe (spec 2026-08-11).
		state.stickyCap = undefined;
		state.stickyReserve = reserve;
	}
	if (state.stickyRegime !== regime) {
		// Mode/state changed: the latch belongs to one regime.
		state.stickyCap = undefined;
		state.stickyRegime = regime;
	}
	if (state.stickyCap === undefined) {
		// First render of the regime: latch the height — the natural height
		// when it fits, else the cap. Constant from here on, fits AND capped.
		state.stickyCap = Math.min(lines.length, cap);
	}
	if (lines.length > state.stickyCap) {
		// Growth past the committed height: head-slice (the dashboard's
		// content priority is top-down), so the buffer line count never
		// changes.
		return lines.slice(0, state.stickyCap);
	}
	if (lines.length < state.stickyCap) {
		// Natural dipped below the committed height: pad deterministically so
		// the buffer line count never changes. Blank rows after the box footer
		// — honest filler (the …/↑ N more markers are only for hidden content).
		const padded = lines.slice();
		while (padded.length < state.stickyCap) padded.push("");
		return padded;
	}
	// Exactly the committed height: unchanged.
	return lines;
}

function heading(theme: Theme, width: number, left: string, right = ""): string {
	if (!right) return fit(left, width);
	const rightPart = ` ${right}`;
	const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(rightPart));
	return fit(`${left}${theme.fg("dim", " ".repeat(fill))}${rightPart}`, width);
}

function branchLine(theme: Theme, width: number, isLast: boolean, content: string): string {
	const prefix = isLast ? "└─" : "├─";
	return fit(`${theme.fg("dim", prefix)} ${content}`, width);
}

function progressBar(pct: number, barWidth: number, theme: Theme): string {
	const safeBar = Math.max(3, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	const empty = safeBar - filled;
	return `[${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(empty))}]`;
}


const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

export interface AuditResultView {
	verdict: "approved" | "disapproved" | "error";
	report: string;
}

/**
 * Structured audit dashboard (§15): five check stages, elapsed duration, and a
 * progress bar, derived from the raw auditor progress stream. Raw tools and
 * recent output appear only with showToolDetails (expanded/debug audit mode)
 * or after a failed audit.
 */
export function renderAuditorWidgetLines(
	progress: AuditorWidgetProgress,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean; verdict?: "approved" | "disapproved" | "error" | null; interruptKey?: GoalKeybinding; scrollOffset?: number; viewportRows?: number } = {},
): string[] {
	const model = deriveAuditorDashboardModel(progress, { auditorLabel: progress.auditorLabel, verdict: opts.verdict });
	return renderAuditorDashboard(model, theme, width, { showToolDetails: opts.showToolDetails, interruptKey: opts.interruptKey, scrollOffset: opts.scrollOffset, viewportRows: opts.viewportRows });
}

/** §15.4: approval / rejection result card for a finished audit. */
export function renderAuditResultCardView(
	view: AuditResultView,
	theme: Theme,
	width: number,
): string[] {
	return renderAuditResultCard(deriveAuditResultCard(view.verdict, view.report), theme, width);
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { commands?: GoalCommands; openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null; disableTasks?: boolean; stalled?: boolean; ledgerEvents?: GoalLedgerEvent[]; expanded?: boolean; debug?: boolean; model?: GoalDashboardModel | null; compactScrollOffset?: number; expandedScrollOffset?: number; expandedTaskRows?: number; compactTaskRows?: number; taskProjection?: TaskTreeProjection; taskLine?: (node: DashboardTaskNode, line: number) => void; taskHeader?: (line: number) => void; controlsLine?: (controls: TaskFooterControls) => void; footerKeys?: DashboardFooterKeys; taskArea?: (first: number, last: number) => void; hideTaskIndicators?: boolean; keybindings?: GoalDashboardKeybindings; auditorKey?: GoalKeybinding; interruptAuditKey?: GoalKeybinding; /** Terminal-height bound (see boundWidgetRenderLines); undefined = unbounded. */ terminalRows?: number } = {}): string[] {
	// When auditor progress is active, show the structured audit dashboard
	// instead of the normal goal widget (§15.3).
	if (options.auditorProgress) {
		return boundWidgetRenderLines(renderAuditorWidgetLines(options.auditorProgress, theme, width, {
			showToolDetails: options.expanded === true || options.debug === true,
			interruptKey: options.interruptAuditKey,
			scrollOffset: options.expandedScrollOffset,
			viewportRows: options.expandedTaskRows,
		}), options.terminalRows);
	}
	const openGoalCount = options.openGoalCount ?? 0;
	if (!goal) {
		// Unfocused panel when open goals exist; nothing when the pool is empty.
		return boundWidgetRenderLines(openGoalCount > 0 ? renderUnfocusedDashboard(openGoalCount, theme, width, options.commands) : [], options.terminalRows);
	}
	const safeWidth = Math.max(1, width);
	const otherCount = Math.max(0, openGoalCount - 1);
	const model = options.model ?? deriveGoalDashboardModel(goal as GoalRecord | null, {
		focused: true,
		otherOpenGoals: otherCount,
		ledgerEvents: options.ledgerEvents ?? [],
		tasksDisabled: options.disableTasks === true,
		commands: options.commands,
	});
	if (!model) return [];
	const lines = options.expanded
		? renderExpandedDashboard(model, theme, safeWidth, { scrollOffset: options.expandedScrollOffset, rows: options.expandedTaskRows, keybindings: options.keybindings, taskRows: options.taskProjection?.rows, expandedTasks: options.taskProjection?.expanded, taskLine: options.taskLine, taskHeader: options.taskHeader, controlsLine: options.controlsLine, footerKeys: options.footerKeys, taskArea: options.taskArea, hideTaskIndicators: options.hideTaskIndicators })
		: renderCompactDashboard(model, theme, safeWidth, { scrollOffset: options.compactScrollOffset, keybindings: options.keybindings, auditorKey: options.auditorKey, taskRows: options.taskProjection?.rows, taskRowBudget: options.compactTaskRows, expandedTasks: options.taskProjection?.expanded, taskLine: options.taskLine, taskHeader: options.taskHeader, controlsLine: options.controlsLine, footerKeys: options.footerKeys, taskArea: options.taskArea, hideTaskIndicators: options.hideTaskIndicators });
	return boundWidgetRenderLines(clampLinesToWidth(lines, width), options.terminalRows);
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;
	private getOpenGoalCount: () => number;
	private getAuditorProgress: () => AuditorWidgetProgress | null;
	private getAuditLifecycle: () => object | null;
	private readonly isIdle: () => boolean;
	private readonly isKeyboardBlocked: () => boolean;
	private auditMouseLifecycle: object | null = null;
	private getSettings: () => GoalSettings;
	private getDebugMode: () => boolean;
	private getStalled: () => boolean;
	private getExpanded: () => boolean;
	private onToggleExpanded: () => void;
	private getLedgerEvents: () => GoalLedgerEvent[];
	private getAuditResult: () => AuditResultView | null;
	private getAuditFailure: NonNullable<GoalWidgetOptions["getAuditFailure"]>;

	// §9.6 scroll state: viewport offsets for the compact top-level list and
	// the expanded tree, compact scroll-focus engagement, and the re-anchor
	// bookkeeping (a new completion re-anchors to the latest completed task).
	private compactScrollOffset = 0;
	private expandedScrollOffset = 0;
	private lastRenderWidth = 100;
	private lastHostFrame?: DashboardHostFrame;
	private readonly hostFrameObservation: ReturnType<typeof observeDashboardHostFrame>;
	private readonly auditViewport = new AuditDashboardViewport();
	private readonly auditMouse = new AuditDashboardMouse();
	private auditIdentity: string | undefined;
	private readonly taskView = new TaskTreeView();
	private readonly taskMouse = new TaskTreeMouse();
	private taskControls: TaskFooterControls | undefined;
	private taskArea: { first: number; last: number } | undefined;
	private taskGoalId: string | undefined;
	private taskSourceSignature: string | undefined;
	private taskMouseSignature = "";
	private taskRowBudget: number | undefined;
	private lastOrdinaryTaskWindow?: { key: string; renderer: TUI; budget: number; hideIndicators: boolean };
	private hideTaskIndicators = false;
	private taskHeaderLine: number | undefined;
	private taskLineMap = new Map<number, DashboardTaskNode>();

	// Stable-height latch (spec 2026-08-11-stable-widget-height): the first
	// render of each regime commits the rendered height (natural when it fits,
	// else the cap); the height stays constant (head-slice growth, pad shrink)
	// until the regime, the terminal size, or the measured dock chrome changes,
	// so the buffer line count never changes and the terminal stops jumping to
	// the bottom.
	private stableHeightState: { stickyCap: number | undefined; stickyRegime: string | undefined; stickyTerminalRows: number | undefined; stickyReserve?: number } = {
		stickyCap: undefined,
		stickyRegime: undefined,
		stickyTerminalRows: undefined,
		stickyReserve: undefined,
	};

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
		this.getAuditorProgress = options.getAuditorProgress ?? (() => null);
		this.getAuditLifecycle = options.getAuditLifecycle ?? (() => null);
		this.isIdle = options.isIdle ?? (() => true);
		this.isKeyboardBlocked = options.isKeyboardBlocked ?? (() => false);
		this.getSettings = options.getSettings ?? (() => ({}));
		this.getDebugMode = options.getDebugMode ?? (() => false);
		this.getStalled = options.getStalled ?? (() => false);
		this.getExpanded = options.getExpanded ?? (() => false);
		this.onToggleExpanded = options.onToggleExpanded ?? (() => {});
		this.getLedgerEvents = options.getLedgerEvents ?? (() => []);
		this.getAuditResult = options.getAuditResult ?? (() => null);
		this.getAuditFailure = options.getAuditFailure ?? (() => undefined);
		this.hostFrameObservation = observeDashboardHostFrame(this.tui, this, () => this.resetDashboardMouse(), () => this.clearDashboardGestures());
	}

	/** Whether the dashboard is currently in expanded mode (§10). */
	isExpanded(): boolean {
		return this.getExpanded();
	}

	/** Pi 1.4's public focus getter and main-editor app wiring survive custom editors. */
	isMainEditorFocused(): boolean | undefined {
		const tui = this.tui as TUI & {getFocusedComponent?: () => Component | null};
		if (typeof tui.getFocusedComponent !== "function") return undefined;
		const focused = tui.getFocusedComponent() as (Component & {onSubmit?: unknown; actionHandlers?: unknown}) | null;
		// Pi copies these public app handlers when installing a replacement CustomEditor.
		// A foreign text editor can have getText/setText without owning app actions.
		return !!focused && typeof focused.onSubmit === "function"
			&& focused.actionHandlers instanceof Map && focused.actionHandlers.has("app.clear");
	}

	private isHostFrameCurrent(): boolean {
		return this.lastHostFrame !== undefined && sameDashboardHostFrame(this.lastHostFrame, dashboardHostFrame(this.tui, this));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.isHostFrameCurrent()) { this.resetDashboardMouse(); return undefined; }
		this.hostFrameObservation.observePlacement();
		const goal = this.getGoal();
		const audit = this.getAuditorProgress();
		if (audit && !this.getAuditResult()) {
			const identity = this.auditIdentity, lifecycle = this.getAuditLifecycle(), layout = JSON.stringify([this.lastRenderWidth, this.auditViewport.geometry]);
			const isCurrent = () => this.isHostFrameCurrent() && !this.tui.hasOverlay?.() && !!this.getAuditorProgress() && !this.getAuditResult() && lifecycle === this.getAuditLifecycle() && identity === this.auditIdentity && identity === JSON.stringify([this.getGoal()?.id, this.getAuditorProgress()?.attemptId, this.getExpanded() || this.getDebugMode(), auditTerminalRows(this.tui)]) && layout === JSON.stringify([this.lastRenderWidth, this.auditViewport.geometry]);
			return this.auditMouse.handle(event, { enabled: this.auditMouseLifecycle === lifecycle && isCurrent(), identity, width: this.lastRenderWidth, geometry: this.auditViewport.geometry, isCurrent, toggle: () => { this.onToggleExpanded(); this.tui.requestRender(); }, scroll: (delta) => { this.auditViewport.scroll(delta, () => this.tui.requestRender()); } });
		}
		this.auditMouse.clear();
		return handleTaskWidgetMouse({ event, mouse: this.taskMouse, enabled: !!goal && !audit && !this.getAuditResult() && goal.id === this.taskGoalId && this.taskSourceSignature === taskWidgetSourceSignature(goal, this.getExpanded()), width: this.lastRenderWidth, signature: this.taskMouseSignature, rows: this.taskLineMap, controls: this.taskControls, taskArea: this.taskArea,
			act: (action) => { if (action.kind === "task") this.taskView.toggle(action.id); else if (action.kind === "follow") this.taskView.resetFollow(); else this.onToggleExpanded(); this.tui.requestRender(); },
			scroll: (delta) => { const mode = this.getExpanded() ? "expanded" : "compact"; const rows = this.taskRowBudget ?? (mode === "expanded" ? expandedTaskViewportRows(this.lastRenderWidth) : compactTaskViewportRows(this.lastRenderWidth)); this.taskView.scroll(mode, rows, delta); this.tui.requestRender(); },
		});
	}

	/** Consume source changes synchronously, even when the next draw is coalesced. */
	observeTaskSource(goal: GoalWidgetRecord | null): void {
		if (this.taskSourceSignature === undefined || (this.taskGoalId === goal?.id && this.taskSourceSignature === taskWidgetSourceSignature(goal, this.getExpanded()))) return;
		this.taskMouse.clear();
		this.clearTaskGeometry();
	}

	private clearTaskGeometry(): void {
		this.taskControls = undefined;
		this.taskArea = undefined;
		this.taskSourceSignature = undefined;
		this.taskLineMap.clear();
	}

	update(): void {
		const audit = this.getAuditorProgress();
		if (!audit || this.getAuditResult()) { if (!this.getAuditResult() && this.getAuditLifecycle()) this.auditViewport.park(); else this.auditViewport.leave(); this.auditIdentity = undefined; this.auditMouse.clear(); }
		else this.auditMouse.observe(JSON.stringify([this.getGoal()?.id, audit.attemptId, this.getExpanded() || this.getDebugMode(), auditTerminalRows(this.tui)]), this.getAuditLifecycle(), this.lastRenderWidth, this.auditViewport.geometry, this.tui.hasOverlay?.() ?? false);
		this.tui.requestRender();
	}

	/** Render debug info panel when debug mode is active */
	private renderDebugPanel(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const safeWidth = Math.max(20, width);

		// Divider
		lines.push(t.fg("dim", "─".repeat(safeWidth)));
		lines.push(t.fg("warning", "⊙ [DEBUG MODE]"));
		lines.push("");

		const goal = this.getGoal();
		if (goal) {
			lines.push(t.fg("dim", `  id: ${goal.id}`));
			lines.push(t.fg("dim", `  status: ${goal.status}`));
			lines.push(t.fg("dim", `  objective: ${truncateText(goal.objective, 80)}`));
			lines.push(t.fg("dim", `  sisyphus: ${goal.sisyphus}`));
			lines.push(t.fg("dim", `  autoContinue: ${goal.autoContinue}`));
			lines.push(t.fg("dim", `  tokens: ${goal.usage.tokensUsed}`));
			lines.push(t.fg("dim", `  activeSeconds: ${goal.usage.activeSeconds}`));
			lines.push(t.fg("dim", `  createdAt: ${goal.createdAt}`));
			lines.push(t.fg("dim", `  updatedAt: ${goal.updatedAt}`));
			if (goal.pauseReason) lines.push(t.fg("dim", `  pauseReason: ${goal.pauseReason}`));
			if (goal.pauseSuggestedAction) lines.push(t.fg("dim", `  pauseSuggestedAction: ${goal.pauseSuggestedAction}`));
			if (goal.stopReason) lines.push(t.fg("dim", `  stopReason: ${goal.stopReason}`));
			if (goal.activePath) lines.push(t.fg("dim", `  activePath: ${goal.activePath}`));
			if (goal.archivedPath) lines.push(t.fg("dim", `  archivedPath: ${goal.archivedPath}`));
			if (goal.verificationContract) lines.push(t.fg("dim", `  vContract: ${truncateText(goal.verificationContract, 60)}`));

			// Task tree summary (from the shared dashboard model).
			const model = deriveGoalDashboardModel(goal as GoalRecord | null, { focused: true, otherOpenGoals: 0 });
			if (model?.taskProgress) {
				lines.push(t.fg("dim", `  tasks: ${model.taskProgress.completed}/${model.taskProgress.total}`));
			}
			if (model?.currentTask) {
				lines.push(t.fg("dim", `  next: ${model.currentTask.id} (${truncateText(model.currentTask.title, 40)})`));
			}
		} else {
			lines.push(t.fg("dim", "  (no goal)"));
		}

		lines.push("");
		lines.push(t.fg("dim", "── Debug keybindings ──"));
		lines.push(t.fg("dim", "  Ctrl+Shift+X  Toggle debug mode"));
		lines.push(t.fg("dim", "  Ctrl+Shift+N  Create test goal"));
		lines.push(t.fg("dim", "  Ctrl+Shift+T  Inject sample tasks"));
		lines.push(t.fg("dim", "  Ctrl+Shift+R  Mock audit animation"));
		lines.push(t.fg("dim", "  Ctrl+Shift+O  Open proposal dialog"));

		return lines;
	}

	render(width: number): string[] {
		this.lastRenderWidth = Math.max(1, width);
		this.lastHostFrame = this.hostFrameObservation.sync();
		// Terminal-height bound (spec 2026-08-10): read pi's terminal rows at
		// render time so the widget never fills the terminal — the chat/editor
		// stay visible and scrollable and the widget can never trigger pi-tui's
		// shrink full-render (\x1b[2J\x1b[H\x1b[3J) scrollback wipe. Same cast
		// pattern as the questionnaire churn guard; mock TUIs without a
		// `terminal` render unbounded.
		const terminalRows = this.lastHostFrame.rows;
		// Render the current branch unbounded (natural), then apply the
		// stable-height bound (spec 2026-08-11): the rendered height latches at
		// the first render of each regime and stays constant (fits and capped),
		// so the dock height / buffer line count stop changing and the
		// terminal stops jumping to the bottom.
		const goal = this.getGoal();
		const failure = goal && goal.status !== "complete" && !this.getAuditResult() && !this.getAuditorProgress() ? this.getAuditFailure(goal.id) : undefined;
		const taskReserve = this.measureDockReserve(width, false) ?? WIDGET_HEIGHT_RESERVE;
		const reserve = failure ? this.measureDockReserve(width, true) ?? taskReserve : taskReserve;
		const ordinaryRegime = this.stableHeightRegime();
		const regime = ordinaryRegime + (failure ? `|audit-failure:${this.lastRenderWidth}` : "");
		const taskWindowKey = JSON.stringify([ordinaryRegime, taskWidgetSourceSignature(goal, this.getExpanded()), this.lastRenderWidth, terminalRows, taskReserve]);
		if (failure) this.reconcileOrdinaryTaskWindow(width, terminalRows, taskReserve, taskWindowKey);
		const prior = this.lastOrdinaryTaskWindow;
		const priorTaskWindow = failure && prior?.key === taskWindowKey && prior.renderer === this.lastHostFrame.renderer ? prior : undefined;
		const sameAuditLatch = this.stableHeightState.stickyRegime === regime && this.stableHeightState.stickyTerminalRows === terminalRows && this.stableHeightState.stickyReserve === reserve;
		this.auditViewport.maxRows = Math.max(1, sameAuditLatch ? (this.stableHeightState.stickyCap ?? (terminalRows ?? 24) - reserve - 1) : (terminalRows ?? 24) - reserve - 1);
		this.taskHeaderLine = undefined;
		this.clearTaskGeometry();
		const natural = renderFittingTaskWidget({ width, terminalRows, reserve, taskReserve, regime, sticky: this.stableHeightState, expanded: this.getExpanded(), auditFailure: !!failure, priorTaskWindow, header: () => this.taskHeaderLine, taskLines: () => this.taskLineMap.keys(), controls: () => this.taskControls, render: (budget, hideIndicators, previewRows, shareStatusRow, minimumLayout, rowCap) => { this.taskRowBudget = budget; this.hideTaskIndicators = hideIndicators; return this.renderNatural(width, failure, previewRows, shareStatusRow, minimumLayout, !failure, rowCap); } });
		if (failure) this.commitTaskOffsets(this.lastRenderWidth, this.taskRowBudget !== 0);
		else if (this.taskHeaderLine !== undefined && this.taskRowBudget !== undefined) this.lastOrdinaryTaskWindow = { key: taskWindowKey, renderer: this.lastHostFrame.renderer, budget: this.taskRowBudget, hideIndicators: this.hideTaskIndicators };
		// Reserve adapted to the actual dock chrome (status + editor + footer +
		// pending): the widget's block plus the chrome must never exceed the
		// terminal, or the chat's appended lines and the status line land above
		// pi-tui's viewport top and every agent write wipes the scrollback.
		const rendered = applyStableHeightBound(natural, terminalRows, this.stableHeightState, regime, reserve);
		for (const line of this.taskLineMap.keys()) if (line >= rendered.length) this.taskLineMap.delete(line);
		if (this.taskControls && this.taskControls.line >= rendered.length) this.taskControls = undefined;
		if (this.taskArea) this.taskArea.last = Math.min(this.taskArea.last, (this.taskControls?.line ?? rendered.length) - 1);
		const taskSignature = taskWidgetMouseSignature({ width: this.lastRenderWidth, rows: this.taskLineMap, controls: this.taskControls, taskArea: this.taskArea }, [this.taskGoalId, this.taskSourceSignature, terminalRows]);
		if (this.taskMouseSignature !== taskSignature) this.taskMouse.clear();
		this.taskMouseSignature = taskSignature;
		this.auditViewport.clipGeometry(rendered.length);
		this.auditMouse.observe(this.auditIdentity, this.getAuditLifecycle(), this.lastRenderWidth, this.auditViewport.geometry, this.tui.hasOverlay?.() ?? false);
		return rendered;
	}

	/**
	 * Measure the rendered height of the dock chrome around the widget
	 * (pending + status + editor + widgetBelow + footer) at the current width,
	 * so the widget can size itself so its block plus the chrome never exceeds
	 * the terminal (spec 2026-08-11): pi-tui full-renders (2J+3J, scrollback
	 * wipe) whenever the first changed line is above its tracked viewport top
	 * (`previousBufferLength − terminalRows`); when the widget's block pushes
	 * the chat's append point and the status line above that, every agent
	 * write wipes the terminal scrollback and the user is forced to the
	 * bottom. Returns undefined (→ the static WIDGET_HEIGHT_RESERVE fallback)
	 * when the TUI exposes no measurable dock (mock TUIs, headless).
	 */
	private measureDockReserve(width: number, auditFailure: boolean): number | undefined {
		const top = dashboardDockChildren(auditFailure ? this.lastHostFrame?.renderer ?? this.tui : this.tui, auditFailure);
		if (!Array.isArray(top) || top.length < 2) return undefined;
		// Locate the dock list and the widget's own container:
		// regular mode — top-level [document, pending, status, widgetAbove,
		//   editor, widgetBelow, footer] with the widget directly inside
		//   widgetContainerAbove;
		// fullscreen mode — top-level [transcript, dock] with the widget
		//   inside widgetContainerAbove inside the dock VStack.
		let dockList: typeof top | undefined;
		let widgetContainer: (typeof top)[number] | undefined;
		for (const c of top) {
			const kids = Array.isArray(c.children) ? c.children : undefined;
			if (kids?.includes(this)) {
				dockList = top;
				widgetContainer = c;
				break;
			}
			const nested = kids?.find((cc) => Array.isArray(cc.children) && cc.children!.includes(this)) as (typeof top)[number] | undefined;
			if (nested) {
				dockList = kids!;
				widgetContainer = nested;
				break;
			}
		}
		if (!dockList || !widgetContainer) return undefined;
		let total = 0;
		// The document does not consume dock space. Other widgets and Pi's
		// spacer inside the above-editor container do.
		const chrome = dockList.slice(dockList === top ? 1 : 0).filter((child) => child !== widgetContainer);
		for (const c of auditFailure ? [...chrome, ...(widgetContainer.children ?? [])] : chrome) {
			if (c === this) continue;
			if (typeof c?.render !== "function") continue;
			try {
				const lines = c.render(width);
				if (Array.isArray(lines)) total += lines.length;
			} catch {
				// A sibling render failure must never break the widget; fall
				// back to the static reserve.
				return undefined;
			}
		}
		// +1 slack so the strictest safety condition (chat append point below
		// the viewport top) holds even at the boundary.
		return total + 1;
	}

	private reconcileOrdinaryTaskWindow(width: number, terminalRows: number | undefined, reserve: number, key: string): void {
		const renderer = this.lastHostFrame?.renderer;
		const prior = this.lastOrdinaryTaskWindow;
		if (!renderer || !terminalRows || (prior?.key === key && prior.renderer === renderer)) return;
		const settled = measureOrdinaryTaskWindow({ width, expanded: this.getExpanded(), cap: Math.max(1, terminalRows - reserve), header: () => this.taskHeaderLine, render: (budget, hideIndicators) => {
			this.taskRowBudget = budget;
			this.hideTaskIndicators = hideIndicators;
			return this.renderNatural(width, undefined, 0, false, undefined, false);
		} });
		if (settled.budget !== undefined) this.lastOrdinaryTaskWindow = { key, renderer, budget: settled.budget, hideIndicators: settled.hideIndicators };
	}

	private commitTaskOffsets(width: number, commit = true): void {
		this.compactScrollOffset = this.taskView.offset("compact", this.taskRowBudget ?? compactTaskViewportRows(width), commit);
		this.expandedScrollOffset = this.taskView.offset("expanded", this.taskRowBudget ?? expandedTaskViewportRows(width), commit);
	}

	/** The current widget branch rendered unbounded (no terminal-height bound). */
	private renderNatural(width: number, failure?: GoalAuditFailure, extraRows = 0, shareStatusRow = false, minimumLayout?: AuditFailureMinimumLayout, commitOffset = !failure, rowCap?: number): string[] {
		const settings = this.getSettings();
		const safeWidth = Math.max(1, width);
		// §15.4: a finished audit shows its result card until cleared.
		const auditResult = this.getAuditResult();
		if (auditResult) {
			this.auditViewport.leave(); this.auditIdentity = undefined; this.auditMouse.clear();
			return clampLinesToWidth(renderAuditResultCardView(auditResult, this.theme, width), width);
		}
		const audit = this.getAuditorProgress();
		const goal = this.getGoal();
		const footerKeys = dashboardFooterKeys({ settings, goal, audit: !!audit, expanded: this.getExpanded(), isIdle: this.isIdle, host: this.tui, keyboardAvailable: dashboardKeyboardAvailable(this.tui, this.isMainEditorFocused(), this.isKeyboardBlocked()) });
		if (audit) { this.taskMouse.clear(); if (this.auditMouseLifecycle !== this.getAuditLifecycle()) this.auditMouse.clear(); this.auditMouseLifecycle = this.getAuditLifecycle(); const expanded = this.getExpanded() || this.getDebugMode(); const goalId = goal?.id; this.auditIdentity = JSON.stringify([goalId, audit.attemptId, expanded, auditTerminalRows(this.tui)]); return this.auditViewport.render(audit, this.theme, safeWidth, { expanded, goalId, lifecycle: this.getAuditLifecycle() ?? undefined, interactive: true, interruptKey: settings.keybindings?.interruptAudit, footerKeys }); }
		if (this.getAuditLifecycle()) this.auditViewport.park(); else this.auditViewport.leave(); this.auditIdentity = undefined; this.auditMouse.clear();
		const otherCount = Math.max(0, this.getOpenGoalCount() - 1);
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: otherCount,
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
			idleContinuationBackoff: settings.idleContinuationBackoff,
			commands: settings.commands,
		}) : null;
		if (model && failure) model.auditFailure = { failure, extraRows, shareStatusRow, minimumLayout, rowCap, commands: settings.commands };
		const projection = this.taskView.update(model?.goalId, model?.currentTask?.id, model?.taskTree ?? []);
		this.taskHeaderLine = undefined;
		this.taskControls = undefined;
		this.taskArea = undefined;
		this.taskGoalId = model?.goalId;
		this.taskSourceSignature = taskWidgetSourceSignature(goal, this.getExpanded());
		this.taskLineMap.clear();
		this.commitTaskOffsets(safeWidth, commitOffset);
		const lines = renderGoalWidgetLines(this.getGoal(), this.theme, safeWidth, {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
			disableTasks: settings.disableTasks,
			stalled: this.getStalled(),
			expanded: this.getExpanded(),
			ledgerEvents: this.getLedgerEvents(),
			debug: this.getDebugMode(),
			model,
			compactScrollOffset: this.compactScrollOffset,
			expandedScrollOffset: this.expandedScrollOffset,
			expandedTaskRows: this.taskRowBudget ?? expandedTaskViewportRows(this.lastRenderWidth),
			compactTaskRows: this.taskRowBudget,
			hideTaskIndicators: this.hideTaskIndicators,
			taskProjection: projection,
			taskHeader: (line) => { this.taskHeaderLine = line; },
			taskLine: (node, line) => { this.taskLineMap.set(line, node); },
			controlsLine: (controls) => { this.taskControls = controls; },
			footerKeys,
			taskArea: (first, last) => { this.taskArea = { first, last }; },
			keybindings: settings.keybindings?.dashboard,
			auditorKey: settings.keybindings?.toggleAuditor,
			commands: settings.commands,
			interruptAuditKey: settings.keybindings?.interruptAudit,
		});
		if (this.getDebugMode()) {
			lines.push(...this.renderDebugPanel(width));
		}
		return clampLinesToWidth(lines, width);
	}

	/**
	 * Stable-height regime key: the latch belongs to one goal, goal status,
	 * widget state kind (focused / audit / result / unfocused / none),
	 * expansion mode, debug mode, task setting, and task presence — a change
	 * clears the latch so the new mode starts from its own natural height.
	 * Task presence re-latches a structurally empty goal (0 tasks → tiny
	 * dashboard) when its first task appears — a rare structural jump, not
	 * steady-state churn.
	 */
	private stableHeightRegime(): string {
		const settings = this.getSettings();
		const goal = this.getGoal();
		let stateKind: string;
		if (this.getAuditResult()) stateKind = "result";
		else if (this.getAuditorProgress()) stateKind = "audit";
		else if (goal) stateKind = "focused";
		else stateKind = this.getOpenGoalCount() > 0 ? "unfocused" : "none";
		const hasTasks = (goal?.taskList?.tasks?.length ?? 0) > 0;
		return [goal?.id ?? "∅", goal?.status ?? "∅", stateKind, String(this.getExpanded()), String(this.getDebugMode()), String(settings.disableTasks === true), String(hasTasks)].join("|");
	}

	/**
	 * Scroll the compact task list with a Ctrl+Shift chord (§9.6). The chords
	 * are free in pi (the editor owns the plain arrows), so no focus state is
	 * needed — but they are consumed only when the compact list actually
	 * overflows its viewport, so they never swallow keystrokes for a short
	 * list. Returns true when the key was consumed.
	 */
	handleCompactScrollKey(key: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): boolean {
		if (this.getExpanded() || this.getAuditorProgress() || this.hasHiddenFailureTaskViewport()) return false;
		const settings = this.getSettings();
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
			idleContinuationBackoff: settings.idleContinuationBackoff,
			commands: settings.commands,
		}) : null;
		const list = this.taskView.update(model?.goalId, model?.currentTask?.id, model?.taskTree ?? []).rows;
		const rows = this.taskRowBudget ?? compactTaskViewportRows(this.lastRenderWidth);
		if (list.length <= rows) return false;
		let offset = this.taskView.offset("compact", rows);
		const previous = offset;
		if (key === "up") offset -= 1;
		else if (key === "down") offset += 1;
		else if (key === "pageUp") offset -= taskViewportPageSize(rows);
		else if (key === "pageDown") offset += taskViewportPageSize(rows);
		else if (key === "home") offset = 0;
		else if (key === "end") offset = maxScrollOffset(list.length, rows);
		offset = clampScrollOffset(offset, list.length, rows);
		if (offset !== previous) this.taskMouse.clear();
		this.compactScrollOffset = this.taskView.scroll("compact", rows, offset - previous);
		this.tui.requestRender();
		return true;
	}

	/**
	 * Handle a navigation key for the expanded dashboard. The expanded
	 * dashboard is modal — while it is open it owns the arrow keys (like the
	 * session tree or model selector), so plain ↑/↓/PgUp/PgDn scroll the task
	 * tree and Esc collapses. Returns true when the key was consumed.
	 * Clamps at both ends; Home/End jump to the edges; PgUp/PgDn page by one
	 * viewport.
	 */
	handleNavigationKey(key: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): boolean {
		if (!this.getExpanded()) return false;
		if (this.getAuditorProgress()) return this.auditViewport.navigate(key, () => this.tui.requestRender());
		if (this.hasHiddenFailureTaskViewport()) return false;
		const settings = this.getSettings();
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
			idleContinuationBackoff: settings.idleContinuationBackoff,
			commands: settings.commands,
		}) : null;
		const list = this.taskView.update(model?.goalId, model?.currentTask?.id, model?.taskTree ?? []).rows;
		if (list.length === 0) return false;
		const rows = this.taskRowBudget ?? expandedTaskViewportRows(this.lastRenderWidth);
		const maxO = maxScrollOffset(list.length, rows);
		if (maxO <= 0) return true;
		let offset = this.taskView.offset("expanded", rows);
		const previous = offset;
		if (key === "up") offset -= 1;
		else if (key === "down") offset += 1;
		else if (key === "pageUp") offset -= taskViewportPageSize(rows);
		else if (key === "pageDown") offset += taskViewportPageSize(rows);
		else if (key === "home") offset = 0;
		else if (key === "end") offset = maxO;
		offset = clampScrollOffset(offset, list.length, rows);
		if (offset !== previous) this.taskMouse.clear();
		this.expandedScrollOffset = this.taskView.scroll("expanded", rows, offset - previous);
		this.tui.requestRender();
		return true;
	}

	private hasHiddenFailureTaskViewport(): boolean {
		return this.taskRowBudget === 0 && this.stableHeightState.stickyRegime?.includes("|audit-failure:") === true;
	}

	private clearDashboardGestures(): void {
		this.taskMouse.clear();
		this.auditMouse.clear();
	}

	/** Mode changes are observable before Pi can draw the next frame. */
	resetDashboardMouse(): void {
		this.clearDashboardGestures();
		this.clearTaskGeometry();
		this.auditIdentity = undefined;
	}

	dispose(): void {
		this.hostFrameObservation.dispose();
		this.resetDashboardMouse();
	}

	invalidate(): void {
		this.hostFrameObservation.sync();
		this.tui.requestRender();
	}
}
