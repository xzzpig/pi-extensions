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
    cwd: process.env.CC_TEST_PROJECT_DIR,
    // Default mock model: 200k window → window-derived budget 200,000,
    // compaction at 183,616 (matches the old fixed-default numbers).
    model: { provider: "opencode", id: "kimi-k3", contextWindow: 200_000 },
    getContextUsage: () => ({
      ...usage,
      percent: (usage.tokens / usage.contextWindow) * 100,
    }),
    isProjectTrusted: () => true,
    compact: (options) => compactCalls.push(options),
    ui: {
      notify: (msg, level) => notices.push({ msg, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
  };

  const setTokens = (tokens) => {
    usage.tokens = tokens;
  };

  // Expose internals so fork tests can drive the whitelist/session logic.
  const setModel = (provider, id, contextWindow = 200_000) => {
    ctx.model = { provider, id, contextWindow };
  };

  return {
    flags,
    commands,
    events,
    sent,
    notices,
    statuses,
    compactCalls,
    pi,
    ctx,
    setTokens,
    setModel,
  };
}

const jiti = createJiti(import.meta.url);
const extensionPath = fileURLToPath(
  new URL("../extensions/context-cap.ts", import.meta.url),
);
const mod = await jiti.import(extensionPath);
const factory = mod.default ?? mod;

// Isolate every harness from the developer's real pi config: redirect the
// global agent dir and project dir to empty temp dirs BEFORE any session
// starts, so tests are deterministic regardless of ~/.pi/agent content.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CC_AGENT_DIR = mkdtempSync(join(tmpdir(), "cc-agent-"));
const CC_PROJECT_DIR = mkdtempSync(join(tmpdir(), "cc-project-"));
const OLD_CC_DIR = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = CC_AGENT_DIR;
process.env.CC_TEST_PROJECT_DIR = CC_PROJECT_DIR;

const projectCfg = (obj) => {
  mkdirSync(join(CC_PROJECT_DIR, ".pi"), { recursive: true });
  writeFileSync(
    join(CC_PROJECT_DIR, ".pi", "context-cap.json"),
    JSON.stringify(obj),
  );
};
const agentCfg = (obj) => {
  writeFileSync(join(CC_AGENT_DIR, "context-cap.json"), JSON.stringify(obj));
};

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
    assert.equal(
      typeof reg.events.get(event),
      "function",
      `missing handler for ${event}`,
    );
  }
});

// --- Threshold behaviour (window-derived budget 200k on a 200k-window
// model, reserve 16384 → compacts at 183,616) ---------------

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
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  m.ctx,
);

check("mid-loop turn over threshold fires compaction", () => {
  assert.equal(m.compactCalls.length, 1);
  assert.ok(m.notices.some((n) => n.msg.includes("compacting")));
});

m.setTokens(195_000);
await m.events.get("turn_end")(
  {
    turnIndex: 1,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
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
    {
      turnIndex: i,
      message: { role: "assistant" },
      toolResults: [{ toolName: "bash", isError: false }],
    },
    f.ctx,
  );

f.setTokens(190_000);
await fTurn(0);
f.compactCalls[0].onError(new Error("summarizer unavailable"));
check("first failure notifies but keeps the watcher enabled", () => {
  assert.equal(f.compactCalls.length, 1);
  assert.ok(
    f.notices.some(
      (n) => n.level === "error" && n.msg.includes("summarizer unavailable"),
    ),
  );
  assert.ok(
    !f.notices.some((n) => n.msg.includes("disabled for this session")),
  );
});

f.setTokens(195_000);
await fTurn(1);
check(
  "refire guard blocks until usage grows by 20k past the last attempt",
  () => {
    assert.equal(f.compactCalls.length, 1);
  },
);

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
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
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
    c.notices.some(
      (n) =>
        n.msg.includes("budget 200,000 (model window)") &&
        n.msg.includes("untouched"),
    ),
    `got: ${c.notices.map((n) => n.msg).join(" | ")}`,
  );
});

await cmd("150000");
c.setTokens(140_000);
await c.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  c.ctx,
);
check("/context-cap <tokens> lowers the budget for the session", () => {
  assert.equal(c.compactCalls.length, 1);
});
c.compactCalls[0].onComplete();

