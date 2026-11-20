import { reflowEditorRows } from "./fork-confirmation-editor-reflow.ts";
import { ConfirmationFeedbackEditor } from "./fork-confirmation-feedback-editor.ts";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { renderAnchoredDiffEntries, type DiffTextEntry } from "@xzzpig/pi-components/diff";
import { getKeybindings, visibleWidth, wrapTextWithAnsi, type Component, type EditorTheme, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { goalDialogControls } from "./goal-dialog-controls.ts";
import { fitConfirmationBody } from "./fork-confirmation-viewport.ts";
import { hostDialogGeometry } from "./fork-confirmation-host.ts";
import { dialogOverlayState, installOneRowDialogFallback } from "./fork-confirmation-tiny-host.ts";
import { ConfirmationMouse, type ConfirmationHit, type ConfirmationMouseLayout, type ConfirmationTarget } from "./fork-confirmation-mouse.ts";
import { computeDialogLineLimit } from "./goal-questionnaire.ts";
import { borderedLine, dialogInnerWidth, horizontalRule } from "./widgets/dialog-scaffold.ts";
import { truncateToWidth } from "./widgets/text-cache.ts";

export type TweakProposalDecision = "confirm" | "continue" | "cancel";
export type TweakProposalView = "diff" | "full";

/** The two read-only presentations of one tweak proposal. */
export interface TweakProposalViews {
	/** Line-level diff from the authoritative goal to the effective candidate. */
	diffText: string;
	/** Complete effective candidate content ("modified goal"). */
	fullText: string;
	/** UI-only escaping when text contains ambiguous whitespace or backslashes. */
	fullUiText?: string;
	/** Ephemeral semantic rows, never stored in the review snapshot. */
	diffEntries?: readonly DiffTextEntry[];
}

export interface TweakProposalDialogOptions {
	/**
	 * Rebuild both views for an auditor choice. Invoked once when the dialog
	 * opens and again on every audit toggle; the selected view, scroll
	 * positions, feedback draft, and option selection survive the rebuild.
	 */
	presentation: (auditorEnabled: boolean) => TweakProposalViews;
	/** Initial completion-auditor selection (the draft's persisted choice). */
	defaultAuditorEnabled: boolean;
	/** Why the model proposed this revision; displayed separately from the diff. */
	reason?: string;
	/** Cancel the host review when the owning tool invocation is aborted. */
	signal?: AbortSignal;
}

interface InternalProposalOptions extends TweakProposalDialogOptions {
	creation?: { title: string; auditorVisible: boolean };
}

export interface TweakProposalDialogResult {
	decision: TweakProposalDecision;
	auditorEnabled: boolean;
	/**
	 * The host could not present the confirmation at all. Callers must keep the
	 * tweak pending instead of treating `decision` as an approval.
	 */
	unavailable: boolean;
	/** Trimmed feedback typed through the Continue-chatting editor. */
	feedback?: string;
}

const VIEW_TOGGLE_INDEX = 3;
const CONTINUE_INDEX = 1;

const DIALOG_TITLE = "Goal tweak confirmation";
const DIFF_VIEW_LABEL = "Changes from the current goal (diff)";
const FULL_VIEW_LABEL = "Modified goal — full effective content";
const DIFF_VIEW_TOGGLE = "View the full modified goal (read-only)";
const FULL_VIEW_TOGGLE = "Back to the change diff (read-only)";
const DECISION_OPTIONS = [
	{ label: "Confirm — apply this tweak", description: "Applies the reviewed tweak as one atomic update." },
	{ label: "Continue chatting — keep refining", description: "Keeps this tweak pending; Enter opens the feedback editor (empty is allowed)." },
	{ label: "Cancel — discard this tweak", description: "Ends this tweak; the current goal stays unchanged." },
] as const;
const CREATE_OPTIONS = [
	{ label: "Confirm — create this goal now", description: "Creates the reviewed goal." },
	{ label: "Continue chatting — keep refining", description: "Keeps the draft pending and opens optional feedback." },
	{ label: "Cancel — discard this draft", description: "Discards this draft without creating a goal." },
] as const;

/**
 * Strip terminal control instructions from user/model-provided proposal text.
 * The text is displayed, never interpreted: ESC/CSI/OSC/APC sequences, C0/C1
 * controls, and carriage returns are removed, tabs become spaces, and newlines
 * are preserved. Wide-character and ANSI-aware width handling happens later on
 * each wrapped line.
 */
/* eslint-disable no-control-regex -- escaping terminal control sequences is this sanitizer's purpose */
function sanitizeProposalText(text: string): string {
	return text
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC
		.replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // APC (incl. pi cursor markers)
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
		.replace(/\u009b[0-?]*[ -/]*[@-~]/g, "") // C1 CSI
		.replace(/\u001b[()][0-9A-Za-z]/g, "") // charset designation
		.replace(/\u001b[@-_]/g, "") // remaining two-byte escapes
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
/* eslint-enable no-control-regex */

function lineStyle(source: string): "added" | "removed" | "meta" | "context" {
	if (source.startsWith("+")) return "added";
	if (source.startsWith("-")) return "removed";
	if (/^\s*(?:@@|\.\.\.|…)/.test(source)) return "meta";
	return "context";
}

interface BodyRow {
	text: string;
	entryIndexes: readonly number[];
	part: number;
	sourcePositions: readonly { entryIndex: number; offset: number; fragment?: number }[];
}
type BodyAnchor = { kind: "top" } | { kind: "source"; entryIndex: number; offset: number; fragment?: number };
interface EditorMouseGeometry { x: number; y: number; width: number; height: number; offsetY: number; fullHeight: number; virtualWidth: number; mapping?: {row: number; col: number}[] }

interface TweakScrollState {
	/** First fully visible content line (excluding the reserved bottom edge). */
	scrollTop: number;
	needsFollow: boolean;
	optionRanges: Array<[number, number]>;
	followIndex: number;
}

/**
 * Window the complete dialog over a fixed height without ever hiding a content
 * line at a page boundary. The shared questionnaire viewport replaces the row
 * at `scrollTop` with its `▲ N more` indicator, so PageDown steps can skip the
 * line that lands exactly there. This dialog instead reserves a dedicated top
 * indicator row only while scrolled (the bottom border always keeps the last
 * row), which makes every content line reachable with repeated paging. The
 * full content is never truncated or sliced away; only the window moves.
 */
function fitTweakViewport(
	lines: readonly string[],
	maxDialogLines: number,
	scroll: TweakScrollState,
	dim: (s: string) => string,
	scrollHint: string,
): string[] {
	if (maxDialogLines <= 0 || lines.length <= maxDialogLines) return [...lines];
	if (maxDialogLines < 3) {
		const selected = scroll.optionRanges[scroll.followIndex];
		if (scroll.needsFollow && selected) {
			const [start, end] = selected;
			if (start < scroll.scrollTop || end >= scroll.scrollTop + maxDialogLines) scroll.scrollTop = start;
			scroll.needsFollow = false;
		}
		scroll.scrollTop = Math.max(0, Math.min(scroll.scrollTop, lines.length - maxDialogLines));
		return lines.slice(scroll.scrollTop, scroll.scrollTop + maxDialogLines);
	}
	const bottomBorder = lines[lines.length - 1]!;
	// The bottom border is the reserved bottom edge; it is only replaced by the
	// “more” indicator while content remains below the window.
	const content = lines.slice(0, -1);
	const contentWindow = maxDialogLines - 2;
	if (scroll.needsFollow && scroll.optionRanges[scroll.followIndex]) {
		const [optionStart, optionEnd] = scroll.optionRanges[scroll.followIndex]!;
		if (optionStart < scroll.scrollTop || optionEnd >= scroll.scrollTop + contentWindow) {
			scroll.scrollTop = optionEnd >= scroll.scrollTop + contentWindow
				? Math.max(0, optionEnd - contentWindow + 1)
				: optionStart;
		}
		scroll.needsFollow = false;
	}
	const maxTop = Math.max(0, content.length - contentWindow);
	scroll.scrollTop = Math.max(0, Math.min(scroll.scrollTop, maxTop));
	const top = scroll.scrollTop;
	const hiddenBelow = content.length - (top + contentWindow);
	if (top === 0) {
		// No top indicator is needed at the start: use the full row for content.
		const firstPage = content.slice(0, contentWindow + 1);
		const below = content.length - firstPage.length;
		return [...firstPage, below > 0 ? dim(`… +${below} more · ${scrollHint} scroll`) : bottomBorder];
	}
	return [
		dim(`▲ ${top} more`),
		...content.slice(top, top + contentWindow),
		hiddenBelow > 0 ? dim(`… +${hiddenBelow} more · ${scrollHint} scroll`) : bottomBorder,
	];
}

class TweakProposalDialog implements Component, Focusable {
	private readonly ctx: ExtensionContext;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly options: InternalProposalOptions;
	private readonly done: (result: TweakProposalDialogResult) => void;
	private readonly controls: ReturnType<typeof goalDialogControls>;
	private readonly editor: ConfirmationFeedbackEditor;
	private readonly wasHardwareCursorShown: boolean;
	private readonly mouse = new ConfirmationMouse();
	private mouseLayout?: ConfirmationMouseLayout;
	private editorGeometry?: EditorMouseGeometry;
	private editorVisualCursor?: { row: number; col: number };
	private editorVisualLayout?: { mapping: {row: number; col: number}[]; virtualWidth: number; fullHeight: number; physicalWidth: number };

	private auditorEnabled: boolean;
	private views: TweakProposalViews;
	private view: TweakProposalView = "diff";
	private optionIndex = 0;
	private inputMode = false;
	private feedbackDraft = "";
	private dialogFocused = false;
	private readonly scrollTopByView: Record<TweakProposalView, number> = { diff: 0, full: 0 };
	private readonly overflowTopByView: Record<TweakProposalView, number> = { diff: 0, full: 0 };
	private readonly anchors: Partial<Record<TweakProposalView, BodyAnchor>> = {};
	private readonly anchorDirty: Record<TweakProposalView, boolean> = { diff: true, full: true };
	private readonly tinyBodyAnchored: Record<TweakProposalView, boolean> = { diff: false, full: false };
	private readonly bodyWidths: Partial<Record<TweakProposalView, number>> = {};
	private readonly bodyHeights: Partial<Record<TweakProposalView, number>> = {};
	private readonly bodyVersions: Partial<Record<TweakProposalView, number>> = {};
	private contentVersion = 0;
	private fixedBody = true;
	private readonly fixedBodyByView: Record<TweakProposalView, boolean> = { diff: true, full: true };
	private visiblePageSize = 1;
	private maxBodyScroll = 0;
	private maxOverflowScroll = 0;
	private previousFrame?: string[];
	private baseFrameLines = 0;
	private lastDialogHeight = 0;
	private renderedHostAvailable?: number;
	private needsFollow = false;
	private finished = false;
	private restored = false;
	private readonly tinyHostOverlay: ReturnType<typeof installOneRowDialogFallback>;

	constructor(
		ctx: ExtensionContext,
		tui: TUI,
		theme: Theme,
		done: (result: TweakProposalDialogResult) => void,
		options: InternalProposalOptions,
	) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.options = options;
		this.controls = goalDialogControls(typeof ctx.cwd === "string" ? ctx.cwd : process.cwd());
		this.auditorEnabled = options.defaultAuditorEnabled;
		this.views = options.presentation(this.auditorEnabled);
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		this.editor = new ConfirmationFeedbackEditor(tui, editorTheme);
		this.wasHardwareCursorShown = tui.getShowHardwareCursor();
		tui.setShowHardwareCursor(false);
		ctx.ui.setWorkingVisible(false);
		this.editor.onSubmit = (value) => {
			if (!this.inputMode) return;
			this.feedbackDraft = value;
			this.finish("continue", value);
		};
		this.tinyHostOverlay = installOneRowDialogFallback(tui, this, (data) => !this.inputMode && (
			this.controls.matches(data, "pageUp") || this.controls.matches(data, "pageDown") ||
			this.controls.matches(data, "scrollUp") || this.controls.matches(data, "scrollDown")
		), () => this.invalidateMouse());
	}

	dispose(): void {
		this.mouse.dispose();
		this.mouseLayout = undefined;
		this.restore();
	}

	invalidate(): void {
		this.invalidateMouse();
	}

	get focused(): boolean {
		return this.dialogFocused;
	}

	set focused(value: boolean) {
		if (this.dialogFocused !== value) this.invalidateMouse();
		this.dialogFocused = value;
		this.editor.focused = value && this.inputMode;
		this.tui.setShowHardwareCursor(value && this.inputMode);
	}

	private restore(): void {
		if (this.restored) return;
		this.restored = true;
		this.tinyHostOverlay?.hide();
		this.tui.setShowHardwareCursor(this.wasHardwareCursorShown);
		this.ctx.ui.setWorkingVisible(true);
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private invalidateMouse(): void {
		this.mouse.invalidate();
		this.mouseLayout = undefined;
		this.editorGeometry = undefined;
	}

	private mouseSignature(layout: ConfirmationMouseLayout, overlay: ReturnType<typeof dialogOverlayState>["signature"]): string {
		// The signature describes observed state, not a render count: an ordinary
		// identical redraw must not invalidate a pending single click.
		// SAFETY: `terminal.rows` is a host-provided optional size hint.
		const terminalRows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows;
		return JSON.stringify([layout, this.editorGeometry, hostDialogGeometry(this.tui, this), terminalRows, this.view, this.optionIndex,
			this.inputMode, this.auditorEnabled, this.contentVersion, this.fixedBody,
			this.scrollTopByView, this.overflowTopByView, this.dialogFocused, overlay]);
	}

	private publishMouse(layout: ConfirmationMouseLayout, editor?: EditorMouseGeometry): void {
		this.mouseLayout = layout;
		this.editorGeometry = editor;
		this.mouse.observe(this.mouseSignature(layout, dialogOverlayState(this.tui, this).signature));
		// The fullscreen host commits geometry only after render returns.
		const renderedHostAvailable = this.renderedHostAvailable;
		queueMicrotask(() => {
			if (this.finished || !this.mouseLayout) return;
			const geometry = hostDialogGeometry(this.tui, this);
			if (!geometry) return;
			this.mouse.observe(this.mouseSignature(this.mouseLayout, dialogOverlayState(this.tui, this).signature));
			const available = Math.min(geometry.rect.height, geometry.clip.height);
			if ((available > 0 && available < this.mouseLayout.height) || geometry.available !== renderedHostAvailable) this.tui.requestRender();
		});
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.finished) return undefined;
		const overlay = dialogOverlayState(this.tui, this);
		const layout = this.mouseLayout;
		if (!layout) {
			// No stale geometry may activate controls. Consecutive wheel events
			// arriving before the requested redraw still accumulate safely.
			if (event.type === "wheel" && event.x >= 0 && event.x < event.width && event.y >= 0 && event.y < event.height) {
				if (!this.inputMode && event.wheelDelta) { this.scrollBody(event.wheelDelta); this.needsFollow = false; this.refresh(); }
				return { handled: true };
			}
			return undefined;
		}
		const signature = this.mouseSignature(layout, overlay.signature);
		this.mouse.observe(signature);
		// Pi already routes by pointer occlusion. A non-capturing overlay
		// changes the gesture signature without disabling fresh clicks.
		if (overlay.blocking && event.type !== "wheel") return undefined;
		if (event.width !== layout.width || event.height !== layout.height) {
			this.invalidateMouse();
			return event.type === "wheel" && event.x >= 0 && event.x < event.width && event.y >= 0 && event.y < event.height
				? { handled: true } : undefined;
		}
		const editor = this.editorGeometry;
		if (this.inputMode && editor && event.x >= editor.x && event.x < editor.x + editor.width && event.y >= editor.y && event.y < editor.y + editor.height) {
			if (!this.mouse.allowEditorEvent(event)) return undefined;
			const entry = editor.mapping?.[event.y - editor.y + editor.offsetY];
			const result = this.editor.handleMouse?.({ ...event, x: event.x - editor.x + (entry?.col ?? 0), y: entry?.row ?? event.y - editor.y + editor.offsetY,
				width: editor.virtualWidth, height: editor.fullHeight });
			if (result) {
				if (entry && event.type === "click") this.syncEditorVisualLayout();
				this.invalidateMouse();
				return result;
			}
			if (event.type !== "wheel") return undefined;
		}
		return this.mouse.handle(event, layout, {
			select: (index) => { this.invalidateMouse(); this.optionIndex = index; this.needsFollow = true; this.refresh(); },
			activate: (target) => this.activateMouseTarget(target),
			scroll: (delta) => {
				this.invalidateMouse();
				if (!this.inputMode) { this.scrollBody(delta); this.needsFollow = false; }
				this.refresh();
			},
			isCurrent: () => !this.finished && !!this.mouseLayout
				&& this.mouseSignature(this.mouseLayout, dialogOverlayState(this.tui, this).signature) === signature,
		});
	}

	private activateMouseTarget(target: ConfirmationTarget): void {
		this.invalidateMouse();
		if (target.kind === "confirm") { this.activateOption(); return; }
		if (target.kind === "auditor") this.toggleAuditor();
		if (target.kind === "view") this.toggleView();
		this.refresh();
	}

	private toggleAuditor(): void {
		this.auditorEnabled = !this.auditorEnabled;
		this.views = this.options.presentation(this.auditorEnabled);
		this.contentVersion++;
	}

	private toggleView(): void {
		this.view = this.view === "diff" ? "full" : "diff";
		this.fixedBody = this.fixedBodyByView[this.view];
		this.needsFollow = false;
	}

	private finish(decision: TweakProposalDecision, feedback?: string): void {
		if (this.finished) return;
		this.finished = true;
		this.mouse.dispose();
		this.mouseLayout = undefined;
		this.restore();
		const trimmed = feedback?.trim();
		this.done({
			decision,
			auditorEnabled: this.auditorEnabled,
			unavailable: false,
			...(trimmed ? { feedback: trimmed } : {}),
		});
	}

	private enterFeedbackEditor(): void {
		this.inputMode = true;
		this.editor.setText(this.feedbackDraft);
		this.editor.focused = this.dialogFocused;
		this.tui.setShowHardwareCursor(this.dialogFocused);
	}

	private leaveFeedbackEditor(): void {
		this.feedbackDraft = this.editor.getExpandedText?.() ?? this.editor.getText();
		this.inputMode = false;
		this.editor.focused = false;
		this.tui.setShowHardwareCursor(false);
	}

	private activateOption(): void {
		switch (this.optionIndex) {
			case 0:
				this.finish("confirm");
				return;
			case CONTINUE_INDEX:
				this.enterFeedbackEditor();
				break;
			case 2:
				this.finish("cancel");
				return;
			case VIEW_TOGGLE_INDEX:
				this.toggleView();
				break;
			default:
				return;
		}
		this.refresh();
	}

	handleInput(data: string): void {
		if (this.finished) return;
		this.invalidateMouse();
		if (this.inputMode) {
			if (this.controls.cancelEditing(data)) {
				// Esc leaves the editor with the draft intact instead of deciding;
				// Esc on the decision list means "continue chatting" (never cancel).
				this.leaveFeedbackEditor();
				this.refresh();
				return;
			}
			const geometry = this.editorVisualLayout;
			const cursor = this.editorVisualCursor;
			const keys = getKeybindings();
			const direction = keys.matches(data, "tui.editor.cursorUp") ? -1 : keys.matches(data, "tui.editor.cursorDown") ? 1 : 0;
			let handled = false;
			if (cursor && direction && geometry) {
				const initial = this.editor.getCursor();
				for (let row = cursor.row + direction; row >= 0 && row < geometry.mapping.length; row += direction) {
					const target = geometry.mapping[row]!;
					if (target.row <= 0 || target.row >= geometry.fullHeight - 1) break;
					this.editor.handleMouse({ type: "click", button: "left", x: target.col + cursor.col,
						y: target.row, width: geometry.virtualWidth, height: geometry.fullHeight, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false });
					const next = this.editor.getCursor();
					if (next.line !== initial.line || next.col !== initial.col) { handled = true; break; }
				}
			}
			if (!handled) this.editor.handleInput(data);
			if (!this.finished) this.syncEditorVisualLayout();
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "pageUp")) {
			this.scrollBody(-this.pageSize());
			this.needsFollow = false;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "pageDown")) {
			this.scrollBody(this.pageSize());
			this.needsFollow = false;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "scrollUp")) {
			this.scrollBody(-1);
			this.needsFollow = false;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "scrollDown")) {
			this.scrollBody(1);
			this.needsFollow = false;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "up")) {
			this.optionIndex = Math.max(0, this.optionIndex - 1);
			this.needsFollow = true;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "down")) {
			this.optionIndex = Math.min(this.options.creation ? 2 : VIEW_TOGGLE_INDEX, this.optionIndex + 1);
			this.needsFollow = true;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "toggleAuditor") && this.options.creation?.auditorVisible !== false) {
			this.toggleAuditor();
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "confirm")) {
			this.activateOption();
			return;
		}
		if (this.controls.matches(data, "cancel")) {
			// Existing proposal semantics: Escape keeps the draft and returns to
			// the conversation; it never cancels the tweak or applies it.
			this.finish("continue");
		}
	}

	private dialogLines(): number {
		// SAFETY: both viewport hints are optional; missing values use the shared bounded fallback.
		const tuiInfo = this.tui as unknown as { terminal?: { rows?: number }; previousLines?: string[] };
		const previous = tuiInfo.previousLines;
		if (previous && previous !== this.previousFrame) {
			// A new host frame after the first draw already contains our previous
			// dialog. Count only the surrounding frame, never our own rows.
			this.baseFrameLines = this.previousFrame ? Math.max(0, previous.length - this.lastDialogHeight) : previous.length;
			this.previousFrame = previous;
		}
		const rows = tuiInfo.terminal?.rows;
		// Historic chat is scrollback, not permanently occupied chrome.
		const reserved = rows ? Math.min(this.baseFrameLines, Math.floor(rows / 4)) : this.baseFrameLines;
		let limit = computeDialogLineLimit({ terminalRows: rows, baseFrameLines: reserved }) ?? 0;
		if (limit > 0 && reserved > 0 && rows) limit = Math.min(limit, Math.max(1, rows - reserved));
		const geometry = hostDialogGeometry(this.tui, this);
		this.renderedHostAvailable = geometry?.available;
		if (geometry && geometry.available > 0) limit = limit > 0 ? Math.min(limit, geometry.available) : geometry.available;
		return limit;
	}

	private pageSize(): number {
		return Math.max(1, this.visiblePageSize);
	}

	private scrollBody(delta: number): void {
		const offsets = this.fixedBody ? this.scrollTopByView : this.overflowTopByView;
		const maximum = this.fixedBody ? this.maxBodyScroll : this.maxOverflowScroll;
		const next = Math.max(0, Math.min(maximum, offsets[this.view] + delta));
		if (next !== offsets[this.view]) this.anchorDirty[this.view] = true;
		offsets[this.view] = next;
	}

	private renderViewBody(innerWidth: number, body: string, framed: boolean, padding: string): BodyRow[] {
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const success = (s: string) => this.theme.fg("success", s);
		const error = (s: string) => this.theme.fg("error", s);
		const line = (content: string) => framed
			? borderedLine(accent, innerWidth, truncateToWidth(`${padding}${content}`, innerWidth, "…"))
			: truncateToWidth(content, innerWidth, "");
		const wrapWidth = Math.max(1, innerWidth - padding.length);
		// Reason rows are part of the SCROLLABLE body, so a long reason can never
		// displace the fixed decision area. They are inert display text and keep
		// per-source anchors so scrolling/resize behave like every other row.
		const reasonRows: BodyRow[] = [];
		let reasonEntryCount = 0;
		if (this.options.reason) {
			const reasonEntries: DiffTextEntry[] = [
				{ kind: "meta", content: "调整原因", hunkIndex: 0 },
				...sanitizeProposalText(this.options.reason).split("\n").map((content) => ({ kind: "meta" as const, content, hunkIndex: 0 })),
				{ kind: "meta", content: "", hunkIndex: 0 },
			];
			reasonEntryCount = reasonEntries.length;
			for (const row of renderAnchoredDiffEntries(reasonEntries, { width: wrapWidth, mode: "unified" })) {
				reasonRows.push({ ...row, text: line(dim(row.text)) });
			}
		}
		let bodyRows: BodyRow[];
		if (this.view === "diff" && this.views.diffEntries) {
			bodyRows = renderAnchoredDiffEntries(this.views.diffEntries, { width: wrapWidth, mode: "auto", splitMinWidth: 120, theme: this.theme })
				.map((row) => ({ ...row, text: line(row.text) }));
		} else {
			const rawLines = sanitizeProposalText(body).split("\n");
			if (rawLines.length === 1 && rawLines[0] === "") {
				bodyRows = [{ text: line(dim("(no content provided)")), entryIndexes: [0], part: 0, sourcePositions: [{ entryIndex: 0, offset: 0 }] }];
			} else {
				const entries: DiffTextEntry[] = rawLines.map((content) => ({ kind: "meta", content, hunkIndex: 1 }));
				bodyRows = renderAnchoredDiffEntries(entries, { width: wrapWidth, mode: "unified" }).map((row) => {
					const rawLine = rawLines[row.entryIndexes[0] ?? 0] ?? "";
					const kind = this.view === "diff" ? lineStyle(rawLine) : "context";
					return { ...row, text: line(kind === "added" ? success(row.text) : kind === "removed" ? error(row.text) : kind === "meta" ? dim(row.text) : muted(row.text)) };
				});
			}
		}
		// Offset the diff/source anchors by the reason block so scroll anchoring
		// keeps pointing at the correct body row.
		const offset = reasonEntryCount;
		for (const row of bodyRows) {
			row.entryIndexes = row.entryIndexes.map((i) => i + offset);
			row.sourcePositions = row.sourcePositions.map((p) => ({ ...p, entryIndex: p.entryIndex + offset }));
		}
		return [...reasonRows, ...bodyRows];
	}

	private reanchorBody(rows: readonly BodyRow[], width: number, force = false): void {
		const view = this.view;
		if (force || this.bodyWidths[view] !== width || this.bodyVersions[view] !== this.contentVersion) {
			const anchor = this.anchors[view];
			if (anchor?.kind === "top") this.scrollTopByView[view] = 0;
			else if (anchor?.kind === "source") {
				let chosen = -1;
				for (let index = 0; index < rows.length; index++) {
					const position = rows[index]!.sourcePositions.find((item) => item.entryIndex === anchor.entryIndex);
					if (!position) continue;
					if (position.offset > anchor.offset || (position.offset === anchor.offset && (position.fragment ?? 0) > (anchor.fragment ?? 0))) break;
					chosen = index;
				}
				if (chosen >= 0) this.scrollTopByView[view] = chosen;
			}
		}
		this.bodyWidths[view] = width;
		this.bodyVersions[view] = this.contentVersion;
	}

	private rememberBodyAnchor(row: BodyRow | undefined, atTop = false): void {
		if (!this.anchorDirty[this.view] && this.anchors[this.view]) return;
		const position = row?.sourcePositions[0];
		if (atTop) this.anchors[this.view] = { kind: "top" };
		else if (position) this.anchors[this.view] = { kind: "source", ...position };
		else return;
		this.anchorDirty[this.view] = false;
	}

	render(width: number): string[] {
		const theme = this.theme;
		// Honor even a very narrow terminal: every rendered line is bounded by the
		// supplied width, and content wraps instead of being cut off.
		const safeWidth = Math.max(1, width);
		// Below five columns a frame/padding would leave only one cell and
		// destroy two-cell graphemes. Use the whole terminal for content.
		const editorMinimum = this.inputMode ? this.editor.minimumWidth() : 0;
		const framed = safeWidth >= (this.inputMode ? editorMinimum + 4 : 5);
		const innerWidth = framed ? Math.max(1, dialogInnerWidth(safeWidth, safeWidth)) : safeWidth;
		const padding = framed && innerWidth > 1 ? " " : "";
		const contentStart = (framed ? 1 : 0) + padding.length;
		const contentEnd = safeWidth - (framed ? 1 : 0);
		const accent = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);
		const muted = (s: string) => theme.fg("muted", s);
		const success = (s: string) => theme.fg("success", s);
		const warning = (s: string) => theme.fg("warning", s);
		const rule = horizontalRule(innerWidth);
		const line = (content: string) => framed
			? borderedLine(accent, innerWidth, truncateToWidth(`${padding}${content}`, innerWidth, "…"))
			: truncateToWidth(content, innerWidth, "");
		const wrapWidth = Math.max(1, innerWidth - padding.length);
		const pushWrapped = (styled: string) => {
			for (const chunk of wrapTextWithAnsi(styled, wrapWidth)) lines.push(line(chunk));
		};
		const sourceHits: ConfirmationHit[] = [];
		const addHit = (y: number, text: string, target: ConfirmationTarget): void => {
			const leading = text.length - text.trimStart().length;
			const start = contentStart + visibleWidth(text.slice(0, leading));
			const end = contentStart + visibleWidth(text.trimEnd());
			// Never create a partially clipped or padding-only control target.
			if (start < end && end <= contentEnd) sourceHits.push({ y, start, end, target });
		};

		let lines: string[] = [];
		lines.push(accent(`┌${rule}┐`));
		lines.push(line(theme.bold(this.options.creation?.title ?? DIALOG_TITLE)));
		lines.push(accent(`├${rule}┤`));

		if (this.inputMode) {
			pushWrapped(theme.bold("Continue chatting — refinement feedback"));
			pushWrapped(muted("Type the adjustment you want the agent to make."));
			lines.push(line(""));
			pushWrapped(dim("Feedback (optional — empty continues without text):"));
			const editorStart = lines.length;
			const availableEditorWidth = framed ? innerWidth - 2 : safeWidth;
			const editorWidth = Math.max(editorMinimum, availableEditorWidth);
			const editorLines = this.editor.render(editorWidth);
			const reflow = editorWidth > availableEditorWidth ? reflowEditorRows(editorLines, availableEditorWidth) : undefined;
			this.editorVisualLayout = reflow ? { mapping: reflow.mapping, virtualWidth: editorWidth, fullHeight: editorLines.length, physicalWidth: availableEditorWidth } : undefined;
			const cursorRow = reflow?.lines.findIndex(value => value.includes("\u001b_pi:c\u0007")) ?? -1;
			const cursorLine = cursorRow >= 0 ? reflow!.lines[cursorRow]! : "";
			this.editorVisualCursor = cursorRow >= 0 ? { row: cursorRow, col: visibleWidth(cursorLine.slice(0, cursorLine.indexOf("\u001b_pi:c\u0007"))) } : undefined;
			for (const editorLine of reflow?.lines ?? editorLines) lines.push(reflow ? editorLine : line(editorLine));
			const displayedEditorHeight = lines.length - editorStart;
			lines.push(line(""));
			const editorHint = `Enter continues · ${this.controls.editorCancelHint()} back to decisions`;
			for (const chunk of wrapTextWithAnsi(editorHint, wrapWidth)) lines.push(line(dim(chunk)));
			lines.push(accent(`└${rule}┘`));
			return this.fitEditorLines(lines, editorStart, displayedEditorHeight,
				availableEditorWidth, safeWidth, contentStart, editorWidth, reflow?.mapping, editorLines.length);

		}

		pushWrapped(theme.bold(this.options.creation ? "Proposed goal and tasks" : this.view === "diff" ? DIFF_VIEW_LABEL : FULL_VIEW_LABEL));
		pushWrapped(muted(this.options.creation ? "Review the complete draft before deciding." : this.view === "diff"
			? "Only changed content is shown; unchanged stretches are omitted."
			: "Complete content after this tweak is applied."));
		lines.push(accent(`├${rule}┤`));
		const bodyStart = lines.length;
		const bodyRows = this.renderViewBody(innerWidth, this.view === "diff" ? this.views.diffText : (this.views.fullUiText ?? this.views.fullText), framed, padding);
		for (const bodyLine of bodyRows) lines.push(bodyLine.text);
		const bodyEnd = lines.length;
		lines.push(accent(`├${rule}┤`));
		if (this.options.creation?.auditorVisible !== false) {
			const fullLabel = this.auditorEnabled ? "● Auditor enabled" : "○ Auditor disabled";
			const auditorLabel = visibleWidth(fullLabel) <= wrapWidth ? fullLabel
				: wrapWidth >= 4 ? (this.auditorEnabled ? "[A+]" : "[A-]") : (this.auditorEnabled ? "+" : "-");
			addHit(lines.length, auditorLabel, { kind: "auditor" });
			const auditHint = `  (press '${this.controls.hint("toggleAuditor")}' to toggle)`;
			const suffix = visibleWidth(auditorLabel + auditHint) <= wrapWidth ? dim(auditHint) : "";
			lines.push(line((this.auditorEnabled ? success(auditorLabel) : warning(auditorLabel)) + suffix));
			lines.push(line(""));
		}

		const optionRanges: Array<[number, number]> = [];
		const viewToggle = this.view === "diff" ? DIFF_VIEW_TOGGLE : FULL_VIEW_TOGGLE;
		const viewDescription = "Read-only preview of the complete content; switching never applies or discards this tweak.";
		const options = this.options.creation ? [...CREATE_OPTIONS] : [...DECISION_OPTIONS, { label: viewToggle, description: viewDescription }];
		for (let i = 0; i < options.length; i++) {
			const option = options[i]!;
			const start = lines.length;
			const selected = i === this.optionIndex;
			const prefix = selected ? "> " : "  ";
			const label = `${i + 1}. ${option.label}`;
			for (const chunk of wrapTextWithAnsi(prefix + label, wrapWidth)) {
				addHit(lines.length, chunk, i === VIEW_TOGGLE_INDEX ? { kind: "view" } : { kind: "decision", index: i });
				lines.push(line(selected ? accent(chunk) : chunk));
			}
			if (selected) {
				for (const chunk of wrapTextWithAnsi(`     ${option.description}`, wrapWidth)) lines.push(line(dim(chunk)));
			}
			optionRanges[i] = [start, lines.length - 1];
		}
		lines.push(line(""));
		const action = this.optionIndex === 0 ? (this.options.creation ? "Create" : "Apply")
			: this.optionIndex === 1 ? "Refine" : this.optionIndex === 2 ? "Cancel" : this.view === "diff" ? "Full view" : "Diff view";
		const fullConfirmLabel = `[Confirm selection] ${action}`;
		const compactConfirmLabel = `[${action}]`;
		const symbol = this.optionIndex === 0 ? (this.options.creation ? "+" : "✓") : this.optionIndex === 1 ? "✎" : this.optionIndex === 2 ? "×" : "↔";
		const confirmLabel = visibleWidth(fullConfirmLabel) <= wrapWidth ? fullConfirmLabel : visibleWidth(compactConfirmLabel) <= wrapWidth ? compactConfirmLabel : symbol;
		addHit(lines.length, confirmLabel, { kind: "confirm" });
		lines.push(line(accent(confirmLabel)));
		const footer = `${this.controls.hint("confirm")} select · ${this.controls.navigationHint()} move · ${this.controls.pagingHint()} scroll · ${this.controls.hint("toggleAuditor")} auditor · ${this.controls.hint("cancel")} continue chatting`;
		for (const chunk of wrapTextWithAnsi(footer, wrapWidth)) lines.push(line(dim(chunk)));
		lines.push(accent(`└${rule}┘`));

		const maxDialogLines = this.dialogLines();
		const heightChanged = this.bodyHeights[this.view] !== maxDialogLines;
		this.bodyHeights[this.view] = maxDialogLines;
		let sourceRows: Array<number | undefined> = lines.map((_line, index) => index);
		const bodySlots = maxDialogLines - (lines.length - bodyRows.length);
		const wasFixed = this.fixedBodyByView[this.view];
		if (maxDialogLines > 0 && lines.length > maxDialogLines && bodySlots >= 1) {
			this.fixedBody = true;
			this.reanchorBody(bodyRows, wrapWidth, !wasFixed || heightChanged);
			const viewport = fitConfirmationBody(bodyRows.map((row) => row.text), bodySlots, this.scrollTopByView[this.view], (label) => line(dim(label)));
			this.scrollTopByView[this.view] = viewport.scrollTop;
			this.visiblePageSize = viewport.pageSize;
			this.maxBodyScroll = Math.max(0, bodyRows.length - viewport.pageSize);
			this.rememberBodyAnchor(bodyRows[viewport.scrollTop], viewport.scrollTop === 0);
			this.needsFollow = false;
			sourceRows = [...sourceRows.slice(0, bodyStart), ...viewport.lines.map(() => undefined), ...sourceRows.slice(bodyEnd)];
			lines = [...lines.slice(0, bodyStart), ...viewport.lines, ...lines.slice(bodyEnd)];
		} else if (maxDialogLines > 0 && lines.length > maxDialogLines) {
			// Tiny hosts cannot hold the action area and a body row: page the
			// entire dialog so no body or decision becomes unreachable.
			const bodyReflow = this.bodyWidths[this.view] !== wrapWidth || this.bodyVersions[this.view] !== this.contentVersion;
			if (!this.needsFollow && (wasFixed || (this.tinyBodyAnchored[this.view] && bodyReflow))) {
				// Fixed layouts may have clamped (or reset) their displayed offset.
				// Resolve the reading anchor even when width and content are unchanged.
				this.reanchorBody(bodyRows, wrapWidth, wasFixed);
				this.overflowTopByView[this.view] = bodyStart + this.scrollTopByView[this.view];
			}
			this.fixedBody = false;
			this.visiblePageSize = Math.max(1, maxDialogLines - 2);
			this.maxOverflowScroll = Math.max(0, lines.length - (maxDialogLines < 3 ? maxDialogLines : maxDialogLines - 1));
			const scroll: TweakScrollState = {
				scrollTop: this.overflowTopByView[this.view],
				needsFollow: this.needsFollow,
				optionRanges,
				followIndex: this.optionIndex,
			};
			lines = fitTweakViewport(lines, maxDialogLines, scroll, dim, this.controls.pagingHint());
			sourceRows = lines.map((_line, index) => {
				if (maxDialogLines < 3) return scroll.scrollTop + index;
				if (scroll.scrollTop === 0) return index < lines.length - 1 ? index : undefined;
				return index > 0 && index < lines.length - 1 ? scroll.scrollTop + index - 1 : undefined;
			});
			this.overflowTopByView[this.view] = scroll.scrollTop;
			this.tinyBodyAnchored[this.view] = scroll.scrollTop >= bodyStart && scroll.scrollTop < bodyEnd;
			if (scroll.scrollTop <= bodyStart) this.rememberBodyAnchor(bodyRows[0], true);
			else if (this.tinyBodyAnchored[this.view]) this.rememberBodyAnchor(bodyRows[scroll.scrollTop - bodyStart]);
			this.needsFollow = scroll.needsFollow;
		} else {
			this.fixedBody = true;
			this.visiblePageSize = Math.max(1, bodyRows.length);
			this.maxBodyScroll = 0;
			this.scrollTopByView[this.view] = 0;
			this.reanchorBody(bodyRows, wrapWidth);
			this.rememberBodyAnchor(bodyRows[0], true);
		}
		this.fixedBodyByView[this.view] = this.fixedBody;
		lines = this.clampWidths(lines, safeWidth);
		const hits: ConfirmationHit[] = [];
		for (const hit of sourceHits) {
			const y = sourceRows.indexOf(hit.y);
			if (y >= 0 && y < lines.length) hits.push({ ...hit, y });
		}
		this.lastDialogHeight = lines.length;
		this.publishMouse({ width: safeWidth, height: lines.length, hits });
		return lines;
	}

	/** Synchronize after native input too: several keys may arrive before Pi draws. */
	private syncEditorVisualLayout(): void {
		const previous = this.editorVisualLayout;
		if (!previous) return;
		const virtualWidth = Math.max(previous.virtualWidth, this.editor.minimumWidth());
		const rows = this.editor.render(virtualWidth);
		const view = reflowEditorRows(rows, previous.physicalWidth);
		this.editorVisualLayout = { mapping: view.mapping, virtualWidth, fullHeight: rows.length, physicalWidth: previous.physicalWidth };
		const row = view.lines.findIndex(value => value.includes("\u001b_pi:c\u0007"));
		const line = row >= 0 ? view.lines[row]! : "";
		this.editorVisualCursor = row >= 0 ? { row, col: visibleWidth(line.slice(0, line.indexOf("\u001b_pi:c\u0007"))) } : undefined;
	}

	private fitEditorLines(lines: string[], editorStart: number, editorHeight: number, editorWidth: number, safeWidth: number, contentStart: number, virtualWidth: number, mapping?: {row: number; col: number}[], nativeHeight = editorHeight): string[] {
		const maxDialogLines = this.dialogLines();
		let top = 0;
		if (maxDialogLines > 0 && lines.length > maxDialogLines) {
			// Keep Pi's native IME cursor visible even on a 1–2 row terminal.
			const marker = lines.findIndex((line) => line.includes("\u001b_pi:c\u0007"));
			const anchor = marker >= 0 ? marker : editorStart + Math.min(1, Math.max(0, editorHeight - 1));
			top = Math.max(0, Math.min(anchor - Math.floor((maxDialogLines - 1) / 2), lines.length - maxDialogLines));
			lines = lines.slice(top, top + maxDialogLines);
		}
		lines = this.clampWidths(lines, safeWidth);
		const first = Math.max(editorStart, top);
		const end = Math.min(editorStart + editorHeight, top + lines.length);
		const editor = first < end && editorWidth > 0
			? { x: contentStart, y: first - top, width: editorWidth, height: end - first, offsetY: first - editorStart, fullHeight: nativeHeight, virtualWidth, mapping }
			: undefined;
		this.lastDialogHeight = lines.length;
		this.publishMouse({ width: safeWidth, height: lines.length, hits: [] }, editor);
		return lines;
	}

	private clampWidths(lines: string[], safeWidth: number): string[] {
		for (let i = 0; i < lines.length; i++) {
			const current = lines[i]!;
			if (visibleWidth(current) > safeWidth) lines[i] = truncateToWidth(current, safeWidth);
		}
		return lines;
	}
}

