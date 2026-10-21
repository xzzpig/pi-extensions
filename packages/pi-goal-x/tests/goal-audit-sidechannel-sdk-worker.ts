/**
 * Real-SDK worker for task 6.1 (design D8).
 *
 * This file runs WITHOUT the Goal-X stub preload: the module resolver is
 * untouched, so `createAgentSession`, `SessionManager`, `SettingsManager` and
 * `defineTool` are the genuine @earendil-works implementations and the default
 * production side-session factory (no injected sessionFactory) is what is
 * exercised.
 *
 * Provider: a local faux provider registered as a runtime native provider on a
 * real offline `ModelRuntime`. No network call, no real credential, no model
 * token is consumed.
 *
 * Observations are made only from payloads the real SDK hands to the provider
 * (`TranscriptContext.messages`) plus the public runtime/coding-agent APIs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL,
	createAuditSupervisorSidechannel,
} from "../extensions/goal-audit-sidechannel.ts";

const PROVIDER_ID = "faux-audit-supervisor";
const MODEL_ID = "faux-audit-model";
const EVIDENCE_TEXT = "pong\n";

type Captured = { messages: unknown[] };

interface Harness {
	root: string;
	cwd: string;
	evidencePath: string;
	runtime: ModelRuntime;
	faux: ReturnType<typeof fauxProvider>;
	model: unknown;
	requests: Captured[];
	steps: number;
}

async function makeHarness(): Promise<Harness> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-audit-sdk-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	const evidencePath = path.join(cwd, "evidence.txt");
	fs.writeFileSync(evidencePath, EVIDENCE_TEXT);
	// Isolate credentials completely: no auth file, no key in the environment.
	process.env.HOME = home;

	const runtime = await ModelRuntime.create({
		authPath: path.join(home, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: PROVIDER_ID,
		api: "faux-audit-api",
		models: [{ id: MODEL_ID, name: "Faux Audit Model" }],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey(PROVIDER_ID, "runtime-only-key");

	const model = runtime.getModel(PROVIDER_ID, MODEL_ID);
	assert.ok(model, "the runtime-only native provider must expose its model");

	return { root, cwd, evidencePath, runtime, faux, model, requests: [], steps: 0 };
}

/** A fake parent context carrying a legal completed-prefix seed. */
function makeCtx(h: Harness) {
	const entries = [
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: 1,
			message: { role: "user", content: "已决定本次交付标记为 ALPHA", timestamp: 1 },
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: 2,
			message: { role: "assistant", content: [{ type: "text", text: "记录下来了。" }], timestamp: 2 },
		},
		{
			// A historical capability declaration: the seed must NOT replay this as
			// a live tool permission.
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: 3,
			message: {
				role: "system",
				content: "capabilities changed",
				toolsAdded: ["bash", "edit", "write"],
				timestamp: 3,
			},
		},
	];
	return {
		cwd: h.cwd,
		model: h.model,
		getSystemPrompt: () => "You are the parent session.",
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => "e3",
			getSessionId: () => "parent-session-1",
		},
		modelRegistry: { runtime: h.runtime },
	};
}

function makeSidechannel(h: Harness, ctx: unknown) {
	return createAuditSupervisorSidechannel({
		ctx: ctx as never,
		getThinkingLevel: () => "off",
		goalPayload: { goalId: "g1", contract: "ship it" },
		getAuditDeadlineAt: () => Date.now() + 60_000,
		requestId: "delegation-1",
		ownerRunId: "g1",
		nodeId: "goal-completion:g1:1",
		clock: () => Date.now(),
	});
}

/** Record every provider payload, then answer with the next scripted step. */
function script(h: Harness, steps: Array<(messages: unknown[]) => ReturnType<typeof fauxAssistantMessage>>) {
	h.faux.setResponses(
		steps.map((step) => (context: { messages: unknown[] }) => {
			h.requests.push({ messages: context.messages });
			h.steps += 1;
			return step(context.messages);
		}),
	);
}

function ask() {
	return {
		requestId: "ask-1",
		reason: "need_decision" as const,
		message: "父用户此前已决定的交付标记是什么",
		runId: "run-1",
		agent: "goal-auditor",
		childIndex: 0,
		deadlineAt: Date.now() + 60_000,
		signal: new AbortController().signal,
	};
}

function toolResultsOf(messages: unknown[]): Array<{ name?: string; text: string }> {
	const out: Array<{ name?: string; text: string }> = [];
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolName?: string; toolCallId?: string };
		if (message.role !== "toolResult" && message.role !== "tool") continue;
		const content = Array.isArray(message.content) ? message.content : [];
		const text = content
			.map((part) => (part as { text?: string }).text ?? "")
			.join("");
		out.push({ name: message.toolName, text });
	}
	return out;
}

function messageText(messages: unknown[]): string {
	return JSON.stringify(messages);
}

