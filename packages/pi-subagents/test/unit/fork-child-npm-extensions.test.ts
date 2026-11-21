import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as pi from "pi-subagents-test-sdk";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { resolveChildNpmExtensions } from "../../src/runs/shared/fork-child-npm-extensions.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";

const packageName = "@fixture/pi-model-instructions";
const source = `npm:${packageName}`;
const otherSource = "npm:pi-ambient-fixture@1.0.0";
const temporaryNpmBucket = createHash("sha256").update("npm-").digest("hex").slice(0, 8);

async function writePackage(root: string, name: string, version: string, marker: string, { declareSkill = true, registerToolInPrompt = false } = {}) {
	const skill = `fixture-${marker}`;
	await mkdir(join(root, "skills", skill), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({
		name, version, type: "module", pi: { extensions: ["./index.js"], ...(declareSkill ? { skills: ["./skills"] } : {}) },
	}));
	await writeFile(join(root, "index.js"), `
		import { appendFileSync } from 'node:fs';
		export default function (pi) {
			appendFileSync(process.env.PI_TEST_NPM_LOADS, ${JSON.stringify(`${marker}\n`)});
			pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + ${JSON.stringify(`\n${marker}`)} }));
			if (${JSON.stringify(marker)} === 'global') {
				const register = () => { pi.registerTool({ name: 'old_version_tool', label: 'Old tool', description: 'Only the old version registers this tool', parameters: { type: 'object', properties: {} }, async execute() { return { content: [] }; } }); };
				if (${registerToolInPrompt}) pi.on('before_agent_start', register);
				else register();
			}
		}
	`);
	await writeFile(join(root, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: A test skill.\n---\n`);
}

test("child npm sources reuse a compatible install and suppress other copies before factories run", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-npm-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const installed = join(agentDir, "npm", "node_modules", packageName);
	const cached = join(agentDir, "tmp", "extensions", "npm", temporaryNpmBucket, "node_modules", packageName);
	const project = join(cwd, ".pi", "npm", "node_modules", packageName);
	const globalSettings = join(agentDir, "settings.json");
	const projectSettings = join(cwd, ".pi", "settings.json");
	const log = join(root, "loads");
	const previous = { offline: process.env.PI_OFFLINE, log: process.env.PI_TEST_NPM_LOADS };
	process.env.PI_OFFLINE = "1";
	process.env.PI_TEST_NPM_LOADS = log;
	t.after(async () => {
		if (previous.offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previous.offline;
		if (previous.log === undefined) delete process.env.PI_TEST_NPM_LOADS;
		else process.env.PI_TEST_NPM_LOADS = previous.log;
		await rm(root, { recursive: true, force: true });
	});
	await writePackage(installed, packageName, "1.2.3", "global", { registerToolInPrompt: true });
	await writePackage(cached, packageName, "2.0.0", "temporary");
	await writePackage(join(agentDir, "npm", "node_modules", "pi-ambient-fixture"), "pi-ambient-fixture", "1.0.0", "unrelated");
	await mkdir(dirname(projectSettings), { recursive: true });
	const config = JSON.stringify({
		packages: [{ source: `${source}@1.2.3`, skills: [] }, { source: otherSource, skills: [] }],
		compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 64 },
	});
	await writeFile(globalSettings, config);
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
	const modelRegistry = new pi.ModelRegistry(modelRuntime);

	async function run(ambientExtensions: boolean, extensionPaths: string[], expected: string[], resolvedPaths: string[], {
		settings = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true }), expectedConfig = config,
	} = {}) {
		const prepared = await resolveChildNpmExtensions(pi, settings, { cwd, ambientExtensions, extensionPaths }, agentDir);
		assert.deepEqual(prepared.additionalExtensionPaths, resolvedPaths);
		await writeFile(log, "");
		const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: !ambientExtensions, additionalExtensionPaths: prepared.additionalExtensionPaths });
		prepared.filterAmbient?.(loader);
		await loader.reload();
		const { extensions, runtime, errors } = loader.getExtensions();
		assert.deepEqual(errors, []);
		assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").filter(Boolean), expected);
		const runner = new pi.ExtensionRunner(extensions, runtime, cwd, pi.SessionManager.inMemory(cwd), modelRegistry);
		const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "test" }, { cwd, forceSystemPrompt: "base" });
		assert.equal(result.systemPromptOptions.forceSystemPrompt, ["base", ...expected].join("\n"));
		assert.equal(await readFile(globalSettings, "utf8"), expectedConfig);
		assert.deepEqual(settings.getGlobalSettings().packages, JSON.parse(expectedConfig).packages);
		return { loader, runner };
	}

	await t.test("unversioned, exact and range selectors each reuse the global install in both hosts", async () => {
		for (const selector of [source, `${source}@1.2.3`, `${source}@^1.0.0`]) {
			await run(false, [selector], ["global"], [installed]);
			await run(true, [selector, selector], ["global", "unrelated"], [installed]);
		}
	});
	await t.test("dist-tags stay with Pi's temporary resolver", async () => {
		await run(false, [`${source}@next`], ["temporary"], [`${source}@next`]);
	});
	await t.test("a regular npm main entry is never loaded as a local extension", async () => {
		const plain = "pi-ordinary-npm-fixture";
		const plainSource = `npm:${plain}@1.0.0`;
		const plainRoot = join(agentDir, "npm", "node_modules", plain);
		await mkdir(plainRoot, { recursive: true });
		await writeFile(join(plainRoot, "index.js"), "throw new Error('npm main entry must not load');");
		const settings = pi.SettingsManager.create(cwd, agentDir);
		for (const fields of [{}, { pi: { extensions: [null] } }]) {
			await writeFile(join(plainRoot, "package.json"), JSON.stringify({ name: plain, version: "1.0.0", ...fields }));
			await writeFile(globalSettings, JSON.stringify({ packages: [plainSource] }));
			try {
				await settings.reload();
				const prepared = await resolveChildNpmExtensions(pi, settings, { cwd, ambientExtensions: false, extensionPaths: [plainSource] }, agentDir);
				assert.deepEqual(prepared.additionalExtensionPaths, [plainSource]);
				const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: prepared.additionalExtensionPaths });
				await loader.reload();
				assert.deepEqual(loader.getExtensions().errors, []);
				assert.equal(loader.getExtensions().extensions.length, 0);
			} finally {
				await writeFile(globalSettings, config);
			}
		}
	});
	await t.test("a matching install with a missing manifest entry falls back to the original npm source", async () => {
		const globalManifestPath = join(installed, "package.json");
		const cacheManifestPath = join(cached, "package.json");
		const globalManifest = await readFile(globalManifestPath, "utf8");
		const cacheManifest = await readFile(cacheManifestPath, "utf8");
		try {
			await writeFile(globalManifestPath, JSON.stringify({ ...JSON.parse(globalManifest), pi: { extensions: ["./nonexistent-entry.js"] } }));
			await writeFile(cacheManifestPath, JSON.stringify({ ...JSON.parse(cacheManifest), version: "1.2.3" }));
			const selector = `${source}@1.2.3`;
			await run(false, [selector], ["temporary"], [selector]);
			await run(true, [selector], ["temporary", "unrelated"], [selector]);
		} finally {
			await writeFile(globalManifestPath, globalManifest);
			await writeFile(cacheManifestPath, cacheManifest);
		}
	});
	await t.test("explicit incompatible version loads only the temporary extension and leaves other ambient extensions", async () => {
		await run(true, [`${source}@2.0.0`], ["temporary", "unrelated"], [`${source}@2.0.0`]);
	});
	await t.test("the background runner allows tools registered during prompt preparation but never calls the model for missing tools", async () => {
		const faux = fauxProvider({ provider: "npm-preflight", models: [{ id: "local", contextWindow: 16_000, maxTokens: 1024 }], tokensPerSecond: 100_000 });
		let modelCalls = 0;
		const reply = () => { modelCalls++; return fauxAssistantMessage("Tool contract satisfied."); };
		faux.setResponses([reply, reply]);
		const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		// SAFETY: both the pinned and host SDK implement this factory's Pi SDK surface.
		const sdk = { ...pi, ModelRuntime: { create: async () => modelRuntime } } as unknown as PiCodingAgentModule;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
		try {
			const runBackground = async (selector: string, sessionFile?: string, trace?: string[]) => {
				const launch = buildInProcessChildLaunch({
					cwd, host: "runner", childAgentName: "reader", childIndex: 0, sessionEnabled: false, sessionFile,
					inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false,
					model: "npm-preflight/local", subagentOnlyExtensions: [selector], tools: ["old_version_tool"],
				});
				launch.session.restoreProcessEnv = true;
				launch.session.hooks.push({ name: "npm-preflight-model", factory: (api) => {
					api.registerProvider(faux.provider);
					if (!trace) return;
					const toolReady = () => api.getAllTools().some(({ name }) => name === "old_version_tool");
					api.on("session_start", () => { trace.push(`session_start:${toolReady()}`); });
					api.on("session_before_compact", () => { trace.push(`compact-start:${toolReady()}`); });
					api.on("session_compact", () => { trace.push("compact-done"); });
					api.on("session_compact_failed", () => { trace.push("compact-failed"); });
					api.on("before_agent_start", () => { trace.push(`prepare:${toolReady()}`); });
				} });
				await writeFile(log, "");
				const result = await runChildSession({ factory, launch, prompt: "Verify the tool contract.", appendChildEvent() {}, writeOutputLine() {} });
				return { result, log: await readFile(log, "utf8") };
			};
			const unavailable = await runBackground(`${source}@4.0.0`);
			assert.equal(unavailable.result.exitCode, 1);
			assert.match(unavailable.result.error ?? "", /requested unavailable child tools: old_version_tool/u);
			assert.equal(unavailable.log, "unrelated\n", "old factory must not initialise");
			assert.equal(modelCalls, 0);
			const available = await runBackground(`${source}@1.2.3`);
			assert.equal(available.result.error, undefined);
			assert.equal(available.result.exitCode, 0);
			assert.equal(available.log, "global\nunrelated\n");
			assert.equal(modelCalls, 1, "the npm reuse path preserves late tool registration");
			const local = await runBackground(join(installed, "index.js"));
			assert.equal(local.result.error, undefined);
			assert.equal(local.result.exitCode, 0);
			assert.equal(modelCalls, 2, "the independent path has the same success behavior");

			for (const [key, selector] of [["local", join(installed, "index.js")], ["npm", `${source}@1.2.3`]]) {
				const trace: string[] = [];
				const writer = pi.SessionManager.create(cwd, join(root, `resume-${key}`));
				const model = faux.getModel("local");
				for (let i = 0; i < 3; i++) {
					writer.appendMessage({ role: "user", content: `Earlier request ${i}: ${"prior context ".repeat(1500)}`, timestamp: Date.now() });
					const answer = fauxAssistantMessage("Earlier answer.");
					writer.appendMessage({ ...answer, model: model.id, provider: model.provider, api: model.api, usage: { ...answer.usage, input: 24_000, totalTokens: 24_001 } });
				}
				const sessionFile = writer.getSessionFile();
				assert.ok(sessionFile);
				faux.setResponses([
					() => { trace.push("summary-model"); return fauxAssistantMessage("Summary of the earlier requests."); },
					() => { trace.push("turn-model"); return fauxAssistantMessage("Resumed with the tool registered."); },
				]);
				const resumed = await runBackground(selector, sessionFile, trace);
				assert.equal(resumed.result.error, undefined);
				assert.equal(resumed.result.exitCode, 0);
				assert.deepEqual(trace, ["session_start:false", "compact-start:false", "summary-model", "compact-done", "prepare:true", "turn-model"], key);
			}
		} finally {
			await factory.dispose();
			if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		}
	});
	await t.test("filtering an npm source does not shadow an independently enabled path to its entry", async () => {
		const expectedConfig = JSON.stringify({ ...JSON.parse(config), extensions: [join(installed, "index.js")] });
		try {
			await writeFile(globalSettings, expectedConfig);
			const selector = `${source}@2.0.0`;
			await run(true, [selector], ["temporary", "global", "unrelated"], [selector], { expectedConfig });
		} finally {
			await writeFile(globalSettings, config);
		}
	});
	await t.test("a child selection does not modify project trust, another loader, or on-disk settings", async () => {
		await writePackage(project, packageName, "3.0.0", "project");
		const projectConfig = JSON.stringify({ packages: [`${source}@3.0.0`] });
		await writeFile(projectSettings, projectConfig);
		const selector = `${source}@2.0.0`;
		const untrusted = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const trusted = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		for (const [settings, expectsProject] of [[untrusted, false], [trusted, true]] as const) {
			const { loader } = await run(true, [selector], ["temporary", "unrelated"], [selector], { settings });
			assert.deepEqual(loader.getSkills().skills.map(({ name }) => name).filter((name) => name.startsWith("fixture-")).sort(), expectsProject ? ["fixture-project", "fixture-temporary"] : ["fixture-temporary"]);
			assert.equal(settings.isProjectTrusted(), expectsProject);
			assert.deepEqual(settings.getProjectSettings().packages, expectsProject ? JSON.parse(projectConfig).packages : undefined);
			await run(true, [], [expectsProject ? "project" : "global", "unrelated"], [], { settings });
		}
		assert.equal(await readFile(projectSettings, "utf8"), projectConfig);
	});
	await t.test("a plain npm entry with a manifest does not start discovering undeclared skill directories when filtered", async () => {
		await writePackage(project, packageName, "3.0.0", "project", { declareSkill: false });
		const selector = `${source}@2.0.0`;
		const { loader } = await run(true, [selector], ["temporary", "unrelated"], [selector]);
		assert.deepEqual(loader.getSkills().skills.map(({ name }) => name).filter((name) => name.startsWith("fixture-")), ["fixture-temporary"]);
	});
	await t.test("metadata-only Pi manifests preserve the host SDK's non-extension discovery", async () => {
		await writeFile(join(project, "package.json"), JSON.stringify({ name: packageName, version: "3.0.0", type: "module", pi: { changelogPath: "./CHANGELOG.md" } }));
		const selector = `${source}@2.0.0`;
		const baseline = await run(true, [], ["unrelated"], []);
		const selected = await run(true, [selector], ["temporary", "unrelated"], [selector]);
		const skills = (loader: pi.DefaultResourceLoader) => loader.getSkills().skills.map(({ name }) => name).filter((name) => name.startsWith("fixture-") && name !== "fixture-temporary");
		assert.deepEqual(skills(selected.loader), skills(baseline.loader));
	});
	await t.test("different explicit selectors for one npm package fail before loading", async () => {
		const settings = pi.SettingsManager.create(cwd, agentDir);
		await assert.rejects(() => resolveChildNpmExtensions(pi, settings, {
			cwd, ambientExtensions: true, extensionPaths: [source, `${source}@2.0.0`],
		}, agentDir), /Conflicting explicit npm extension selectors for '@fixture\/pi-model-instructions'/u);
	});
	await t.test("denied sources are not resolved and non-npm and required paths stay unchanged", async () => {
		const settings = pi.SettingsManager.create(cwd, agentDir);
		const required = { id: "host-extension", path: join(root, "required.js") };
		const localSource = join(root, "local-extension.js");
		const plan = resolvePiLaunchToolPlan({ cwd, extensions: [localSource, source], requiredExtensions: [required] });
		const prepared = await resolveChildNpmExtensions(pi, settings, { cwd, ambientExtensions: true, extensionPaths: plan.extensionArgs }, agentDir);
		assert.deepEqual(prepared.additionalExtensionPaths, plan.extensionArgs.map((entry) => entry === source ? installed : entry));
		assert.ok(prepared.additionalExtensionPaths.includes(required.path));
		const denied = resolvePiLaunchToolPlan({ cwd, extensions: [source], capabilityCeiling: { version: 1, sources: ["test"], denyExtensions: true } });
		assert.equal(denied.disableAmbientExtensions, true);
		assert.ok(!denied.extensionArgs.includes(source));
		const deniedSources = await resolveChildNpmExtensions(pi, settings, { cwd, ambientExtensions: false, extensionPaths: denied.extensionArgs }, agentDir);
		assert.equal(deniedSources.additionalExtensionPaths, denied.extensionArgs);
		assert.equal(deniedSources.filterAmbient, undefined);
	});
});