function isTweakProposalDialogResult(value: unknown): value is TweakProposalDialogResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Record<string, unknown>;
	return (result.decision === "confirm" || result.decision === "continue" || result.decision === "cancel")
		&& typeof result.auditorEnabled === "boolean" && typeof result.unavailable === "boolean"
		&& (result.feedback === undefined || typeof result.feedback === "string");
}

function unavailableResult(options: TweakProposalDialogOptions): TweakProposalDialogResult {
	return { decision: "continue", auditorEnabled: options.defaultAuditorEnabled, unavailable: true };
}

/**
 * Basic-host confirmation loop. It carries the exact same proposal text,
 * auditor choice, and decision semantics as the rich component, but uses one
 * native select per step and the existing input dialog for feedback. Viewing a
 * read-only presentation is an option, never an answer.
 */
export async function runBasicTweakDialog(ctx: ExtensionContext, options: TweakProposalDialogOptions): Promise<TweakProposalDialogResult> {
	if (typeof ctx.ui.select !== "function") return unavailableResult(options);
	let auditorEnabled = options.defaultAuditorEnabled;
	let view: TweakProposalView = "diff";
	let views = options.presentation(auditorEnabled);
	for (;;) {
		const viewToggle = view === "diff" ? DIFF_VIEW_TOGGLE : FULL_VIEW_TOGGLE;
		const auditorToggle = `Toggle completion auditor (currently ${auditorEnabled ? "enabled" : "disabled"})`;
		const choices = [DECISION_OPTIONS[0].label, DECISION_OPTIONS[1].label, DECISION_OPTIONS[2].label, viewToggle, auditorToggle];
		const semanticDiff = views.diffEntries?.map((entry) => entry.kind === "line"
			? `${entry.lineKind === "add" ? "+" : entry.lineKind === "remove" ? "-" : " "} ${entry.content}`
			: entry.content).join("\n");
		const presentation = view === "diff" ? (semanticDiff ?? views.diffText) : (views.fullUiText ?? views.fullText);
		const reasonBlock = options.reason ? ["调整原因：", sanitizeProposalText(options.reason).trim(), ""] : [];
		const prompt = [
			DIALOG_TITLE,
			"",
			view === "diff" ? DIFF_VIEW_LABEL : FULL_VIEW_LABEL,
			"",
			...reasonBlock,
			sanitizeProposalText(presentation).trim() || "(no content provided)",
			"",
			`Auditor: ${auditorEnabled ? "enabled" : "disabled"}`,
		].join("\n");
		const picked = await ctx.ui.select(prompt, choices, { signal: options.signal });
		if (options.signal?.aborted) throw new Error("Goal proposal aborted");
		if (picked === undefined) {
			// Dismissing the native dialog is the same escape path as the rich
			// component: continue refining, never an implicit approval.
			return { decision: "continue", auditorEnabled, unavailable: false };
		}
		if (!choices.includes(picked)) throw new Error("The host returned an unknown tweak confirmation choice");
		if (picked === viewToggle) {
			view = view === "diff" ? "full" : "diff";
			continue;
		}
		if (picked === auditorToggle) {
			auditorEnabled = !auditorEnabled;
			views = options.presentation(auditorEnabled);
			continue;
		}
		if (picked === DECISION_OPTIONS[0].label) return { decision: "confirm", auditorEnabled, unavailable: false };
		if (picked === DECISION_OPTIONS[2].label) return { decision: "cancel", auditorEnabled, unavailable: false };
		let feedback: string | undefined;
		if (typeof ctx.ui.input === "function") {
			const typed = await ctx.ui.input(`${prompt}\n\nContinue chatting — type the adjustment you want (optional):`, "Adjustment (optional)", { signal: options.signal });
			if (options.signal?.aborted) throw new Error("Goal proposal aborted");
			const trimmed = typed?.trim();
			feedback = trimmed ? trimmed : undefined;
		} else if (typeof ctx.ui.notify === "function") {
			ctx.ui.notify("This host cannot collect refinement feedback; continuing without text.", "warning");
		}
		return { decision: "continue", auditorEnabled, unavailable: false, ...(feedback ? { feedback } : {}) };
	}
}