test("6.1 real SDK default factory: explicit read-only tool plan, real read, runtime-only auth", { timeout: 90_000 }, async () => {
	const h = await makeHarness();
	const ctx = makeCtx(h);
	const sidechannel = makeSidechannel(h, ctx);

	script(h, [
		// 1st request: the model asks for a real file read.
		() => fauxAssistantMessage(fauxToolCall("read", { path: h.evidencePath }), { stopReason: "toolUse" }),
		// 2nd request: the model attempts an unauthorised write/exec tool.
		() => fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /" }), { stopReason: "toolUse" }),
		// 3rd request: the model submits the answer through the custom tool.
		(captured) => {
			const bash = toolResultsOf(captured).at(-1);
			assert.ok(bash, "the unauthorised tool call must produce a tool result");
			assert.match(
				String(bash.text),
				/unknown|not found|not available|not enabled|no such tool/i,
				`an unauthorised tool must be rejected, got: ${bash.text}`,
			);
			return fauxAssistantMessage(
				fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { kind: "reply", message: "ALPHA" }),
				{ stopReason: "toolUse" },
			);
		},
		// 4th request: final assistant text.
		() => fauxAssistantMessage("answer submitted"),
	]);

	const outcome = await sidechannel.respond(ask());
	assert.equal(outcome.kind, "reply");
	assert.equal(outcome.kind === "reply" ? outcome.message : "", "ALPHA");

	// --- real read of the temporary evidence through the real SDK tool -------
	const readResult = h.requests[1] ? toolResultsOf(h.requests[1].messages)[0] : undefined;
	assert.ok(readResult, "the second request must carry the read tool result");
	assert.match(readResult.text, /pong/, "the real read tool must return the file content");

	// --- the effective tool plan is the explicit five-tool read-only set -----
	// `read` and the custom submit tool really executed; `bash` was refused, so
	// the session never received bash/edit/write even though the very first
	// request's seed carried a historical toolsAdded declaration.
	assert.ok(h.steps >= 3, "the model ran its scripted turns");
	assert.equal(sidechannel.records().length, 1);
	assert.equal(sidechannel.records()[0]?.deliveryStatus, "delivered");
	assert.equal(sidechannel.usage().turns > 0, true, "real generated assistant messages are billed");

	// --- standalone runtime: never disposed by the side channel --------------
	assert.ok(h.runtime.getModel(PROVIDER_ID, MODEL_ID), "the borrowed parent runtime must stay usable");

	await sidechannel.dispose();
	fs.rmSync(h.root, { recursive: true, force: true });
});

test("6.1 real SDK: capability declarations in the seed are not replayed as permissions", { timeout: 90_000 }, async () => {
	const h = await makeHarness();
	const ctx = makeCtx(h);
	const sidechannel = makeSidechannel(h, ctx);
	const seen: unknown[][] = [];

	script(h, [
		() => fauxAssistantMessage(fauxToolCall("read", { path: h.evidencePath }), { stopReason: "toolUse" }),
		(captured) => {
			seen.push(captured);
			return fauxAssistantMessage(
				fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { kind: "unresolved", reason: "no authorisation" }),
				{ stopReason: "toolUse" },
			);
		},
		() => fauxAssistantMessage("unresolved submitted"),
	]);

	const outcome = await sidechannel.respond({
		...ask(),
		requestId: "ask-2",
		message: "是否授权删除本测试的 evidence.txt",
	});
	// The responder could not decide from completed history: it must fail closed
	// with an explicit unresolved outcome rather than inventing an authorisation.
	assert.equal(outcome.kind, "error");
	assert.equal(outcome.kind === "error" ? outcome.code : "", "unresolved");
	assert.equal(outcome.kind === "error" ? outcome.message : "", "no authorisation");
	const unresolvedRecord = sidechannel.records().at(-1);
	assert.equal(unresolvedRecord?.deliveryStatus, "failed");
	assert.equal(unresolvedRecord?.unresolvedReason, "no authorisation");
	assert.equal(unresolvedRecord?.answer, undefined, "an unresolved ask must never carry an answer");
	// Capability isolation. The SDK announces the side session's own live tools
	// (that announcement is expected and legitimate); what must never happen is
	// the seeded historical declaration widening the real tool set.
	const declared = new Set<string>();
	for (const captured of seen) {
		for (const raw of captured) {
			const message = raw as { toolsAdded?: Array<{ name?: string }>; toolsRemoved?: Array<{ name?: string }> };
			for (const tool of message.toolsAdded ?? []) if (tool?.name) declared.add(tool.name);
			for (const tool of message.toolsRemoved ?? []) if (tool?.name) declared.add(tool.name);
		}
	}
	const seededEscalation = ["bash", "edit", "write"].filter((name) => declared.has(name));
	assert.deepEqual(
		seededEscalation,
		[],
		`historical seed capabilities must not be replayed as live permissions (saw ${JSON.stringify([...declared])})`,
	);
	// The live declaration may only ever name the side channel's own read-only set.
	const allowed = new Set(["read", "grep", "find", "ls", SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL]);
	assert.deepEqual(
		[...declared].filter((name) => !allowed.has(name)),
		[],
		`the side session must only ever gain its read-only tools (saw ${JSON.stringify([...declared])})`,
	);
	assert.equal(messageText(seen[0] ?? []).includes("ALPHA"), true, "the completed parent history is the seed");

	await sidechannel.dispose();
	assert.equal(fs.readFileSync(h.evidencePath, "utf8"), EVIDENCE_TEXT, "the side channel never mutates evidence");
	fs.rmSync(h.root, { recursive: true, force: true });
});

