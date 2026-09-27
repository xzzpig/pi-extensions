import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolDisplayConfig } from "./types.js";

/**
 * Fork-only helper for the `bashCommandDisplay` option.
 *
 * `bashCommandDisplay` controls the bash tool-call command line:
 * - `full` (default): upstream behavior, the command is rendered verbatim.
 * - `collapsed`: the command is folded onto one line and clamped to the
 *   terminal width; expanding the tool row still shows the full command.
 * - `auto`: same as `full` while the command is still running
 *   (`executionStarted && isPartial`) and same as `collapsed` afterwards.
 *
 * Only the command line (`renderCall`) is affected; command output rendering
 * is untouched. Collapsing never changes the executed command.
 */

/** Width used when neither the render width nor `process.stdout.columns` is usable. */
export const BASH_COMMAND_FALLBACK_WIDTH = 120;

/** Ellipsis appended by the ANSI-aware truncation when the line overflows. */
export const BASH_COMMAND_ELLIPSIS = "…";

interface BashCommandDisplayState {
	expanded?: boolean;
	executionStarted?: boolean;
	isPartial?: boolean;
}

interface BashCommandArgsLike {
	command?: string;
	commandPrefix?: string;
	shellPath?: string;
	timeout?: number;
}

/**
 * Width the command line may occupy: the width the component is actually
 * rendered at, then `process.stdout.columns`, then the documented fallback
 * constant for non-TTY environments.
 */
export function resolveBashCommandDisplayWidth(renderWidth?: number): number {
	if (typeof renderWidth === "number" && Number.isFinite(renderWidth) && renderWidth > 0) {
		return Math.floor(renderWidth);
	}
	const columns = process.stdout.columns;
	return typeof columns === "number" && Number.isFinite(columns) && columns > 0
		? Math.floor(columns)
		: BASH_COMMAND_FALLBACK_WIDTH;
}

/**
 * Whether the command should be collapsed for this render. Expanding the tool
 * row always wins, so `full`, `collapsed`, and `auto` all reveal the original
 * multi-line command once the row is expanded.
 */
export function shouldCollapseBashCommand(
	config: Pick<ToolDisplayConfig, "bashCommandDisplay"> | undefined,
	state: BashCommandDisplayState,
): boolean {
	if (!config || config.bashCommandDisplay === "full" || state.expanded) {
		return false;
	}
	if (config.bashCommandDisplay === "collapsed") {
		return true;
	}
	return !(state.executionStarted && state.isPartial);
}

/**
 * Fold a possibly multi-line command onto one display line: line breaks and
 * the whitespace around them become single spaces, tabs become spaces, and the
 * ends are trimmed. Quotes, separators, and single spaces inside the command
 * are preserved, so the folded text stays recognizable.
 */
export function foldBashCommandToSingleLine(command: string): string {
	return command
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]*\n[ \t]*/g, " ")
		.replace(/\t/g, " ")
		.trim();
}

/** ANSI-aware clamp of a rendered line to `width`, using `…` when it overflows. */
export function clampBashCommandLineToWidth(text: string, width: number): string {
	if (!Number.isFinite(width) || width <= 0) {
		return text;
	}
	const safeWidth = Math.floor(width);
	if (visibleWidth(text) <= safeWidth) {
		return text;
	}
	return truncateToWidth(text, safeWidth, BASH_COMMAND_ELLIPSIS);
}

/**
 * Pre-process bash call args before the upstream renderer builds the line: the
 * command is folded in place when this render should be collapsed, so every
 * upstream code path (including the running spinner) picks it up unchanged.
 */
export function resolveBashCommandDisplayArgs<T extends BashCommandArgsLike>(
	args: T,
	config: Pick<ToolDisplayConfig, "bashCommandDisplay"> | undefined,
	state: BashCommandDisplayState,
): T {
	if (!shouldCollapseBashCommand(config, state) || typeof args.command !== "string") {
		return args;
	}
	return { ...args, command: foldBashCommandToSingleLine(args.command) };
}

/**
 * `Text` subclass that clamps the command line to the width the component is
 * actually rendered at, which is narrower than the terminal (message box
 * borders and padding). It stays a `Text` so upstream's `lastComponent`
 * reuse check and the running spinner keep working unchanged.
 */
export class BashCommandLineText extends Text {
	private collapse = false;
	private rawLine = "";
	private appliedLine?: string;

	setCollapse(enabled: boolean): void {
		this.collapse = enabled;
	}

	override setText(text: string): void {
		this.rawLine = text;
		this.appliedLine = undefined;
		super.setText(text);
	}

	override render(width: number): string[] {
		const target = this.collapse
			? clampBashCommandLineToWidth(this.rawLine, resolveBashCommandDisplayWidth(width))
			: this.rawLine;
		if (target !== this.appliedLine) {
			this.appliedLine = target;
			super.setText(target);
		}
		return super.render(width);
	}
}
