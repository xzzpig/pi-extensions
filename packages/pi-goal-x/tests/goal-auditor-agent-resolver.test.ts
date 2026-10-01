// [fork] Tests for the cross-extension auditor-agent resolver registry (S2
// seam, ./extensions/goal-auditor-agent-resolver.ts) and its consumption by the
// completion-audit delegation preflight. Pins the S2 contract:
//   - a resolver hit lets a configured agent that file-based discovery cannot
//     see (a runtime registration owned by pi-subagents) pass preflight and
//     dispatch, with the protocol tool enforced on the resolver's definition;
//   - a resolver miss leaves the original missing_agent fallback byte-identical
//     (same error, no dispatch);
//   - a resolver for a foreign name never intercepts the plain goal-auditor
//     path (normal goals stay on the exact original route).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { RUNTIME_AGENT_REGISTER_EVENT, type RuntimeAgentDefinition } from "@xzzpig/pi-subagents/agents";
import { registerAuditorAgentResolver, resolveExternalAuditorAgentDefinition } from "../extensions/goal-auditor-agent-resolver.ts";
import { disposeDefaultGoalAuditor, registerDefaultGoalAuditor } from "../extensions/goal-auditor-registration.ts";
import { REPORT_AUDITOR_PROGRESS_TOOL_NAME } from "../extensions/goal-auditor-progress.ts";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import { invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import { createGoal } from "../extensions/goal-record.ts";

let tempDir = "";
let oldAgentDir: string | undefined;
let oldExtraAgentDirs: string | undefined;
let resolverDisposes: Array<() => void> = [];

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-agent-resolver-"));
	oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
	oldExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	invalidateGoalSettingsCache();
});

afterEach(() => {
	for (const dispose of resolverDisposes.splice(0)) dispose();
	disposeDefaultGoalAuditor();
	if (oldExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = oldExtraAgentDirs;
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	fs.rmSync(tempDir, { recursive: true, force: true });
	invalidateGoalSettingsCache();
});

function trackResolver(resolver: Parameters<typeof registerAuditorAgentResolver>[0]): () => void {
	const dispose = registerAuditorAgentResolver(resolver);
	resolverDisposes.push(dispose);
	return dispose;
}

function createBus(): {
	on(event: string, handler: (value: unknown) => void): () => void;
	emit(event: string, value: unknown): void;
} {
	const handlers = new Map<string, Array<(value: unknown) => void>>();
	return {
		on(event, handler) {
			const entries = handlers.get(event) ?? [];
			entries.push(handler);
			handlers.set(event, entries);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event, value) {
			for (const handler of [...(handlers.get(event) ?? [])]) handler(value);
		},
	};
}

/** Simulate the installed pi-subagents owner answering registration requests. */
function installFakeOwner(events: ReturnType<typeof createBus>): { names: string[] } {
	const names: string[] = [];
	events.on(RUNTIME_AGENT_REGISTER_EVENT, (rawRequest) => {
		const request = rawRequest as { name: string; definition: unknown; result?: unknown };
		if (request.result !== undefined) return;
		names.push(request.name);
		request.result = { ok: true, registration: { dispose: () => {} } };
	});
	return { names };
}

/**
 * Answer the delegation request the way the pi-subagents executor would: an
 * ack, then a terminal structured approval for the exact delegation identity.
 */
function respondWithApproval(events: ReturnType<typeof createBus>): { dispatched: () => boolean; agent: () => string | undefined } {
	let dispatched = false;
	let agent: string | undefined;
	events.on("prompt-template:subagent:request", (value) => {
		const request = value as { requestId: string; ownerRunId: string; nodeId: string; agent?: string };
		dispatched = true;
		agent = request.agent;
		events.emit("prompt-template:subagent:started", {
			requestId: request.requestId,
			ownerRunId: request.ownerRunId,
			nodeId: request.nodeId,
		});
		events.emit("prompt-template:subagent:response", {
			...request,
			status: "completed",
			model: "mock/opsx-reviewer",
			result: {
				kind: "structured",
				value: { verdict: "approved", report: "Resolver-supplied agent executed the audit.", findings: [] },
			},
		});
	});
	return { dispatched: () => dispatched, agent: () => agent };
}

function opsxDefinition(tools: string[]): RuntimeAgentDefinition {
	return {
		description: "OpenSpec plan reviewer supplied by a consumer extension",
		systemPrompt: "You review goal execution against the accepted openspec proposal.",
		tools,
	};
}

// ── registry unit contract ──────────────────────────────────────────────────

test("S2 registry: name-keyed lookup, dispose, and idempotent re-registration", () => {
	const definition = opsxDefinition(["read"]);
	const resolver = (name: string): RuntimeAgentDefinition | undefined => (name === "opsx-reviewer" ? definition : undefined);
	const disposeFirst = trackResolver(resolver);
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), definition);
	assert.equal(resolveExternalAuditorAgentDefinition("someone-else"), undefined);

	trackResolver(resolver); // same function reference: deduplicated to a single entry
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), definition);
	disposeFirst();
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), undefined, "one dispose removes the deduplicated single entry");
	disposeFirst(); // a second dispose is safe
});