test("6.1 real SDK: a duplicate submit fails the ask closed without a second reply", { timeout: 90_000 }, async () => {
	const h = await makeHarness();
	const ctx = makeCtx(h);
	const sidechannel = makeSidechannel(h, ctx);

	script(h, [
		() =>
			fauxAssistantMessage(
				[
					fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { kind: "reply", message: "ALPHA" }),
					fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { kind: "reply", message: "BETA" }),
				],
				{ stopReason: "toolUse" },
			),
		() => fauxAssistantMessage("done"),
	]);

	const outcome = await sidechannel.respond({ ...ask(), requestId: "ask-3" });
	assert.equal(outcome.kind, "error", "two submits in one ask must never answer the question");
	assert.equal(outcome.kind === "error" ? outcome.code : "", "session_error");
	const records = sidechannel.records();
	assert.equal(records.length, 1);
	assert.equal(records[0]?.deliveryStatus, "failed");
	assert.equal(records[0]?.answer, undefined, "no answer may be recorded for a duplicated submit");

	await sidechannel.dispose();
	fs.rmSync(h.root, { recursive: true, force: true });
});

test("6.1 real SDK: cache warming stays off so one ask costs one scripted turn set", { timeout: 90_000 }, async () => {
	const h = await makeHarness();
	const ctx = makeCtx(h);
	const sidechannel = makeSidechannel(h, ctx);

	script(h, [
		() => fauxAssistantMessage(fauxToolCall("read", { path: h.evidencePath }), { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { kind: "reply", message: "ALPHA" }), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("answer submitted"),
	]);

	const before = h.steps;
	assert.equal(before, 0);
	const outcome = await sidechannel.respond({ ...ask(), requestId: "ask-4" });
	assert.equal(outcome.kind, "reply");
	// Exactly the scripted steps ran: nothing replayed the prompt for cache
	// warming, and no fallback request was issued.
	assert.equal(h.steps, 3, `expected exactly 3 provider requests, saw ${h.steps}`);
	assert.equal(sidechannel.usage().turns, 3, "only generated assistant messages are billed");

	await sidechannel.dispose();
	fs.rmSync(h.root, { recursive: true, force: true });

});

test("6.1 real SDK: a schema-level rejected submit still locks the ask shut", { timeout: 90_000 }, async () => {
	const h = await makeHarness();
	const ctx = makeCtx(h);
	const sidechannel = makeSidechannel(h, ctx);

	script(h, [
		// The SDK's own schema layer must hand this through (nothing is required), so
		// `execute` sees it and locks the ask instead of silently ignoring it.
		() => fauxAssistantMessage(fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { message: "invalid missing kind" }), { stopReason: "toolUse" }),
		// A later, perfectly well-formed submit must NOT rescue the question.
		() => fauxAssistantMessage(fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { kind: "reply", message: "ALPHA" }), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("done"),
	]);

	const outcome = await sidechannel.respond({ ...ask(), requestId: "ask-invalid-then-legal" });
	assert.equal(outcome.kind, "error", "an invalid submit must lock the ask, even through the real SDK");
	assert.equal(outcome.kind === "error" ? outcome.code : "", "session_error");
	const records = sidechannel.records();
	assert.equal(records.length, 1, "one record for the failed ask");
	assert.equal(records[0]?.deliveryStatus, "failed");
	assert.equal(records[0]?.answer, undefined, "no answer may be recorded after a rejected submit");

	await sidechannel.dispose();
	fs.rmSync(h.root, { recursive: true, force: true });

});

test("6.1 real SDK: null / array / string submits are locked too, never rescued", { timeout: 120_000 }, async () => {
	for (const [label, payload] of [
		["null", null],
		["array", []],
		["string", "ALPHA"],
	] as const) {
		const h = await makeHarness();
		const ctx = makeCtx(h);
		const sidechannel = makeSidechannel(h, ctx);
		script(h, [
			() => fauxAssistantMessage(fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, payload as never), { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxToolCall(SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL, { kind: "reply", message: "ALPHA" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);
		const outcome = await sidechannel.respond({ ...ask(), requestId: `ask-${label}` });
		assert.equal(outcome.kind, "error", `a ${label} submit must lock the ask`);
		assert.equal(sidechannel.records().at(-1)?.deliveryStatus, "failed");
		assert.equal(sidechannel.records().at(-1)?.answer, undefined);
		await sidechannel.dispose();
		fs.rmSync(h.root, { recursive: true, force: true });
	}
});

