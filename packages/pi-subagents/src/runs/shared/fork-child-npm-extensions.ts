import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { satisfies, valid, validRange } from "semver";
import type { PiCodingAgentModule } from "./child-session.ts";
import { evaluateChildToolDiagnostic, type ChildRuntimeConfig } from "./child-runtime-config.ts";
import { formatChildToolDiagnostic } from "./tool-availability.ts";

interface SettingsView {
	getGlobalSettings(): { packages?: ReadonlyArray<string | { source: string }> };
}
type PackageManager = Pick<InstanceType<PiCodingAgentModule["DefaultPackageManager"]>, "getInstalledPath" | "resolveExtensionSources">;

function npmSource(source: string) {
	const match = /^npm:\s*((?:@[\w.-]+\/)?[\w.-]+)(?:@(.+))?$/u.exec(source.trim());
	if (!match?.[1] || match[1].replace(/^@/u, "").split("/").some((part) => part === "." || part === "..")) return undefined;
	return { name: match[1], selector: match[2]?.trim() };
}

function installedVersion(root: string, name: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(/^\uFEFF/u, ""));
		if (manifest?.name === name && typeof manifest.version === "string" && valid(manifest.version)) return manifest.version;
	} catch {
		// Invalid or missing local metadata leaves npm resolution to Pi.
	}
	return undefined;
}

interface ChildLoader {
	reload(): Promise<void>;
}

interface PackageAccumulator {
	extensions: Map<unknown, unknown>;
}

type CollectResources = (root: string, accumulator: PackageAccumulator, filter: unknown, metadata: { scope: string; source: string }) => boolean;

/** Pi does not expose a pre-load filter for package extension resources. Scope
 * this adapter to a single loader's package collector; leave the SDK's original
 * manifest parsing, resource filters and precedence alone. */
function filterAmbientPackages(loader: ChildLoader, selected: ReadonlySet<string>): void {
	const manager = (loader as ChildLoader & { packageManager?: { collectPackageResources?: CollectResources } }).packageManager;
	const collect = manager?.collectPackageResources;
	if (!manager || typeof collect !== "function") {
		throw new Error("Cannot deduplicate explicit child npm extensions: this Pi SDK does not expose its package resource collector.");
	}
	manager.collectPackageResources = function (root, accumulator, filter, metadata) {
		const request = metadata.scope === "user" || metadata.scope === "project" ? npmSource(metadata.source) : undefined;
		if (!request || !selected.has(request.name)) return collect.call(this, root, accumulator, filter, metadata);
		// A separate extension map is essential: marking the original entry
		// disabled would claim its path before Pi considers non-npm declarations.
		if (!(accumulator.extensions instanceof Map)) throw new Error("Cannot deduplicate explicit child npm extensions: unsupported Pi resource accumulator.");
		return collect.call(this, root, { ...accumulator, extensions: new Map() }, filter, metadata);
	};
}

function explicitSelectors(extensionPaths: string[]): Map<string, string | undefined> {
	const explicit = new Map<string, string | undefined>();
	for (const source of extensionPaths) {
		const request = npmSource(source);
		if (!request) continue;
		if (explicit.has(request.name) && explicit.get(request.name) !== request.selector) {
			throw new Error(`Conflicting explicit npm extension selectors for '${request.name}'; select one version per child session.`);
		}
		explicit.set(request.name, request.selector);
	}
	return explicit;
}

type ConfiguredSource = { source: string; selector?: string };

function configuredNpmSources(settings: SettingsView, explicit: ReadonlyMap<string, string | undefined>): Map<string, ConfiguredSource> {
	const configured = new Map<string, ConfiguredSource>();
	for (const entry of settings.getGlobalSettings().packages ?? []) {
		const source = typeof entry === "string" ? entry : entry.source;
		const pkg = npmSource(source);
		if (pkg && explicit.has(pkg.name) && !configured.has(pkg.name)) configured.set(pkg.name, { source, selector: pkg.selector });
	}
	return configured;
}

async function reusableInstall(manager: PackageManager, request: { name: string; selector?: string }, configured: ConfiguredSource): Promise<string | undefined> {
	if (request.selector && !validRange(request.selector)) return undefined;
	const root = manager.getInstalledPath(configured.source, "user");
	if (!root) return undefined;
	const version = installedVersion(root, request.name);
	if (!version || (request.selector && !satisfies(version, request.selector))) return undefined;
	// Pi's ambient pass can replace a stale install before loading additional sources.
	if (configured.selector && validRange(configured.selector) && !satisfies(version, configured.selector)) return undefined;
	const { extensions } = await manager.resolveExtensionSources([root], { temporary: true });
	// A local directory without Pi resources can resolve to its main entry.
	// Only reuse a directory when Pi discovers an actual extension entry.
	return extensions.some((entry) => entry.enabled && resolve(entry.path) !== resolve(root)) ? root : undefined;
}

type NativeChildSession = Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>["session"];

function guardFirstNpmModelCall(runtime: ChildRuntimeConfig, session: NativeChildSession): void {
	if (!runtime.requiredTools?.length) return;
	const agent = session.agent;
	const stream = agent.streamFunction;
	let passed = false;
	// Pi treats event-handler errors as diagnostics, not provider barriers.
	// Only the normal turn uses this session's routing ID. Pi sends summaries
	// (including restored-history compaction before before_agent_start) through
	// the same stream function with a different ID, and those do not use tools.
	agent.streamFunction = (...args) => {
		if (passed || args[2]?.sessionId !== session.sessionId) return stream(...args);
		const diagnostic = evaluateChildToolDiagnostic(runtime, session.getAllTools().map(({ name }) => name));
		if (diagnostic) {
			runtime.toolDiagnostic?.(diagnostic);
			throw new Error(formatChildToolDiagnostic(diagnostic));
		}
		passed = true;
		agent.streamFunction = stream;
		return stream(...args);
	};
}

export async function resolveChildNpmExtensions<Manager extends SettingsView>(
	pi: { DefaultPackageManager: new (options: { cwd: string; agentDir: string; settingsManager: Manager }) => PackageManager },
	settingsManager: Manager,
	{ cwd, ambientExtensions, extensionPaths }: { cwd: string; ambientExtensions: boolean; extensionPaths: string[] },
	agentDir: string,
): Promise<{ additionalExtensionPaths: string[]; filterAmbient?: (loader: ChildLoader) => void; guardFirstModelCall?: typeof guardFirstNpmModelCall }> {
	const explicit = explicitSelectors(extensionPaths);
	if (!explicit.size) return { additionalExtensionPaths: extensionPaths };
	const configured = configuredNpmSources(settingsManager, explicit);
	const manager = configured.size && typeof pi.DefaultPackageManager === "function"
		? new pi.DefaultPackageManager({ cwd, agentDir, settingsManager }) : undefined;
	const seen = new Set<string>();
	const additionalExtensionPaths: string[] = [];
	for (const source of extensionPaths) {
		const request = npmSource(source);
		if (request && seen.has(request.name)) continue;
		if (request) seen.add(request.name);
		const ambient = request && configured.get(request.name);
		const reused = manager && request && ambient ? await reusableInstall(manager, request, ambient) : undefined;
		additionalExtensionPaths.push(reused ?? source);
	}

	const selected = new Set(explicit.keys());
	return {
		additionalExtensionPaths,
		guardFirstModelCall: guardFirstNpmModelCall,
		...(ambientExtensions ? { filterAmbient: (loader: ChildLoader) => filterAmbientPackages(loader, selected) } : {}),
	};
}
