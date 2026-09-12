import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildNativeFleetTranscript,
	hasRequiredNativeExports,
	loadNativeTranscriptSupport,
	type NativeTranscriptModule,
} from "../../src/tui/fleet-native-transcript.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// Composed at runtime so no control character appears in this source file.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (lines: string[]): string => lines.join("\n").replace(ANSI_PATTERN, "");

function makeRoot(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-native-"));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

let sequence = 0;
function baseRecord(recordType: string): Record<string, unknown> {
	sequence += 1;
	return {
		version: 1,
		recordType,
		source: "async",
		runId: "run-1",
		agent: "worker",
		cwd: "/tmp",
		ts: Date.now() + sequence,
		timestamp: new Date().toISOString(),
	};
}

function writeTranscript(root: string, records: Array<Record<string, unknown>>): string {
	const filePath = path.join(root, "transcript.jsonl");
	fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	return filePath;
}

function userRecord(text: string): Record<string, unknown> {
	const record = baseRecord("message");
	record.role = "user";
	record.text = text;
	record.message = { role: "user", content: [{ type: "text", text }] };
	return record;
}

const initialPrompt = () => userRecord("please inspect the auth flow");

describe("fleet native transcript adapter", () => {
	it("replays a normal child transcript into native-renderable entries", async () => {
		const mod = await loadNativeTranscriptSupport();
		assert.ok(mod, "shared transcript module should load in this workspace");
		const { root, cleanup } = makeRoot();
		try {
			const toolStart = baseRecord("tool_start");
			toolStart.toolCallId = "call-1";
			toolStart.toolName = "bash";
			toolStart.argsPreview = '{"command": "grep -R auth src"}';
			toolStart.argsPayload = '{\n  "command": "grep -R auth src"\n}';

			const toolEnd = baseRecord("tool_end");
			toolEnd.toolCallId = "call-1";
			toolEnd.toolName = "bash";

			const toolResult = baseRecord("message");
			toolResult.role = "toolResult";
			toolResult.toolCallId = "call-1";
			toolResult.toolName = "bash";
			toolResult.isError = false;
			toolResult.text = "src/auth.ts:1 export function login";
			toolResult.message = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "src/auth.ts:1 export function login" }],
			};

			const assistant = baseRecord("message");
			assistant.role = "assistant";
			assistant.model = "test-model";
			assistant.message = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "check the login path first" },
					{ type: "text", text: "The auth flow starts in **src/auth.ts**." },
				],
			};

			const stderr = baseRecord("stderr");
			stderr.text = "warn: deprecated api usage";

			const filePath = writeTranscript(root, [
				initialPrompt(),
				toolStart,
				toolEnd,
				toolResult,
				assistant,
				stderr,
				userRecord("now check the tests"),
			]);
			const built = buildNativeFleetTranscript(mod as NativeTranscriptModule, {
				filePath,
				trustedRoots: [root],
				width: 80,
				expandedTools: false,
				cwd: root,
				theme,
			});

			assert.equal(built.warning, undefined);
			assert.equal(built.truncated, false);
			assert.ok(built.entryCount > 6);
			assert.equal(built.conversationState, "supervisor message");

			const plain = stripAnsi(built.lines);
			assert.ok(plain.includes("grep -R auth src"), "command should render via native bash component");
			assert.ok(plain.includes("export function login"), "tool output should render");
			assert.ok(plain.includes("src/auth.ts"), "assistant markdown text should render");
			assert.ok(plain.includes("deprecated api usage"), "stderr notice should render");
		} finally {
			cleanup();
		}
	});

	it("keeps the tool entry renderable when argsPayload is truncated or corrupt", async () => {
		const mod = await loadNativeTranscriptSupport();
		assert.ok(mod);
		const { root, cleanup } = makeRoot();
		try {
			const toolStart = baseRecord("tool_start");
			toolStart.toolCallId = "call-big";
			toolStart.toolName = "edit";
			toolStart.argsPreview = '"path": "src/big.ts"';
			// Mirrors the writer's >32 KiB truncation: one invalid-JSON string
			// ending in the truncation marker (child-transcript v1 behavior).
			toolStart.argsPayload = '{\n  "path": "src/big.ts",\n  "old_str\n\n… payload truncated';

			const toolEnd = baseRecord("tool_end");
			toolEnd.toolCallId = "call-big";
			toolEnd.toolName = "edit";
			toolEnd.isError = false;

			const toolResult = baseRecord("message");
			toolResult.role = "toolResult";
			toolResult.toolCallId = "call-big";
			toolResult.toolName = "edit";
			toolResult.isError = false;
			toolResult.text = "edited successfully";
			toolResult.message = {
				role: "toolResult",
				toolCallId: "call-big",
				toolName: "edit",
				isError: false,
				content: [{ type: "text", text: "edited successfully" }],
			};

			const filePath = writeTranscript(root, [initialPrompt(), toolStart, toolEnd, toolResult]);
			const built = buildNativeFleetTranscript(mod as NativeTranscriptModule, {
				filePath,
				trustedRoots: [root],
				width: 80,
				expandedTools: false,
				theme,
			});

			assert.ok(built.entryCount > 0);
			assert.equal(built.conversationState, "activity");
			// Wrapping can split phrases across lines; match on normalized text.
			const plain = stripAnsi(built.lines).replace(/\s+/g, " ");
			assert.ok(plain.includes("edit"), "tool name must survive degraded arguments");
			assert.ok(plain.includes("edited successfully"), "result must survive degraded arguments");
			assert.ok(plain.includes("arguments truncated"), "degraded call must surface a truncation notice");
			assert.ok(plain.includes('"path": "src/big.ts"'), "argsPreview must survive as the truncation preview");
		} finally {
			cleanup();
		}
	});

	it("synthesizes an error result when tool_end reports failure without a result record", async () => {
		const mod = await loadNativeTranscriptSupport();
		assert.ok(mod);
		const { root, cleanup } = makeRoot();
		try {
			const toolStart = baseRecord("tool_start");
			toolStart.toolCallId = "call-fail";
			toolStart.toolName = "bash";
			toolStart.argsPayload = '{"command": "exit 1"}';

			const toolEnd = baseRecord("tool_end");
			toolEnd.toolCallId = "call-fail";
			toolEnd.toolName = "bash";
			toolEnd.isError = true;

			const filePath = writeTranscript(root, [initialPrompt(), toolStart, toolEnd]);
			const built = buildNativeFleetTranscript(mod as NativeTranscriptModule, {
				filePath,
				trustedRoots: [root],
				width: 80,
				expandedTools: false,
				theme,
			});

			assert.equal(built.conversationState, "bash · error");
			const plain = stripAnsi(built.lines);
			assert.ok(plain.includes("ended with error"));
		} finally {
			cleanup();
		}
	});

	it("refuses transcripts outside trusted roots and surfaces a warning", async () => {
		const mod = await loadNativeTranscriptSupport();
		assert.ok(mod);
		const { root, cleanup } = makeRoot();
		try {
			const filePath = writeTranscript(root, [initialPrompt()]);
			const built = buildNativeFleetTranscript(mod as NativeTranscriptModule, {
				filePath,
				trustedRoots: [path.join(root, "elsewhere")],
				width: 80,
				expandedTools: false,
				theme,
			});
			assert.equal(built.entryCount, 0);
			assert.ok(built.warning, "path escape must surface as a warning");
			assert.match(built.warning, /trusted roots/);
			assert.deepEqual(built.lines, []);
		} finally {
			cleanup();
		}
	});

	it("keeps every assistant thinking block of one replayed turn and honors the collapse toggle", async () => {
		const mod = await loadNativeTranscriptSupport();
		assert.ok(mod);
		const { root, cleanup } = makeRoot();
		try {
			const assistant = (index: number): Record<string, unknown> => {
				const record = baseRecord("message");
				record.role = "assistant";
				record.model = "test-model";
				record.text = `ANSWER_${index}`;
				record.message = {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: `THINKING_${index}` },
						{ type: "text", text: `ANSWER_${index}` },
					],
				};
				return record;
			};
			const tool = (index: number): Array<Record<string, unknown>> => {
				const start = baseRecord("tool_start");
				start.toolCallId = `call-${index}`;
				start.toolName = "bash";
				start.argsPayload = JSON.stringify({ command: `echo ${index}` });
				const end = baseRecord("tool_end");
				end.toolCallId = `call-${index}`;
				end.toolName = "bash";
				end.isError = false;
				return [start, end];
			};
			// No user record: this mirrors the reader's tail window, where the
			// whole slice belongs to one open turn.
			const filePath = writeTranscript(root, [
				assistant(1),
				...tool(1),
				assistant(2),
				...tool(2),
				assistant(3),
			]);
			const expanded = buildNativeFleetTranscript(mod as NativeTranscriptModule, {
				filePath,
				trustedRoots: [root],
				width: 100,
				expandedTools: false,
				hideThinkingBlock: false,
				theme,
			});
			const expandedPlain = stripAnsi(expanded.lines);
			for (const index of [1, 2, 3]) {
				assert.ok(expandedPlain.includes(`THINKING_${index}`), `thinking block ${index} must survive replay`);
				assert.ok(expandedPlain.includes(`ANSWER_${index}`), `assistant answer ${index} must survive replay`);
			}
			assert.ok(expandedPlain.indexOf("THINKING_3") > expandedPlain.indexOf("THINKING_1"), "replay order must be preserved");

			const collapsed = buildNativeFleetTranscript(mod as NativeTranscriptModule, {
				filePath,
				trustedRoots: [root],
				width: 100,
				expandedTools: false,
				hideThinkingBlock: true,
				thinkingLabel: "Thinking (t/T to expand)",
				theme,
			});
			const collapsedPlain = stripAnsi(collapsed.lines);
			assert.ok(collapsedPlain.includes("Thinking (t/T to expand)"), "collapsed view must label each thinking block");
			assert.ok(!/THINKING_[123]/.test(collapsedPlain), "collapsed view must not leak thinking text");
			assert.ok(collapsedPlain.includes("ANSWER_1") && collapsedPlain.includes("ANSWER_3"), "collapsing must not hide assistant answers");
		} finally {
			cleanup();
		}
	});

	it("validates candidate modules through the structural export probe", async () => {
		const mod = await loadNativeTranscriptSupport();
		assert.ok(mod);
		assert.equal(hasRequiredNativeExports(mod), true);
		assert.equal(hasRequiredNativeExports({}), false);
		assert.equal(hasRequiredNativeExports({ createTranscriptState: () => ({}) }), false, "partial exports must fail the probe");
		assert.equal(hasRequiredNativeExports(null), false);
	});
});