await cmd("off");
c.setTokens(300_000);
await c.events.get("turn_end")(
  {
    turnIndex: 1,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  c.ctx,
);
check("/context-cap off disables enforcement", () => {
  assert.equal(c.compactCalls.length, 1);
});

await cmd("on");
await c.events.get("turn_end")(
  {
    turnIndex: 2,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  c.ctx,
);
check("/context-cap on re-enables enforcement", () => {
  assert.equal(c.compactCalls.length, 2);
});
c.compactCalls[1].onComplete();

await cmd("resume off");
c.setTokens(320_000);
await c.events.get("turn_end")(
  {
    turnIndex: 3,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
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
  assert.ok(
    c.notices.some(
      (n) => n.level === "error" && n.msg.includes("unrecognized argument"),
    ),
  );
});

await cmd("5000");
check("budget must exceed the reserve", () => {
  assert.ok(
    c.notices.some(
      (n) => n.level === "error" && n.msg.includes("larger than the reserve"),
    ),
  );
});

// --- Fork: whitelist config and tri-state session toggle ---------------------

// No config files → all models allowed, default budget.
const w = makeHarness();
factory(w.pi);
await w.events.get("session_start")({}, w.ctx);
w.setTokens(190_000);
await w.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  w.ctx,
);
check(
  "no config: budget follows the model window (200k), fires at 183,616",
  () => {
    assert.equal(w.compactCalls.length, 1);
  },
);

// Whitelist: opencode/* allowed, anthropic/* blocked.
const p = makeHarness();
factory(p.pi);
projectCfg({ models: ["opencode/*"] });
await p.events.get("session_start")({}, p.ctx);
p.setTokens(190_000);
await p.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  p.ctx,
);
check("whitelist: opencode/kimi-k3 allowed → fires", () => {
  assert.equal(p.compactCalls.length, 1);
});
p.compactCalls[0].onComplete();

