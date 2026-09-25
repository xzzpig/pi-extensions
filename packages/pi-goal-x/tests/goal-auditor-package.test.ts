import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { RUNTIME_AGENT_REGISTER_EVENT, type RuntimeAgentDefinition } from "@xzzpig/pi-subagents/agents";
import { resolveSubagentLaunchContract } from "@xzzpig/pi-subagents/preflight";
import {
	DEFAULT_AUDITOR_DEFINITION,
	disposeDefaultGoalAuditor,
	getDefaultGoalAuditorRegistration,
	mergeAuditorDefinition,
	registerDefaultGoalAuditor,
} from "../extensions/goal-auditor-registration.ts";
import { invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import registerGoalAuditorProgress, {
	REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX,
	REPORT_AUDITOR_PROGRESS_TOOL_NAME,
} from "../extensions/goal-auditor-progress.ts";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import { createGoal } from "../extensions/goal-record.ts";

let tempDir = "";
let oldAgentDir: string | undefined;
let oldExtraAgentDirs: string | undefined;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-package-"));
	oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
	// Isolate from ambient e2e state: a stale PI_SUBAGENT_EXTRA_AGENT_DIRS
	// pointing at a materialized 0.7.4 goal-auditor.md from earlier e2e phases
	// would be discovered as a user-scope file agent and mask the runtime-only
	// registration-under-test.
	oldExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
});

