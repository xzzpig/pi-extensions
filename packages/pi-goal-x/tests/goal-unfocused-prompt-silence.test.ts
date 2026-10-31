/**
 * Fork-only contract tests for openspec change `silence-unfocused-goal-prompts`.
 *
 * An unfocused session must not receive other-goal guidance in its model input:
 * no `[PI GOAL UNFOCUSED]` request context and no hidden `pi-goal-steering-event`
 * message. The runtime boundaries (human-owned focus, stale-checkpoint
 * rejection, ordinary tool access) stay exactly as they were.
 *
 * These live in a fork-only file so an upstream sync cannot conflict with them.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache, loadGoalSettings, mutateSettingsLayer } from "../extensions/goal-settings.ts";

interface SentMessage {
	customType: string;
	content: string;
	triggerTurn: boolean;
}

interface HarnessOptions {
	cwd: string;
	sessionEntries: unknown[];
	hasUI?: boolean;
	idle?: boolean;
}

function createHarness(options: HarnessOptions) {
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const selectCalls: string[] = [];
	const sentMessages: SentMessage[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
	let abortCount = 0;
	let selectCount = 0;

	const pi = {
		registerTool: (definition: any) => { tools.set(definition.name, definition); },
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) => {
			commands.set(name, definition);
		},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { appendedEntries.push({ customType, data }); },
		registerMessageRenderer: () => {},
		sendMessage: (message: { customType: string; content: unknown }, sendOptions?: { triggerTurn?: boolean }) => {
			sentMessages.push({
				customType: String(message.customType ?? ""),
				content: String(message.content ?? ""),
				triggerTurn: sendOptions?.triggerTurn === true,
			});
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: options.hasUI ?? false,
	};

	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? false,
		sessionManager: {
			getBranch: () => options.sessionEntries,
			getCwd: () => options.cwd,
			getSessionId: () => "unfocused-silence-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async (_title: string, selectOptions: string[] = []) => { selectCount += 1; selectCalls.push(...selectOptions); return undefined; },
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => false,
		abort: () => { abortCount += 1; },
	} as unknown as ExtensionContext;

	goalExtension(pi as any, {});
	return {
		ctx,
		commands,
		handlers,
		tools,
		appendedEntries,
		statuses,
		notifications,
		sentMessages,
		selectCalls,
		steeringMessages: () => sentMessages.filter((message) => message.customType === "pi-goal-steering-event"),
		get abortCount() { return abortCount; },
		get selectCount() { return selectCount; },
	};
}

interface Fixture {
	cwd: string;
	goals: GoalRecord[];
	activePaths: string[];
	cleanup: () => void;
}

function createFixture(settings: Record<string, unknown>, goalCount = 1): Fixture {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-unfocused-silence-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify(settings));
	const goals: GoalRecord[] = [];
	const activePaths: string[] = [];
	for (let i = 0; i < goalCount; i++) {
		const goal = createGoal({
			objective: `=== Goal ===\nObjective: Keep shared goal ${i + 1} open`,
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 0, 1, 3, 4, 5 + i));
		const written = writeActiveGoalFile({ cwd } as ExtensionContext, goal);
		goals.push(written);
		activePaths.push(path.join(cwd, written.activePath!));
	}
	return {
		cwd,
		goals,
		activePaths,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

const UNFOCUSED_SETTINGS = { autoSelectSingleGoal: false, disabled: true };

const requestText = (result: unknown): string => JSON.stringify(result ?? null);
const hasReminder = (result: unknown): boolean => requestText(result).includes("PI GOAL UNFOCUSED");
const hasActiveContext = (result: unknown): boolean => requestText(result).includes("PI GOAL ACTIVE");

function focusEntryFor(goalId: string, reason: "created" | "selected" | "migrated" = "selected") {
	return { type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goalId, reason) };
}

function unfocusedEntry() {
	return { type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(null, "unfocused") };
}

/** Drive one ordinary user turn and return the request the host would send. */
async function ordinaryTurn(harness: ReturnType<typeof createHarness>, prompt: string) {
	await harness.handlers.get("before_agent_start")?.({ systemPrompt: "base prompt", prompt }, harness.ctx);
	return harness.handlers.get("context_with_system")?.({ messages: [] }, harness.ctx);
}