/** Rich creation confirmation only; an unavailable host falls back to the original questionnaire. */
export async function showCreateProposalDialog(
	ctx: ExtensionContext,
	confirmationText: string,
	title: string,
	defaultAuditorEnabled: boolean | undefined,
): Promise<TweakProposalDialogResult | undefined> {
	if (!ctx.hasUI || typeof ctx.ui.custom !== "function") return undefined;
	const options: InternalProposalOptions = {
		defaultAuditorEnabled: defaultAuditorEnabled ?? true,
		creation: { title, auditorVisible: defaultAuditorEnabled !== undefined },
		presentation: () => ({ diffText: confirmationText, fullText: confirmationText }),
	};
	const show = () => ctx.ui.custom<TweakProposalDialogResult | undefined>((tui, theme, _keykeybindings, done) => {
		if (!tui || typeof tui.getShowHardwareCursor !== "function" || typeof tui.setShowHardwareCursor !== "function" || typeof tui.requestRender !== "function") {
			done(undefined);
			return { render: () => [], invalidate: () => {} };
		}
		return new TweakProposalDialog(ctx, tui, theme, (result) => done(result), options);
	});
	return ctx.mode === "rpc" ? show().catch(() => undefined) : show();
}

/**
 * Confirm an existing-goal tweak through the adjustment-specific review UI.
 *
 * The caller owns the effective candidate and builds both read-only views
 * through `presentation`; this module owns only presentation and the
 * confirm/continue/cancel decision (the same decision semantics as
 * `showProposalDialog`). It never consults auto-confirm policy and never
 * approves a host that cannot present the dialog.
 */