afterEach(() => {
	if (oldExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = oldExtraAgentDirs;
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("D-08: goal package removes its transcript runtime and shared transcript dependency", () => {
	const packageRoot = path.resolve(path.dirname(new URL("../package.json", import.meta.url).pathname));
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
	assert.equal(manifest.dependencies?.["@xzzpig/pi-components"], undefined);
	assert.equal(manifest.bundledDependencies?.includes("@xzzpig/pi-components") ?? false, false);
	assert.equal(manifest.bundleDependencies?.includes("@xzzpig/pi-components") ?? false, false);
	assert.equal(manifest.files?.includes("CHANGELOG.md"), true);
	assert.equal(fs.existsSync(path.join(packageRoot, "extensions", "widgets", "auditor-transcript-overlay.ts")), false);
	assert.equal(fs.existsSync(path.join(packageRoot, "tests", "auditor-transcript-overlay.test.ts")), false);
	assert.doesNotMatch(fs.readFileSync(path.join(packageRoot, "extensions", "goal-state.ts"), "utf8"), /SessionTranscript|lastAuditTranscript/);
	assert.doesNotMatch(
		fs.readFileSync(path.join(packageRoot, "extensions", "goal-commands.ts"), "utf8"),
		/registerCommand\(["']goal-audit["']/,
	);
	assert.match(fs.readFileSync(path.join(packageRoot, "README.md"), "utf8"), /Fleet/);
});

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
function installFakeOwner(events: ReturnType<typeof createBus>): { names: string[]; definitions: unknown[]; disposed: () => number } {
	const names: string[] = [];
	const definitions: unknown[] = [];
	let disposed = 0;
	events.on(RUNTIME_AGENT_REGISTER_EVENT, (rawRequest) => {
		const request = rawRequest as { name: string; definition: unknown; result?: unknown };
		if (request.result !== undefined) return;
		names.push(request.name);
		definitions.push(request.definition);
		request.result = { ok: true, registration: { dispose: () => { disposed += 1; } } };
	});
	return { names, definitions, disposed: () => disposed };
}

test("D-05/D-12: default auditor definition keeps the audit wiring code-owned", () => {
	assert.equal(DEFAULT_AUDITOR_DEFINITION.description, "Independent read-only completion auditor for pi-goal-x");
	assert.deepEqual(DEFAULT_AUDITOR_DEFINITION.tools, ["read", "grep", "find", "ls", "bash", REPORT_AUDITOR_PROGRESS_TOOL_NAME]);
	assert.equal(DEFAULT_AUDITOR_DEFINITION.systemPromptMode, "replace");
	assert.equal(DEFAULT_AUDITOR_DEFINITION.inheritProjectContext, false);
	assert.equal(DEFAULT_AUDITOR_DEFINITION.inheritSkills, false);
	assert.equal(DEFAULT_AUDITOR_DEFINITION.defaultContext, "fresh");
	assert.equal(DEFAULT_AUDITOR_DEFINITION.acceptanceRole, "read-only");
	assert.equal(DEFAULT_AUDITOR_DEFINITION.subagentOnlyExtensions?.length, 1);
	assert.ok(
		DEFAULT_AUDITOR_DEFINITION.subagentOnlyExtensions?.[0]?.endsWith(path.join("extensions", "goal-auditor-progress.ts")),
		"the child-only progress provider is referenced by an absolute package-owned path",
	);
	assert.match(DEFAULT_AUDITOR_DEFINITION.systemPrompt, /structured_output tool exactly once/);
});

test("D-05/D-12: auditor definition settings merge by tier without breaking the protocol", () => {
	const merged = mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, {
		systemPromptExtra: "Also check the changelog.",
		tools: ["read", "grep"],
		excludeTools: ["find"],
		subagentOnlyExtensions: ["/tmp/extra-extension.ts"],
		extensions: ["/tmp/ambient-extension.ts"],
		skills: ["repo-review"],
		inheritProjectContext: true,
		sandbox: "reviewer-strict",
		permissionProfile: "reviewer",
	});
	assert.ok(merged.systemPrompt.endsWith("Also check the changelog."));
	assert.ok(merged.systemPrompt.startsWith(DEFAULT_AUDITOR_DEFINITION.systemPrompt));
	assert.deepEqual(merged.tools, ["read", "grep", REPORT_AUDITOR_PROGRESS_TOOL_NAME], "tools replace the default allowlist with the progress tool retained at the tail");
	assert.equal(merged.subagentOnlyExtensions?.[0], DEFAULT_AUDITOR_DEFINITION.subagentOnlyExtensions?.[0], "the required progress provider always leads the union");
	assert.deepEqual(merged.subagentOnlyExtensions?.slice(1), ["/tmp/extra-extension.ts"]);
	assert.deepEqual(merged.extensions, ["/tmp/ambient-extension.ts"]);
	assert.deepEqual(merged.skills, ["repo-review"]);
	assert.equal(merged.inheritProjectContext, true);
	assert.equal(merged.sandbox, "reviewer-strict", "sandbox profile selector overrides when provided");
	assert.equal(merged.permissionProfile, "reviewer", "permission profile selector overrides when provided");
	assert.ok(
		mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, { tools: ["read"] }).tools?.includes(REPORT_AUDITOR_PROGRESS_TOOL_NAME),
		"the progress tool survives allowlist replacement even when omitted",
	);
	assert.deepEqual(
		mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, { tools: ["read", "bash"], excludeTools: ["bash"] }).tools,
		["read", REPORT_AUDITOR_PROGRESS_TOOL_NAME],
		"excludeTools subtracts from the effective allowlist",
	);
	assert.equal(mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, {}), DEFAULT_AUDITOR_DEFINITION);
	assert.equal(mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, undefined), DEFAULT_AUDITOR_DEFINITION);
});

test("D-12: profile selectors merge independently and stay unset when absent", () => {
	const sandboxOnly = mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, { sandbox: "strict" });
	assert.equal(sandboxOnly.sandbox, "strict");
	assert.equal(sandboxOnly.permissionProfile, undefined, "untouched profile field stays unset");
	assert.deepEqual(sandboxOnly.tools, DEFAULT_AUDITOR_DEFINITION.tools, "profile selector alone does not disturb the tool allowlist");
	const permissionOnly = mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, { permissionProfile: "readonly" });
	assert.equal(permissionOnly.permissionProfile, "readonly");
	assert.equal(permissionOnly.sandbox, undefined, "untouched sandbox stays unset");
	assert.equal(mergeAuditorDefinition(DEFAULT_AUDITOR_DEFINITION, { sandbox: "strict" }).subagentOnlyExtensions?.length, DEFAULT_AUDITOR_DEFINITION.subagentOnlyExtensions?.length, "profile selector alone does not disturb the progress-provider union length");
});

