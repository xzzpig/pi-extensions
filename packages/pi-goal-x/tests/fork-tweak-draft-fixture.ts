/** Adapt the legacy questionnaire fixture to the adjustment-only decision API. */
export function tweakFixtureAnswer(result: unknown, entries: unknown[]): unknown {
	const latest = entries.findLast((entry) => (entry as { customType?: string }).customType === "pi-goal-draft") as { data?: { mode?: string; auditorEnabled?: boolean } } | undefined;
	if (latest?.data?.mode !== "tweak") return result;
	const answer = result as { answers?: Array<{ answer: string; wasCustom?: boolean }>; cancelled?: boolean; auditorEnabled?: boolean };
	if (!Array.isArray(answer?.answers)) return result;
	const first = answer.answers[0];
	return { decision: answer.cancelled ? "continue" : first?.wasCustom ? "continue" : first?.answer.startsWith("Confirm") ? "confirm" : first?.answer.startsWith("Cancel") ? "cancel" : "continue",
		auditorEnabled: answer.auditorEnabled ?? latest.data.auditorEnabled ?? true, unavailable: false,
		...(first?.wasCustom && first.answer.trim() ? { feedback: first.answer.trim() } : {}) };
}