export async function showTweakProposalDialog(
	ctx: ExtensionContext,
	options: TweakProposalDialogOptions,
): Promise<TweakProposalDialogResult> {
	if (options.signal?.aborted) throw new Error("Goal proposal aborted");
	if (!ctx.hasUI) return unavailableResult(options);
	if (typeof ctx.ui.custom === "function") {
		let result: TweakProposalDialogResult | undefined;
		let close: (() => void) | undefined;
		const abort = () => close?.();
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			result = await ctx.ui.custom<TweakProposalDialogResult | undefined>((tui, theme, _keybindings, done) => {
				close = () => done(undefined);
				if (options.signal?.aborted) { close(); return { render: () => [], invalidate: () => {} }; }
				// Some web hosts invoke the factory with a render callback in place of
				// a TUI. Bail out through done(undefined) so the caller can use the
				// native select fallback instead of silently approving.
				if (!tui || typeof tui.getShowHardwareCursor !== "function" || typeof tui.setShowHardwareCursor !== "function" || typeof tui.requestRender !== "function") {
					done(undefined);
					return { render: () => [], invalidate: () => {} };
				}
				return new TweakProposalDialog(ctx, tui, theme, done, options);
			});
		} catch (error) {
			if (options.signal?.aborted) throw new Error("Goal proposal aborted");
			// A host that advertises custom rendering but fails while building it is
			// not a confirmation. Fall through to the basic loop; never approve.
			if (typeof ctx.ui.notify === "function") {
				ctx.ui.notify(`The tweak review dialog could not be rendered by this host (${error instanceof Error ? error.message : String(error)}); falling back to basic dialogs.`, "warning");
			}
			result = undefined;
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
		if (options.signal?.aborted) throw new Error("Goal proposal aborted");
		if (result !== undefined && result !== null) {
			if (options.reason && !isTweakProposalDialogResult(result)) throw new Error("The host returned an invalid tweak confirmation response");
			return result;
		}
	}
	return runBasicTweakDialog(ctx, options);
}