test("an unfocused session with no open goals stays completely silent", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 0);
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [] });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		for (const prompt of ["hello", "second request"]) {
			const result = await ordinaryTurn(harness, prompt);
			assert.equal(hasReminder(result), false, `${prompt} must not carry an unfocused reminder`);
		}
		assert.deepEqual(harness.steeringMessages(), []);
		assert.deepEqual(harness.sentMessages, [], "no goal message may be appended without a goal");
	} finally {
		fixture.cleanup();
	}
});

test("one open goal adds no reminder on load, repeated requests, or a tool loop", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 1);
	const originalGoalFile = readFileSync(fixture.activePaths[0]!);
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [], hasUI: true });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		assert.deepEqual(harness.steeringMessages(), [], "session load must not append an unfocused steering message");
		assert.equal(harness.sentMessages.length, 0, "session load must not append any goal message while unfocused");

		for (let i = 0; i < 3; i++) {
			const result = await ordinaryTurn(harness, `ordinary request ${i + 1}`);
			assert.equal(hasReminder(result), false, `request ${i + 1} must not carry the reminder`);
			assert.equal(hasActiveContext(result), false, `request ${i + 1} must not claim an active goal`);
		}

		// A tool loop must not re-introduce the reminder on the follow-up requests.
		const gate = await harness.handlers.get("tool_call")?.({ toolName: "read", input: { path: "README.md" } }, harness.ctx);
		assert.equal(gate?.block, undefined, "ordinary tools stay available while unfocused");
		const afterTool = await harness.handlers.get("context_with_system")?.({ messages: [] }, harness.ctx);
		assert.equal(hasReminder(afterTool), false, "the tool-loop request must stay silent");

		assert.deepEqual(harness.steeringMessages(), [], "no steering message may appear across the whole turn set");
		assert.ok(harness.sentMessages.every((message) => message.triggerTurn === false), "no goal message may trigger an extra model turn");
		assert.equal(harness.appendedEntries.filter((entry) => entry.customType === "pi-goal-focus").length, 0, "focus must not be written");
		assert.deepEqual(readFileSync(fixture.activePaths[0]!), originalGoalFile, "the goal file must stay byte-identical");
		assert.equal(existsSync(path.join(fixture.cwd, ".pi", "goals", "goal_events.jsonl")), false, "no shared ledger writes while unfocused");
		assert.equal(readdirSync(path.join(fixture.cwd, ".pi", "goals", "archived")).length, 0);

		// The UI keeps its own unfocused hint: only the model-facing reminder is retired.
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(
			harness.statuses.some((status) => /^goal: unfocused \[1 open\]/.test(status ?? "")),
			`expected the unfocused status hint, saw ${JSON.stringify(harness.statuses)}`,
		);
	} finally {
		fixture.cleanup();
	}
});

test("multiple open goals stay silent and never pick a focus", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 3);
	const originals = fixture.activePaths.map((activePath) => readFileSync(activePath));
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [], hasUI: true });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		const result = await ordinaryTurn(harness, "which goals exist?");
		assert.equal(hasReminder(result), false, "multiple open goals must not be announced to the model");
		assert.equal(hasActiveContext(result), false, "no goal may be selected automatically");
		assert.equal(harness.selectCount, 0, "startup must not prompt for a focus choice");
		assert.deepEqual(harness.steeringMessages(), []);
		assert.equal(harness.appendedEntries.filter((entry) => entry.customType === "pi-goal-focus").length, 0);
		fixture.activePaths.forEach((activePath, index) => {
			assert.deepEqual(readFileSync(activePath), originals[index], `goal ${index + 1} must stay byte-identical`);
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(
			harness.statuses.some((status) => /^goal: unfocused \[3 open\]/.test(status ?? "")),
			`expected the multi-goal status hint, saw ${JSON.stringify(harness.statuses)}`,
		);
	} finally {
		fixture.cleanup();
	}
});

