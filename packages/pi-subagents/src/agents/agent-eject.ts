/**
 * [fork] Agent ejection implementation.
 *
 * This module is fork-only: it was split out of agents/agent-management.ts so
 * that file stays byte-close to upstream. The management action handler
 * (handleEject) remains in agent-management.ts and delegates here, and
 * src/api/agent-management.ts re-exports the public API from this module.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { discoverAgents, discoverAgentsAll } from "./agents.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { resolveSkillsWithFallback } from "./skills.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { resolvePiLaunchToolPlan } from "../runs/shared/child-tool-plan.ts";
import { availableAgentNames, nameExistsInScope, sanitizeName } from "./agent-management.ts";

export type AgentEjectionScope = "user" | "project";

export type AgentEjectionErrorCode =
	| "invalid_agent"
	| "untrusted_project"
	| "missing_project_root"
	| "missing_source"
	| "existing_custom"
	| "name_conflict"
	| "existing_file"
	| "source_read_failed"
	| "resource_missing"
	| "write_failed"
	| "rediscovery_failed"
	| "preflight_failed";

export interface EjectAgentDefinitionInput {
	cwd: string;
	agent: string;
	scope: AgentEjectionScope;
	/** Direct project-scope API callers must affirm host project trust. */
	projectTrusted?: boolean;
}

export interface EjectAgentDefinitionVerification {
	agent: string;
	scope: AgentEjectionScope;
	targetPath: string;
	source: "builtin" | "package";
	resourcePaths: string[];
	launchPreflighted: true;
}

export type EjectAgentDefinitionResult =
	| {
			ok: true;
			code: "ejected";
			message: string;
			agent: string;
			source: "builtin" | "package";
			scope: AgentEjectionScope;
			targetPath: string;
			verification: EjectAgentDefinitionVerification;
		}
	| {
			ok: false;
			code: AgentEjectionErrorCode;
			message: string;
			scope?: AgentEjectionScope;
			targetPath?: string;
		};

function isRelativeAgentResourcePath(value: string): boolean {
	return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}

/**
 * Upstream v0.53.0 resolves agent-frontmatter extension paths to absolute
 * paths at discovery time, so a portable resource is any entry that is a
 * path (relative or absolute) rather than a bare tool name.
 */
function isAgentResourcePath(value: string): boolean {
	return isRelativeAgentResourcePath(value) || path.isAbsolute(value);
}

function resolvePortableAgentResources(
	entries: string[] | undefined,
	sourceFilePath: string,
): { entries: string[] | undefined; resourcePaths: string[] } {
	const baseDir = path.dirname(sourceFilePath);
	const resourcePaths = (entries ?? []).flatMap((entry) =>
		isAgentResourcePath(entry) ? [path.resolve(baseDir, entry)] : [],
	);
	return {
		entries: entries?.map((entry) => isAgentResourcePath(entry) ? path.resolve(baseDir, entry) : entry),
		resourcePaths,
	};
}

function portableEjectedAgentContent(source: AgentConfig): {
	content?: string;
	resourcePaths?: string[];
	error?: EjectAgentDefinitionResult;
} {
	let sourceContent: string;
	try {
		sourceContent = fs.readFileSync(source.filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: {
				ok: false,
				code: "source_read_failed",
				message: `Failed to read source agent at ${source.filePath}: ${message}`,
			},
		};
	}

	const extensions = resolvePortableAgentResources(source.extensions, source.filePath);
	const subagentOnlyExtensions = resolvePortableAgentResources(source.subagentOnlyExtensions, source.filePath);
	const skillPath = resolvePortableAgentResources(source.skillPath, source.filePath);
	const tools = resolvePortableAgentResources(source.tools, source.filePath);
	const resourcePaths = [...new Set([
		...extensions.resourcePaths,
		...subagentOnlyExtensions.resourcePaths,
		...skillPath.resourcePaths,
		...tools.resourcePaths,
	])].sort((a, b) => a.localeCompare(b));
	const missingResources = resourcePaths.filter((resourcePath) => !fs.existsSync(resourcePath));
	if (missingResources.length > 0) {
		return {
			error: {
				ok: false,
				code: "resource_missing",
				message: `Agent '${source.name}' cannot be ejected because its relative resource path(s) do not exist: ${missingResources.join(", ")}.`,
			},
		};
	}
	if (resourcePaths.length === 0) return { content: sourceContent, resourcePaths };

	const { frontmatter } = parseFrontmatter(sourceContent);
	const portableAgent: AgentConfig = {
		...source,
		...(source.extensions !== undefined ? { extensions: extensions.entries! } : {}),
		...(source.subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: subagentOnlyExtensions.entries! } : {}),
		...(source.skillPath !== undefined ? { skillPath: skillPath.entries! } : {}),
		...(source.tools !== undefined ? { tools: tools.entries! } : {}),
	};
	return {
		content: serializeAgent(portableAgent, { preserveFrontmatterFields: new Set(Object.keys(frontmatter)) }),
		resourcePaths,
	};
}

function cleanupEjectedFile(targetPath: string, expectedContent: string): void {
	try {
		if (fs.readFileSync(targetPath, "utf-8") === expectedContent) fs.unlinkSync(targetPath);
	} catch {
		// The service only cleans the file it created during this call.
	}
}

