/**
 * Headless functional verification for the context-cap extension.
 *
 * Loads extensions/context-cap.ts with jiti (the same loader pi uses at
 * runtime), drives it with a mock ExtensionAPI/ExtensionContext, and asserts
 * the core behaviour: registration, the budget threshold, mid-loop compaction
 * with auto-resume, run-end compaction without resume, session-start
 * compaction for over-budget resumes, the refire growth guard, the failure
 * disable, and command/flag configuration.
 *
 * Runs anywhere — no pi binary, models, or API keys required.
 *
 *   node scripts/verify.mjs
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

let passed = 0;
let failed = 0;
function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}`);
		console.error(`    ${err.message}`);
	}
}

/**
 * Build a fresh extension instance plus mocks. Captures everything the
 * extension does through pi/ctx so tests can assert on it.
 */
function makeHarness() {
	const flags = new Map();
	const commands = new Map();
	const events = new Map();
	const sent = [];
	const notices = [];
	const statuses = [];
	const compactCalls = [];

	const pi = {
		registerFlag: (name, def) => flags.set(name, def),
		registerCommand: (name, def) => commands.set(name, def),
		on: (event, handler) => events.set(event, handler),
		getFlag: (name) => flags.get(name)?.value,
		sendUserMessage: (content, opts) => sent.push({ content, opts }),
	};

	const usage = { tokens: 0, contextWindow: 1_048_576, percent: 0 };
	const ctx = {
		hasUI: true,
		model: { provider: "opencode", id: "kimi-k3", contextWindow: 1_048_576 },
		getContextUsage: () => ({ ...usage, percent: (usage.tokens / usage.contextWindow) * 100 }),
		compact: (options) => compactCalls.push(options),
		ui: {
			notify: (msg, level) => notices.push({ msg, level }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
	};

	const setTokens = (tokens) => {
		usage.tokens = tokens;
	};

	return { flags, commands, events, sent, notices, statuses, compactCalls, pi, ctx, setTokens };
}

const jiti = createJiti(import.meta.url);
const extensionPath = fileURLToPath(new URL("../extensions/context-cap.ts", import.meta.url));
const mod = await jiti.import(extensionPath);
const factory = mod.default ?? mod;

console.log("context-cap extension verification\n");

check("default export is a factory function", () => {
	assert.equal(typeof factory, "function");
});

// --- Registration -----------------------------------------------------------

const reg = makeHarness();
factory(reg.pi);

check("registers --context-cap and --context-cap-reserve flags", () => {
	assert.equal(reg.flags.get("context-cap")?.type, "string");
	assert.equal(reg.flags.get("context-cap-reserve")?.type, "string");
});

check("registers /context-cap command", () => {
	assert.equal(typeof reg.commands.get("context-cap")?.handler, "function");
});

check("subscribes to session_start, turn_end, and agent_settled", () => {
	for (const event of ["session_start", "turn_end", "agent_settled"]) {
		assert.equal(typeof reg.events.get(event), "function", `missing handler for ${event}`);
	}
});

// --- Threshold behaviour (default budget 200k, reserve 16384) ---------------

const h = makeHarness();
factory(h.pi);
const start = () => h.events.get("session_start")({}, h.ctx);
const turnEnd = (withTools) =>
	h.events.get("turn_end")(
		{
			turnIndex: 0,
			message: { role: "assistant" },
			toolResults: withTools ? [{ toolName: "read", isError: false }] : [],
		},
		h.ctx,
	);
const settled = () => h.events.get("agent_settled")({}, h.ctx);

await start();

h.setTokens(150_000);
await turnEnd(true);
check("no compaction under the threshold", () => {
	assert.equal(h.compactCalls.length, 0);
});

h.setTokens(183_616);
await turnEnd(true);
check("no compaction at exactly budget - reserve", () => {
	assert.equal(h.compactCalls.length, 0);
});

h.setTokens(190_000);
await turnEnd(false);
check("final turn (no tool results) does not fire at turn_end", () => {
	assert.equal(h.compactCalls.length, 0);
});

await settled();
check("agent_settled fires compaction when over threshold", () => {
	assert.equal(h.compactCalls.length, 1);
});

h.compactCalls[0].onComplete();
check("run-end compaction does not send a resume prompt", () => {
	assert.equal(h.sent.length, 0);
});

// --- Mid-loop compaction with auto-resume ------------------------------------

const m = makeHarness();
factory(m.pi);
await m.events.get("session_start")({}, m.ctx);
m.setTokens(190_000);
await m.events.get("turn_end")(
	{ turnIndex: 0, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
	m.ctx,
);

check("mid-loop turn over threshold fires compaction", () => {
	assert.equal(m.compactCalls.length, 1);
	assert.ok(m.notices.some((n) => n.msg.includes("compacting")));
});

m.setTokens(195_000);
await m.events.get("turn_end")(
	{ turnIndex: 1, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
	m.ctx,
);
check("no second compaction while one is in flight", () => {
	assert.equal(m.compactCalls.length, 1);
});

m.compactCalls[0].onComplete();
check("mid-loop compaction sends the resume follow-up", () => {
	assert.equal(m.sent.length, 1);
	assert.equal(m.sent[0].opts.deliverAs, "followUp");
	assert.ok(String(m.sent[0].content).includes("Continue the task"));
});

// --- Failure handling: refire guard and disable ------------------------------

const f = makeHarness();
factory(f.pi);
await f.events.get("session_start")({}, f.ctx);
const fTurn = (i) =>
	f.events.get("turn_end")(
		{ turnIndex: i, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
		f.ctx,
	);

f.setTokens(190_000);
await fTurn(0);
f.compactCalls[0].onError(new Error("summarizer unavailable"));
check("first failure notifies but keeps the watcher enabled", () => {
	assert.equal(f.compactCalls.length, 1);
	assert.ok(f.notices.some((n) => n.level === "error" && n.msg.includes("summarizer unavailable")));
	assert.ok(!f.notices.some((n) => n.msg.includes("disabled for this session")));
});

f.setTokens(195_000);
await fTurn(1);
check("refire guard blocks until usage grows by 20k past the last attempt", () => {
	assert.equal(f.compactCalls.length, 1);
});

f.setTokens(215_000);
await fTurn(2);
check("refire happens once usage grows past the guard", () => {
	assert.equal(f.compactCalls.length, 2);
});

f.compactCalls[1].onError(new Error("summarizer unavailable"));
f.setTokens(250_000);
await fTurn(3);
check("second consecutive failure disables the watcher for the session", () => {
	assert.equal(f.compactCalls.length, 2);
	assert.ok(f.notices.some((n) => n.msg.includes("disabled for this session")));
});

// --- session_start compacts an over-budget resumed session -------------------

const r = makeHarness();
factory(r.pi);
r.setTokens(220_000);
await r.events.get("session_start")({}, r.ctx);
check("session_start compacts a resumed session that is over budget", () => {
	assert.equal(r.compactCalls.length, 1);
});
r.compactCalls[0].onComplete();
check("session_start compaction does not send a resume prompt", () => {
	assert.equal(r.sent.length, 0);
});

// --- Flags --------------------------------------------------------------------

const fl = makeHarness();
factory(fl.pi);
fl.flags.get("context-cap").value = "100000";
fl.flags.get("context-cap-reserve").value = "10000";
await fl.events.get("session_start")({}, fl.ctx);
fl.setTokens(95_000);
await fl.events.get("turn_end")(
	{ turnIndex: 0, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
	fl.ctx,
);
check("--context-cap and --context-cap-reserve set the session budget", () => {
	assert.equal(fl.compactCalls.length, 1);
	assert.ok(fl.statuses.some((s) => s.text?.includes("/100k")));
});

// --- Command ------------------------------------------------------------------

const c = makeHarness();
factory(c.pi);
await c.events.get("session_start")({}, c.ctx);
const cmd = (args) => c.commands.get("context-cap").handler(args, c.ctx);

await cmd("status");
check("status reports budget, threshold, and untouched window", () => {
	assert.ok(
		c.notices.some((n) => n.msg.includes("budget 200,000") && n.msg.includes("untouched")),
		`got: ${c.notices.map((n) => n.msg).join(" | ")}`,
	);
});

await cmd("150000");
c.setTokens(140_000);
await c.events.get("turn_end")(
	{ turnIndex: 0, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
	c.ctx,
);
check("/context-cap <tokens> lowers the budget for the session", () => {
	assert.equal(c.compactCalls.length, 1);
});
c.compactCalls[0].onComplete();

await cmd("off");
c.setTokens(300_000);
await c.events.get("turn_end")(
	{ turnIndex: 1, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
	c.ctx,
);
check("/context-cap off disables enforcement", () => {
	assert.equal(c.compactCalls.length, 1);
});

await cmd("on");
await c.events.get("turn_end")(
	{ turnIndex: 2, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
	c.ctx,
);
check("/context-cap on re-enables enforcement", () => {
	assert.equal(c.compactCalls.length, 2);
});
c.compactCalls[1].onComplete();

await cmd("resume off");
c.setTokens(320_000);
await c.events.get("turn_end")(
	{ turnIndex: 3, message: { role: "assistant" }, toolResults: [{ toolName: "bash", isError: false }] },
	c.ctx,
);
const sentBeforeResumeOff = c.sent.length;
c.compactCalls[2].onComplete();
check("resume off suppresses the follow-up prompt", () => {
	assert.equal(c.compactCalls.length, 3);
	assert.equal(c.sent.length, sentBeforeResumeOff);
});

await cmd("nonsense argument");
check("unknown argument reports an error", () => {
	assert.ok(c.notices.some((n) => n.level === "error" && n.msg.includes("unrecognized argument")));
});

await cmd("5000");
check("budget must exceed the reserve", () => {
	assert.ok(c.notices.some((n) => n.level === "error" && n.msg.includes("larger than the reserve")));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
