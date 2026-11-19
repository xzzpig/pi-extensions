/** Adapt legacy final-confirmation fixtures to the shared rich decision API. */
export function tweakFixtureAnswer(result: unknown, entries: unknown[]): unknown {
	const latest = entries.findLast((entry) => (entry as { customType?: string }).customType === "pi-goal-draft") as { data?: { mode?: string; auditorEnabled?: boolean } } | undefined;
	const answer = result as { answers?: Array<{ id?: string; answer: string; wasCustom?: boolean }>; cancelled?: boolean; auditorEnabled?: boolean };
	if (!Array.isArray(answer?.answers)) return result;
	const first = answer.answers[0];
	if (latest?.data?.mode !== "tweak" && first?.id !== "confirm") return result;
	return { decision: answer.cancelled ? "continue" : first?.wasCustom ? "continue" : first?.answer.startsWith("Confirm") ? "confirm" : first?.answer.startsWith("Cancel") ? "cancel" : "continue",
		auditorEnabled: answer.auditorEnabled ?? latest?.data?.auditorEnabled ?? true, unavailable: false,
		...(first?.wasCustom && first.answer.trim() ? { feedback: first.answer.trim() } : {}) };
}
