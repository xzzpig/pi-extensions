/** Keep upstream's request prefix stable when an opt-in-only counter disappears. */
const CONTEXT_DISPLAY_OFF = "Context usage display is off.";

export function contextSwitchCounters(
	state: string,
	counters: string | undefined,
	contextEnabled: boolean,
	retained: readonly string[] | undefined,
): string | undefined {
	if (contextEnabled || counters !== undefined || !retained?.length || retained[0] !== state) return counters;
	const last = retained.at(-1);
	// Only replace a context-only counter, not one containing a budget or run
	// limit: removing real constraints must still invalidate the old tails.
	if (last === CONTEXT_DISPLAY_OFF || (last?.startsWith("Context snapshot: ") && !last.includes("\n"))) return CONTEXT_DISPLAY_OFF;
	return counters;
}
