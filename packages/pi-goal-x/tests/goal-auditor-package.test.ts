import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resolveSubagentLaunchContract } from "@xzzpig/pi-subagents/preflight";
import registerGoalAuditorProgress, {
	REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX,
	REPORT_AUDITOR_PROGRESS_TOOL_NAME,
} from "../extensions/goal-auditor-progress.ts";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import { createGoal } from "../extensions/goal-record.ts";

let tempDir = "";
let oldAgentDir: string | undefined;
let oldExtraAgentDirs: string | undefined;

function installGoalXPackage(agentDir: string): string {
	const packageRoot = path.resolve(path.dirname(new URL("../package.json", import.meta.url).pathname));
	const target = path.join(agentDir, "npm", "node_modules", "@xzzpig", "pi-goal-x");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.symlinkSync(packageRoot, target, "dir");
	return packageRoot;
}

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-package-"));
	oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	oldExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
	delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
});

afterEach(() => {
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	if (oldExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = oldExtraAgentDirs;
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

test("D-05/D-12: package goal-auditor is discoverable with its child-only progress provider", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	installGoalXPackage(agentDir);
	const project = path.join(tempDir, "project");
	fs.mkdirSync(project, { recursive: true });

	const preflight = await resolveSubagentLaunchContract({
		agent: "goal-auditor",
		cwd: project,
		context: "fresh",
		availableModels: [],
		outputSchema: { type: "object", properties: {}, additionalProperties: false },
	});

	assert.equal(preflight.ok, true);
	if (!preflight.ok) return;
	assert.equal(preflight.contract.agent.source, "package");
	assert.equal(preflight.contract.context, "fresh");
	assert.equal(preflight.contract.inheritProjectContext, false);
	assert.equal(preflight.contract.inheritSkills, false);
	assert.deepEqual(preflight.contract.tools.declaredBuiltin, ["read", "grep", "find", "ls", "bash", REPORT_AUDITOR_PROGRESS_TOOL_NAME]);
	assert.ok(preflight.contract.tools.effectiveAllowlist.includes("structured_output"));
	assert.ok(preflight.contract.tools.extensionArgs.includes("../extensions/goal-auditor-progress.ts"));
});

test("D-05/D-12: package default is materialized with an absolute progress provider before delegation", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	installGoalXPackage(agentDir);
	const project = path.join(tempDir, "package-fallback-project");
	fs.mkdirSync(project, { recursive: true });
	const before = await resolveSubagentLaunchContract({
		agent: "goal-auditor",
		cwd: project,
		context: "fresh",
		availableModels: [],
		outputSchema: { type: "object", properties: {}, additionalProperties: false },
	});
	assert.equal(before.ok, true);
	if (!before.ok) return;
	assert.equal(before.contract.agent.source, "package");

	const handlers = new Map<string, Array<(value: unknown) => void>>();
	const events = {
		on(event: string, handler: (value: unknown) => void): () => void {
			const entries = handlers.get(event) ?? [];
			entries.push(handler);
			handlers.set(event, entries);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, value: unknown): void {
			for (const handler of [...(handlers.get(event) ?? [])]) handler(value);
		},
	};
	events.on("prompt-template:subagent:request", (value) => {
		const identity = value as { requestId: string; ownerRunId: string; nodeId: string };
		events.emit("prompt-template:subagent:response", {
			...identity,
			status: "completed",
			result: { kind: "structured", value: { verdict: "approved", report: "Portable package default loaded.", findings: [] } },
		});
	});

	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project, modelRegistry: { getAvailable: () => [] } } as any,
		events,
		goal: createGoal({ objective: "Verify package default portability", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: package default portability",
	});
	assert.equal(result.approved, true);

	const after = await resolveSubagentLaunchContract({
		agent: "goal-auditor",
		cwd: project,
		context: "fresh",
		availableModels: [],
		outputSchema: { type: "object", properties: {}, additionalProperties: false },
	});
	assert.equal(after.ok, true);
	if (!after.ok) return;
	assert.equal(after.contract.agent.source, "user");
	const packageRoot = path.resolve(path.dirname(new URL("../package.json", import.meta.url).pathname));
	assert.ok(after.contract.tools.extensionArgs.includes(path.join(packageRoot, "extensions", "goal-auditor-progress.ts")));
});

test("D-12: standalone extension loading supplies a portable default goal-auditor", async () => {
	const project = path.join(tempDir, "standalone-project");
	fs.mkdirSync(project, { recursive: true });
	const handlers = new Map<string, Array<(value: unknown) => void>>();
	const events = {
		on(event: string, handler: (value: unknown) => void): () => void {
			const entries = handlers.get(event) ?? [];
			entries.push(handler);
			handlers.set(event, entries);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, value: unknown): void {
			for (const handler of [...(handlers.get(event) ?? [])]) handler(value);
		},
	};
	let delegated = false;
	events.on("prompt-template:subagent:request", (value) => {
		delegated = true;
		const identity = value as { requestId: string; ownerRunId: string; nodeId: string };
		events.emit("prompt-template:subagent:response", {
			...identity,
			status: "completed",
			result: { kind: "structured", value: { verdict: "approved", report: "Standalone auditor loaded.", findings: [] } },
		});
	});

	const result = await runGoalCompletionAuditor({
		ctx: { cwd: project, modelRegistry: { getAvailable: () => [] } } as any,
		events,
		goal: createGoal({ objective: "Verify standalone extension discovery", autoContinue: true, sisyphus: false }),
		detailedSummary: "Goal: standalone extension discovery",
	});

	assert.equal(delegated, true);
	assert.equal(result.approved, true);
	const standaloneDir = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	assert.ok(standaloneDir, "the existing extra-agent-dir discovery hook must be configured");
	const generatedAgent = path.join(standaloneDir!, "goal-auditor.md");
	const generatedSource = fs.readFileSync(generatedAgent, "utf8");
	const packageRoot = path.resolve(path.dirname(new URL("../package.json", import.meta.url).pathname));
	const progressExtension = path.join(packageRoot, "extensions", "goal-auditor-progress.ts");
	assert.match(generatedSource, new RegExp(`subagentOnlyExtensions: ${JSON.stringify(progressExtension).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

	const preflight = await resolveSubagentLaunchContract({
		agent: "goal-auditor",
		cwd: project,
		context: "fresh",
		availableModels: [],
		outputSchema: { type: "object", properties: {}, additionalProperties: false },
	});
	assert.equal(preflight.ok, true);
	if (!preflight.ok) return;
	assert.equal(preflight.contract.agent.source, "user");
	assert.ok(preflight.contract.tools.extensionArgs.includes(progressExtension));
});

test("D-04: packaged goal auditor discovery follows the installed pi-subagents resource policy", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	installGoalXPackage(agentDir);
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

test("D-03/D-11: missing configured model fails before dispatch", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	installGoalXPackage(agentDir);
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
		settings: { provider: "mock", model: "missing" },
	});
	assert.equal(dispatched, false);
	assert.match(result.error ?? "", /Goal auditor preflight failed/);
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