test("focus to unfocus to focus cycles never emit a reminder", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 1);
	const sessionEntries: unknown[] = [focusEntryFor(fixture.goals[0]!.id)];
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries, hasUI: true });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		const focused = await ordinaryTurn(harness, "focused request");
		assert.equal(hasActiveContext(focused), true, "a focused goal must still deliver its active context");
		assert.equal(hasReminder(focused), false);

		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		const unfocused = await ordinaryTurn(harness, "unfocused request");
		assert.equal(hasReminder(unfocused), false, "unfocus must not add a reminder");
		assert.equal(hasActiveContext(unfocused), false, "unfocus must drop the active context");
		assert.deepEqual(harness.steeringMessages(), []);

		sessionEntries.splice(0, sessionEntries.length, unfocusedEntry());
		await harness.handlers.get("session_tree")?.({ newLeafId: "unfocused-branch", oldLeafId: "focused-branch" }, harness.ctx);
		const stillUnfocused = await ordinaryTurn(harness, "tree switch to unfocused");
		assert.equal(hasReminder(stillUnfocused), false, "a tree switch into the unfocused branch must stay silent");

		sessionEntries.splice(0, sessionEntries.length, focusEntryFor(fixture.goals[0]!.id));
		await harness.handlers.get("session_tree")?.({ newLeafId: "focused-branch", oldLeafId: "unfocused-branch" }, harness.ctx);
		const refocused = await ordinaryTurn(harness, "tree switch back to focused");
		assert.equal(hasActiveContext(refocused), true, "focus restored through the branch must deliver its active context");
		assert.equal(hasReminder(refocused), false);
		assert.deepEqual(harness.steeringMessages(), []);
	} finally {
		fixture.cleanup();
	}
});

test("a stale checkpoint is still rejected while no goal is focused", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 1);
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [], hasUI: true });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		await harness.handlers.get("before_agent_start")?.({
			systemPrompt: "base prompt",
			prompt: '<pi_goal_continuation goal_id="ghost-goal" kind="checkpoint" v="2"/>',
		}, harness.ctx);
		assert.equal(harness.abortCount, 1, "a stale checkpoint must still abort the turn");
		const result = await harness.handlers.get("context_with_system")?.({ messages: [] }, harness.ctx);
		assert.match(requestText(result), /\[GOAL STALE goalId=ghost-goal\]/, "the stale rejection note must survive");
		assert.equal(hasReminder(result), false, "the stale path must not re-introduce the unfocused reminder");
	} finally {
		fixture.cleanup();
	}
});

test("pre-existing history keeps an old reminder verbatim without adding a new one", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 1);
	const oldReminder =
		"[PI GOAL UNFOCUSED]\n1 open pi goal exists, but this session has no focused goal.\n" +
		"Do not choose or switch focus autonomously. Focus is human-owned intent.\n" +
		"Ask the user to run /goal-focus, /goal-list, or /goal-resume before doing goal work.";
	const history = [
		{ role: "user", content: "earlier request" },
		{ role: "custom", customType: "pi-goal-steering-event", content: oldReminder, display: false },
		{ role: "assistant", content: "noted" },
	];
	const snapshot = JSON.parse(JSON.stringify(history));
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [] });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		await harness.handlers.get("before_agent_start")?.({ systemPrompt: "base prompt", prompt: "new request" }, harness.ctx);
		const result = (await harness.handlers.get("context_with_system")?.({ messages: history }, harness.ctx)) as
			| { messages?: unknown[] }
			| undefined;
		const messages = result?.messages ?? history;
		assert.deepEqual(messages.slice(0, snapshot.length), snapshot, "replayed history must stay byte-identical");
		const occurrences = JSON.stringify(messages).split("PI GOAL UNFOCUSED").length - 1;
		assert.equal(occurrences, 1, "the retired reminder must not be appended again on top of history");
		assert.deepEqual(harness.steeringMessages(), [], "no new steering message may be written");
	} finally {
		fixture.cleanup();
	}
});

test("a goal tool refuses to act without a focused goal", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 1);
	const originalGoalFile = readFileSync(fixture.activePaths[0]!);
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [], hasUI: true });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		const updateGoal = harness.tools.get("update_goal");
		assert.ok(updateGoal, "update_goal must stay registered");
		const result = await updateGoal.execute("call-1", { status: "complete" }, undefined, undefined, harness.ctx);
		const text = String(result?.content?.[0]?.text ?? "");
		assert.match(text, /No goal is set|goal-focus|create_goal/, "the guard must return the existing precondition message");
		assert.doesNotMatch(text, /\[PI GOAL UNFOCUSED\]/, "the tool guard is not the retired reminder channel");
		assert.deepEqual(readFileSync(fixture.activePaths[0]!), originalGoalFile, "the goal must not be mutated");
		assert.equal(harness.appendedEntries.filter((entry) => entry.customType === "pi-goal-focus").length, 0, "focus must not change");
		assert.equal(readdirSync(path.join(fixture.cwd, ".pi", "goals", "archived")).length, 0, "nothing may be archived");
	} finally {
		fixture.cleanup();
	}
});