test("S2 registry: first registered resolver wins; non-functions are rejected", () => {
	const first = opsxDefinition(["read"]);
	const second = opsxDefinition(["grep"]);
	trackResolver((name) => (name === "opsx-reviewer" ? first : undefined));
	trackResolver((name) => (name === "opsx-reviewer" ? second : undefined));
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), first);
	resolverDisposes[0]!();
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), second, "the next registered resolver takes over after a dispose");

	assert.throws(() => registerAuditorAgentResolver(undefined as any), /must be a function/);
	assert.throws(() => registerAuditorAgentResolver(42 as any), /must be a function/);
});

test("S2 registry: a throwing resolver or a non-definition answer degrades to a miss", () => {
	let calls = 0;
	trackResolver(() => {
		calls += 1;
		throw new Error("resolver exploded");
	});
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), undefined, "a throwing resolver is a miss, not a crash");
	assert.equal(calls, 1);

	trackResolver(() => "not-a-definition" as any);
	trackResolver(() => ({}) as any);
	trackResolver(() => null as any);
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), undefined, "answers without description/systemPrompt are misses");

	const valid = opsxDefinition(["read"]);
	trackResolver(() => valid);
	assert.equal(resolveExternalAuditorAgentDefinition("opsx-reviewer"), valid, "a valid resolver after invalid ones still resolves");
});

test("S2 registry: blank agent names never consult resolvers", () => {
	let calls = 0;
	trackResolver(() => {
		calls += 1;
		return opsxDefinition(["read"]);
	});
	assert.equal(resolveExternalAuditorAgentDefinition(""), undefined);
	assert.equal(resolveExternalAuditorAgentDefinition("   "), undefined);
	assert.equal(calls, 0, "no resolver is invoked for a blank name");
});

// ── delegation preflight integration (real file-based preflight) ────────────

test("S2 preflight: a resolver-backed configured agent dispatches with protocol enforcement", async () => {
	const project = path.join(tempDir, "resolver-hit-project");
	fs.mkdirSync(project, { recursive: true });
	trackResolver((name) => (name === "opsx-reviewer" ? opsxDefinition(["read", "grep", "bash", REPORT_AUDITOR_PROGRESS_TOOL_NAME]) : undefined));
	const events = createBus();
	const responder = respondWithApproval(events);
	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project } as any,
		events,
		goal: createGoal({ objective: "Verify resolver-backed audit", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: resolver-backed audit",
		settings: { auditor: { agent: "opsx-reviewer" } },
	});
	assert.equal(responder.dispatched(), true, "the resolver hit must dispatch instead of failing preflight");
	assert.equal(responder.agent(), "opsx-reviewer");
	assert.equal(result.approved, true, `unexpected result: ${result.error}`);
	assert.match(result.output, /Resolver-supplied agent executed the audit\./);
});

