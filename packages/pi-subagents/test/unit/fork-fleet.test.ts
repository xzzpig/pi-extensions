/**
 * [fork] Fleet UI extensions: thinking replay collapse, pi-notify silent-span
 * markers. Moved out of fleet.test.ts so that file stays byte-identical to
 * upstream.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { openSubagentFleet, openSubagentFleetFromStatus, SubagentFleetComponent } from "../../src/tui/fleet.ts";
import { loadNativeTranscriptSupport } from "../../src/tui/fleet-native-transcript.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function writeAsyncRun(root: string, input: {
	id: string;
	sessionId?: string;
	state?: "running" | "complete" | "failed";
	mode?: "single" | "parallel" | "workflow";
	lastUpdate?: number;
	startedAt?: number;
	agents?: string[];
	contexts?: Array<"fresh" | "fork">;
	models?: string[];
	thinking?: string[];
	output?: string;
	transcript?: Array<Record<string, unknown>>;
}): string {
	const asyncDir = path.join(root, input.id);
	fs.mkdirSync(asyncDir, { recursive: true });
	const agents = input.agents ?? ["worker"];
	if (input.output !== undefined) fs.writeFileSync(path.join(asyncDir, "output-0.log"), input.output, "utf-8");
	const transcriptPath = input.transcript ? path.join(asyncDir, "transcript-0.jsonl") : undefined;
	if (transcriptPath && input.transcript) fs.writeFileSync(transcriptPath, `${input.transcript.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
	const state = input.state ?? "running";
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: input.id,
		sessionId: input.sessionId ?? "session-current",
		mode: input.mode ?? (agents.length > 1 ? "parallel" : "single"),
		state,
		startedAt: input.startedAt ?? 100,
		lastUpdate: input.lastUpdate ?? 200,
		currentStep: 0,
		steps: agents.map((agent, index) => ({
			agent,
			...(input.contexts?.[index] ? { context: input.contexts[index] } : {}),
			...(input.models?.[index] ? { model: input.models[index] } : {}),
			...(input.thinking?.[index] ? { thinking: input.thinking[index] } : {}),
			status: input.state === "complete" ? "complete" : input.state === "failed" ? "failed" : index === 0 ? "running" : "pending",
			startedAt: 100,
			...(index === 0 ? { sessionFile: path.join(asyncDir, `${agent}.jsonl`), ...(transcriptPath ? { transcriptPath } : {}) } : {}),
		})),
		...(input.output !== undefined ? { outputFile: "output-0.log" } : {}),
	}, null, 2));
	updateActiveRunIndex(asyncDir, state);
	return asyncDir;
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const markdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

describe("native subagent fleet", () => {
	it("collapses replayed thinking by default and expands it with the thinking binding", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-thinking-toggle-"));
		try {
			const assistant = (index: number): Record<string, unknown> => ({
				recordType: "message",
				role: "assistant",
				model: "test-model",
				text: `ANSWER_${index}`,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: `THINKING_${index}` },
						{ type: "text", text: `ANSWER_${index}` },
					],
				},
			});
			writeAsyncRun(root, {
				id: "async-thinking",
				state: "complete",
				transcript: [
					assistant(1),
					{ recordType: "tool_start", toolCallId: "read-1", toolName: "read", argsPayload: JSON.stringify({ path: "src/a.ts" }), ts: 1 },
					{ recordType: "tool_end", toolCallId: "read-1", toolName: "read", isError: false, ts: 2 },
					{ recordType: "message", role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, text: "tool output", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, content: [{ type: "text", text: "tool output" }] } },
					assistant(2),
				],
			});
			const state = stateForTest();
			state.baseCwd = root;
			// The shared renderer needs the full host theme surface (`bg` included);
			// the compact test stub above would throw and silently downgrade the
			// inspector to the legacy rail, which carries no thinking entries.
			const nativeTheme = { ...theme, bg: (_name: string, text: string) => text };
			// Prime the shared renderer so the inspector never falls back to the
			// legacy rail (which carries no thinking entries at all).
			assert.ok(await loadNativeTranscriptSupport(), "shared transcript module should load in this workspace");
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 32, columns: 110 }, requestRender() {} } as never,
				nativeTheme as never,
				state,
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000, markdownTheme },
			);
			try {
				for (let tick = 0; tick < 4; tick++) await Promise.resolve();
				let lines = component.render(110);
				assert.ok(lines.some((line) => line.includes("Thinking (t/T to expand)")), "thinking should be collapsed by default");
				assert.ok(!lines.some((line) => line.includes("THINKING_1") || line.includes("THINKING_2")), "collapsed thinking must not leak its content");
				component.handleInput("t");
				lines = component.render(110);
				assert.ok(lines.some((line) => line.includes("THINKING_1")), "expanding should reveal the first thinking block");
				assert.ok(lines.some((line) => line.includes("THINKING_2")), "expanding should reveal every replayed thinking block");
				component.handleInput("T");
				lines = component.render(110);
				assert.ok(lines.some((line) => line.includes("Thinking (t/T to expand)")), "the same binding should collapse again");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("claims the fleet dialog as a silent span before opening it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-silent-marker-"));
		try {
			writeAsyncRun(root, { id: "marked", agents: ["worker"] });
			const state = stateForTest();
			const emitted: Array<{ channel: string; data: unknown }> = [];
			const events = {
				emit(channel: string, data: unknown) {
					emitted.push({ channel, data });
				},
			};
			const ctx = {
				hasUI: true,
				ui: {
					setWidget() {},
					async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: undefined) => void) => SubagentFleetComponent) {
						const component = factory({ terminal: { rows: 32 }, requestRender() {} }, theme, undefined, () => {});
						component.dispose();
					},
				},
			};

			await openSubagentFleet(ctx as never, state, {
				asyncDirRoot: root,
				resultsDir: path.join(root, "results"),
				events,
			});
			assert.deepEqual(emitted, [
				{ channel: "pi-notify:ui_span_silent", data: { reason: "fleet" } },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("claims a silent span on the status-widget fleet open path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-widget-marker-"));
		try {
			writeAsyncRun(root, { id: "widget-path", agents: ["worker"] });
			const state = stateForTest();
			const emitted: Array<{ channel: string; data: unknown }> = [];
			const pi = {
				events: {
					emit(channel: string, data: unknown) {
						emitted.push({ channel, data });
					},
				},
			} as never;
			const ctx = {
				hasUI: true,
				ui: {
					setWidget() {},
					async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: undefined) => void) => SubagentFleetComponent) {
						const component = factory({ terminal: { rows: 32 }, requestRender() {} }, theme, undefined, () => {});
						component.dispose();
					},
				},
			};

			await openSubagentFleetFromStatus(ctx as never, state, pi, {
				asyncDirRoot: root,
				resultsDir: path.join(root, "results"),
			});
			assert.deepEqual(emitted, [
				{ channel: "pi-notify:ui_span_silent", data: { reason: "fleet" } },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
