/**
 * 0.4.0 — the full goal-context message (pi-goal-context-event) is the
 * persisted carrier of the objective, verification contract, and lifecycle
 * policy now that the system prompt carries no goal content. Contract:
 *   - sent when the goal is created (created);
 *   - re-sent after compaction (compacted);
 *   - re-sent on session load when the branch has no copy after its last
 *     compaction entry (rehydrated), and NOT re-sent when a copy exists.
 * All sends are display:false append-only custom messages.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

interface SentMessage {
	customType: string;
	content: string;
	display: boolean | undefined;
	details: Record<string, unknown> | undefined;
}

function createHarness(cwd: string, sessionEntries: unknown[]) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const sent: SentMessage[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: SentMessage) => {
			sent.push({ customType: message.customType, content: String(message.content ?? ""), display: message.display, details: message.details });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "context-message-test-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	const contextMessages = () => sent.filter((m) => m.customType === "pi-goal-context-event");
	return { handlers, commands, ctx, sent, contextMessages };
}

function fixture(settings: Record<string, unknown> = { autoSelectSingleGoal: false, disabled: true }) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-context-msg-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify(settings));
	const goal = createGoal({
		objective: "=== Goal ===\nObjective: Context message goal",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 8, 6, 9, 0, 0));
	const written = writeActiveGoalFile({ cwd }, goal);
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort; failure must not fail the test */ } };
	return { cwd, goal: written, cleanup };
}

test("goal creation sends the full goal-context message with reason=created", async () => {
	const f = fixture();
	try {
		const { commands, ctx, contextMessages, sent } = createHarness(f.cwd, []);
		// /goal-direct is a direct creation path (replaceGoal).
		await commands.get("goal-direct")?.handler("Brand new goal", ctx);
		const created = contextMessages();
		assert.equal(created.length, 1, "exactly one context message on creation");
		assert.equal(created[0]!.details?.reason, "created");
		assert.match(created[0]!.content, /^\[PI GOAL CONTEXT goalId=/);
		assert.match(created[0]!.content, /\[OUTCOMES\]/, "lifecycle policy rides the message");
		assert.ok(created[0]!.details && typeof created[0]!.details.timestamp === "number");
		// Append-only plumbing: nothing else was sent apart from UI-free messages.
		assert.ok(sent.every((m) => m.customType !== "pi-goal-event"), "creation must not send a checkpoint marker");
	} finally {
		f.cleanup();
	}
});

test("session load re-sends the context message when the branch has no copy after the last compaction", async () => {
	const f = fixture();
	try {
		// Branch with a compaction entry and nothing after it: the summary ate
		// the earlier copy, so the message must be re-supplied.
		const sessionEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(f.goal.id, "created") },
			{ type: "compaction", id: "c1", summary: "older context summarized" },
		];
		const { handlers, ctx, contextMessages } = createHarness(f.cwd, sessionEntries);
		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		const rehydrated = contextMessages();
		assert.equal(rehydrated.length, 1, "context message re-supplied after compaction");
		assert.equal(rehydrated[0]!.details?.reason, "rehydrated");
	} finally {
		f.cleanup();
	}
});

test("session load does NOT re-send when a context message already exists after the last compaction", async () => {
	const f = fixture();
	try {
		const sessionEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(f.goal.id, "created") },
			{ type: "compaction", id: "c1", summary: "older context summarized" },
			{ type: "custom_message", customType: "pi-goal-context-event", content: "[PI GOAL CONTEXT goalId=existing]" },
		];
		const { handlers, ctx, contextMessages } = createHarness(f.cwd, sessionEntries);
		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		assert.equal(contextMessages().length, 0, "existing copy suppresses the re-send");
	} finally {
		f.cleanup();
	}
});

test("session load without any compaction re-supplies only for legacy sessions without a copy", async () => {
	const f = fixture();
	try {
		// Fresh-looking branch with a focus entry but no context message yet
		// (legacy session upgrading to the message channel).
		const sessionEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(f.goal.id, "created") },
		];
		const { handlers, ctx, contextMessages } = createHarness(f.cwd, sessionEntries);
		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		assert.equal(contextMessages().length, 1, "legacy branch gets the context message once");
		assert.equal(contextMessages()[0]!.details?.reason, "rehydrated");
	} finally {
		f.cleanup();
	}
});

test("session_compact re-sends the context message with reason=compacted", async () => {
	const f = fixture();
	try {
		const sessionEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(f.goal.id, "created") },
		];
		const { handlers, ctx, contextMessages } = createHarness(f.cwd, sessionEntries);
		await handlers.get("session_start")?.({ reason: "start" }, ctx);
		const before = contextMessages().length;
		await handlers.get("session_compact")?.({}, ctx);
		const after = contextMessages();
		assert.equal(after.length, before + 1, "compaction triggers exactly one re-send");
		assert.equal(after.at(-1)!.details?.reason, "compacted");
	} finally {
		f.cleanup();
	}
});

test("every context message is a display:false append-only custom message", async () => {
	const f = fixture();
	try {
		const { commands, ctx, contextMessages } = createHarness(f.cwd, []);
		await commands.get("goal-direct")?.handler("Display check", ctx);
		const messages = contextMessages();
		assert.ok(messages.length >= 1);
		for (const message of messages) {
			assert.equal(message.display, false, "context messages must never render in the UI");
		}
	} finally {
		f.cleanup();
	}
});