test("every legacy reminder value keeps the model input silent", async () => {
	for (const value of [undefined, true, false] as const) {
		const fixture = createFixture({
			...UNFOCUSED_SETTINGS,
			...(value === undefined ? {} : { hideUnfocusedPrompt: value }),
		}, 1);
		const originalGoalFile = readFileSync(fixture.activePaths[0]!);
		const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [] });
		try {
			await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
			for (let i = 0; i < 3; i++) {
				const result = await ordinaryTurn(harness, `ordinary request ${i + 1}`);
				assert.equal(hasReminder(result), false, `legacy value ${String(value)} must stay silent on request ${i + 1}`);
			}
			assert.deepEqual(harness.steeringMessages(), [], `legacy value ${String(value)} must not add a steering message`);
			assert.deepEqual(readFileSync(fixture.activePaths[0]!), originalGoalFile);
			assert.equal(harness.appendedEntries.filter((entry) => entry.customType === "pi-goal-focus").length, 0);
		} finally {
			fixture.cleanup();
		}
	}
});

test("editing the legacy key on disk never changes model input", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 1);
	const settingsPath = path.join(fixture.cwd, ".pi", "pi-goal-x-settings.json");
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [] });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		assert.equal(hasReminder(await ordinaryTurn(harness, "default settings")), false);
		for (const value of [true, false]) {
			writeFileSync(settingsPath, JSON.stringify({ ...UNFOCUSED_SETTINGS, hideUnfocusedPrompt: value }));
			invalidateGoalSettingsCache();
			assert.equal(hasReminder(await ordinaryTurn(harness, `legacy ${String(value)}`)), false, `legacy value ${String(value)} must stay silent`);
		}
	} finally {
		invalidateGoalSettingsCache();
		fixture.cleanup();
	}
});

test("the settings menu no longer offers the retired reminder row", async () => {
	const fixture = createFixture({ ...UNFOCUSED_SETTINGS, hideUnfocusedPrompt: true }, 1);
	const harness = createHarness({ cwd: fixture.cwd, sessionEntries: [], hasUI: true });
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		await harness.commands.get("goal-settings")!.handler("", harness.ctx);
		const rendered = harness.selectCalls.join("\n");
		assert.ok(rendered.includes("hideUnfocusedBanner"), "the UI banner row must stay available");
		assert.ok(!rendered.includes("hideUnfocusedPrompt"), "the retired reminder row must not be offered");
	} finally {
		invalidateGoalSettingsCache();
		fixture.cleanup();
	}
});

test("saving an unrelated setting keeps the legacy reminder key on disk", () => {
	const fixture = createFixture({ ...UNFOCUSED_SETTINGS, hideUnfocusedPrompt: true }, 1);
	try {
		mutateSettingsLayer({ scope: "project", cwd: fixture.cwd, mutation: { op: "set", path: ["hideUnfocusedBanner"], value: true } });
		invalidateGoalSettingsCache();
		const settings = loadGoalSettings(fixture.cwd);
		assert.equal(settings.hideUnfocusedBanner, true, "the edited setting is applied");
		assert.equal(settings.hideUnfocusedPrompt, true, "the legacy key is still parsed");
		const raw = JSON.parse(readFileSync(path.join(fixture.cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(raw.hideUnfocusedPrompt, true, "the legacy key is preserved when other settings are saved");
	} finally {
		invalidateGoalSettingsCache();
		fixture.cleanup();
	}
});

test("retired reminder state is not cached across sessions", async () => {
	const fixture = createFixture(UNFOCUSED_SETTINGS, 1);
	try {
		const first = createHarness({ cwd: fixture.cwd, sessionEntries: [] });
		await first.handlers.get("session_start")?.({ reason: "startup" }, first.ctx);
		assert.deepEqual(first.steeringMessages(), []);

		// A second session over the same pool must observe the same silence; no
		// module-level "already notified" flag may leak across sessions.
		const second = createHarness({ cwd: fixture.cwd, sessionEntries: [] });
		await second.handlers.get("session_start")?.({ reason: "resume" }, second.ctx);
		assert.deepEqual(second.steeringMessages(), []);
		const result = await ordinaryTurn(second, "resumed ordinary request");
		assert.equal(hasReminder(result), false);
	} finally {
		invalidateGoalSettingsCache();
		fixture.cleanup();
	}
});
