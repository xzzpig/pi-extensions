#!/usr/bin/env node
// Explicit real-provider TUI acceptance. Never add this .mjs entry to auto test discovery.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = process.env.PI_E2E_REPO_ROOT ?? process.cwd();
const name = `dynamic-audit-${Date.now()}`;
const dir = `/tmp/pi-e2e-${name}`;
const wrapper = path.join(
  root,
  ".agents/skills/pi-plugin-e2e-test/scripts/pi-e2e-env.sh",
);
const env = { ...process.env, TMUX_TMPDIR: "/tmp" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (...args) =>
  execFileSync("bash", [wrapper, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20000,
  });
const send = (...args) => step("send", name, ...args);
const mark = (text) => step("mark", name, text);
const capture = () => step("capture", name, "42");
function trace() {
  if (!existsSync(path.join(dir, "audit-trace.jsonl"))) return [];
  return readFileSync(path.join(dir, "audit-trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      } // A concurrent final append can be incomplete until the next poll.
    });
}
async function wait(predicate, label, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = predicate();
    if (result) return result;
    await sleep(750);
  }
  throw new Error(`Timed out: ${label}`);
}

let started = false;
let stopped = false;
try {
  console.log(
    step(
      "start",
      name,
      path.join(root, "packages/pi-subagents/index.ts"),
      path.join(
        root,
        "packages/pi-goal-x/tests/fixtures/fork-dynamic-audit-live.ts",
      ),
      path.join(root, "packages/pi-goal-x/extensions/goal.ts"),
    ),
  );
  started = true;
  writeFileSync("/tmp/dynamic-checklist-live-name.txt", name);
  await wait(
    () => existsSync(path.join(dir, "seeded")),
    "isolated seed",
    60000,
  );
  let screen = capture();
  assert.match(screen, /fork-dynamic-audit-live\.ts, goal\.ts, pi-subagents/);
  mark("01 PASS local extensions and isolated seeded goal loaded");
  for (let i = 0; i < 8 && !/thinking off/.test(screen); i++) {
    send("BTab");
    await sleep(250);
    screen = capture();
  }
  assert.match(screen, /thinking off/);
  send(
    '这是隔离真实运行验收。请实际读取 evidence.txt，核验 DELIVERY-READY 和 CHECK-01 到 CHECK-10，然后调用 update_goal(status="complete") 请求独立审计。不要创建或修改目标或任务，不要调用 audit_review_barrier（仅审计员使用）。审计返回后简短报告。',
    "Enter",
  );
  const first = await wait(
    () => trace().find((e) => e.kind === "progress"),
    "real per-item progress",
  );
  screen = capture();
  assert.match(screen, /已检查 \d+\/11/);
  mark(
    "02 PASS compact dynamic checklist visible after real child progress; Escape park",
  );
  send("Escape");
  await wait(
    () => /Audit interrupted/.test(capture()),
    "audit interruption dialog",
    10000,
  );
  mark("03 PASS real interruption dialog; choose default Continue audit");
  send("Enter");
  await wait(
    () => /Independent completion audit/.test(capture()),
    "resumed audit widget",
    10000,
  );
  send("-l", "\u001b[116;6u"); // Ctrl+Shift+T via CSI-u, matching the existing native shortcut.
  await wait(
    () => trace().find((e) => e.kind === "barrier_enter"),
    "real auditor observation barrier",
  );
  screen = capture();
  assert.match(screen, /已检查 11\/11/);
  assert.match(screen, /CHECK-01/);
  send("End");
  await sleep(200);
  screen = capture();
  assert.match(screen, /CHECK-10/);
  assert.match(screen, /tool audit_review_barrier/);
  mark("04 PASS expanded actual evidence and End reaches final extra item");
  execFileSync(
    "tmux",
    ["resize-window", "-t", `e2e-${name}:`, "-x", "72", "-y", "28"],
    { env },
  );
  send("End");
  await sleep(300);
  screen = capture();
  assert.match(screen, /CHECK-10/);
  assert.ok(
    screen
      .split("\n")
      .filter((line) => /^[╭│╰]/.test(line))
      .every((line) => visibleWidth(line) <= 72),
  );
  execFileSync(
    "tmux",
    ["resize-window", "-t", `e2e-${name}:`, "-x", "130", "-y", "42"],
    { env },
  );
  send("Home");
  await sleep(200);
  screen = capture();
  assert.match(screen, /DELIVERY-READY/);
  send("-l", "\u001b[116;6u");
  await sleep(200);
  screen = capture();
  assert.match(screen, /已检查 11\/11/);
  mark(
    "05 PASS resize/Home/compact; release pacing barrier (not evidence or verdict)",
  );
  writeFileSync(
    path.join(dir, "review-ready"),
    "Observation complete; auditor decides independently.\n",
  );
  const terminal = await wait(
    () => trace().find((e) => e.kind === "response"),
    "real audit verdict",
    180000,
  );
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.verdict, "approved");
  const parent = trace().find((e) => e.kind === "seed")?.sessionId;
  await wait(
    () =>
      trace().find(
        (e) =>
          e.kind === "agent_end" &&
          e.sessionId === parent &&
          e.at >= terminal.at,
      ),
    "parent idle after actual verdict",
    60000,
  );
  screen = capture();
  mark("06 PASS real verdict returned and parent reached idle");
  const rows = trace();
  assert.equal(rows.filter((e) => e.kind === "request").length, 1);
  assert.equal(rows.filter((e) => e.kind === "started").length, 1);
  assert.equal(rows.filter((e) => e.kind === "cancel").length, 0);
  assert.equal(rows.filter((e) => e.kind === "response").length, 1);
  assert.equal(rows.filter((e) => e.kind === "progress_parse_error").length, 0);
  assert.ok(
    rows
      .filter((e) => e.kind === "progress")
      .every((e) => e.requestId === first.requestId),
  );
  const last = new Map(
    rows.filter((e) => e.kind === "progress").map((e) => [e.checkId, e.state]),
  );
  assert.equal(last.size, 11);
  assert.ok([...last.values()].every((state) => state === "passed"));
  const barrier = rows.find((e) => e.kind === "barrier_enter");
  assert.notEqual(
    barrier?.sessionId,
    parent,
    "only the real child called the pacing tool",
  );
  const ledger = readFileSync(
    path.join(dir, ".pi/goals/goal_events.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(ledger.filter((e) => e.type === "audit_result").length, 1);
  assert.equal(
    ledger.find((e) => e.type === "audit_result")?.verdict,
    "approved",
  );
  assert.equal(ledger.filter((e) => e.type === "audit_skipped").length, 0);
  assert.equal(
    readdirSync(path.join(dir, ".pi/goals/archived")).filter((f) =>
      f.endsWith(".md"),
    ).length,
    1,
  );
  console.log(step("stop", name));
  stopped = true;
  const run = readFileSync(path.join(dir, "current-run"), "utf8").trim();
  assert.equal(readFileSync(path.join(run, "pi-exit"), "utf8").trim(), "0");
  assert.equal(
    readFileSync(path.join(run, "recorder-exit"), "utf8").trim(),
    "0",
  );
  const cast = readFileSync(path.join(run, "session.cast"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(cast[0].version, 2);
  assert.ok(cast.slice(1).some((e) => e[1] === "o"));
  const summary = {
    pass: true,
    dir,
    cast: path.join(run, "session.cast"),
    requestId: first.requestId,
    uniqueChecklistItems: last.size,
    verdict: terminal.verdict,
    parentSessionId: parent,
    childSessionId: barrier?.sessionId,
    piExit: 0,
    recorderExit: 0,
    replay: "pending",
  };
  writeFileSync(
    path.join(dir, "acceptance.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(`FAIL real dynamic audit TUI: ${error.message}`);
  if (started) {
    mark("FAIL acceptance; keep every capture and recording");
    writeFileSync(
      path.join(dir, "review-ready"),
      "Release test pacing during failure cleanup; not approval.\n",
    );
    console.error(`Evidence retained: ${dir}`);
  }
  process.exitCode = 1;
} finally {
  if (started && !stopped) {
    try {
      console.log(step("stop", name));
    } catch {
      console.error(`Recording cleanup needs inspection: ${dir}`);
    }
  }
}
