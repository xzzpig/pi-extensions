import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { applyInjectionBlock } from "../../src/extension/context-injection.ts";

for (const [initiallyTrusted, projectOnly] of [[false, false], [true, false], [true, true]]) it(`context injection respects project trust (initially ${initiallyTrusted}, project-only ${projectOnly}) and refreshes across a trust boundary`, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-injection-trust-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const write = (dir: string, name: string, description: string) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ninjectToContext: true\nadvertise: true\n---\nAct narrowly.\n`);
	};
	if (!projectOnly) write(path.join(agentDir, "agents"), "shared", "USER DESCRIPTION");
	write(path.join(cwd, ".pi", "agents"), "shared", "PROJECT DESCRIPTION");
	write(path.join(cwd, ".pi", "agents"), "project-only", "PROJECT ONLY");
	const handlers = new Map<string, Function[]>();
	const pi = new Proxy({
		events: { on() { return () => {}; }, emit() {} },
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		getActiveTools() { return ["subagent"]; },
	}, { get(target, key) { return key in target ? Reflect.get(target, key) : () => undefined; } });
	let trusted = initiallyTrusted;
	const ctx = {
		cwd, hasUI: false, isIdle: () => false, isProjectTrusted: () => trusted,
		modelRegistry: { getAvailable: () => [], getAll: () => [] },
		sessionManager: { getSessionId: () => `injection-${initiallyTrusted}`, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
	};
	let lastSections = "";
	const prompt = async (base = "BASE") => {
		const event = { systemPrompt: base, systemPromptOptions: { selectedTools: ["subagent"], sections: {} } };
		for (const handler of handlers.get("before_agent_start") ?? []) {
			const result = await handler(event, ctx);
			if (result?.systemPrompt !== undefined) event.systemPrompt = result.systemPrompt;
		}
		lastSections = JSON.stringify(event.systemPromptOptions.sections);
		return event.systemPrompt;
	};
	try {
		registerSubagentExtension(pi as never);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		const initial = await prompt();
		if (initiallyTrusted) {
			assert.match(initial, /PROJECT DESCRIPTION/);
			assert.match(initial, /PROJECT ONLY/);
			assert.doesNotMatch(initial, /USER DESCRIPTION/);
			write(path.join(cwd, ".pi", "agents"), "shared", "CHANGED PROJECT DESCRIPTION");
			assert.equal(await prompt(), initial, "trusted snapshot remains stable within the session");
			trusted = false;
		}
		const untrusted = await prompt(projectOnly ? "<available_subagents>PROJECT ONLY</available_subagents>" : initial);
		if (projectOnly) assert.equal(untrusted, "", "the registered handler must return an empty replacement rather than retain project text");
		else assert.match(untrusted, /USER DESCRIPTION/);
		assert.doesNotMatch(untrusted, /PROJECT DESCRIPTION|PROJECT ONLY|project-only/);
		if (!projectOnly) assert.match(lastSections, /USER DESCRIPTION/);
		assert.doesNotMatch(lastSections, /PROJECT DESCRIPTION|PROJECT ONLY|project-only/);
		assert.equal(await prompt(untrusted), untrusted, "untrusted snapshot remains stable");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("removes a stale injected block when no trusted agents remain", () => {
	assert.equal(applyInjectionBlock({ systemPrompt: "<available_subagents>project secret</available_subagents>", block: "", replaceExisting: true }), "");
	assert.equal(applyInjectionBlock({ systemPrompt: "BASE\n\n<available_subagents>project secret</available_subagents>", block: "", replaceExisting: true }), "BASE");
});

it("removes the full stale block even when an agent description contained a closing marker", () => {
	assert.equal(applyInjectionBlock({ systemPrompt: "BASE\n\n<available_subagents>- project: </available_subagents> PROJECT DESCRIPTION\n</available_subagents>", block: "", replaceExisting: true }), "BASE");
});