test("D-05/D-12: registration requests the default agent when the name is free", async () => {
	const project = path.join(tempDir, "registration-project");
	fs.mkdirSync(project, { recursive: true });
	const bus = createBus();
	const owner = installFakeOwner(bus);
	const freeResolver = (async () => ({ ok: false as const, code: "missing_agent" as const, message: "missing" }));
	const result = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: freeResolver as any,
	});
	assert.equal(result.registered, true);
	assert.deepEqual(owner.names, ["goal-auditor"]);
	const definition = owner.definitions[0] as RuntimeAgentDefinition;
	assert.ok(definition.tools?.includes(REPORT_AUDITOR_PROGRESS_TOOL_NAME));
	// Re-registration replaces the previous handle instead of colliding.
	const second = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: freeResolver as any,
	});
	assert.equal(second.registered, true);
	assert.equal(owner.disposed(), 1, "the previous registration handle was disposed");
	disposeDefaultGoalAuditor();
	assert.equal(owner.disposed(), 2);
});

test("D-04/D-12: registration is skipped when a configured goal-auditor exists", async () => {
	const project = path.join(tempDir, "shadowed-project");
	fs.mkdirSync(project, { recursive: true });
	const bus = createBus();
	const owner = installFakeOwner(bus);
	const result = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: (async () => ({ ok: true as const, contract: { agent: { name: "goal-auditor", source: "project" } } })) as any,
	});
	assert.equal(result.registered, false);
	assert.equal(result.reason, "shadowed");
	assert.deepEqual(owner.names, [], "no runtime agent is registered for a shadowed name");
});

test("D-12: registration without an owner listener fails soft", async () => {
	const project = path.join(tempDir, "ownerless-project");
	fs.mkdirSync(project, { recursive: true });
	const bus = createBus();
	const result = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: (async () => ({ ok: false as const, code: "missing_agent" as const, message: "missing" })) as any,
	});
	assert.equal(result.registered, false);
	assert.equal(result.reason, "unavailable");
	assert.match(result.error ?? "", /pi-subagents/);
});

test("D-12: preflight outcomes other than missing_agent never register (collision safety)", async () => {
	const project = path.join(tempDir, "broken-config-project");
	fs.mkdirSync(project, { recursive: true });
	const bus = createBus();
	const owner = installFakeOwner(bus);
	const result = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: (async () => ({ ok: false as const, code: "denied_required_tool" as const, message: "broken config" })) as any,
	});
	assert.equal(result.registered, false);
	assert.equal(result.reason, "shadowed", "a configured agent exists; registering would collide at discovery time");
	assert.deepEqual(owner.names, []);
});

test("D-04: packaged goal auditor discovery follows the installed pi-subagents resource policy", async () => {
	const project = path.join(tempDir, "project-auditor-resolution");
	const projectAgents = path.join(project, ".pi", "agents");
	fs.mkdirSync(projectAgents, { recursive: true });
	fs.writeFileSync(path.join(projectAgents, "goal-auditor.md"), `---
name: goal-auditor
description: Project override
tools: read
---

Use the project configuration.
`, "utf8");

	const resolved = await resolveSubagentLaunchContract({
		agent: "goal-auditor",
		cwd: project,
		context: "fresh",
		availableModels: [],
		outputSchema: { type: "object", properties: {}, additionalProperties: false },
	});
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.equal(resolved.contract.agent.source, "project");
	assert.deepEqual(resolved.contract.tools.declaredBuiltin, ["read"]);
});

test("D-03/D-11: missing configured model fails before dispatch", async () => {	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "agents", "goal-auditor.md"), `---
name: goal-auditor
description: Global default auditor
---

Auditor body.
`, "utf8");
	const project = path.join(tempDir, "missing-model-project");
	fs.mkdirSync(project, { recursive: true });
	let dispatched = false;
	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "available" }] } } as any,
		events: {
			on: () => () => {},
			emit: (event) => {
				if (event === "prompt-template:subagent:request") dispatched = true;
			},
		},
		goal: createGoal({ objective: "Verify missing model preflight", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: missing model preflight",
		settings: { auditor: { provider: "mock", model: "missing" } },
	});
	assert.equal(dispatched, false);
	assert.match(result.error ?? "", /Goal auditor preflight failed/);
});