test("S2 preflight: the resolver's definition is still protocol-enforced", async () => {
	const project = path.join(tempDir, "resolver-no-protocol-project");
	fs.mkdirSync(project, { recursive: true });
	trackResolver((name) => (name === "opsx-reviewer" ? opsxDefinition(["read"]) : undefined));
	const events = createBus();
	const responder = respondWithApproval(events);
	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project } as any,
		events,
		goal: createGoal({ objective: "Verify resolver protocol enforcement", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: resolver protocol enforcement",
		settings: { auditor: { agent: "opsx-reviewer" } },
	});
	assert.equal(responder.dispatched(), false, "a resolver definition without the progress tool must not dispatch");
	assert.match(result.error ?? "", /must retain the required report_auditor_progress tool/);
});

test("S2 preflight: a resolver miss keeps the original missing_agent fallback byte-identical", async () => {
	const project = path.join(tempDir, "resolver-miss-project");
	fs.mkdirSync(project, { recursive: true });
	trackResolver((name) => (name === "someone-else" ? opsxDefinition(["read", REPORT_AUDITOR_PROGRESS_TOOL_NAME]) : undefined));
	const events = createBus();
	const responder = respondWithApproval(events);
	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project } as any,
		events,
		goal: createGoal({ objective: "Verify resolver miss fallback", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: resolver miss fallback",
		settings: { auditor: { agent: "opsx-reviewer" } },
	});
	assert.equal(responder.dispatched(), false);
	assert.match(
		result.error ?? "",
		/'opsx-reviewer' is neither a configured agent nor an active runtime registration/,
		"the unchanged fallback error for an unresolvable configured agent",
	);
});

test("S2 preflight: a foreign-name resolver never intercepts the plain goal-auditor path", async () => {
	const project = path.join(tempDir, "normal-goal-project");
	fs.mkdirSync(project, { recursive: true });
	trackResolver((name) => (name === "opsx-reviewer" ? opsxDefinition(["read", REPORT_AUDITOR_PROGRESS_TOOL_NAME]) : undefined));
	const events = createBus();
	const responder = respondWithApproval(events);
	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project } as any,
		events,
		goal: createGoal({ objective: "Verify normal goal isolation", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: normal goal isolation",
	});
	assert.equal(responder.dispatched(), false);
	assert.match(
		result.error ?? "",
		/'goal-auditor' is neither a configured agent nor an active runtime registration/,
		"the plain default-agent path still reports the original missing-agent failure",
	);
});

test("S2 preflight: the default goal-auditor registration path is unchanged beside a foreign resolver", async () => {
	const project = path.join(tempDir, "default-registration-project");
	fs.mkdirSync(project, { recursive: true });
	trackResolver((name) => (name === "opsx-reviewer" ? opsxDefinition(["read", REPORT_AUDITOR_PROGRESS_TOOL_NAME]) : undefined));
	const bus = createBus();
	const owner = installFakeOwner(bus);
	const registration = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: (async () => ({ ok: false as const, code: "missing_agent" as const, message: "Unknown agent: goal-auditor" })) as any,
	});
	assert.equal(registration.registered, true);
	try {
		const events = createBus();
		const responder = respondWithApproval(events);
		const result = await runGoalCompletionAuditor({
			ctx: { cwd: project } as any,
			events,
			goal: createGoal({ objective: "Verify default auditor beside a resolver", autoContinue: true, sisyphus: false }),
			detailedSummary: "Goal: default auditor beside a resolver",
		});
		assert.equal(responder.dispatched(), true, "the local default registration must still dispatch");
		assert.equal(responder.agent(), "goal-auditor");
		assert.equal(result.approved, true, `unexpected result: ${result.error}`);
		assert.deepEqual(owner.names, ["goal-auditor"]);
	} finally {
		disposeDefaultGoalAuditor();
	}
});
