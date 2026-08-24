/**
 * Composed-request capture (PR D). Drives the REAL extension handlers over a
 * fixture and returns the complete model-facing request parts:
 *
 *   baseSystem       — the host system prompt before extension injection
 *   extensionSystem  — what before_agent_start appends
 *   messages         — the provider message list AFTER the context hook
 *   tools            — registered goal tools (name + description + schema)
 *
 * Pure in-process function calls over fixture data: no network, no child
 * agent, no live model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import piGoalExtension from "../../extensions/goal.ts";
import { FIXTURES, userMessage, v2CheckpointMessage, assistantMessage } from "./fixtures.mjs";
import { serializeGoalFile } from "../../extensions/storage/goal-files.ts";
import { GOAL_LEDGER_FILE } from "../../extensions/goal-ledger.ts";

const BASE_SYSTEM = "You are a helpful coding agent running inside pi.";
const CAPTURE_CWD = "/tmp/goal-context-capture";

function createCapture() {
	const handlers = new Map();
	const tools = [];

	const mockPi = {
		registerTool: (def) => tools.push(def),
		registerCommand: () => {},
		on: (event, handler) => {
			handlers.set(event, async (eventArg, ctxArg) => handler(eventArg, ctxArg));
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write", ...tools.map((t) => t.name)],
		setActiveTools: () => {},
	};

	const ctx = {
		cwd: CAPTURE_CWD,
		hasUI: false,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => CAPTURE_CWD,
			getSessionId: () => "capture",
			getRoot: () => CAPTURE_CWD,
			append: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "capture", model: null, thinkingLevel: "medium" }),
			getSessionFile: () => undefined,
		},
		getSystemPrompt: () => BASE_SYSTEM,
		isIdle: () => true,
		hasPendingMessages: () => false,
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: () => {}, setStatus: () => {}, setWidget: () => {},
			select: async () => undefined, input: async () => undefined, confirm: async () => false,
		},
	};

	piGoalExtension(mockPi);

	async function startSession(entries) {
		const sessionManager = { ...ctx.sessionManager, getBranch: () => entries };
		await handlers.get("session_start")({ reason: "start" }, { ...ctx, sessionManager });
	}

	async function runTurn(triggerPrompt) {
		return (await handlers.get("before_agent_start")(
			{ systemPrompt: BASE_SYSTEM, prompt: triggerPrompt, systemPromptOptions: {} },
			ctx,
		)) ?? {};
	}

	async function runContext(messages) {
		const event = { messages };
		const result = await handlers.get("context")(event, ctx);
		return result?.messages ?? event.messages;
	}

	return { tools, startSession, runTurn, runContext };
}

/** Materialize goal files, focus entry, and ledger events for a scenario. */
function materializeState(scenario) {
	fs.rmSync(CAPTURE_CWD, { recursive: true, force: true });
	fs.mkdirSync(path.join(CAPTURE_CWD, ".pi", "goals", "archived"), { recursive: true });

	const entries = [];
	const goals = scenario.goal ? [scenario.goal] : [];
	if (scenario.extraOpenGoals) goals.push(...scenario.extraOpenGoals);

	for (const goal of goals) {
		const relPath = `.pi/goals/active_goal_${goal.id}.md`;
		goal.activePath = relPath;
		fs.writeFileSync(path.join(CAPTURE_CWD, relPath), serializeGoalFile(goal), "utf8");
		entries.push({ type: "custom", customType: "pi-goal-state", data: { version: 3, goal } });
	}

	if (goals.length > 0) {
		const focusedGoalId = scenario.focusNull ? null : scenario.goal.id;
		entries.unshift({
			type: "custom",
			customType: "pi-goal-focus",
			data: { version: 1, focusedGoalId, reason: "created" },
		});
	}

	if (scenario.ledgerEvents?.length > 0) {
		const lines = scenario.ledgerEvents.map((e) => JSON.stringify(e)).join("\n");
		fs.writeFileSync(path.join(CAPTURE_CWD, GOAL_LEDGER_FILE), `${lines}\n`, "utf8");
	}
	return entries;
}

/** Deterministic default conversation for active-goal fixtures. */
function baseConversation(goal) {
	const messages = [userMessage("Begin working on the goal.")];
	for (let i = 1; i <= 3; i += 1) {
		messages.push(v2CheckpointMessage(goal.id, i));
		messages.push(assistantMessage(`Turn ${i} progress notes.`));
	}
	return messages;
}

/** Capture one fixture's composed request. */
export async function captureOne(fixtureId) {
	const build = FIXTURES[fixtureId];
	if (!build) throw new Error(`unknown fixture: ${fixtureId}`);
	const scenario = build();

	const capture = createCapture();
	const entries = materializeState(scenario);
	await capture.startSession(entries);
	const turn = await capture.runTurn(scenario.trigger ?? "continue");

	let raw = scenario.messages ?? (scenario.goal ? baseConversation(scenario.goal) : [userMessage("Hello")]);
	if (scenario.draftPrompt) raw = [...raw, userMessage(scenario.draftPrompt)];
	const messages = await capture.runContext(raw);

	return {
		fixture: fixtureId,
		baseSystem: BASE_SYSTEM,
		extensionSystem: typeof turn.systemPrompt === "string" && turn.systemPrompt.startsWith(BASE_SYSTEM)
			? turn.systemPrompt.slice(BASE_SYSTEM.length)
			: (turn.systemPrompt ?? ""),
		messages,
		tools: capture.tools.map((t) => ({
			name: t.name,
			description: t.description ?? "",
			schema: t.parameters ?? t.schema ?? null,
		})),
	};
}

export { BASE_SYSTEM };