test("D-11/I-21: runtime-registered default auditor passes the audit preflight through the local registration record", async () => {
	// Phase D proved the amended spec's core bare -e scenario was broken: the
	// audit preflight resolved the agent through file-only discovery, which
	// cannot see the session_start runtime registration, so audits died with
	// 'Unknown agent: goal-auditor'. The runtime registry is keyed by the OWNING
	// extension's api identity, so the preflight must trust this process's own
	// registration record while the file view reports missing_agent; the
	// delegation executor (which runs inside pi-subagents, under the owning key)
	// launches it.
	const project = path.join(tempDir, "runtime-registered-project");
	fs.mkdirSync(project, { recursive: true });
	const bus = createBus();
	const owner = installFakeOwner(bus);
	const registration = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: (async () => ({ ok: false as const, code: "missing_agent" as const, message: "Unknown agent: goal-auditor" })) as any,
	});
	assert.equal(registration.registered, true, "the runtime registration must succeed for the free name");
	assert.deepEqual(owner.names, ["goal-auditor"]);
	try {
		const events = createBus();
		let dispatched = false;
		let capturedAgent: string | undefined;
		events.on("prompt-template:subagent:request", (value) => {
			dispatched = true;
			capturedAgent = (value as { agent?: string }).agent;
			const request = value as { requestId: string; ownerRunId: string; nodeId: string };
			events.emit("prompt-template:subagent:started", {
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
			});
			events.emit("prompt-template:subagent:response", {
				...request,
				status: "completed",
				model: "mock/auditor",
				result: {
					kind: "structured",
					value: { verdict: "approved", report: "Runtime definition reachable.", findings: [] },
				},
			});
		});
		const result = await runGoalCompletionAuditor({
			ctx: { cwd: project } as any,
			events,
			goal: createGoal({ objective: "Verify runtime-registered preflight fallback", autoContinue: true, sisyphus: false }),
			detailedSummary: "Goal: runtime preflight fallback",
		});
		assert.equal(dispatched, true, "the runtime-registered auditor must dispatch instead of failing preflight");
		assert.equal(capturedAgent, "goal-auditor");
		assert.equal(result.approved, true, `unexpected result: ${result.error}`);
		assert.match(result.output, /Runtime definition reachable\./);
	} finally {
		disposeDefaultGoalAuditor();
	}
});

test("D-11: audit fails closed when no configured agent and no runtime registration exist", async () => {
	const project = path.join(tempDir, "unknown-agent-project");
	fs.mkdirSync(project, { recursive: true });
	let dispatched = false;
	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project } as any,
		events: {
			on: () => () => {},
			emit: (event) => {
				if (event === "prompt-template:subagent:request") dispatched = true;
			},
		},
		goal: createGoal({ objective: "Verify unknown agent fails closed", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: unknown agent",
	});
	assert.equal(dispatched, false);
	assert.match(result.error ?? "", /Goal auditor preflight failed/);
	assert.match(result.error ?? "", /goal-auditor/);
	assert.match(result.error ?? "", /neither a configured agent nor an active runtime registration/);
});

test("D-11/I-20: runtime fallback enforcement retains the protocol progress tool", async () => {
	const project = path.join(tempDir, "stripped-tools-project");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "pi-goal-x-settings.json"),
		JSON.stringify({ auditor: { tools: ["read", "grep"], excludeTools: [REPORT_AUDITOR_PROGRESS_TOOL_NAME] } }),
		"utf8",
	);
	invalidateGoalSettingsCache();
	const bus = createBus();
	installFakeOwner(bus);
	const registration = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: (async () => ({ ok: false as const, code: "missing_agent" as const, message: "Unknown agent: goal-auditor" })) as any,
	});
	assert.equal(registration.registered, true);
	try {
		let dispatched = false;
		const result = await runGoalCompletionAuditor({
			ctx: { cwd: project } as any,
			events: {
				on: () => () => {},
				emit: (event) => {
					if (event === "prompt-template:subagent:request") dispatched = true;
				},
			},
			goal: createGoal({ objective: "Verify protocol tool enforcement", autoContinue: true, sisyphus: false }),
			detailedSummary: "Goal: protocol tool",
		});
		assert.equal(dispatched, false, "auditor with the progress tool excluded must fail closed");
		assert.match(result.error ?? "", /must retain the required report_auditor_progress tool/);
	} finally {
		disposeDefaultGoalAuditor();
		invalidateGoalSettingsCache();
	}
});