p.setModel("anthropic", "claude-sonnet-4-5");
p.setTokens(190_000);
await p.events.get("turn_end")(
  {
    turnIndex: 1,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  p.ctx,
);
check("whitelist: anthropic model blocked → no fire", () => {
  assert.equal(p.compactCalls.length, 1);
});

// /context-cap on forces active even outside the whitelist.
// Note: 210k would sit exactly on the refire guard (190k+20k); use 220k.
await p.commands.get("context-cap").handler("on", p.ctx);
p.setTokens(220_000); // above the 20k refire guard vs the 190k last fire
await p.events.get("turn_end")(
  {
    turnIndex: 2,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  p.ctx,
);
check("session on: forces active outside whitelist", () => {
  assert.equal(p.compactCalls.length, 2);
});
p.compactCalls[1].onComplete();

// /context-cap off forces inactive even inside the whitelist.
p.setModel("opencode", "kimi-k3");
await p.commands.get("context-cap").handler("off", p.ctx);
p.setTokens(300_000);
await p.events.get("turn_end")(
  {
    turnIndex: 3,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  p.ctx,
);
check("session off: forces inactive inside whitelist", () => {
  assert.equal(p.compactCalls.length, 2);
});

// /context-cap default restores whitelist following.
await p.commands.get("context-cap").handler("default", p.ctx);
await p.events.get("turn_end")(
  {
    turnIndex: 4,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  p.ctx,
);
check("session default: follows whitelist again", () => {
  assert.equal(p.compactCalls.length, 3);
});

// status reports active state reason.
await p.commands.get("context-cap").handler("status", p.ctx);
check("status reports whitelist-active state", () => {
  assert.ok(
    p.notices.some((n) => n.msg.includes("active (whitelisted model)")),
  );
});

// reserve >= budget config error disables the guard.
const d = makeHarness();
factory(d.pi);
projectCfg({ budget: 50000, reserve: 50000 });
await d.events.get("session_start")({}, d.ctx);
d.setTokens(40000);
await d.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  d.ctx,
);
check("reserve>=budget config error disables the guard", () => {
  assert.equal(d.compactCalls.length, 0);
  assert.ok(
    d.notices.some((n) => n.level === "error" && n.msg.includes("reserve")),
  );
});

// Project config overrides global config per key.
const g = makeHarness();
factory(g.pi);
agentCfg({ budget: 300000, reserve: 20000 });
projectCfg({ budget: 150000 });
await g.events.get("session_start")({}, g.ctx);
g.setTokens(140_000);
await g.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  g.ctx,
);
check("project config overrides global per key (150k-20k=130k)", () => {
  assert.equal(g.compactCalls.length, 1);
});

// --- Fork: budget derives from the model's configured contextWindow --------

projectCfg({}); // clear any earlier project budget config
agentCfg({}); // ...and any earlier global budget config

const wd = makeHarness();
factory(wd.pi);
await wd.events.get("session_start")({}, wd.ctx);
const wdTurn = (index) =>
  wd.events.get("turn_end")(
    {
      turnIndex: index,
      message: { role: "assistant" },
      toolResults: [{ toolName: "bash", isError: false }],
    },
    wd.ctx,
  );

// 1M window → budget = the window itself, compacts at 1,048,576 − 16,384.
wd.setModel("opencode", "big", 1_048_576);
wd.setTokens(110_000);
await wdTurn(0);
check(
  "window 1M: budget = window, 110k is far under the ~1,032k trigger → no fire",
  () => {
    assert.equal(wd.compactCalls.length, 0);
  },
);

// Switch to a 128k window → budget = 128,000, compacts at
// min(128,000 − 16,384, 128,000 − 4,096) = 111,616. 115k crosses it.
wd.setModel("opencode", "small", 128_000);
wd.setTokens(115_000);
await wdTurn(1);
check("window 128k: budget = window and fires at ~112k", () => {
  assert.equal(wd.compactCalls.length, 1);
});
wd.compactCalls[0].onComplete();

// Explicit session budget still wins over the window, but the trigger point
// is clamped so it never exceeds window - 4096.
await wd.commands.get("context-cap").handler("150000", wd.ctx);
wd.setModel("opencode", "tiny", 100_000);
// budget 150k - reserve 16k = 133,616, but window 100k clamps to 95,904.
wd.setTokens(100_000);
await wdTurn(2);
check(
  "explicit budget 150k on a 100k window: trigger clamped to 100k-4k",
  () => {
    assert.equal(wd.compactCalls.length, 2);
  },
);
wd.compactCalls[1].onComplete();

// An explicit budget carries no source annotation in status.
await wd.commands.get("context-cap").handler("status", wd.ctx);
check("explicit budget status carries no source annotation", () => {
  const status = wd.notices.find((n) => n.msg.includes("budget 150,000"));
  assert.ok(status, "status should report the explicit budget");
  assert.ok(
    status.msg.includes("budget 150,000, compacts at") &&
      !status.msg.includes("(model window)") &&
      !status.msg.includes("(default)"),
    `got: ${status.msg}`,
  );
});

// A window too small to leave the 4096 safety margin disables the guard.
wd.setModel("opencode", "tiny-window", 3_000);
wd.setTokens(2_000);
await wdTurn(3);
check("window below safety margin (3k) disables the guard", () => {
  assert.equal(wd.compactCalls.length, 2);
});
await wd.commands.get("context-cap").handler("status", wd.ctx);
check("status reports the too-small-window disable reason", () => {
  assert.ok(
    wd.notices.some((n) => n.msg.includes("disabled (model window too small")),
    `got: ${wd.notices.map((n) => n.msg).join(" | ")}`,
  );
});

// A window too small to host the reserve also disables the guard (with no
// explicit budget the budget IS the window: reserve 16,384 >= 10,000).
const wd2 = makeHarness();
factory(wd2.pi);
wd2.setModel("opencode", "narrow", 10_000);
await wd2.events.get("session_start")({}, wd2.ctx);
wd2.setTokens(6_000);
await wd2.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  wd2.ctx,
);
check("window too small for the reserve disables the guard", () => {
  assert.equal(wd2.compactCalls.length, 0);
  assert.ok(
    wd2.notices.some((n) =>
      n.msg.includes("too small for the configured reserve"),
    ),
    `got: ${wd2.notices.map((n) => n.msg).join(" | ")}`,
  );
});

// --- Fork: config robustness (null placeholders, prefixes, strict parse) -----

// JSON null values are treated as unset (common in generated configs such as
// home-manager), silently — no warning, and the guard still runs on the
// window-derived budget.
const nul = makeHarness();
factory(nul.pi);
agentCfg({ budget: null, models: null, reserve: null });
projectCfg({});
await nul.events.get("session_start")({}, nul.ctx);
nul.setTokens(190_000);
await nul.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  nul.ctx,
);
check("JSON null config values are unset, without warnings", () => {
  assert.equal(nul.compactCalls.length, 1); // budget = 200k window, fires at 183,616
  assert.equal(
    nul.notices.filter((x) => x.level === "warning").length,
    0,
    `got: ${nul.notices.map((n) => n.msg).join(" | ")}`,
  );
});
nul.compactCalls[0].onComplete();