function validateEjectedAgentLaunchPreflight(agent: AgentConfig, cwd: string): string | undefined {
	const resolvedSkills = resolveSkillsWithFallback(
		agent.skills ?? [],
		cwd,
		undefined,
		agent.skillPath,
		agent.filePath ? path.dirname(agent.filePath) : cwd,
	);
	if (resolvedSkills.missing.length > 0) {
		return `Missing skills: ${resolvedSkills.missing.join(", ")}`;
	}
	try {
		resolvePiLaunchToolPlan({
			tools: agent.tools,
			extensions: agent.extensions,
			subagentOnlyExtensions: agent.subagentOnlyExtensions,
			mcpDirectTools: agent.mcpDirectTools,
			cwd,
			requireReadTool: resolvedSkills.resolved.length > 0,
			agentName: agent.name,
			sandbox: agent.sandbox,
			permissionProfile: agent.permissionProfile,
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return undefined;
}

/**
 * Shared extraction of the existing eject handler. It deliberately owns only
 * agent-definition copying, no-overwrite checks, project-trust input, and
 * portable package-relative resource paths.
 */
export function ejectAgentDefinition(input: EjectAgentDefinitionInput): EjectAgentDefinitionResult {
	const raw = input.agent.trim();
	const sanitized = sanitizeName(raw);
	if (!raw || !sanitized) {
		return { ok: false, code: "invalid_agent", message: "agent must be a non-empty valid agent name." };
	}
	if (input.scope !== "user" && input.scope !== "project") {
		return { ok: false, code: "invalid_agent", message: "scope must be 'user' or 'project'." };
	}
	if (input.scope === "project" && input.projectTrusted !== true) {
		return {
			ok: false,
			code: "untrusted_project",
			scope: input.scope,
			message: "Project scope ejection requires a trusted project. Trust the project and retry.",
		};
	}

	let discovered: ReturnType<typeof discoverAgentsAll>;
	try {
		discovered = discoverAgentsAll(input.cwd);
	} catch (error) {
		return {
			ok: false,
			code: "rediscovery_failed",
			scope: input.scope,
			message: `Unable to discover agents before ejecting: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (input.scope === "project" && discovered.projectDir === null) {
		return {
			ok: false,
			code: "missing_project_root",
			scope: input.scope,
			message: "Project scope ejection is not available here: no project config root (.pi or .agents) was found above the cwd.",
		};
	}

	const existingCustom = (input.scope === "user" ? discovered.user : discovered.project)
		.find((candidate) => candidate.name === raw || candidate.name === sanitized);
	if (existingCustom) {
		return {
			ok: false,
			code: "existing_custom",
			scope: input.scope,
			targetPath: existingCustom.filePath,
			message: `Agent '${existingCustom.name}' is already a custom ${input.scope} agent at ${existingCustom.filePath}. Edit it with { action: "update", agent: "${existingCustom.name}" } or delete it first.`,
		};
	}
	const bundledCandidates = input.scope === "user"
		? discoverAgents(input.cwd, "user").agents.filter((candidate) => candidate.source === "builtin" || candidate.source === "package")
		: [...discovered.package, ...discovered.builtin];
	const source = bundledCandidates.find((candidate) => candidate.name === raw || candidate.name === sanitized);
	if (!source) {
		return {
			ok: false,
			code: "missing_source",
			scope: input.scope,
			message: `Agent '${raw}' not found or is not a bundled/package agent. eject copies a builtin or package agent to ${input.scope} scope so it can be customized. Available: ${availableAgentNames(input.cwd).join(", ") || "none"}.`,
		};
	}
	const runtimeName = source.name;
	if (nameExistsInScope(input.cwd, input.scope, runtimeName)) {
		return {
			ok: false,
			code: "name_conflict",
			scope: input.scope,
			message: `An agent or chain named '${runtimeName}' already exists in ${input.scope} scope. Remove or rename it first.`,
		};
	}

	const targetDir = input.scope === "user" ? discovered.userDir : discovered.projectDir!;
	const targetPath = path.join(targetDir, `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) {
		return {
			ok: false,
			code: "existing_file",
			scope: input.scope,
			targetPath,
			message: `File already exists at ${targetPath} but is not a valid agent definition. Remove or rename it first.`,
		};
	}

	const portable = portableEjectedAgentContent(source);
	if (portable.error) return { ...portable.error, scope: input.scope, targetPath };
	const content = portable.content!;
	try {
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(targetPath, content, { encoding: "utf-8", flag: "wx" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			code: "write_failed",
			scope: input.scope,
			targetPath,
			message: `Failed to write ejected agent '${runtimeName}' at ${targetPath}: ${message}`,
		};
	}

	const rediscovered = discoverAgentsAll(input.cwd);
	const copied = (input.scope === "user" ? rediscovered.user : rediscovered.project)
		.find((candidate) => candidate.name === runtimeName && path.resolve(candidate.filePath) === path.resolve(targetPath));
	if (!copied) {
		cleanupEjectedFile(targetPath, content);
		return {
			ok: false,
			code: "rediscovery_failed",
			scope: input.scope,
			targetPath,
			message: `Ejected agent '${runtimeName}' could not be rediscovered at ${targetPath}; no file was kept.`,
		};
	}

	const preflightError = validateEjectedAgentLaunchPreflight(copied, input.cwd);
	if (preflightError) {
		cleanupEjectedFile(targetPath, content);
		return {
			ok: false,
			code: "preflight_failed",
			scope: input.scope,
			targetPath,
			message: `Ejected agent '${runtimeName}' failed launch preflight at ${targetPath}: ${preflightError}. No file was kept.`,
		};
	}

	const sourceKind = source.source as "builtin" | "package";
	return {
		ok: true,
		code: "ejected",
		message: `Ejected agent '${runtimeName}' from ${sourceKind} to ${input.scope} scope at ${targetPath}. Edit it there to customize; it shadows the bundled ${sourceKind} agent of the same name.`,
		agent: runtimeName,
		source: sourceKind,
		scope: input.scope,
		targetPath,
		verification: {
			agent: copied.name,
			scope: input.scope,
			targetPath,
			source: sourceKind,
			resourcePaths: portable.resourcePaths ?? [],
			launchPreflighted: true,
		},
	};
}
