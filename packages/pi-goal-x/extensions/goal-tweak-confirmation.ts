import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, visibleWidth, wrapTextWithAnsi, type Component, type EditorTheme, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { goalDialogControls } from "./goal-dialog-controls.ts";
import { computeDialogLineLimit, fitDialogLines } from "./goal-questionnaire.ts";
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
	if (maxDialogLines < 3) return lines.slice(0, maxDialogLines);
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
	private readonly options: TweakProposalDialogOptions;
	private readonly done: (result: TweakProposalDialogResult) => void;
	private readonly controls: ReturnType<typeof goalDialogControls>;
	private readonly editor: Editor;
	private readonly wasHardwareCursorShown: boolean;

	private auditorEnabled: boolean;
	private views: TweakProposalViews;
	private view: TweakProposalView = "diff";
	private optionIndex = 0;
	private inputMode = false;
	private feedbackDraft = "";
	private dialogFocused = false;
	private readonly scrollTopByView: Record<TweakProposalView, number> = { diff: 0, full: 0 };
	private needsFollow = false;
	private finished = false;
	private restored = false;

	constructor(
		ctx: ExtensionContext,
		tui: TUI,
		theme: Theme,
		done: (result: TweakProposalDialogResult) => void,
		options: TweakProposalDialogOptions,
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
		this.editor = new Editor(tui, editorTheme);
		this.wasHardwareCursorShown = tui.getShowHardwareCursor();
		tui.setShowHardwareCursor(false);
		ctx.ui.setWorkingVisible(false);
		this.editor.onSubmit = (value) => {
			if (!this.inputMode) return;
			this.feedbackDraft = value;
			this.finish("continue", value);
		};
	}

	dispose(): void {
		this.restore();
	}

	invalidate(): void {
		// The dialog renders from live state on every pass; there is no cached
		// output to drop. A resize or theme change is therefore picked up as-is.
	}

	get focused(): boolean {
		return this.dialogFocused;
	}

	set focused(value: boolean) {
		this.dialogFocused = value;
		this.editor.focused = value && this.inputMode;
		this.tui.setShowHardwareCursor(value && this.inputMode);
	}

	private restore(): void {
		if (this.restored) return;
		this.restored = true;
		this.tui.setShowHardwareCursor(this.wasHardwareCursorShown);
		this.ctx.ui.setWorkingVisible(true);
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private finish(decision: TweakProposalDecision, feedback?: string): void {
		if (this.finished) return;
		this.finished = true;
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
		this.feedbackDraft = this.editor.getText();
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
				this.view = this.view === "diff" ? "full" : "diff";
				// The view toggle keeps both independent scroll positions exactly
				// where the user left them; it never resolves the dialog.
				this.needsFollow = false;
				break;
			default:
				return;
		}
		this.refresh();
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (this.inputMode) {
			if (this.controls.cancelEditing(data)) {
				// Esc leaves the editor with the draft intact instead of deciding;
				// Esc on the decision list means "continue chatting" (never cancel).
				this.leaveFeedbackEditor();
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "pageUp")) {
			this.scrollTopByView[this.view] -= this.pageSize();
			this.needsFollow = false;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "pageDown")) {
			this.scrollTopByView[this.view] += this.pageSize();
			this.needsFollow = false;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "scrollUp")) {
			this.scrollTopByView[this.view] -= 1;
			this.needsFollow = false;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "scrollDown")) {
			this.scrollTopByView[this.view] += 1;
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
			this.optionIndex = Math.min(VIEW_TOGGLE_INDEX, this.optionIndex + 1);
			this.needsFollow = true;
			this.refresh();
			return;
		}
		if (this.controls.matches(data, "toggleAuditor")) {
			this.auditorEnabled = !this.auditorEnabled;
			this.views = this.options.presentation(this.auditorEnabled);
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
		return computeDialogLineLimit({ terminalRows: tuiInfo.terminal?.rows, baseFrameLines: tuiInfo.previousLines?.length }) ?? 0;
	}

	private pageSize(): number {
		// Two rows are reserved for the top indicator and the bottom edge.
		return Math.max(1, this.dialogLines() - 2);
	}

	private renderViewBody(innerWidth: number, body: string): string[] {
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const success = (s: string) => this.theme.fg("success", s);
		const error = (s: string) => this.theme.fg("error", s);
		const line = (content: string) => borderedLine(accent, innerWidth, truncateToWidth(` ${content}`, innerWidth, "…"));
		const wrapWidth = Math.max(1, innerWidth - 1);
		const lines: string[] = [];
		const rawLines = sanitizeProposalText(body).split("\n");
		if (rawLines.length === 1 && rawLines[0] === "") {
			lines.push(line(dim("(no content provided)")));
			return lines;
		}
		for (const rawLine of rawLines) {
			const chunks = rawLine.length === 0 ? [""] : wrapTextWithAnsi(rawLine, wrapWidth);
			const kind = lineStyle(rawLine);
			for (const chunk of chunks) {
				lines.push(line(kind === "added" ? success(chunk) : kind === "removed" ? error(chunk) : kind === "meta" ? dim(chunk) : muted(chunk)));
			}
		}
		return lines;
	}

	render(width: number): string[] {
		const theme = this.theme;
		// Honor even a very narrow terminal: every rendered line is bounded by the
		// supplied width, and content wraps instead of being cut off.
		const safeWidth = Math.max(1, width);
		const termWidth = Math.max(3, Math.min(safeWidth, 80));
		const innerWidth = Math.max(1, dialogInnerWidth(termWidth));
		const accent = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);
		const muted = (s: string) => theme.fg("muted", s);
		const success = (s: string) => theme.fg("success", s);
		const warning = (s: string) => theme.fg("warning", s);
		const rule = horizontalRule(innerWidth);
		const line = (content: string) => borderedLine(accent, innerWidth, truncateToWidth(` ${content}`, innerWidth, "…"));
		const wrapWidth = Math.max(1, innerWidth - 1);
		const pushWrapped = (styled: string) => {
			for (const chunk of wrapTextWithAnsi(styled, wrapWidth)) lines.push(line(chunk));
		};

		let lines: string[] = [];
		lines.push(accent(`┌${rule}┐`));
		lines.push(line(theme.bold(DIALOG_TITLE)));
		lines.push(accent(`├${rule}┤`));

		if (this.inputMode) {
			pushWrapped(theme.bold("Continue chatting — refinement feedback"));
			pushWrapped(muted("Type the adjustment you want the agent to make."));
			lines.push(line(""));
			pushWrapped(dim("Feedback (optional — empty continues without text):"));
			const editorLines = this.editor.render(Math.max(1, innerWidth - 2));
			for (const editorLine of editorLines) lines.push(line(editorLine));
			lines.push(line(""));
			const editorHint = `Enter continues · ${this.controls.editorCancelHint()} back to decisions`;
			for (const chunk of wrapTextWithAnsi(editorHint, wrapWidth)) lines.push(line(dim(chunk)));
			lines.push(accent(`└${rule}┘`));
			return this.fitRenderedLines(lines, 0, safeWidth);
		}

		pushWrapped(theme.bold(this.view === "diff" ? DIFF_VIEW_LABEL : FULL_VIEW_LABEL));
		pushWrapped(muted(this.view === "diff"
			? "Only changed content is shown; unchanged stretches are omitted."
			: "Complete content after this tweak is applied."));
		lines.push(accent(`├${rule}┤`));
		for (const bodyLine of this.renderViewBody(innerWidth, this.view === "diff" ? this.views.diffText : this.views.fullText)) lines.push(bodyLine);
		lines.push(accent(`├${rule}┤`));
		const auditorLabel = this.auditorEnabled ? "● Auditor enabled" : "○ Auditor disabled";
		lines.push(line((this.auditorEnabled ? success(auditorLabel) : warning(auditorLabel)) + dim(`  (press '${this.controls.hint("toggleAuditor")}' to toggle)`)));
		lines.push(line(""));

		const optionRanges: Array<[number, number]> = [];
		const viewToggle = this.view === "diff" ? DIFF_VIEW_TOGGLE : FULL_VIEW_TOGGLE;
		const viewDescription = "Read-only preview of the complete content; switching never applies or discards this tweak.";
		const options = [...DECISION_OPTIONS, { label: viewToggle, description: viewDescription }];
		for (let i = 0; i < options.length; i++) {
			const option = options[i]!;
			const start = lines.length;
			const selected = i === this.optionIndex;
			const prefix = selected ? "> " : "  ";
			const label = `${i + 1}. ${option.label}`;
			for (const chunk of wrapTextWithAnsi(prefix + label, wrapWidth)) {
				lines.push(line(selected ? accent(chunk) : chunk));
			}
			if (selected) {
				for (const chunk of wrapTextWithAnsi(`     ${option.description}`, wrapWidth)) lines.push(line(dim(chunk)));
			}
			optionRanges[i] = [start, lines.length - 1];
		}
		lines.push(line(""));
		const footer = `${this.controls.hint("confirm")} select · ${this.controls.navigationHint()} move · ${this.controls.pagingHint()} scroll · ${this.controls.hint("toggleAuditor")} auditor · ${this.controls.hint("cancel")} continue chatting`;
		for (const chunk of wrapTextWithAnsi(footer, wrapWidth)) lines.push(line(dim(chunk)));
		lines.push(accent(`└${rule}┘`));

		const maxDialogLines = this.dialogLines();
		if (maxDialogLines > 0 && lines.length > maxDialogLines) {
			const scroll: TweakScrollState = {
				scrollTop: this.scrollTopByView[this.view],
				needsFollow: this.needsFollow,
				optionRanges,
				followIndex: this.optionIndex,
			};
			lines = fitTweakViewport(lines, maxDialogLines, scroll, dim, this.controls.pagingHint());
			this.scrollTopByView[this.view] = scroll.scrollTop;
			this.needsFollow = scroll.needsFollow;
		}
		return this.clampWidths(lines, safeWidth);
	}

	private fitRenderedLines(lines: string[], protectedHead: number, safeWidth: number): string[] {
		const maxDialogLines = this.dialogLines();
		const fitted = maxDialogLines > 0 && lines.length > maxDialogLines
			? fitDialogLines(lines, maxDialogLines, protectedHead, null, null, (s) => this.theme.fg("dim", s), this.controls.pagingHint())
			: lines;
		return this.clampWidths(fitted, safeWidth);
	}

	private clampWidths(lines: string[], safeWidth: number): string[] {
		for (let i = 0; i < lines.length; i++) {
			const current = lines[i]!;
			if (visibleWidth(current) > safeWidth) lines[i] = truncateToWidth(current, safeWidth);
		}
		return lines;
	}
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
async function runBasicTweakDialog(ctx: ExtensionContext, options: TweakProposalDialogOptions): Promise<TweakProposalDialogResult> {
	if (typeof ctx.ui.select !== "function") return unavailableResult(options);
	let auditorEnabled = options.defaultAuditorEnabled;
	let view: TweakProposalView = "diff";
	let views = options.presentation(auditorEnabled);
	for (;;) {
		const viewToggle = view === "diff" ? DIFF_VIEW_TOGGLE : FULL_VIEW_TOGGLE;
		const auditorToggle = `Toggle completion auditor (currently ${auditorEnabled ? "enabled" : "disabled"})`;
		const choices = [DECISION_OPTIONS[0].label, DECISION_OPTIONS[1].label, DECISION_OPTIONS[2].label, viewToggle, auditorToggle];
		const presentation = view === "diff" ? views.diffText : views.fullText;
		const prompt = [
			DIALOG_TITLE,
			"",
			view === "diff" ? DIFF_VIEW_LABEL : FULL_VIEW_LABEL,
			sanitizeProposalText(presentation).trim() || "(no content provided)",
			"",
			`Auditor: ${auditorEnabled ? "enabled" : "disabled"}`,
		].join("\n");
		const picked = await ctx.ui.select(prompt, choices);
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
			const typed = await ctx.ui.input(`${prompt}\n\nContinue chatting — type the adjustment you want (optional):`, "Adjustment (optional)");
			const trimmed = typed?.trim();
			feedback = trimmed ? trimmed : undefined;
		} else if (typeof ctx.ui.notify === "function") {
			ctx.ui.notify("This host cannot collect refinement feedback; continuing without text.", "warning");
		}
		return { decision: "continue", auditorEnabled, unavailable: false, ...(feedback ? { feedback } : {}) };
	}
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
	if (!ctx.hasUI) return unavailableResult(options);
	if (typeof ctx.ui.custom === "function") {
		let result: TweakProposalDialogResult | undefined;
		try {
			result = await ctx.ui.custom<TweakProposalDialogResult | undefined>((tui, theme, _keybindings, done) => {
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
			// A host that advertises custom rendering but fails while building it is
			// not a confirmation. Fall through to the basic loop; never approve.
			if (typeof ctx.ui.notify === "function") {
				ctx.ui.notify(`The tweak review dialog could not be rendered by this host (${error instanceof Error ? error.message : String(error)}); falling back to basic dialogs.`, "warning");
			}
			result = undefined;
		}
		if (result !== undefined && result !== null) return result;
	}
	return runBasicTweakDialog(ctx, options);
}
