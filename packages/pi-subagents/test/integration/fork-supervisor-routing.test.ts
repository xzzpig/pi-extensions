/**
 * Integration: real delegation bridge + real executor + real native supervisor
 * channel, with a fake child runtime that "calls contact_supervisor" on its
 * first prompt.
 *
 * The fake child cannot write the native request file itself (it is a stub
 * process), so the test writes that file into the channel directory the
 * executor's binding resolved. Everything else is production code: the bridge,
 * the executor's runId/canonical-agent binding, the owner registry, the
 * dispatcher, the native channel poll, and the reply-file protocol.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	installSingleExecutionHooks,
	makeExecutor,
	mockPi,
	tempDir,
} from "../support/single-execution-fixture.ts";
import { createEventBus, events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { registerPromptTemplateDelegationBridge } from "../../src/slash/prompt-template-bridge.ts";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../../src/api/delegation.ts";
import {
	createSupervisorDispatcher,
	createSupervisorLaunchHooks,
	registerSupervisorResponderEventListener,
	type SupervisorLaunchHooks,
} from "../../src/intercom/fork-supervisor-routing.ts";
import {
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	resolveSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";

const SESSION_ID = "session-integration";
const ASK_ID = "ask-integration-1";

installSingleExecutionHooks();

function makeOwnerPi(events: ExtensionAPI["events"]): ExtensionAPI {
	const tools = new Map<string, unknown>();
	return {
		events,
		on() {
			return () => {};
		},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		getAllTools() {
			return [...tools.values()] as never;
		},
	} as unknown as ExtensionAPI;
}

function channelState(): SubagentState {
	return {
		supervisorOwnerSessionId: SESSION_ID,
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		asyncJobs: new Map(),
	} as unknown as SubagentState;
}

function request(agentName: string, overrides: Partial<SubagentDelegationRequest> = {}): SubagentDelegationRequest {
	return {
		requestId: "delegation-integration-1",
		ownerRunId: "goal-integration",
		nodeId: "goal-completion:goal-integration:1",
		agent: agentName,
		task: "Verify the evidence file.",
		context: "fresh",
		cwd: tempDir,
		model: "mock/model",
		skill: false,
		artifacts: false,
		result: { kind: "structured", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
		...overrides,
	};
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function writeAsk(channelDir: string, overrides: Record<string, unknown> = {}): void {
	ensureSupervisorChannelDir(channelDir);
	fs.writeFileSync(
		path.join(channelDir, "requests", `${ASK_ID}.json`),
		JSON.stringify({
			type: "subagent.supervisor.request",
			id: ASK_ID,
			createdAt: Date.now(),
			reason: "need_decision",
			message: "What is the release marker?",
			expectsReply: true,
			orchestratorSessionId: SESSION_ID,
			runId: "placeholder",
			agent: "placeholder",
			childIndex: 0,
			...overrides,
		}),
		"utf-8",
	);
}

describe("fork supervisor routing integration", () => {
	it("claims the earliest ask through the real bridge and emits exactly one terminal", async () => {
		const agentName = `audit-int-${Date.now().toString(36)}`;
		const releaseChild = path.join(tempDir, "release-child");
		mockPi.onCall({
			structuredOutputCapture: { ok: true },
			steps: [
				{ waitForPath: releaseChild, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "What is the release marker?" })] },
				{ jsonl: [
					{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
					{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
					{ type: "tool_execution_end", toolName: "structured_output" },
				] },
			],
		});

		const piEvents = createEventBus();
		const pi = makeOwnerPi(piEvents as ExtensionAPI["events"]);
		const wakes: unknown[] = [];
		const detaches: unknown[] = [];
		piEvents.on(INTERCOM_DETACH_REQUEST_EVENT, (payload: unknown) => detaches.push(payload));

		const state = channelState();
		let boundRunId: string | undefined;
		const channel = createNativeSupervisorChannel(pi, state, {
			getChannelDirs: () => ({ dirs: [resolveSupervisorChannelDir(boundRunId ?? "unbound", agentName, 0)] }),
			parentWake: { sendMessage: (message: unknown) => { wakes.push(message); } } as never,
			supervisorDispatcher: createSupervisorDispatcher(pi, () => SESSION_ID),
		});
		channel.registerTools();

		void registerSupervisorResponderEventListener(pi, () => SESSION_ID);
		let responderCalls = 0;

		const registrationRequest: Record<string, unknown> = {
			version: 1,
			scope: {
				sessionId: SESSION_ID,
				requestId: "delegation-integration-1",
				ownerRunId: "goal-integration",
				nodeId: "goal-completion:goal-integration:1",
				agent: agentName,
			},
			respond: () => {
				responderCalls += 1;
				return { kind: "reply", message: "ALPHA" };
			},
		};
		piEvents.emit("pi-subagents:supervisor-responder-register:v1", registrationRequest);
		assert.equal((registrationRequest.result as { ok?: boolean })?.ok, true);

		const realHooks = createSupervisorLaunchHooks(
			pi,
			{ requestId: "delegation-integration-1", ownerRunId: "goal-integration", nodeId: "goal-completion:goal-integration:1", agent: agentName },
			() => SESSION_ID,
		);
		assert.ok(realHooks, "expected launch hooks for the registered attempt");
		const hooks: SupervisorLaunchHooks = {
			beforeNativeChildLaunch: (route) => {
				realHooks!.beforeNativeChildLaunch(route);
				boundRunId = route.runId;
			},
			release: () => realHooks!.release(),
		};

		const terminals: SubagentDelegationResponse[] = [];
		piEvents.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload: unknown) => terminals.push(payload as SubagentDelegationResponse));

		const bridge = registerPromptTemplateDelegationBridge({
			events: piEvents as never,
			getContext: () => makeMinimalCtx(tempDir),
			execute: async () => {
				throw new Error("legacy path must not run");
			},
			executeStructured: async (requestId, params, signal, ctx, onUpdate) => {
				const executor = makeExecutor([makeAgent(agentName, { systemPrompt: "Intercom orchestration channel:" })], {}, false, undefined, true, new Map(), undefined, undefined, piEvents as never);
				return executor.executeDelegated(requestId, params, signal, onUpdate, ctx, hooks);
			},
		});

		const delegationRequest = request(agentName);
		piEvents.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, delegationRequest);

		await waitFor(() => boundRunId !== undefined, "the pre-prompt route binding");
		const channelDir = resolveSupervisorChannelDir(boundRunId!, agentName, 0);
		writeAsk(channelDir, { runId: boundRunId, agent: agentName });

		// Drive a real native poll: this is the same discover path the tool uses.
		const tool = (pi.getAllTools() as unknown as Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }>)
			.find((candidate) => candidate.name === "subagent_supervisor");
		assert.ok(tool, "native supervisor tool must be registered");
		await tool!.execute("poll" as never, { action: "pending" } as never, undefined as never, undefined as never, undefined as never);

		await waitFor(() => responderCalls === 1, "the responder claim");
		await waitFor(() => fs.existsSync(path.join(channelDir, "replies", `${ASK_ID}.json`)), "the native reply file");
		assert.equal(JSON.parse(fs.readFileSync(path.join(channelDir, "replies", `${ASK_ID}.json`), "utf-8")).message, "ALPHA");

		fs.writeFileSync(releaseChild, "", "utf-8");
		await waitFor(() => terminals.length === 1, "the single delegation terminal");
		await waitFor(() => mockPi.callCount() === 1, "the single child launch");

		assert.equal(wakes.length, 0, "a claimed ask must not wake the parent");
		assert.equal(detaches.length, 0, "a claimed ask must not request detach");
		assert.equal(responderCalls, 1);
		assert.equal(mockPi.callCount(), 1, "the child launches exactly once");
		assert.equal(terminals.length, 1, "the bridge emits exactly one terminal response");
		assert.equal(terminals[0]?.status, "completed");

		bridge.cancelAll();
		bridge.dispose();
		channel.dispose();
	});

	it("keeps native wake and detach for an unregistered attempt", async () => {
		const agentName = `audit-int-off-${Date.now().toString(36)}`;
		const releaseChild = path.join(tempDir, "release-child-off");
		mockPi.onCall({
			steps: [
				{ waitForPath: releaseChild, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Decision?" })] },
				{ output: "final" },
			],
		});
		const piEvents = createEventBus();
		const pi = makeOwnerPi(piEvents as ExtensionAPI["events"]);
		const wakes: unknown[] = [];
		const detaches: unknown[] = [];
		piEvents.on(INTERCOM_DETACH_REQUEST_EVENT, (payload: unknown) => detaches.push(payload));
		let boundRunId: string | undefined;
		const channel = createNativeSupervisorChannel(pi, channelState(), {
			getChannelDirs: () => ({ dirs: [resolveSupervisorChannelDir(boundRunId ?? "unbound", agentName, 0)] }),
			parentWake: { sendMessage: (message: unknown) => { wakes.push(message); } } as never,
			supervisorDispatcher: createSupervisorDispatcher(pi, () => SESSION_ID),
		});
		channel.registerTools();
		// No registration and no hooks: the default path must stay intact.
		const terminals: SubagentDelegationResponse[] = [];
		piEvents.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload: unknown) => terminals.push(payload as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events: piEvents as never,
			getContext: () => makeMinimalCtx(tempDir),
			execute: async () => {
				throw new Error("legacy path must not run");
			},
			executeStructured: async (requestId, params, signal, ctx, onUpdate) => {
				const executor = makeExecutor([makeAgent(agentName, { systemPrompt: "Intercom orchestration channel:" })], {}, false, undefined, true, new Map(), undefined, undefined, piEvents as never);
				return executor.executeDelegated(requestId, params, signal, onUpdate, ctx, {
					beforeNativeChildLaunch: (route) => { boundRunId = route.runId; },
					release: () => {},
				});
			},
		});
		piEvents.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request(agentName, { requestId: "delegation-integration-off" }));

		await waitFor(() => boundRunId !== undefined, "the child route");
		const channelDir = resolveSupervisorChannelDir(boundRunId!, agentName, 0);
		writeAsk(channelDir, { runId: boundRunId, agent: agentName, id: "ask-integration-off" });
		const tool = (pi.getAllTools() as unknown as Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }>)
			.find((candidate) => candidate.name === "subagent_supervisor");
		await tool!.execute("poll" as never, { action: "pending" } as never, undefined as never, undefined as never, undefined as never);

		assert.equal(wakes.length, 1, "an unregistered ask keeps the native wake");
		assert.equal(detaches.length, 1, "an unregistered ask keeps the native detach request");

		fs.writeFileSync(releaseChild, "", "utf-8");
		await waitFor(() => terminals.length === 1, "the single delegation terminal");
		assert.equal(mockPi.callCount(), 1);
		bridge.cancelAll();
		bridge.dispose();
		channel.dispose();
	});

	it("does not claim when the intercom bridge is off", async () => {
		const agentName = `audit-int-bridgeoff-${Date.now().toString(36)}`;
		const releaseChild = path.join(tempDir, "release-child-bridgeoff");
		mockPi.onCall({
			steps: [
				{ waitForPath: releaseChild, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Decision?" })] },
				{ output: "final" },
			],
		});
		const piEvents = createEventBus();
		const pi = makeOwnerPi(piEvents as ExtensionAPI["events"]);
		const wakes: unknown[] = [];
		piEvents.on(INTERCOM_DETACH_REQUEST_EVENT, () => {});
		let boundRunId: string | undefined;
		let bridgeActive: boolean | undefined;
		let responderCalls = 0;
		const channel = createNativeSupervisorChannel(pi, channelState(), {
			getChannelDirs: () => ({ dirs: [resolveSupervisorChannelDir(boundRunId ?? "unbound", agentName, 0)] }),
			parentWake: { sendMessage: (message: unknown) => { wakes.push(message); } } as never,
			supervisorDispatcher: createSupervisorDispatcher(pi, () => SESSION_ID),
		});
		channel.registerTools();
		void registerSupervisorResponderEventListener(pi, () => SESSION_ID);
		const registrationRequest: Record<string, unknown> = {
			version: 1,
			scope: {
				sessionId: SESSION_ID,
				requestId: "delegation-integration-bridgeoff",
				ownerRunId: "goal-integration",
				nodeId: "goal-completion:goal-integration:1",
				agent: agentName,
			},
			respond: () => {
				responderCalls += 1;
				return { kind: "reply", message: "ALPHA" };
			},
		};
		piEvents.emit("pi-subagents:supervisor-responder-register:v1", registrationRequest);
		assert.equal((registrationRequest.result as { ok?: boolean })?.ok, true);
		const realHooks = createSupervisorLaunchHooks(
			pi,
			{ requestId: "delegation-integration-bridgeoff", ownerRunId: "goal-integration", nodeId: "goal-completion:goal-integration:1", agent: agentName },
			() => SESSION_ID,
		);
		assert.ok(realHooks);
		const terminals: SubagentDelegationResponse[] = [];
		piEvents.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload: unknown) => terminals.push(payload as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events: piEvents as never,
			getContext: () => makeMinimalCtx(tempDir),
			execute: async () => {
				throw new Error("legacy path must not run");
			},
			executeStructured: async (requestId, params, signal, ctx, onUpdate) => {
				const executor = makeExecutor([makeAgent(agentName, { systemPrompt: "Intercom orchestration channel:" })], {}, false, undefined, true, new Map(), undefined, undefined, piEvents as never);
				return executor.executeDelegated(requestId, params, signal, onUpdate, ctx, {
					beforeNativeChildLaunch: (route) => {
						realHooks!.beforeNativeChildLaunch(route);
						boundRunId = route.runId;
						bridgeActive = route.bridgeActive;
					},
					release: () => realHooks!.release(),
				});
			},
		});
		piEvents.emit(
			SUBAGENT_DELEGATION_REQUEST_EVENT,
			request(agentName, { requestId: "delegation-integration-bridgeoff", intercomBridge: { mode: "off" } }),
		);

		await waitFor(() => boundRunId !== undefined, "the child route");
		assert.equal(bridgeActive, false, "a bridge-off child has no supervisor capability");
		const channelDir = resolveSupervisorChannelDir(boundRunId!, agentName, 0);
		writeAsk(channelDir, { runId: boundRunId, agent: agentName, id: "ask-integration-bridgeoff" });
		const tool = (pi.getAllTools() as unknown as Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }>)
			.find((candidate) => candidate.name === "subagent_supervisor");
		await tool!.execute("poll" as never, { action: "pending" } as never, undefined as never, undefined as never, undefined as never);

		assert.equal(responderCalls, 0, "bridge off must not expand responder capability");
		assert.equal(wakes.length, 1, "an unbound route keeps the native wake");

		fs.writeFileSync(releaseChild, "", "utf-8");
		await waitFor(() => terminals.length === 1, "the single delegation terminal");
		bridge.cancelAll();
		bridge.dispose();
		channel.dispose();
	});
});
