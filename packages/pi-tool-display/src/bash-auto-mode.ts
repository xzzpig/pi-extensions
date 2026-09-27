import type { ToolDisplayConfig } from "./types.js";

/**
 * Fork-only bash output mode: `auto` streams a live tail preview while a
 * command is running and collapses to the summary line count once it
 * finishes successfully.
 *
 * Implemented as a config normalizer so the upstream mode dispatch in
 * `renderBashDisplayResult` needs no further seams: while running (or on
 * error) `auto` resolves to `opencode` with a forced `tail` live preview,
 * and after a successful completion it resolves to `summary`. Run it before
 * the partial/error branches consume the config.
 */
export function resolveBashAutoOutputMode(
	config: ToolDisplayConfig,
	options: { isPartial: boolean },
	isError: boolean,
): ToolDisplayConfig {
	if (config.bashOutputMode !== "auto") {
		return config;
	}
	return {
		...config,
		bashOutputMode: options.isPartial || isError ? "opencode" : "summary",
		bashLivePreviewMode: "tail",
	};
}
