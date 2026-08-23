import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import {
	applyInjectionBlock,
	renderInjectionBlock,
	resolveInjectableAgents,
	SUBAGENT_INJECTION_MARKER,
	type InjectableAgentSummary,
} from "../../src/extension/context-injection.ts";

function agent(overrides: Partial<AgentConfig> & Pick<AgentConfig, "name" | "description">): AgentConfig {
	return {
		systemPrompt: "body",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/tmp/${overrides.name}.md`,
		...overrides,
	};
}

const summaries: InjectableAgentSummary[] = [
	{ name: "scout", description: "Fast recon with   collapsed whitespace" },
	{ name: "worker", description: "Implementation work" },
];

describe("resolveInjectableAgents", () => {
	it("unions settings-listed and frontmatter-flagged agents while deduplicating", () => {
		const result = resolveInjectableAgents({
			agents: [
				agent({ name: "worker", description: "Implementation work" }),
				agent({ name: "scout", description: "Fast recon", injectToContext: true }),
				agent({ name: "auditor", description: "Audit things", injectToContext: true }),
			],
			injectAgents: ["worker", "scout"],
		});

		assert.deepEqual(result.agents.map((entry) => entry.name), ["auditor", "scout", "worker"]);
		assert.deepEqual(result.unknownNames, []);
	});

	it("resolves settings names through aliases", () => {
		const result = resolveInjectableAgents({
			agents: [agent({ name: "security-reviewer", description: "Security review", aliases: ["sec-review"] })],
			injectAgents: ["sec-review"],
		});

		assert.deepEqual(result.agents.map((entry) => entry.name), ["security-reviewer"]);
		assert.deepEqual(result.unknownNames, []);
	});

	it("reports unknown settings names in discovery order without duplicates", () => {
		const result = resolveInjectableAgents({
			agents: [agent({ name: "worker", description: "Work" })],
			injectAgents: ["ghost", "worker", "phantom", "ghost"],
		});

		assert.deepEqual(result.agents.map((entry) => entry.name), ["worker"]);
		assert.deepEqual(result.unknownNames, ["ghost", "phantom"]);
	});

	it("never advertises disabled agents from either source", () => {
		const result = resolveInjectableAgents({
			agents: [
				agent({ name: "worker", description: "Work" }),
				agent({ name: "retired", description: "Gone", disabled: true, injectToContext: true }),
			],
			injectAgents: ["worker", "retired"],
		});

		assert.deepEqual(result.agents.map((entry) => entry.name), ["worker"]);
	});

	it("filters agents restricted by the capability ceiling", () => {
		const result = resolveInjectableAgents({
			agents: [
				agent({ name: "worker", description: "Work", injectToContext: true }),
				agent({ name: "reviewer", description: "Review", injectToContext: true }),
			],
			capabilityCeiling: { version: 1, denyExtensions: false, allowedAgents: ["reviewer"], sources: ["test"] },
		});

		assert.deepEqual(result.agents.map((entry) => entry.name), ["reviewer"]);
	});

	it("returns an empty selection when no source contributes agents", () => {
		const result = resolveInjectableAgents({ agents: [agent({ name: "worker", description: "Work" })] });

		assert.deepEqual(result.agents, []);
		assert.deepEqual(result.unknownNames, []);
	});
});

describe("renderInjectionBlock", () => {

	it("renders a compact single-line block with a stable header", () => {
		const block = renderInjectionBlock(summaries);

		assert.equal(
			block,
			[
				SUBAGENT_INJECTION_MARKER,
				"The following pre-declared subagents are available.",
				"Launch them with the subagent tool when a task matches their description.",
				"",
				"- scout: Fast recon with collapsed whitespace",
				"- worker: Implementation work",
				"</available_subagents>",
			].join("\n"),
		);
	});

	it("is deterministic: two renders of the same input are byte-identical", () => {
		const first = renderInjectionBlock(summaries);
		const second = renderInjectionBlock([...summaries]);

		assert.equal(first, second);
		assert.equal(first.length, second.length);
	});

	it("returns an empty string for an empty selection", () => {
		assert.equal(renderInjectionBlock([]), "");
	});
});

describe("applyInjectionBlock across consecutive turns", () => {
	const block = renderInjectionBlock(summaries);

	it("appends a byte-identical segment on every simulated turn", () => {
		let prompt = "Base system prompt v1\n\n<available_skills>...</available_skills>";
		const segments: string[] = [];
		for (let turn = 0; turn < 5; turn++) {
			// Each turn pi rebuilds the base prompt; simulate growing conversation metadata.
			prompt = `${prompt.split("\n\n<available_subagents>")[0]}\n(turn ${turn} baseline drift)`;
			const next = applyInjectionBlock({ systemPrompt: prompt, block });
			assert.ok(next);
			const markerStart = next.indexOf(SUBAGENT_INJECTION_MARKER);
			segments.push(next.slice(markerStart));
			prompt = next;
		}

		assert.equal(new Set(segments).size, 1);
		assert.equal(segments[0], block);
		for (const segment of segments) assert.equal(segment.endsWith("</available_subagents>"), true);
	});

	it("never duplicates the block when the prompt already carries it", () => {
		const once = applyInjectionBlock({ systemPrompt: "base", block });
		assert.ok(once);
		assert.equal(once.split(SUBAGENT_INJECTION_MARKER).length - 1, 1);

		const twice = applyInjectionBlock({ systemPrompt: once, block });
		assert.equal(twice, undefined);
		assert.equal(once.split(SUBAGENT_INJECTION_MARKER).length - 1, 1);
	});

	it("returns undefined for an empty snapshot", () => {
		assert.equal(applyInjectionBlock({ systemPrompt: "base", block: "" }), undefined);
	});
});
