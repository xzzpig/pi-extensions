/**
 * Composed-request size breakdown (PR D).
 *
 * Measures every component of the model-facing request — including the tool
 * schemas and historical checkpoint payload that B4 never saw.
 */

import { countSemanticOccurrences, currentTaskNeedle } from "./semantic-invariants.mjs";

/**
 * Serialize one captured request to the exact text whose size we report.
 */
export function serializeRequest(captured) {
	const system = `${captured.baseSystem}${captured.extensionSystem ?? ""}`;
	const messages = (captured.messages ?? [])
		.map((m) => {
			if (typeof m.content === "string") return m.content;
			if (Array.isArray(m.content)) return m.content.map((part) => part.text ?? "").join("");
			return JSON.stringify(m.content ?? "");
		})
		.join("\n");
	const tools = (captured.tools ?? [])
		.map((t) => `${t.name}\n${t.description}\n${JSON.stringify(t.schema ?? {})}`)
		.join("\n");
	return { system, messages, tools, total: `${system}\n${messages}\n${tools}` };
}

/**
 * Compute ContextSizeBreakdown for one captured request.
 */
export function measureContext(captured) {
	const goal = captured.goal;
	const serialized = serializeRequest(captured);

	let checkpointChars = 0;
	let historicalCheckpointChars = 0;
	let messageChars = 0;
	for (const message of captured.messages ?? []) {
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((p) => p.text ?? "").join("")
				: "";
		messageChars += text.length + 8; // role framing overhead estimate
		if (message.role === "custom" && message.customType === "pi-goal-event") {
			checkpointChars += text.length;
			// Historical = any pi-goal-event beyond the LAST one in the list.
		}
	}
	// Historical checkpoints: every event message except the last one.
	const eventIndexes = [];
	(captured.messages ?? []).forEach((m, i) => {
		if (m.role === "custom" && m.customType === "pi-goal-event") eventIndexes.push(i);
	});
	for (let k = 0; k < eventIndexes.length - 1; k += 1) {
		const m = captured.messages[eventIndexes[k]];
		historicalCheckpointChars += typeof m.content === "string" ? m.content.length : 0;
	}
	void checkpointChars;

	const baseSystemChars = captured.baseSystem.length;
	const extensionSystemChars = (captured.extensionSystem ?? "").length;
	// Goal state = the extension's injected system block only.
	const goalStateChars = extensionSystemChars;
	const toolSchemaChars = serialized.tools.length;

	return {
		baseSystemChars,
		extensionSystemChars,
		goalStateChars,
		checkpointChars: checkpointTotal(captured),
		historicalCheckpointChars,
		toolSchemaChars,
		messageChars,
		totalSerializedChars: serialized.total.length,
		estimatedTokens: Math.ceil(serialized.total.length / 4),
	};
}

function checkpointTotal(captured) {
	let sum = 0;
	for (const m of captured.messages ?? []) {
		if (m.role === "custom" && m.customType === "pi-goal-event" && typeof m.content === "string") sum += m.content.length;
	}
	return sum;
}

/** Semantic counts for one captured request. Pass `goal` for exact needles. */
export function semanticCounts(captured) {
	const serialized = serializeRequest(captured);
	return countSemanticOccurrences(serialized.total, {
		objective: captured.goal?.objective,
		verificationContract: captured.goal?.verificationContract,
		currentTaskLine: currentTaskNeedle(captured.goal),
	});
}