// A model without a configured contextWindow falls back to the 200k default.
const fb = makeHarness();
factory(fb.pi);
await fb.events.get("session_start")({}, fb.ctx);
fb.ctx.model = { provider: "opencode", id: "no-window" };
fb.setTokens(190_000);
await fb.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  fb.ctx,
);
check("model without a window falls back to the 200k default budget", () => {
  assert.equal(fb.compactCalls.length, 1);
});
fb.compactCalls[0].onComplete();
await fb.commands.get("context-cap").handler("status", fb.ctx);
check("status annotates the fallback budget source as (default)", () => {
  assert.ok(
    fb.notices.some((n) => n.msg.includes("budget 200,000 (default)")),
    `got: ${fb.notices.map((n) => n.msg).join(" | ")}`,
  );
});

// A 365k-window model (e.g. gpt-5.6-terra) uses the window as the budget:
// compacts at min(365,000 − 16,384, 365,000 − 4,096) = 348,616.
const terra = makeHarness();
factory(terra.pi);
await terra.events.get("session_start")({}, terra.ctx);
terra.setModel("new-api", "gpt-5.6-terra", 365_000);
terra.setTokens(350_000);
await terra.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  terra.ctx,
);
check("365k window: budget = 365,000, fires above 348,616", () => {
  assert.equal(terra.compactCalls.length, 1);
});
terra.compactCalls[0].onComplete();
await terra.commands.get("context-cap").handler("status", terra.ctx);
check(
  "365k window status: budget 365,000 (model window), compacts at ~348,616",
  () => {
    assert.ok(
      terra.notices.some(
        (n) =>
          n.msg.includes("budget 365,000 (model window)") &&
          n.msg.includes("~348,616"),
      ),
      `got: ${terra.notices.map((n) => n.msg).join(" | ")}`,
    );
  },
);

// Invalid values warn exactly once (single "context-cap: " prefix) and do not
// leak into the whitelist reason.
const cfg = makeHarness();
factory(cfg.pi);
agentCfg({ budget: "abc", models: ["new-api/gpt-*"] });
await cfg.events.get("session_start")({}, cfg.ctx);
await cfg.commands.get("context-cap").handler("status", cfg.ctx);
check("invalid budget warns once with a single prefix", () => {
  const warnings = cfg.notices.filter((x) => x.level === "warning");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].msg.startsWith("context-cap: "));
  assert.ok(!warnings[0].msg.includes("context-cap: context-cap:"));
});
check("whitelist reason excludes config-load warnings", () => {
  const status = cfg.notices.find((x) =>
    x.msg.includes("model not whitelisted"),
  );
  assert.ok(status, "status should report the model as not whitelisted");
  assert.ok(
    !status.msg.includes("must be a positive token count"),
    `got: ${status.msg}`,
  );
});

// Suffix strings like "200k" are rejected instead of silently parsing as 200.
const suf = makeHarness();
factory(suf.pi);
agentCfg({ budget: "200k" });
await suf.events.get("session_start")({}, suf.ctx);
check("suffix strings like 200k are rejected, not truncated to 200", () => {
  assert.ok(
    suf.notices.some(
      (x) => x.level === "warning" && x.msg.includes('"budget"'),
    ),
    `got: ${suf.notices.map((n) => n.msg).join(" | ")}`,
  );
});

// Pattern matching is case-insensitive, consistent with pi's scopedModels.
const noc = makeHarness();
factory(noc.pi);
agentCfg({ models: ["NEW-API/GPT-*"] });
await noc.events.get("session_start")({}, noc.ctx);
noc.setModel("new-api", "gpt-5.6-sol");
noc.setTokens(190_000);
await noc.events.get("turn_end")(
  {
    turnIndex: 0,
    message: { role: "assistant" },
    toolResults: [{ toolName: "bash", isError: false }],
  },
  noc.ctx,
);
check("whitelist matching is case-insensitive (pi convention)", () => {
  assert.equal(noc.compactCalls.length, 1);
});

rmSync(CC_AGENT_DIR, { recursive: true, force: true });
rmSync(CC_PROJECT_DIR, { recursive: true, force: true });
if (OLD_CC_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = OLD_CC_DIR;
delete process.env.CC_TEST_PROJECT_DIR;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