test("D-11: a runtime registration never substitutes for a different configured auditor name", async () => {
	// Fail-closed matrix (3): `auditor.agent` may name ANY agent. The local
	// registration record only ever describes the default goal-auditor, so it
	// must never validate a differently-named auditor.
	const project = path.join(tempDir, "name-mismatch-project");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "pi-goal-x-settings.json"),
		JSON.stringify({ auditor: { agent: "other-auditor" } }),
		"utf8",
	);
	invalidateGoalSettingsCache();
	const bus = createBus();
	installFakeOwner(bus);
	const registration = await registerDefaultGoalAuditor({ events: bus } as any, project, {
		resolveLaunchContract: (async () => ({ ok: false as const, code: "missing_agent" as const, message: "Unknown agent: goal-auditor" })) as any,
	});
	assert.equal(registration.registered, true, "the default name is free, so the local record exists");
	try {
		let dispatched = false;
		const result = await runGoalCompletionAuditor({
			ctx: { cwd: project } as any,
			events: {
				on: () => () => {},
				emit: (event) => {
					if (event === "prompt-template:subagent:request") dispatched = true;
				},
			},
			goal: createGoal({ objective: "Verify auditor name mismatch fails closed", autoContinue: true, sisyphus: false }),
			detailedSummary: "Goal: name mismatch",
		});
		assert.equal(dispatched, false, "a differently named auditor must not be validated by the goal-auditor record");
		assert.match(result.error ?? "", /auditor\.agent resolves to 'other-auditor'/);
		assert.match(result.error ?? "", /the active runtime registration is 'goal-auditor'/);
	} finally {
		disposeDefaultGoalAuditor();
		invalidateGoalSettingsCache();
	}
});

test("D-11: a configured goal-auditor shadows the local registration and still audits through discovery", async () => {
	// Fail-closed matrix (2): when a configured `goal-auditor` already exists,
	// registration is skipped (registering would collide at discovery time) and
	// the audit must resolve through the ordinary file path instead.
	const project = path.join(tempDir, "shadowed-audit-project");
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "agents", "goal-auditor.md"),
		`---
name: goal-auditor
description: Project override auditor
tools: read, grep, find, ls, bash, ${REPORT_AUDITOR_PROGRESS_TOOL_NAME}
---

Use the project configuration.
`,
		"utf8",
	);
	invalidateGoalSettingsCache();
	const bus = createBus();
	const owner = installFakeOwner(bus);
	const registration = await registerDefaultGoalAuditor({ events: bus } as any, project);
	assert.equal(registration.registered, false);
	assert.equal(registration.reason, "shadowed");
	assert.deepEqual(owner.names, [], "a configured name is never double-registered at runtime");
	assert.equal(getDefaultGoalAuditorRegistration(), undefined, "no local record exists for a shadowed name");
	const events = createBus();
	let dispatched = false;
	events.on("prompt-template:subagent:request", (value) => {
		dispatched = true;
		const request = value as { requestId: string; ownerRunId: string; nodeId: string };
		events.emit("prompt-template:subagent:response", {
			...request,
			status: "completed",
			model: "mock/auditor",
			result: { kind: "structured", value: { verdict: "approved", report: "Configured agent reachable.", findings: [] } },
		});
	});
	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "auditor" }] } } as any,
		events,
		goal: createGoal({ objective: "Verify configured auditor path", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: configured auditor",
	});
	assert.equal(dispatched, true, `the configured auditor must dispatch: ${result.error}`);
	assert.equal(result.approved, true, `unexpected result: ${result.error}`);
	assert.match(result.output, /Configured agent reachable\./);
});

test("D-05: child-only progress provider registers the required progress tool", async () => {
	let definition: any;
	registerGoalAuditorProgress({ registerTool: (tool: unknown) => { definition = tool; } } as any);
	assert.equal(definition?.name, REPORT_AUDITOR_PROGRESS_TOOL_NAME);
	const progress = { label: "Inspecting workspace...", percentage: 20 };
	const result = await definition.execute("progress-1", progress);
	assert.equal(
		result.content[0]?.text,
		`Progress reported: Inspecting workspace... (20%)\n${REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX}${JSON.stringify(progress)}`,
	);
	assert.deepEqual(result.details, progress);
});
